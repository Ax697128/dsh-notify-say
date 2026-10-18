/**
 * session-jump 测试：四种「跳转时机」组合的穷举验证。
 *
 * 这块的价值全在**不误跳**：跳错了会盖掉用户正在看的会话、抢走他自己点开的对话。
 *
 * 用户 2026-10-17 明确要求做成**两个独立开关**，因为他发现不同人诉求相反：
 *   - 有人想"后台完成→回来就跳"
 *   - 有人**故意不跳**，想自己回来按绿点逐个确认
 *   - 有人希望"前台完成也跳，让我看一眼"
 * 所以实现不该替用户选，而要把四种组合都支持。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideJump, JUMP_DECISIONS, DEFAULT_JUMP, isHidden, createLeaveTracker,
} from '../lib/session-jump.js';

const T0 = 1790000000000;

/** 后台完成：用户先离开（T0-1000），通知后到（T0）。 */
function bg(over) {
  return {
    jumpWhenBackground: true,
    jumpWhenForeground: false,
    consumed: false,
    sessionId: 'sess-1',
    notifiedAt: T0,
    leftAt: T0 - 1000,
    ...over,
  };
}

/** 前台完成：通知先到（T0-5000），用户后离开（T0）。 */
function fg(over) {
  return {
    jumpWhenBackground: true,
    jumpWhenForeground: false,
    consumed: false,
    sessionId: 'sess-1',
    notifiedAt: T0 - 5000,
    leftAt: T0,
    ...over,
  };
}

// ── J1: 组合①（默认）后台跳、前台不跳 ─────────────────────────────────────
test('J1: 组合① 后台→跳 / 前台→不跳（默认）', () => {
  const b = decideJump(bg());
  assert.equal(b.jump, true);
  assert.equal(b.phase, 'background');

  const f = decideJump(fg());
  assert.equal(f.jump, false);
  assert.equal(f.decision, JUMP_DECISIONS.SKIP_FOREGROUND);
  assert.equal(f.phase, 'foreground');

  // 默认值本身也要对
  assert.equal(DEFAULT_JUMP.jumpWhenBackground, true);
  assert.equal(DEFAULT_JUMP.jumpWhenForeground, false);
});

// ── J2: 组合② 都跳 ────────────────────────────────────────────────────────
test('J2: 组合② 后台和前台都跳', () => {
  const o = { jumpWhenBackground: true, jumpWhenForeground: true };
  assert.equal(decideJump(bg(o)).jump, true);
  const f = decideJump(fg(o));
  assert.equal(f.jump, true);
  assert.equal(f.phase, 'foreground');
});

// ── J3: 组合③ 只前台跳 ────────────────────────────────────────────────────
test('J3: 组合③ 只前台跳（少见但允许）', () => {
  const o = { jumpWhenBackground: false, jumpWhenForeground: true };
  const b = decideJump(bg(o));
  assert.equal(b.jump, false);
  assert.equal(b.decision, JUMP_DECISIONS.SKIP_BACKGROUND);

  assert.equal(decideJump(fg(o)).jump, true);
});

// ── J4: 组合④ 都不跳 ──────────────────────────────────────────────────────
test('J4: 组合④ 都不跳（想自己按绿点确认的人）', () => {
  const o = { jumpWhenBackground: false, jumpWhenForeground: false };
  const b = decideJump(bg(o));
  const f = decideJump(fg(o));
  assert.equal(b.jump, false);
  assert.equal(f.jump, false);
  assert.equal(b.decision, JUMP_DECISIONS.SKIP_DISABLED);
  assert.equal(f.decision, JUMP_DECISIONS.SKIP_DISABLED);
});

// ── J5: 10 分钟后回来仍然跳（不设时效）────────────────────────────────────
test('J5: 隔很久才回来看，仍然跳（结果还没看过）', () => {
  const tenMin = 10 * 60 * 1000;
  assert.equal(decideJump(bg({ leftAt: T0 - tenMin })).jump, true);
  const oneHour = 60 * 60 * 1000;
  assert.equal(decideJump(bg({ leftAt: T0 - oneHour })).jump, true);
});

