/**
 * 视觉通道与听觉通道的独立性（v0.4.59）。
 *
 * ## 为什么这个文件必须存在
 *
 * 外部审阅在 v0.4.56 上指出一个真 bug：
 *
 *   `showToast=false` **只在 TTS 分支被处理**；语音包 / 系统提示音 /
 *   自定义音频一律让 `dsh-notify.ps1` 自己弹窗 —— 于是"关掉弹窗"对
 *   这三种音源根本没生效。
 *
 * 而当时的 `audio-wiring.test.mjs` 的 A3 用例**只测了 TTS**，
 * 所以这个 bug 一直绿灯。我改完代码后测试也全绿 —— 再次印证：
 * **没覆盖到的组合等于没测。**
 *
 * 这个文件按"五种音源 × 两个开关的全部组合"做参数级断言。
 *
 * ## 关键契约
 *
 * | showToast | voice | 期望 |
 * |-----------|-------|------|
 * | true      | true  | 弹窗 + 出声（notify 不带任何抑制开关） |
 * | true      | false | 只弹窗（notify 带 `-NoSound`） |
 * | false     | true  | 只出声（notify 带 `-SoundOnly`） |
 * | false     | false | **不启动任何进程** |
 *
 * 注意 `-NoSound` 与 `-SoundOnly` **互斥**，同时出现说明逻辑错了。
 *
 * 需带 loader 跑：`npm run test:toast`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'notify-channels-'));
process.env.DSH_HOME = HOME;
process.on('exit', () => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });

const { apply } = await import('../lib/index.js');

function stubActive() {
  return globalThis.__STUB_CHILD_PROCESS__ === true;
}

function skipReason() {
  if (!process.env.DSH_ROUTE_LOADER && !stubActive()) return '需 npm run test:toast（带 --import loader）';
  if (!stubActive()) return 'loader stub 未生效';
  return false;
}

function mkCtx() {
  const handlers = new Map();
  return {
    on(name, fn) { handlers.set(name, fn); return { dispose() { handlers.delete(name); } }; },
    effect(fn) { try { const d = fn(); return { dispose() { try { if (typeof d === 'function') d(); } catch { /* ignore */ } } }; } catch { return { dispose() { /* ignore */ } }; } },
    inject(_names, fn) { try { fn({ webServer: null }); } catch { /* ignore */ } return { dispose() { /* ignore */ } }; },
    get() { return undefined; },
    logger: { info() { /* silent */ }, warn() { /* silent */ }, error() { /* silent */ } },
    emit(name, ...args) { const h = handlers.get(name); if (h) h(...args); },
  };
}

/** 触发一次"完成"，返回 spawn 的 argv 列表。 */
function runDone(pluginCfg) {
  globalThis.__SPAWN_CALLS = [];
  const ctx = mkCtx();
  apply(ctx, { idleGate: false, subagents: false, ...pluginCfg });

  const agent = { id: 'agent-1', session: { id: 'sess-1' }, status: 'running' };
  ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  agent.status = 'idle';
  ctx.emit('agent/status', { agent, status: 'running' });
  ctx.emit('agent/status', { agent, status: 'idle' });

  return (globalThis.__SPAWN_CALLS || []).map((c) => (c && (c.args || c.argv)) || []);
}

function scriptOf(argv) {
  const arr = Array.isArray(argv) ? argv : [];
  const i = arr.indexOf('-File');
  return i >= 0 && arr[i + 1] ? String(arr[i + 1]).replace(/\\/g, '/').split('/').pop() : '';
}

/** 只留下 dsh-notify.ps1 的调用（负责 Toast/系统音/自定义音频）。 */
function notifyCalls(calls) {
  return calls.filter((a) => scriptOf(a) === 'dsh-notify.ps1');
}

/** 只留下 tts-speak.ps1 的调用。 */
function ttsCalls(calls) {
  return calls.filter((a) => scriptOf(a) === 'tts-speak.ps1');
}

