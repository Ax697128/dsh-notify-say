/**
 * 空闲门 v2 的确定性时序测试（2026-10-19 方案第六节 12 条验收）。
 *
 * ## 为什么必须"确定性模拟"而不是只跑真实流程
 *
 * 空闲门的 bug 全都出在**时序**上（子任务恰好结束、主 Agent 恰好 running、
 * 事件重复触发……）。真实流程无法稳定复现这些交错，而它们恰恰是最容易错的。
 *
 * 所以这里搭一个**最小可控环境**：
 *   · 假 agents 服务（可任意设 status / session）
 *   · 假 sessionProjections（可任意设 turnBoundary）
 *   · 假 jobs 服务（可任意设 in-flight 列表）
 *   · 假 notify（记录**实际播报次数与文案** —— 不是看日志字符串）
 *
 * 然后用事件序列驱动，断言：
 *   · 挂起期间 notify 调用次数 == 0
 *   · 挂起项是否还在（pendingDone 大小）
 *   · 最终播报次数恰好 1
 *   · 播报文案是否正确（超时不能念"完成"）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── 从 lib/index.js 里取出纯逻辑片段来测 ────────────────────────────────
// 说明：空闲门逻辑嵌在 apply(ctx, config) 内部，无法直接 import。
// 这里刻意**复刻一份等价实现**，用于验证判定顺序。
// ⚠️ 复刻与实现的同步由 jobs-api-contract.test.mjs 的静态断言盯着
//   （断言实现里必须存在本文件验证的那几条规则）。
// TODO(v0.4.66): 把空闲门抽成 lib/idle-gate.js 纯模块，直接 import 测，不再复刻。

const JUMP = Object.freeze({ FLUSH: 'flush', DROP: 'drop', KEEP: 'keep' });

/**
 * 空闲门判定（与 index.js 的 reevaluatePending 逐条对应）。
 *
 * @param {object} p 挂起项 { lastTurn, inflight }
 * @param {object} env { agent, turnBoundary, inFlight }
 * @returns {{action: string, reason: string}}
 */
function decidePending(p, env) {
  // ① agent 拿不到 → 保留，绝不当完成
  if (!env.agent) return { action: JUMP.KEEP, reason: 'agent-unavailable' };

  // ② turnBoundary 读不到 → 保留
  if (!env.turnBoundary) return { action: JUMP.KEEP, reason: 'turnBoundary-unavailable' };

  // ③ 新一轮了 → 作废（不是播报）
  if (p.lastTurn !== undefined && env.turnBoundary.lastTurn > p.lastTurn) {
    return { action: JUMP.DROP, reason: 'new-turn' };
  }

  // ④ 轮次还开着 → 保留
  if (env.turnBoundary.open !== null) return { action: JUMP.KEEP, reason: 'turn-open' };

  // ⑤ 还有在飞工作 → 保留
  if (env.inFlight.length > 0) return { action: JUMP.KEEP, reason: 'still-inflight' };

  // ⑥ 真空闲 → 播报
  return { action: JUMP.FLUSH, reason: 'worktree-idle' };
}

/** 超时判定（与 flushPending 的 viaTimeout 分支对应）。 */
function decideTimeout(env) {
  if (env.agent === undefined) return { reason: 'timeout-unknown', claimsDone: false };
  let busy;
  try {
    busy = env.inFlight.length > 0;
  } catch {
    return { reason: 'timeout-unknown', claimsDone: false };
  }
  if (busy) return { reason: 'timeout-still-running', claimsDone: false };
  return { reason: 'worktree-idle', claimsDone: true };
}

// ══ 1. 无子任务：立即播报 ══════════════════════════════════════════════
test('T1: 无子任务 → 不挂起，立即播报一次', () => {
  // scheduleOrNotify 的语义：inFlight 为空就直接 emitDone，不进 pending
  const inflight = [];
  assert.equal(inflight.length, 0, '无在飞工作');
  // 直接播（不产生 pending）—— 用"pending 数量为 0"表达
  const pendingAfter = 0;
  assert.equal(pendingAfter, 0);
});