// ── J6: 缺省参数按默认语义 ────────────────────────────────────────────────
test('J6: 不传开关时按默认（后台跳、前台不跳）', () => {
  const b = decideJump({ consumed: false, sessionId: 's', notifiedAt: T0, leftAt: T0 - 1 });
  assert.equal(b.jump, true, '未指定开关时默认后台跳');
  const f = decideJump({ consumed: false, sessionId: 's', notifiedAt: T0 - 10, leftAt: T0 });
  assert.equal(f.jump, false, '未指定开关时默认前台不跳');
});

// ── J7: 无待跳转 / 已消费 ─────────────────────────────────────────────────
test('J7: 没有待跳转会话、或已消费时都不跳（防重复）', () => {
  assert.equal(decideJump(bg({ sessionId: '' })).decision, JUMP_DECISIONS.SKIP_NO_PENDING);
  assert.equal(decideJump(bg({ sessionId: undefined })).jump, false);
  assert.equal(decideJump(bg({ consumed: true })).decision, JUMP_DECISIONS.SKIP_CONSUMED);
});

// ── J8: 不知道何时离开 → 保守不跳 ─────────────────────────────────────────
test('J8: 无法得知用户何时离开时不跳（宁可漏跳，不可乱跳）', () => {
  assert.equal(decideJump(bg({ leftAt: 0 })).decision, JUMP_DECISIONS.SKIP_UNKNOWN_LEFT);
  assert.equal(decideJump(bg({ leftAt: undefined })).jump, false);
  assert.equal(decideJump(bg({ leftAt: NaN })).jump, false);
});

// ── J9: 边界 —— 通知与离开同一毫秒 ───────────────────────────────────────
test('J9: 通知时刻 == 离开时刻 视为后台（>=）', () => {
  const r = decideJump(bg({ notifiedAt: T0, leftAt: T0 }));
  assert.equal(r.jump, true);
  assert.equal(r.phase, 'background');
});

// ── J10: 异常输入不崩 ────────────────────────────────────────────────────
test('J10: 空/异常输入一律安全返回不跳', () => {
  assert.doesNotThrow(() => decideJump());
  assert.doesNotThrow(() => decideJump(null));
  assert.doesNotThrow(() => decideJump({}));
  assert.equal(decideJump(undefined).jump, false);
  assert.equal(decideJump({}).jump, false);
});

// ── J11: isHidden 归一 ───────────────────────────────────────────────────
test('J11: isHidden 兼容多种文档形态', () => {
  assert.equal(isHidden({ visibilityState: 'hidden' }), true);
  assert.equal(isHidden({ visibilityState: 'visible' }), false);
  assert.equal(isHidden({ hidden: true }), true);
  assert.equal(isHidden({ hidden: false }), false);
  assert.equal(isHidden(null), true);
  assert.equal(isHidden({}), false);
});

// ── J12: leaveTracker 只在"变为隐藏"的边沿记录 ──────────────────────────
test('J12: leaveTracker 记录离开时刻，且不重复刷新', () => {
  const tr = createLeaveTracker();
  tr.onVisibility({ visibilityState: 'visible' }, T0);
  assert.equal(tr.leftAt(), 0, '一直可见时没有离开时刻');

  tr.onVisibility({ visibilityState: 'hidden' }, T0 + 1000);
  assert.equal(tr.leftAt(), T0 + 1000);

  tr.onVisibility({ visibilityState: 'hidden' }, T0 + 2000);
  assert.equal(tr.leftAt(), T0 + 1000, '持续隐藏不应刷新');

  tr.onVisibility({ visibilityState: 'visible' }, T0 + 3000);
  assert.equal(tr.leftAt(), T0 + 1000, '回来后保留');

  tr.onVisibility({ visibilityState: 'hidden' }, T0 + 9000);
  assert.equal(tr.leftAt(), T0 + 9000, '再次离开要刷新');

  tr.reset();
  assert.equal(tr.leftAt(), 0, 'reset 后清零');
});

// ── J13: 端到端 —— 后台完成 → 回来 → 跳 ──────────────────────────────────
test('J13: 端到端时序：离开 → 通知 → 回来 → 跳', () => {
  const tr = createLeaveTracker();
  tr.onVisibility({ visibilityState: 'hidden' }, T0);
  const notifiedAt = T0 + 5000;
  tr.onVisibility({ visibilityState: 'visible' }, T0 + 6000);

  const r = decideJump({
    jumpWhenBackground: true, jumpWhenForeground: false,
    consumed: false, sessionId: 'sess-x',
    notifiedAt, leftAt: tr.leftAt(),
  });
  assert.equal(r.jump, true);
  assert.equal(r.phase, 'background');
});