const SOURCES = ['tts', 'bundled', 'system', 'custom', 'none'];

// ── M1: 两个都关 → 一个进程都不该启动 ──────────────────────────────────
test('M1: 弹窗与声音都关时，不启动任何进程（五种音源）', { skip: skipReason() }, () => {
  for (const source of SOURCES) {
    const calls = runDone({ audioSource: source, voice: false, showToast: false });
    assert.equal(calls.length, 0,
      `source=${source} 且 voice/showToast 都关时不该 spawn 任何东西，实际 ${JSON.stringify(calls.map(scriptOf))}`);
  }
});

// ── M2: 只出声 → notify 必须带 -SoundOnly，且不得带 -NoSound ────────────
test('M2: showToast=false 且 voice=true 时，notify 带 -SoundOnly', { skip: skipReason() }, () => {
  // 这条就是审阅指出的 bug：语音包/系统音/自定义音频原来不带这个开关，
  // 于是"关掉弹窗"形同虚设。
  for (const source of ['bundled', 'system', 'custom']) {
    const calls = runDone({ audioSource: source, voice: true, showToast: false });
    const n = notifyCalls(calls);
    assert.equal(n.length, 1, `source=${source} 应恰好调一次 notify.ps1，实际 ${n.length}`);
    assert.ok(n[0].includes('-SoundOnly'),
      `source=${source} 应传 -SoundOnly（只出声不弹窗），实际参数: ${JSON.stringify(n[0])}`);
    assert.ok(!n[0].includes('-NoSound'),
      `source=${source} 不应同时传 -NoSound（与 -SoundOnly 互斥）`);
  }
});

// ── M3: 只弹窗 → notify 必须带 -NoSound，且不得带 -SoundOnly ────────────
test('M3: showToast=true 且 voice=false 时，notify 带 -NoSound', { skip: skipReason() }, () => {
  for (const source of ['bundled', 'system', 'custom', 'none']) {
    const calls = runDone({ audioSource: source, voice: false, showToast: true });
    const n = notifyCalls(calls);
    assert.equal(n.length, 1, `source=${source} 应恰好调一次 notify.ps1，实际 ${n.length}`);
    assert.ok(n[0].includes('-NoSound'),
      `source=${source} 应传 -NoSound（只弹窗不出声），实际: ${JSON.stringify(n[0])}`);
    assert.ok(!n[0].includes('-SoundOnly'),
      `source=${source} 不应同时传 -SoundOnly`);
  }
});

// ── M4: 两个都开 → 两个抑制开关都不该出现 ──────────────────────────────
test('M4: showToast=true 且 voice=true 时，两个抑制开关都不出现', { skip: skipReason() }, () => {
  for (const source of ['bundled', 'system', 'custom']) {
    const calls = runDone({ audioSource: source, voice: true, showToast: true });
    const n = notifyCalls(calls);
    assert.equal(n.length, 1, `source=${source} 应调一次 notify.ps1`);
    assert.ok(!n[0].includes('-NoSound'), `source=${source} 不该抑制声音`);
    assert.ok(!n[0].includes('-SoundOnly'), `source=${source} 不该抑制弹窗`);
  }
});

