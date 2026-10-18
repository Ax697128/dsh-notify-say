/**
 * dsh-notify-desktop「运行时路由」测试 —— v0.3.1。
 *
 * 与另外两个测试文件的分工：
 *  - `fail-voice.test.mjs`：真跑 ps1，验**池选择**与语义护栏（但用的是自己传的 -Kind）。
 *  - 本文件：验 **lib/index.js 运行时到底给 ps1 传了什么 -Kind**
 *    ——即"error 回合真的会走 fail 池吗"这条**端到端接线**。
 *
 * 为什么必须单独验：`fail-voice.test.mjs` 的 A1 只读**源码文本**（`psKind = 'fail'`），
 * 证明不了"事件进来后实际传出的参数就是 fail"。这两者之间隔着
 * `handleDone` 的分支选择 + `emitDone`/`notify` 的参数透传，任一环写错都会让
 * 失败语音静默失效，而纯文本断言**照样全绿**。
 *
 * 隔离手法：用 `--import` 前置的 loader stub 替换 `node:child_process`，
 * 让 spawn 只记录参数、**不起进程**（不弹 Toast、不出声、不依赖 SystemRoot）。
 * 见 `stub-child-process.mjs` 的注释；踩坑 #424 的教训是别在这里设 SystemRoot。
 *
 * ⚠️ 运行方式：本文件需要 `--import` loader，**不能用默认 `node --test`**。
 * 用专用脚本 `npm run test:route`，或：
 *   node --import ./test/route-loader-register.mjs --test test/fail-route.test.mjs
 * 为免误跑，默认的 `node --test` 会跳过它（本文件首个用例会检测并 skip）。
 *
 * 运行：npm run test:route
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');

// ⚠️ 必须在 import lib/index.js **之前**把 DSH_HOME 指到空目录。
//
// 为什么：插件启动时会读 `$DSH_HOME/storages/dsh-notify-desktop/config.json`
// 作为"运行时覆盖层"，其优先级**高于** apply() 传入的 config。
// 如果测试用真实 DSH_HOME，用户只要在 GUI 里改过任何一项
// （实测：把 notifyOnAborted 打开），R4「aborted 默认不播」就会失败——
// 那是用户配置导致的，不是代码缺陷。测试必须与用户真实配置隔离。
const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'notify-route-home-'));
process.env.DSH_HOME = ISOLATED_HOME;
process.on('exit', () => {
  try { rmSync(ISOLATED_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** 只有 loader 生效时 `__SPAWN_CALLS` 才可能被写入；否则说明没用 --import 跑。 */
function stubActive() {
  return globalThis.__STUB_CHILD_PROCESS__ === true;
}

/** 造最小 ctx 替身。 */
function mkCtx() {
  const handlers = new Map();
  return {
    handlers,
    on(name, fn) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); },
    get() { return undefined; },
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
    emit(name, ...args) { for (const fn of handlers.get(name) || []) fn(...args); },
  };
}

function mkAgent(id, { origin, parentSession, status = 'idle' } = {}) {
  return { id, status, session: { id, header: { id, origin, parentSession } } };
}

/** 从记录的 spawn 调用里取出所有传给 ps1 的 -Kind 值。 */
function kindsOf(calls) {
  const out = [];
  for (const c of calls || []) {
    const args = Array.isArray(c.args) ? c.args : [];
    const i = args.indexOf('-Kind');
    if (i >= 0 && i + 1 < args.length) out.push(String(args[i + 1]));
  }
  return out;
}

/** 跑一次「turn/end(kind) + agent 状态 running→idle」并返回本次 spawn 的 -Kind 列表。 */
async function runTurnAndCollectKind(turnKind, { idleGate = true, subagents = false } = {}) {
  // 每次重新 import 会命中模块缓存，apply 可重复调用（插件本就是可多次 apply 的）
  const { apply } = await import('../lib/index.js');
  const agent = mkAgent('sess-1', { status: 'running' });
  const ctx = mkCtx();
  globalThis.__SPAWN_CALLS = [];
  apply(ctx, { idleGate, subagents, voice: true, volume: 0 });
  ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: turnKind } } });
  agent.status = 'idle';
  ctx.emit('agent/status', { agent, status: 'running' });
  ctx.emit('agent/status', { agent, status: 'idle' });
  // spawn 是同步调用（fire-and-forget），无需等待
  return kindsOf(globalThis.__SPAWN_CALLS);
}

test('R0: loader stub 生效（否则本文件的断言无意义）', { skip: !process.env.DSH_ROUTE_LOADER && '需 npm run test:route（带 --import loader）；默认 node --test 跳过' }, () => {
  assert.equal(stubActive(), true, 'stub 未生效：必须用 npm run test:route 跑');
});

test('R1: error 回合 → ps1 收到 -Kind fail（exact，不是 chime）', { skip: !process.env.DSH_ROUTE_LOADER && '需 npm run test:route' }, async () => {
  const kinds = await runTurnAndCollectKind('error');
  assert.deepEqual(kinds, ['fail'], `error 应传出 ['fail']，实际 ${JSON.stringify(kinds)}`);
  // 负例：绝不能还是 chime（那正是本次要改掉的旧行为）
  assert.ok(!kinds.includes('chime'), 'error 不应再传 chime');
});

test('R2: blocked 回合 → ps1 收到 -Kind chime（维持蜂鸣，语义不同）', { skip: !process.env.DSH_ROUTE_LOADER && '需 npm run test:route' }, async () => {
  const kinds = await runTurnAndCollectKind('blocked');
  assert.deepEqual(kinds, ['chime'], `blocked 应传出 ['chime']，实际 ${JSON.stringify(kinds)}`);
  assert.ok(!kinds.includes('fail'), 'blocked 不应传 fail（它是"被拦下"不是"失败"）');
});

test('R3: completed 回合（无在飞工作）→ ps1 收到 -Kind done', { skip: !process.env.DSH_ROUTE_LOADER && '需 npm run test:route' }, async () => {
  const kinds = await runTurnAndCollectKind('completed');
  assert.deepEqual(kinds, ['done'], `completed 应传出 ['done']，实际 ${JSON.stringify(kinds)}`);
});

test('R4: aborted 回合 → 默认不播（无 spawn 调用）', { skip: !process.env.DSH_ROUTE_LOADER && '需 npm run test:route' }, async () => {
  const kinds = await runTurnAndCollectKind('aborted');
  assert.deepEqual(kinds, [], `aborted 默认静默，实际 ${JSON.stringify(kinds)}`);
});

test('R5: error 在 idleGate=true 下**立即**播（不过空闲门）', { skip: !process.env.DSH_ROUTE_LOADER && '需 npm run test:route' }, async () => {
  // 即便开着空闲门，error 也必须立刻出声（失败要马上知道）——本用例断言"有 spawn 发出"，
  // 即没有被挂起吞掉。挂起路径不会调 notify()，故 spawn 计数为 0 就说明被吞了。
  const kinds = await runTurnAndCollectKind('error', { idleGate: true });
  assert.deepEqual(kinds, ['fail'], `error 开着空闲门也应立即播出 ['fail']，实际 ${JSON.stringify(kinds)}`);
});