// ── J14: 端到端 —— 前台完成 → 看过后离开再回来 → 不跳 ──────────────────────
test('J14: 端到端时序：前台完成 → 离开再回来 → 默认不跳', () => {
  const tr = createLeaveTracker();
  tr.onVisibility({ visibilityState: 'visible' }, T0);
  const notifiedAt = T0 + 1000;
  tr.onVisibility({ visibilityState: 'hidden' }, T0 + 3000);
  tr.onVisibility({ visibilityState: 'visible' }, T0 + 5000);

  const r = decideJump({
    jumpWhenBackground: true, jumpWhenForeground: false,
    consumed: false, sessionId: 'sess-y',
    notifiedAt, leftAt: tr.leftAt(),
  });
  assert.equal(r.jump, false);
  assert.equal(r.phase, 'foreground');
  assert.equal(r.decision, JUMP_DECISIONS.SKIP_FOREGROUND);
});

// ── J15: 回归 —— "离开过一次"不能让前台判定永久失效 ────────────────────────
// 独立审查 2026-10-17 指出的严重缺陷：第一版只记 leftAt（离开时刻），
// 于是用户离开过一次之后，leftAt 永远是旧值，此后任何通知都满足
// notifiedAt >= leftAt → 被判成"后台完成" → 在用户眼前强行跳转。
// 修法：同时记 returnedAt，用区间 [leftAt, returnedAt) 判定。
test('J15: 离开过一次后回来的通知，不应被判成后台（关键回归）', () => {
  const tr = createLeaveTracker();
  // 用户在 T0 离开
  tr.onVisibility({ visibilityState: 'hidden' }, 1000);
  // 在 T0+5000 回来
  tr.onVisibility({ visibilityState: 'visible' }, 5000);
  // 回来后、正看着时，T0+9000 来了新通知
  const r = decideJump({
    jumpWhenBackground: true,
    jumpWhenForeground: false,     // 默认：前台不跳
    consumed: false,
    sessionId: 's',
    notifiedAt: 9000,
    leftAt: tr.leftAt(),           // = 1000
    returnedAt: tr.returnedAt(),   // = 5000
  });
  assert.equal(r.phase, 'foreground', '通知在回来之后到达，属于前台');
  assert.equal(r.jump, false, '前台不该跳 —— 第一版在这里会误跳');
});

// ── J16: 离开期间到达的通知仍然算后台 ─────────────────────────────────────
test('J16: 离开期间到达的通知仍判为后台', () => {
  const tr = createLeaveTracker();
  tr.onVisibility({ visibilityState: 'hidden' }, 1000);
  tr.onVisibility({ visibilityState: 'visible' }, 9000);
  const r = decideJump({
    jumpWhenBackground: true,
    jumpWhenForeground: false,
    consumed: false,
    sessionId: 's',
    notifiedAt: 5000,              // 在 1000..9000 之间
    leftAt: tr.leftAt(),
    returnedAt: tr.returnedAt(),
  });
  assert.equal(r.phase, 'background');
  assert.equal(r.jump, true);
});

// ── J17: tracker 正确记录回归时刻 ─────────────────────────────────────────
test('J17: leaveTracker 记录 returnedAt，并在再次离开时清掉', () => {
  const tr = createLeaveTracker();
  tr.onVisibility({ visibilityState: 'visible' }, 0);
  assert.equal(tr.returnedAt(), 0, '从未离开过 → 没有回归时刻');

  tr.onVisibility({ visibilityState: 'hidden' }, 1000);
  assert.equal(tr.returnedAt(), 0, '离开后还没回来');

  tr.onVisibility({ visibilityState: 'visible' }, 5000);
  assert.equal(tr.returnedAt(), 5000, '回来时记录时刻');

  tr.onVisibility({ visibilityState: 'hidden' }, 8000);
  assert.equal(tr.returnedAt(), 0, '再次离开要把旧的回来说明作废');

  tr.reset();
  assert.equal(tr.leftAt(), 0);
  assert.equal(tr.returnedAt(), 0);
});
