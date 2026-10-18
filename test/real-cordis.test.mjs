/**
 * dsh-notify-desktop 空闲门「真实 Cordis 接线」测试。
 *
 * 为什么需要这个文件（补 wiring.test.mjs 的洞）：
 * `wiring.test.mjs` 用的是**自造 ctx 替身**，它的 `get(name)` 忽略第二个参数——
 * 所以那套测试**无法证明** `ctx.get(name, false)`（非 strict 取服务）在真实 Cordis
 * 上真的能拿到服务。如果真实 Cordis 语义不同，空闲门会静默失效（永不挂起 =
 * 本缺陷原样复发），而替身测试**照样全绿**——这是典型的"假绿"。
 *
 * 本文件用**宿主自带的真实 @deepseek-ai/cordis**（4.0.2）加载本插件：
 *  - 真实 Context/Service/effect/事件系统；
 *  - 真实 `ctx.get`（含 2 参非 strict）语义；
 *  - 真实 `ctx.on(..., { global: true })` 是否能注册成功。
 * 只把**外部副作用**（spawn 子进程）隔离掉：SystemRoot 指向不存在路径。
 *
 * 运行：node --test tools/plugins/dsh-notify-desktop/test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
// ⚠️ 必须在 import lib/index.js **之前**把 DSH_HOME 指到空目录。
//
// 插件启动时会读 `$DSH_HOME/storages/dsh-notify-desktop/config.json` 作为
// 「运行时覆盖层」，其优先级**高于** apply() 传入的 config。若用真实 DSH_HOME，
// 用户只要在 GUI 里改过任何一项（实测：把 notifyOnAborted 打开），
// 那些假定默认值的用例就会红——那是用户配置导致的，不是代码缺陷。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'notify-test-home-'));
process.env.DSH_HOME = ISOLATED_HOME;
process.on('exit', () => { try { rmSync(ISOLATED_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

// 必须在 import 插件之前设置：插件模块顶层读 SystemRoot 算 POWERSHELL_EXE。
process.env.SystemRoot = 'Z:\\__no_such_root__';

const { apply } = await import('../lib/index.js');

/**
 * 定位宿主自带的真实 cordis。找不到就**跳过**（不静默通过）：
 * 该依赖是宿主的、不在插件包内，换机器可能不存在。
 *
 * ⚠️ Windows 上动态 import 绝对路径必须先转 `file://` URL，否则报
 * `ERR_UNSUPPORTED_ESM_URL_SCHEME`（Received protocol 'd:'）——实测踩过。
 */
function loadRealCordis() {
  const candidates = [
    process.env.DSH_CORDIS_ENTRY || '',   // CI/其他机器可指定
    'D:\\Program Files (x86)\\DSH\\.runtime\\node_modules\\@deepseek-ai\\cordis\\lib\\index.js',
  ];
  const req = createRequire(import.meta.url);
  for (const p of candidates) {
    // 显式设了 DSH_CORDIS_ENTRY 就只用它 —— 便于模拟"没有宿主"的 CI 环境
    if (process.env.DSH_CORDIS_ENTRY) {
      const only = process.env.DSH_CORDIS_ENTRY;
      try { req.resolve(only); return pathToFileURL(only).href; } catch { return undefined; }
    }
    if (!p) continue;
    try {
      req.resolve(p);
      return pathToFileURL(p).href;
    } catch { /* 试下一个 */ }
  }
  return undefined;
}

const REAL_CORDIS = loadRealCordis();

/** 捕获插件日志。 */
function captureLogs() {
  const lines = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...a) => { lines.push(a.join(' ')); };
  console.warn = (...a) => { lines.push(a.join(' ')); };
  return {
    lines,
    restore() { console.log = origLog; console.warn = origWarn; },
    get text() { return lines.join('\n'); },
  };
}

function mkAgent(id, { origin, parentSession, status = 'idle' } = {}) {
  return { id, status, session: { id, header: { id, origin, parentSession } } };
}

