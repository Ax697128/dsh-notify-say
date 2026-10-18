/**
 * 音源接线测试：`notify()` 到底给哪个脚本传了什么参数。
 *
 * ## 为什么需要
 *
 * `audio-source.js` 的 17 条测试只验"该用哪个音源"这个**判定**，
 * 但判定正确 ≠ 真的按判定执行。中间隔着 `notify()` 的分流：
 *
 *   - `audioSource=tts` 时该调 `tts-speak.ps1`，且**不该**让 notify.ps1 出声
 *   - `showToast=false` 时不该弹窗
 *   - `audioSource=none` / `voice=false` 时不该有任何声音脚本
 *
 * 这些接线写错的表现是**静默**的：用户选了 TTS 却听到语音包，或什么都没听到。
 *
 * ## 隔离
 *
 * 不真实 spawn：用测试自身的桩收集参数（与 fail-route 的 loader stub 同思路，
 * 但这里更简单——只验"组出来的参数对不对"，不验进程行为）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'notify-wiring-audio-'));
process.env.DSH_HOME = HOME;
process.on('exit', () => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });

const { apply } = await import('../lib/index.js');

/**
 * 造一个最小 ctx，收集所有 spawn 出去的 argv。
 *
 * 插件用 `spawn(POWERSHELL_EXE, args, ...)`；这里没法替换已 import 的 spawn，
 * 所以改为**拦截 tts/notify 脚本路径**：构造一个会触发 notify 的事件流，
 * 然后读 `globalThis.__SPAWN_CALLS`（由 test/route-loader-register.mjs 的 stub 提供）。
 *
 * 本文件必须用 `--import ./test/route-loader-register.mjs` 跑，
 * 否则 `globalThis.__SPAWN_CALLS` 不存在，首个用例会 skip。
 */
function stubActive() {
  return globalThis.__STUB_CHILD_PROCESS__ === true;
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

/** 跑一次完整"完成"事件流，返回 spawn 的 argv 列表。 */
function runDone(pluginCfg) {
  globalThis.__SPAWN_CALLS = [];
  const ctx = mkCtx();
  apply(ctx, { idleGate: false, subagents: false, ...pluginCfg });

  const agent = { id: 'agent-1', session: { id: 'sess-1' }, status: 'running' };
  // 触发完成：turn/end(completed) → agent/status idle
  ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  agent.status = 'idle';
  ctx.emit('agent/status', { agent, status: 'running' });
  ctx.emit('agent/status', { agent, status: 'idle' });

  return (globalThis.__SPAWN_CALLS || []).map((c) => (c && (c.args || c.argv)) || []);
}

/** 从 argv 里取出 `-File` 后面的脚本名。 */
function scriptOf(argv) {
  const arr = Array.isArray(argv) ? argv : [];
  const i = arr.indexOf('-File');
  return i >= 0 && arr[i + 1] ? String(arr[i + 1]).replace(/\\/g, '/').split('/').pop() : '';
}

/** 取 `-Flag value`。 */
function argOf(argv, flag) {
  const arr = Array.isArray(argv) ? argv : [];
  const i = arr.indexOf(flag);
  return i >= 0 ? arr[i + 1] : undefined;
}

// ⚠️ skip 必须在**用例执行时**求值，不能在模块加载时算好：const SKIP = ...`n// 会在 import 那一刻定死，而那时代码还没机会说它生效。故写成函数。 
function skipReason() {
  if (!process.env.DSH_ROUTE_LOADER && !stubActive()) return '需 npm run test:route（带 --import loader）';
  if (!stubActive()) return 'loader stub 未生效';
  return false;
}

// ── A1: audioSource=tts 应调 tts-speak.ps1 ────────────────────────────────
test('A1: audioSource=tts 时调用 tts-speak.ps1', { skip: skipReason() }, () => {
  const calls = runDone({ audioSource: 'tts', voice: true, showToast: true });
  const scripts = calls.map(scriptOf);
  assert.ok(scripts.includes('tts-speak.ps1'),
    `应调 TTS，实际脚本: ${JSON.stringify(scripts)}`);

  const tts = calls.find((a) => scriptOf(a) === 'tts-speak.ps1');
  // v0.4.8 起台词从台词库随机取（不再固定一句），所以断言：非空、不含"主人"。
  const ttsText = argOf(tts, '-Text');
  assert.ok(typeof ttsText === 'string' && ttsText.length > 0, 'TTS 台词不应为空');
  assert.doesNotMatch(ttsText, /主人/, 'TTS 台词不应含"主人"');
});

// ── A2: TTS 台词不含"主人" ────────────────────────────────────────────────
test('A2: TTS 台词不含「主人」（用户明确要求去掉）', { skip: skipReason() }, () => {
  const cases = [
    ['completed', '任务完成了'],
    ['error', '任务失败了，抱歉'],
  ];
  for (const [turnKind] of cases) {
    globalThis.__SPAWN_CALLS = [];
    const ctx = mkCtx();
    apply(ctx, { audioSource: 'tts', voice: true, showToast: false, idleGate: false });
    const agent = { id: 'a', session: { id: 's' }, status: 'running' };
    ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: turnKind } } });
    agent.status = 'idle';
    ctx.emit('agent/status', { agent, status: 'running' });
    ctx.emit('agent/status', { agent, status: 'idle' });

    for (const a of (globalThis.__SPAWN_CALLS || []).map((c) => c.args || c.argv || [])) {
      const text = argOf(a, '-Text');
      if (text !== undefined) {
        assert.doesNotMatch(text, /主人/, `台词不该含"主人"，实际: ${text}`);
        assert.ok(text.length > 0, '台词不应为空');
      }
    }
  }
});