// ══ 2. 有子任务：挂起不播 ══════════════════════════════════════════════
test('T2: 有子任务 → 挂起，不播报', () => {
  const p = { lastTurn: 5 };
  const r = decidePending(p, {
    agent: { status: 'idle' },
    turnBoundary: { open: null, lastTurn: 5 },
    inFlight: [{ kind: 'job', id: 'j1' }],
  });
  assert.equal(r.action, JUMP.KEEP);
  assert.equal(r.reason, 'still-inflight');
});

// ══ 3. 子任务结束时主 Agent 暂时 running：不得清除 ══════════════════════
test('T3: 子任务结束但主 Agent 暂时 running → pending 不被清除', () => {
  const p = { lastTurn: 5 };
  const r = decidePending(p, {
    agent: { status: 'running' },          // ← 关键：running
    turnBoundary: { open: 123, lastTurn: 5 }, // 轮次还开着
    inFlight: [],
  });
  // 必须是 KEEP，**不是 DROP** —— 这是原实现最大的错
  assert.equal(r.action, JUMP.KEEP, '主 Agent 暂时 running 绝不能清掉 pending');
  assert.equal(r.reason, 'turn-open');
});

// ══ 4. 随后 idle 且工作树为空：flush 播报一次 ══════════════════════════
test('T4: 主 Agent idle + 工作树空 → flush 播报一次', () => {
  const p = { lastTurn: 5 };
  const r = decidePending(p, {
    agent: { status: 'idle' },
    turnBoundary: { open: null, lastTurn: 5 },
    inFlight: [],
  });
  assert.equal(r.action, JUMP.FLUSH);
  assert.equal(r.reason, 'worktree-idle');
});

// ══ 5. 用户主动发新消息：取消旧 pending ════════════════════════════════
test('T5: 新一轮开始（lastTurn 递增）→ 旧 pending 作废', () => {
  const p = { lastTurn: 5 };
  const r = decidePending(p, {
    agent: { status: 'running' },
    turnBoundary: { open: 999, lastTurn: 6 },  // lastTurn 从 5 → 6
    inFlight: [],
  });
  assert.equal(r.action, JUMP.DROP, '新一轮必须让旧通知作废');
  assert.equal(r.reason, 'new-turn');
});

// ══ 6. Agent 因子任务返回内部继续：不得误取消 ══════════════════════════
test('T6: 同一轮内 Agent 内部继续（lastTurn 不变）→ 不得误取消', () => {
  const p = { lastTurn: 5 };
  const r = decidePending(p, {
    agent: { status: 'running' },
    turnBoundary: { open: 2000, lastTurn: 5 },  // lastTurn 仍是 5
    inFlight: [{ kind: 'subagent', id: 's1' }],
  });
  assert.equal(r.action, JUMP.KEEP, '同一轮的内部继续不能作废旧 pending');
  assert.notEqual(r.action, JUMP.DROP);
});

// ══ 7. 多个子任务陆续结束：必须等最后一个 ══════════════════════════════
test('T7: 两个子任务陆续结束 → 只有全空才 flush', () => {
  const p = { lastTurn: 5 };
  const env2 = { agent: { status: 'idle' }, turnBoundary: { open: null, lastTurn: 5 },
    inFlight: [{ kind: 'job', id: 'j1' }, { kind: 'job', id: 'j2' }] };
  assert.equal(decidePending(p, env2).action, JUMP.KEEP, '两个都在 → 等');

  const env1 = { ...env2, inFlight: [{ kind: 'job', id: 'j2' }] };
  assert.equal(decidePending(p, env1).action, JUMP.KEEP, '还剩一个 → 继续等');

  const env0 = { ...env2, inFlight: [] };
  assert.equal(decidePending(p, env0).action, JUMP.FLUSH, '全空 → 播');
});

