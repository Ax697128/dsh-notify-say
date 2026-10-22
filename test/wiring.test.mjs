/**
 * dsh-notify-say 空闲门「事件接线」集成测试。
 *
 * 与 idle-gate.test.mjs 的分工：那边测**纯函数**的判定逻辑；这边测 apply() 的
 * **事件接线与挂起状态机**——即"主会话 idle 时若有子代理在跑，到底有没有挂起"。
 *
 * 安全性：本测试把 `process.env.SystemRoot` 指向不存在的路径，使插件解析出的
 * POWERSHELL_EXE 无效 → spawn 只会异步 emit 'error'（不启动任何进程、不播声音）。
 * 测试的观测量是插件的 console 日志（挂起/未挂起），不是 Toast 本身。
 *
 * 运行：node --test tools/plugins/dsh-notify-say/test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
// ⚠️ 必须在 import lib/index.js **之前**把 DSH_HOME 指到空目录。
//
// 插件启动时会读 `$DSH_HOME/storages/dsh-notify-say/config.json` 作为
// 「运行时覆盖层」，其优先级**高于** apply() 传入的 config。若用真实 DSH_HOME，
// 用户只要在 GUI 里改过任何一项（实测：把 notifyOnAborted 打开），
// 那些假定默认值的用例就会红——那是用户配置导致的，不是代码缺陷。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'notify-test-home-'));
process.env.DSH_HOME = ISOLATED_HOME;
process.on('exit', () => { try { rmSync(ISOLATED_HOME, { recursive: true, force: true }); } catch { /* best effort */ } });

// 必须在 import 插件之前设置：插件在模块顶层读 SystemRoot 计算 POWERSHELL_EXE。
process.env.SystemRoot = 'Z:\\__no_such_root__';

// ⚠️ 显式关闭注册表访问（v0.5.0 起必须）。
//
// 上面那个 SystemRoot 桩**不足以**当保护：它只是让 powershell.exe 路径失效，
// 属于"顺带没删成"，不是约定。而 v0.5.0 给 apply() 增加了
// `cleanupLegacyProtocols()`（会 Remove-Item 历史 dshnotify 键）——
// 一旦这个桩被改动、或 POWERSHELL_EXE 改成走 PATH 查找，
// 跑测试就会删掉用户机器上真实的协议注册。
//
// DSH_NOTIFY_NO_REGISTRY=1 是插件里所有注册表读写（probe / register /
// unregister / cleanup）共同的守卫，这里显式写上，不依赖副作用。
process.env.DSH_NOTIFY_NO_REGISTRY = '1';

const { apply } = await import('../lib/index.js');

/**
 * 造一个最小 ctx 替身：捕获事件处理器，记录 effect/dispose。
 * @param {{ jobs?: any, agents?: any }} services - 要注入的宿主服务。
 */
function mkCtx(services = {}) {
  const handlers = new Map();
  const effects = [];
  return {
    handlers,
    effects,
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
    },
    get(name) {
      return services[name];
    },
    effect(fn) {
      const d = fn();
      effects.push(d);
      return () => { if (typeof d === 'function') d(); };
    },
    /** 触发某事件的全部处理器。 */
    emit(name, ...args) {
      for (const fn of handlers.get(name) || []) fn(...args);
    },
  };
}

/** 造一个最小 agent 替身。 */
function mkAgent(id, { origin, parentSession, status = 'idle' } = {}) {
  return { id, status, session: { id, header: { id, origin, parentSession } } };
}

/** 捕获插件日志（挂起路径会打 'idle-gate: 挂起完成播报'）。 */
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

/** 等待若干轮微任务/定时器，让异步 spawn 的 error 事件落地。 */
function settle() {
  return new Promise((r) => setTimeout(r, 20));
}

test('接线：apply() 注册了 session/event、agent/status、approval/request 三个处理器', () => {
  const ctx = mkCtx();
  apply(ctx, {});
  assert.ok(ctx.handlers.has('session/event'), '应注册 session/event');
  assert.ok(ctx.handlers.has('agent/status'), '应注册 agent/status');
  assert.ok(ctx.handlers.has('approval/request'), '应注册 approval/request');
});