// ── M5: TTS 走两个进程，各管一个通道 ───────────────────────────────────
test('M5: TTS 由两个进程分别负责声音与弹窗', { skip: skipReason() }, () => {
  // 两个都开：tts-speak.ps1 出声、notify.ps1 弹窗（带 -NoSound 避免重复出声）
  {
    const calls = runDone({ audioSource: 'tts', voice: true, showToast: true });
    assert.equal(ttsCalls(calls).length, 1, '应调一次 tts-speak.ps1');
    const n = notifyCalls(calls);
    assert.equal(n.length, 1, '应调一次 notify.ps1 负责弹窗');
    assert.ok(n[0].includes('-NoSound'), 'TTS 自己出声，notify 应带 -NoSound');
  }
  // 只出声：不调 notify
  {
    const calls = runDone({ audioSource: 'tts', voice: true, showToast: false });
    assert.equal(ttsCalls(calls).length, 1, '应仍调 TTS');
    assert.equal(notifyCalls(calls).length, 0, 'showToast=false 时不该调 notify.ps1');
  }
  // 只弹窗：不调 TTS
  {
    const calls = runDone({ audioSource: 'tts', voice: false, showToast: true });
    assert.equal(ttsCalls(calls).length, 0, 'voice=false 时不该调 TTS');
    const n = notifyCalls(calls);
    assert.equal(n.length, 1, '应调一次 notify.ps1 弹窗');
    assert.ok(n[0].includes('-NoSound'), '不该出声');
  }
});

// ── M6: none 音源：不出声但可弹窗 ──────────────────────────────────────
test('M6: audioSource=none 只弹窗、不出声', { skip: skipReason() }, () => {
  const calls = runDone({ audioSource: 'none', voice: true, showToast: true });
  assert.equal(ttsCalls(calls).length, 0, 'none 不该调 TTS');
  const n = notifyCalls(calls);
  assert.equal(n.length, 1, 'none 仍应弹窗');
  assert.ok(n[0].includes('-NoSound'), 'none 不该出声');
});

// ── M7: 普通 fork 会话不能被当成子代理过滤掉 ────────────────────────────
test('M7: 普通 fork（有 parentSession、无 origin）仍会提醒', { skip: skipReason() }, () => {
  // ⚠️ 外部审阅指出的规则矛盾：isSubagent() 原来只看 parentSession。
  // 但 sessions.fork 产生的**普通分叉会话** header 也带 parentSession
  // （origin 为空、是用户自己的顶层会话），于是默认 subagents:false 时
  // 它的完成通知会被当成"子代理的"过滤掉 —— 用户觉得"我这个会话怎么不响"。
  globalThis.__SPAWN_CALLS = [];
  const ctx = mkCtx();
  apply(ctx, { idleGate: false, subagents: false, audioSource: 'tts', voice: true, showToast: true });

  // fork 会话：parentSession 有值，origin 为空
  const forked = {
    id: 'agent-fork',
    session: { id: 'sess-fork', header: { parentSession: 'root-1' } },
    status: 'running',
  };
  ctx.emit('session/event', forked.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  forked.status = 'idle';
  ctx.emit('agent/status', { agent: forked, status: 'running' });
  ctx.emit('agent/status', { agent: forked, status: 'idle' });

  const calls = (globalThis.__SPAWN_CALLS || []).map((c) => (c && (c.args || c.argv)) || []);
  assert.ok(calls.length > 0,
    '普通 fork 会话的完成**应该**提醒；被当成子代理过滤掉了（isSubagent 误判）');
});

test('M8: 真子代理（origin=subagent）在 subagents=false 时仍被过滤', { skip: skipReason() }, () => {
  // 负例的另一半：不能为了修 fork 误判，把真子代理也放进来。
  globalThis.__SPAWN_CALLS = [];
  const ctx = mkCtx();
  apply(ctx, { idleGate: false, subagents: false, audioSource: 'tts', voice: true, showToast: true });

  const sub = {
    id: 'agent-sub',
    session: { id: 'sess-sub', header: { origin: 'subagent', parentSession: 'root-1' } },
    status: 'running',
  };
  ctx.emit('session/event', sub.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  sub.status = 'idle';
  ctx.emit('agent/status', { agent: sub, status: 'running' });
  ctx.emit('agent/status', { agent: sub, status: 'idle' });

  const calls = (globalThis.__SPAWN_CALLS || []).map((c) => (c && (c.args || c.argv)) || []);
  assert.equal(calls.length, 0,
    'subagents=false 时真子代理不该提醒（过滤规则不能因为修 fork 而失效）');
});