// ── A3: showToast=false 时不弹窗 ──────────────────────────────────────────
test('A3: showToast=false 时只出声不弹窗', { skip: skipReason() }, () => {
  const calls = runDone({ audioSource: 'tts', voice: true, showToast: false });
  const notifyCalls = calls.filter((a) => scriptOf(a) === 'dsh-notify.ps1');
  assert.equal(notifyCalls.length, 0,
    `showToast=false 时不该调 dsh-notify.ps1（会弹窗），实际 ${notifyCalls.length} 次`);
  // 但仍应有声音
  assert.ok(calls.some((a) => scriptOf(a) === 'tts-speak.ps1'), '仍应有语音');
});

// ── A4: voice=false 时完全静音 ────────────────────────────────────────────
test('A4: voice=false 时不产生任何声音', { skip: skipReason() }, () => {
  const calls = runDone({ audioSource: 'tts', voice: false, showToast: true });
  assert.equal(calls.filter((a) => scriptOf(a) === 'tts-speak.ps1').length, 0,
    'voice=false 不该调 TTS');
  const notify = calls.find((a) => scriptOf(a) === 'dsh-notify.ps1');
  assert.ok(notify, '仍应弹窗');
  assert.ok(notify.includes('-NoSound'), '弹窗应带 -NoSound');
});

// ── A5: audioSource=none 时不出声但可弹窗 ─────────────────────────────────
test('A5: audioSource=none 时不出声（但可弹窗）', { skip: skipReason() }, () => {
  const calls = runDone({ audioSource: 'none', voice: true, showToast: true });
  assert.equal(calls.filter((a) => scriptOf(a) === 'tts-speak.ps1').length, 0, '不该调 TTS');
  const notify = calls.find((a) => scriptOf(a) === 'dsh-notify.ps1');
  assert.ok(notify, '仍应弹窗');
  assert.ok(notify.includes('-NoSound'), 'none 应静音');
});

// ── A6: audioSource=bundled 时走 notify.ps1 且不出错 ──────────────────────
test('A6: audioSource=bundled 时走 dsh-notify.ps1（语音包）', { skip: skipReason() }, () => {
  const calls = runDone({ audioSource: 'bundled', voice: true, showToast: true });
  assert.equal(calls.filter((a) => scriptOf(a) === 'tts-speak.ps1').length, 0,
    'bundled 不该走 TTS');
  const notify = calls.find((a) => scriptOf(a) === 'dsh-notify.ps1');
  assert.ok(notify, '应调 dsh-notify.ps1');
  assert.ok(!notify.includes('-NoSound'), 'bundled 应出声，不该带 -NoSound');
});

// ── A7: 音量与语速透传到 TTS ─────────────────────────────────────────────
test('A7: 音量与语速透传给 TTS', { skip: skipReason() }, () => {
  const calls = runDone({ audioSource: 'tts', voice: true, showToast: false, volume: 42, ttsRate: -3 });
  const tts = calls.find((a) => scriptOf(a) === 'tts-speak.ps1');
  assert.ok(tts, '应调 TTS');
  assert.equal(argOf(tts, '-Volume'), '42', '音量应透传');
  assert.equal(argOf(tts, '-Rate'), '-3', '语速应透传');
});

// ── A8: 兜底 —— 未配置 audioSource 时默认 TTS ────────────────────────────
test('A8: 未指定 audioSource 时默认走 TTS（零下载也能说话）', { skip: skipReason() }, () => {
  const calls = runDone({ voice: true, showToast: false });   // 不传 audioSource
  assert.ok(calls.some((a) => scriptOf(a) === 'tts-speak.ps1'),
    '默认音源应是 tts');
});