test('接线：jobs 服务存在时订阅 onJobsChanged（并挂进 effect）', () => {
  let subscribed = false;
  const ctx = mkCtx({
    jobs: { list: () => [], onJobsChanged: () => { subscribed = true; return () => {}; } },
  });
  apply(ctx, {});
  assert.equal(subscribed, true, '应调用 jobs.onJobsChanged');
  assert.ok(ctx.effects.length > 0, '应通过 ctx.effect 注册');
});

// ── 核心场景：主会话 idle 时子代理仍在跑 → 必须挂起，不立即播报 ─────────────
test('空闲门：主会话 idle 但 continuable 子代理 running → 挂起（不立即播报）', () => {
  const main = mkAgent('main-1', { status: 'running' });
  const child = mkAgent('child-1', { origin: 'subagent', parentSession: 'main-1', status: 'running' });
  const ctx = mkCtx({ agents: { list: () => [main, child], get: (id) => (id === 'main-1' ? main : undefined) } });

  const logs = captureLogs();
  try {
    apply(ctx, { idleGate: true });
    // 主会话这一轮结束：turn/end completed
    ctx.emit('session/event', main.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    // 主会话进入 idle（running→idle 边沿）
    main.status = 'idle';
    ctx.emit('agent/status', { agent: main, status: 'running' });
    ctx.emit('agent/status', { agent: main, status: 'idle' });
    assert.match(logs.text, /idle-gate: 挂起完成播报/, '有子代理在跑时应挂起');
  } finally {
    logs.restore();
  }
});

test('空闲门：子代理结束后重估 → 兑现播报（挂起被清）', () => {
  const main = mkAgent('main-1', { status: 'idle' });
  const child = mkAgent('child-1', { origin: 'subagent', parentSession: 'main-1', status: 'running' });
  const ctx = mkCtx({ agents: { list: () => [main, child], get: (id) => (id === 'main-1' ? main : undefined) } });

  const logs = captureLogs();
  try {
    apply(ctx, { idleGate: true });
    ctx.emit('session/event', main.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    ctx.emit('agent/status', { agent: main, status: 'running' });
    ctx.emit('agent/status', { agent: main, status: 'idle' });
    assert.match(logs.text, /idle-gate: 挂起完成播报/, '前置：应先挂起');

    // 子代理跑完 → 状态变化触发重估
    child.status = 'idle';
    ctx.emit('agent/status', { agent: child, status: 'idle' });
    // 兑现路径不打挂起日志；用"再次重估不再有挂起"间接确认已清
    const before = logs.lines.length;
    ctx.emit('agent/status', { agent: child, status: 'idle' });
    assert.equal(logs.lines.length, before, '挂起已兑现后不应再产生新的挂起日志');
  } finally {
    logs.restore();
  }
});

test('空闲门：无子代理/后台任务时**不**挂起（立即播报路径）', () => {
  const main = mkAgent('main-1', { status: 'running' });
  const ctx = mkCtx({ agents: { list: () => [main], get: () => main } });

  const logs = captureLogs();
  try {
    apply(ctx, { idleGate: true });
    ctx.emit('session/event', main.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    main.status = 'idle';
    ctx.emit('agent/status', { agent: main, status: 'running' });
    ctx.emit('agent/status', { agent: main, status: 'idle' });
    assert.doesNotMatch(logs.text, /idle-gate: 挂起完成播报/, '空闲时不应挂起');
  } finally {
    logs.restore();
  }
});

test('空闲门：后台 job running 也触发挂起（jobs 一路）', () => {
  const main = mkAgent('main-1', { status: 'running' });
  const ctx = mkCtx({
    agents: { list: () => [main], get: () => main },
    jobs: { list: () => [{ id: 'bash-1', label: 'sleep', status: 'running' }], onJobsChanged: () => () => {} },
  });

  const logs = captureLogs();
  try {
    apply(ctx, { idleGate: true });
    ctx.emit('session/event', main.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    main.status = 'idle';
    ctx.emit('agent/status', { agent: main, status: 'running' });
    ctx.emit('agent/status', { agent: main, status: 'idle' });
    assert.match(logs.text, /idle-gate: 挂起完成播报/, '有后台 job 在跑时应挂起');
  } finally {
    logs.restore();
  }
});

test('空闲门：idleGate=false 时完全不过门（回归开关可用）', () => {
  const main = mkAgent('main-1', { status: 'running' });
  const child = mkAgent('child-1', { origin: 'subagent', parentSession: 'main-1', status: 'running' });
  const ctx = mkCtx({ agents: { list: () => [main, child], get: () => main } });

  const logs = captureLogs();
  try {
    apply(ctx, { idleGate: false });
    ctx.emit('session/event', main.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    main.status = 'idle';
    ctx.emit('agent/status', { agent: main, status: 'running' });
    ctx.emit('agent/status', { agent: main, status: 'idle' });
    assert.doesNotMatch(logs.text, /idle-gate: 挂起完成播报/, 'idleGate=false 时应照旧立即播报');
  } finally {
    logs.restore();
  }
});

test('空闲门：error 分支不过门（有子代理在跑也立即播报）', () => {
  const main = mkAgent('main-1', { status: 'running' });
  const child = mkAgent('child-1', { origin: 'subagent', parentSession: 'main-1', status: 'running' });
  const ctx = mkCtx({ agents: { list: () => [main, child], get: () => main } });

  const logs = captureLogs();
  try {
    apply(ctx, { idleGate: true });
    ctx.emit('session/event', main.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } });
    main.status = 'idle';
    ctx.emit('agent/status', { agent: main, status: 'running' });
    ctx.emit('agent/status', { agent: main, status: 'idle' });
    assert.doesNotMatch(logs.text, /idle-gate: 挂起完成播报/, 'error 需立即介入，不应被挂起');
  } finally {
    logs.restore();
  }
});

test('空闲门：子代理自身的完成不播报（subagents=false 默认过滤仍生效）', () => {
  const child = mkAgent('child-1', { origin: 'subagent', parentSession: 'main-1', status: 'running' });
  const ctx = mkCtx({ agents: { list: () => [child], get: () => undefined } });

  const logs = captureLogs();
  try {
    apply(ctx, { idleGate: true, subagents: false });
    ctx.emit('session/event', child.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    child.status = 'idle';
    ctx.emit('agent/status', { agent: child, status: 'running' });
    ctx.emit('agent/status', { agent: child, status: 'idle' });
    assert.doesNotMatch(logs.text, /idle-gate: 挂起完成播报/, '子代理自身完成不应触发主会话播报');
  } finally {
    logs.restore();
  }
});

test('空闲门：宿主服务全部缺失时退化为立即播报（fail-visible，不静默）', async () => {
  const main = mkAgent('main-1', { status: 'running' });
  const ctx = mkCtx(); // 无 jobs、无 agents

  const logs = captureLogs();
  try {
    apply(ctx, { idleGate: true });
    ctx.emit('session/event', main.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    main.status = 'idle';
    ctx.emit('agent/status', { agent: main, status: 'running' });
    ctx.emit('agent/status', { agent: main, status: 'idle' });
    assert.doesNotMatch(logs.text, /idle-gate: 挂起完成播报/, '服务不可读时应退化为立即播报（宁可多报不静默）');
  } finally {
    logs.restore();
  }
  await settle();
});

test('空闲门：jobs.list 抛异常时不崩、退化为立即播报', () => {
  const main = mkAgent('main-1', { status: 'running' });
  const ctx = mkCtx({
    agents: { list: () => [main], get: () => main },
    jobs: { list: () => { throw new Error('boom'); }, onJobsChanged: () => () => {} },
  });

  const logs = captureLogs();
  try {
    apply(ctx, { idleGate: true });
    ctx.emit('session/event', main.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    main.status = 'idle';
    ctx.emit('agent/status', { agent: main, status: 'running' });
    ctx.emit('agent/status', { agent: main, status: 'idle' });
    assert.match(logs.text, /jobs\.list failed/, '应记录 jobs.list 失败');
    assert.doesNotMatch(logs.text, /idle-gate: 挂起完成播报/, '读取失败应退化为立即播报');
  } finally {
    logs.restore();
  }
});

test('审批 waterfall：始终 next() 放行并透传返回值（绝不阻断）', () => {
  const ctx = mkCtx();
  apply(ctx, {});
  const handler = (ctx.handlers.get('approval/request') || [])[0];
  assert.ok(handler, '应有 approval/request 处理器');
  const sentinel = { decision: 'allow' };
  const got = handler({ agent: mkAgent('main-1'), toolName: 'pwsh' }, () => sentinel);
  assert.equal(got, sentinel, '必须透传 next() 的返回值');
});