test('真实 Cordis：ctx.get(name, false) 确实能取到非 strict 提供的服务', { skip: !REAL_CORDIS && '未找到宿主 cordis（跳过，不算通过）' }, async () => {
  const { Context, Service } = await import(REAL_CORDIS);
  const root = new Context();

  // 用真实 Service 子类注册一个 'jobs'，模拟宿主提供方式。
  class FakeJobs extends Service {
    constructor(ctx) { super(ctx, 'jobs'); }
    list() { return []; }
    onJobsChanged() { return () => {}; }
  }

  // 关键：在**已就绪**的 fiber 上提供，然后分别用 strict / non-strict 读。
  let provided = false;
  root.plugin((ctx) => {
    new FakeJobs(ctx);
    provided = true;
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(provided, true, '前置：服务应已提供');

  const strictHit = root.get('jobs');
  const looseHit = root.get('jobs', false);
  assert.ok(looseHit, 'ctx.get("jobs", false) 必须能取到服务（空闲门依赖此语义）');
  assert.ok(strictHit, 'ctx.get("jobs") strict 也应取到（fiber 已 active）');
  assert.equal(typeof looseHit.list, 'function', '取到的服务应可用');
});

test('真实 Cordis：未提供时 ctx.get(name, false) 返回 undefined 而不是抛错', { skip: !REAL_CORDIS && '未找到宿主 cordis（跳过，不算通过）' }, async () => {
  const { Context } = await import(REAL_CORDIS);
  const root = new Context();
  let threw = false;
  let val;
  try { val = root.get('definitely-not-provided', false); } catch { threw = true; }
  assert.equal(threw, false, '读未提供的服务不应抛（空闲门靠这个退化）');
  assert.equal(val, undefined, '未提供应为 undefined');
});

test('真实 Cordis：插件能在真实 ctx 上加载，注册三个事件处理器且不抛', { skip: !REAL_CORDIS && '未找到宿主 cordis（跳过，不算通过）' }, async () => {
  const { Context } = await import(REAL_CORDIS);
  const root = new Context();
  const logs = captureLogs();
  let loaded = false;
  let failure;
  try {
    root.plugin((ctx) => { apply(ctx, { idleGate: true }); loaded = true; });
    await new Promise((r) => setTimeout(r, 40));
  } catch (e) {
    failure = e;
  } finally {
    logs.restore();
  }
  assert.equal(failure, undefined, 'apply 不应抛：' + (failure && failure.message));
  assert.equal(loaded, true, '插件应加载成功');
  // 未提供 jobs/agents 时应走退化路径，而不是崩
  assert.doesNotMatch(logs.text, /idle-gate: 挂起完成播报/, '无服务时不应挂起（退化为立即播报）');
});

test('真实 Cordis：空闲门端到端——真实服务下，子代理 running 时挂起', { skip: !REAL_CORDIS && '未找到宿主 cordis（跳过，不算通过）' }, async () => {
  const { Context, Service } = await import(REAL_CORDIS);
  const root = new Context();

  const main = mkAgent('main-1', { status: 'idle' });
  const child = mkAgent('child-1', { origin: 'subagent', parentSession: 'main-1', status: 'running' });
  const liveAgents = [main, child];

  // 用真实 Service 注册 agents / jobs，验证插件通过 ctx.get 真能拿到。
  class FakeAgents extends Service {
    constructor(ctx) { super(ctx, 'agents'); }
    list() { return liveAgents; }
    get(id) { return liveAgents.find((a) => a.id === id); }
  }
  class FakeJobs2 extends Service {
    constructor(ctx) { super(ctx, 'jobs'); }
    list() { return []; }
    onJobsChanged() { return () => {}; }
  }

  let ctxRef;
  root.plugin((ctx) => {
    new FakeAgents(ctx);
    new FakeJobs2(ctx);
    ctxRef = ctx;
    apply(ctx, { idleGate: true });
  });
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(ctxRef, '前置：插件应已加载');

  const logs = captureLogs();
  try {
    // 真实事件分发：session/event + agent/status
    ctxRef.emit('session/event', main.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    ctxRef.emit('agent/status', { agent: main, status: 'running' });
    ctxRef.emit('agent/status', { agent: main, status: 'idle' });
    assert.match(
      logs.text,
      /idle-gate: 挂起完成播报/,
      '真实 Cordis 下，子代理 running 时**必须**挂起——若这里失败，说明 ctx.get(name,false) 语义不符，空闲门会失效',
    );
  } finally {
    logs.restore();
  }
});

test('真实 Cordis：ctx.effect 的 disposer 真能被调用（卸载清理路径）', { skip: !REAL_CORDIS && '未找到宿主 cordis（跳过，不算通过）' }, async () => {
  const { Context } = await import(REAL_CORDIS);
  const root = new Context();
  let disposed = false;
  // ctx.plugin 返回 fiber；卸载走 fiber.dispose()（不是 root.stop()——那不存在，实测踩过）。
  const fiber = root.plugin((ctx) => {
    ctx.effect(() => () => { disposed = true; }, 'test-effect');
  });
  await fiber;
  assert.equal(disposed, false, '前置：未卸载前不应清理');
  await fiber.dispose();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(disposed, true, '卸载时应调用 effect disposer（清挂起计时器靠它）');
});