// ── A9-A12: 冷却（v0.4.7）─────────────────────────────────────────────────
//
// 用户 2026-10-17 明确要求："同一会话的冷却我们可以给它关了，
// 甚至可以把不同会话的冷却给它加上。"
//
// 两级冷却语义不同，必须分别验证：
//   同一会话 → 连响多次只播最后一次
//   所有会话 → 响过一次后，别的会话也不播
//
// 注意：这里不假装能测"时间流逝"，用的是"同一毫秒内连续触发"
// —— 只要冷却 > 0，第二次就必然落在窗口内，这正是我们要的行为。

/**
 * 触发两个**不同会话**各完成一次，返回实际发出的播报次数。
 * @param {object} pluginCfg
 */
function runTwoSessions(pluginCfg) {
  globalThis.__SPAWN_CALLS = [];
  const ctx = mkCtx();
  apply(ctx, { idleGate: false, subagents: false, ...pluginCfg });

  const fire = (id, n) => {
    const agent = { id: 'agent-' + n, session: { id }, status: 'running' };
    ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn: n, reason: { kind: 'completed' } } });
    agent.status = 'idle';
    ctx.emit('agent/status', { agent, status: 'running' });
    ctx.emit('agent/status', { agent, status: 'idle' });
  };
  fire('sess-A', 1);
  fire('sess-B', 2);

  return (globalThis.__SPAWN_CALLS || []).map((c) => (c && (c.args || c.argv)) || []);
}

test('A9: 跨会话冷却关闭（默认 0）时，两个会话都播报', { skip: skipReason() }, () => {
  const calls = runTwoSessions({
    audioSource: 'tts', voice: true, showToast: false,
    debounceSeconds: 0, globalCooldownSeconds: 0,
  });
  const tts = calls.filter((a) => scriptOf(a) === 'tts-speak.ps1');
  assert.equal(tts.length, 2, `两个不同会话都应播报，实际 ${tts.length}`);
});

test('A10: 跨会话冷却开启后，第二个会话被抑制', { skip: skipReason() }, () => {
  const calls = runTwoSessions({
    audioSource: 'tts', voice: true, showToast: false,
    debounceSeconds: 0,            // 先排除同会话冷却的干扰
    globalCooldownSeconds: 60,
  });
  const tts = calls.filter((a) => scriptOf(a) === 'tts-speak.ps1');
  assert.equal(tts.length, 1,
    `跨会话冷却应只放行第一次，实际 ${tts.length} 次（第二个会话该被抑制）`);
});

test('A11: 同会话冷却关闭（0）时，同一会话连续完成都播报', { skip: skipReason() }, () => {
  globalThis.__SPAWN_CALLS = [];
  const ctx = mkCtx();
  apply(ctx, {
    idleGate: false, subagents: false,
    audioSource: 'tts', voice: true, showToast: false,
    debounceSeconds: 0, globalCooldownSeconds: 0,
  });

  // 同一会话连触发两次（不同轮次）
  for (const turn of [1, 2]) {
    const agent = { id: 'agent-same', session: { id: 'sess-SAME' }, status: 'running' };
    ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
    agent.status = 'idle';
    ctx.emit('agent/status', { agent, status: 'running' });
    ctx.emit('agent/status', { agent, status: 'idle' });
  }

  const tts = (globalThis.__SPAWN_CALLS || []).map((c) => c.args || c.argv || [])
    .filter((a) => scriptOf(a) === 'tts-speak.ps1');
  assert.equal(tts.length, 2, `debounceSeconds=0 时两次都应播，实际 ${tts.length}`);
});

test('A12: 同会话冷却 > 0 时，连响两次只播一次', { skip: skipReason() }, () => {
  globalThis.__SPAWN_CALLS = [];
  const ctx = mkCtx();
  apply(ctx, {
    idleGate: false, subagents: false,
    audioSource: 'tts', voice: true, showToast: false,
    debounceSeconds: 60, globalCooldownSeconds: 0,
  });

  for (const turn of [1, 2]) {
    const agent = { id: 'agent-same', session: { id: 'sess-SAME2' }, status: 'running' };
    ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
    agent.status = 'idle';
    ctx.emit('agent/status', { agent, status: 'running' });
    ctx.emit('agent/status', { agent, status: 'idle' });
  }

  const tts = (globalThis.__SPAWN_CALLS || []).map((c) => c.args || c.argv || [])
    .filter((a) => scriptOf(a) === 'tts-speak.ps1');
  assert.equal(tts.length, 1, `同会话 60 秒冷却应只播一次，实际 ${tts.length}`);
});