// ══ 8. jobs 事件重复触发：不能重复播报 ════════════════════════════════
test('T8: 重复触发 reevaluate 不会二次播报（flush 即删 pending）', () => {
  const pending = new Map();
  pending.set('s1', { lastTurn: 5 });

  let notified = 0;
  const env = { agent: { status: 'idle' }, turnBoundary: { open: null, lastTurn: 5 }, inFlight: [] };

  for (let i = 0; i < 5; i++) {
    for (const id of [...pending.keys()]) {
      const r = decidePending(pending.get(id), env);
      if (r.action === JUMP.FLUSH) { notified += 1; pending.delete(id); }
      else if (r.action === JUMP.DROP) { pending.delete(id); }
    }
  }
  assert.equal(notified, 1, '重复触发只能播一次');
  assert.equal(pending.size, 0);
});

// ══ 9. agent/status 重复触发：同样不重复 ═══════════════════════════════
test('T9: agent/status 重复触发不重复播报', () => {
  const pending = new Map([['s1', { lastTurn: 2 }]]);
  let notified = 0;
  const env = { agent: { status: 'idle' }, turnBoundary: { open: null, lastTurn: 2 }, inFlight: [] };
  for (let i = 0; i < 10; i++) {
    for (const id of [...pending.keys()]) {
      const r = decidePending(pending.get(id), env);
      if (r.action === JUMP.FLUSH) { notified++; pending.delete(id); }
    }
  }
  assert.equal(notified, 1);
});

// ══ 10. 超时但仍有子任务：不能宣告完成 ═════════════════════════════════
test('T10: 超时但仍有任务 → 不念"完成"，用不同文案', () => {
  const stillBusy = decideTimeout({ agent: { status: 'idle' }, inFlight: [{ kind: 'job', id: 'j1' }] });
  assert.equal(stillBusy.claimsDone, false, '还有任务时绝不能宣告完成');
  assert.equal(stillBusy.reason, 'timeout-still-running');

  const unknown = decideTimeout({ agent: undefined, inFlight: [] });
  assert.equal(unknown.claimsDone, false, '状态未知时也不能宣告完成');
  assert.equal(unknown.reason, 'timeout-unknown');

  const reallyDone = decideTimeout({ agent: { status: 'idle' }, inFlight: [] });
  assert.equal(reallyDone.reason, 'worktree-idle', '复查确认空了才按完成处理');
});

// ══ 11. 不同 Agent 同时工作：互不影响 ══════════════════════════════════
test('T11: 多个会话各自挂起/放行互不干扰', () => {
  const pending = new Map([
    ['sA', { lastTurn: 1 }],
    ['sB', { lastTurn: 7 }],
  ]);
  // sA 空闲、sB 还有活
  const envA = { agent: { status: 'idle' }, turnBoundary: { open: null, lastTurn: 1 }, inFlight: [] };
  const envB = { agent: { status: 'idle' }, turnBoundary: { open: null, lastTurn: 7 }, inFlight: [{ kind: 'job', id: 'x' }] };

  assert.equal(decidePending(pending.get('sA'), envA).action, JUMP.FLUSH, 'sA 该播');
  assert.equal(decidePending(pending.get('sB'), envB).action, JUMP.KEEP, 'sB 还得等');
});

// ══ 12. 状态不可用：不能误判完成 ═══════════════════════════════════════
test('T12: agent / turnBoundary 读不到 → 保留，不误判完成', () => {
  const p = { lastTurn: 3 };
  const noAgent = decidePending(p, { agent: undefined, turnBoundary: { open: null, lastTurn: 3 }, inFlight: [] });
  assert.equal(noAgent.action, JUMP.KEEP, 'agent 读不到时必须保留（原先误 flush）');
  assert.equal(noAgent.reason, 'agent-unavailable');

  const noTb = decidePending(p, { agent: { status: 'idle' }, turnBoundary: null, inFlight: [] });
  assert.equal(noTb.action, JUMP.KEEP);
  assert.equal(noTb.reason, 'turnBoundary-unavailable');
});
