/**
 * dsh-notify-desktop 空闲门（idle gate）单元测试。
 *
 * 覆盖 v0.3.0 引入的三个纯函数与关键判定：
 *  - reasonKindOf：turn/end 的 reason.kind 取值（对象 / 字符串 / 缺失）
 *  - isDescendantOf：子代理后代判定（含 sessions.fork 分叉会话**不得**误判为后代）
 *  - collectInFlight：两路在飞工作汇总（jobs + agents），缺一不可
 *
 * 为什么这些断言是 exact 而非宽松：判定协议（空闲门）的语义漂移会让"误报完成"
 * 这个原始缺陷复发，而宽松断言会把漂移伪装成绿灯。故每条都断言精确结果。
 *
 * 运行：node --test tools/plugins/dsh-notify-desktop/test/idle-gate.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reasonKindOf, isDescendantOf, collectInFlight } from '../lib/index.js';

/** 造一个最小 agent 替身（只含判定用到的字段）。 */
function mkAgent(id, { origin, parentSession, status = 'idle' } = {}) {
  return {
    id,
    status,
    session: { id, header: { id, origin, parentSession } },
  };
}

// ── reasonKindOf ─────────────────────────────────────────────────────────
test('reasonKindOf: 对象形态取 kind', () => {
  assert.equal(reasonKindOf({ reason: { kind: 'completed' } }), 'completed');
  assert.equal(reasonKindOf({ reason: { kind: 'error' } }), 'error');
  assert.equal(reasonKindOf({ reason: { kind: 'aborted' } }), 'aborted');
});

test('reasonKindOf: 字符串形态向前兼容', () => {
  assert.equal(reasonKindOf({ reason: 'completed' }), 'completed');
});

test('reasonKindOf: 缺失/畸形一律空串（不抛）', () => {
  assert.equal(reasonKindOf(undefined), '');
  assert.equal(reasonKindOf({}), '');
  assert.equal(reasonKindOf({ reason: {} }), '');
  assert.equal(reasonKindOf({ reason: null }), '');
});

// ── isDescendantOf：子代理后代判定 ────────────────────────────────────────
test('isDescendantOf: 直接子代理（origin=subagent, parentSession=root）→ true', () => {
  const root = mkAgent('root-1');
  const child = mkAgent('child-1', { origin: 'subagent', parentSession: 'root-1' });
  const byId = new Map([['root-1', root], ['child-1', child]]);
  assert.equal(isDescendantOf(child, 'root-1', byId), true);
});

test('isDescendantOf: 孙代子代理（多跳）→ true', () => {
  const root = mkAgent('root-1');
  const child = mkAgent('child-1', { origin: 'subagent', parentSession: 'root-1' });
  const grand = mkAgent('grand-1', { origin: 'subagent', parentSession: 'child-1' });
  const byId = new Map([['root-1', root], ['child-1', child], ['grand-1', grand]]);
  assert.equal(isDescendantOf(grand, 'root-1', byId), true);
});

test('isDescendantOf: 分叉会话（有 parentSession 但 origin 为空）→ false', () => {
  // 这是关键负例：sessions.fork 的分叉会话 header 也带 parentSession，
  // 但它是用户自己的顶层会话。误判为后代会让主会话完成通知被拖住。
  const root = mkAgent('root-1');
  const forked = mkAgent('fork-1', { parentSession: 'root-1' });
  const byId = new Map([['root-1', root], ['fork-1', forked]]);
  assert.equal(isDescendantOf(forked, 'root-1', byId), false);
});

test('isDescendantOf: 无关顶层会话 → false', () => {
  const other = mkAgent('other-1');
  const byId = new Map([['other-1', other]]);
  assert.equal(isDescendantOf(other, 'root-1', byId), false);
});

test('isDescendantOf: 链上祖先已不在注册表 → false（不臆断）', () => {
  const child = mkAgent('child-1', { origin: 'subagent', parentSession: 'gone-1' });
  const byId = new Map([['child-1', child]]);
  assert.equal(isDescendantOf(child, 'root-1', byId), false);
});

test('isDescendantOf: 畸形输入不抛，返回 false', () => {
  assert.equal(isDescendantOf(null, 'root-1', new Map()), false);
  assert.equal(isDescendantOf({}, 'root-1', new Map()), false);
  assert.equal(isDescendantOf(mkAgent('x'), 'root-1', null), false);
});

// ── collectInFlight：两路在飞汇总 ─────────────────────────────────────────
test('collectInFlight: 全部空闲 → 空数组（可播报）', () => {
  const root = mkAgent('root-1');
  assert.deepEqual(collectInFlight([], [root], 'root-1'), []);
});

test('collectInFlight: running 的后台任务算在飞', () => {
  const root = mkAgent('root-1');
  const jobs = [{ id: 'bash-1', label: 'sleep 100', status: 'running' }];
  const items = collectInFlight(jobs, [root], 'root-1');
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'job');
  assert.equal(items[0].id, 'bash-1');
});

test('collectInFlight: stopping 也算在飞（尚未真正停止）', () => {
  const root = mkAgent('root-1');
  const jobs = [{ id: 'bash-2', label: 'x', status: 'stopping' }];
  assert.equal(collectInFlight(jobs, [root], 'root-1').length, 1);
});

test('collectInFlight: 终态任务不算在飞', () => {
  const root = mkAgent('root-1');
  for (const status of ['completed', 'killed', 'failed']) {
    const jobs = [{ id: 'bash-3', label: 'x', status }];
    assert.equal(collectInFlight(jobs, [root], 'root-1').length, 0, `status=${status} 不应算在飞`);
  }
});

test('collectInFlight: continuable 子代理不注册 job，只能靠 agents 一路发现', () => {
  // 关键正例：这是本缺陷最容易漏掉的一路。
  // dsh-base/cordis.patch.yml:354 的 subagent 工具默认 backgroundMode=continuable，
  // 走 ctx.agents.create({parentAgent})，**不经过 jobs.start**。
  const root = mkAgent('root-1', { status: 'idle' });
  const child = mkAgent('child-1', { origin: 'subagent', parentSession: 'root-1', status: 'running' });
  const items = collectInFlight([], [root, child], 'root-1');
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'subagent');
  assert.equal(items[0].id, 'child-1');
});

test('collectInFlight: 子代理已 idle 不算在飞', () => {
  const root = mkAgent('root-1');
  const child = mkAgent('child-1', { origin: 'subagent', parentSession: 'root-1', status: 'idle' });
  assert.deepEqual(collectInFlight([], [root, child], 'root-1'), []);
});

test('collectInFlight: 主会话自身 running 不算"在飞子工作"', () => {
  // 主会话正在跑是正常状态，不该被当作"需要等待的子工作"（否则永不播报）。
  const root = mkAgent('root-1', { status: 'running' });
  assert.deepEqual(collectInFlight([], [root], 'root-1'), []);
});

test('collectInFlight: 无关顶层会话 running 不影响本会话判定', () => {
  const root = mkAgent('root-1');
  const other = mkAgent('other-1', { status: 'running' });
  assert.deepEqual(collectInFlight([], [root, other], 'root-1'), []);
});

test('collectInFlight: 分叉会话 running 不影响本会话判定（负例）', () => {
  const root = mkAgent('root-1');
  const forked = mkAgent('fork-1', { parentSession: 'root-1', status: 'running' });
  assert.deepEqual(collectInFlight([], [root, forked], 'root-1'), []);
});

test('collectInFlight: 两路同时有在飞 → 都报出来', () => {
  const root = mkAgent('root-1');
  const child = mkAgent('child-1', { origin: 'subagent', parentSession: 'root-1', status: 'running' });
  const jobs = [{ id: 'bash-9', label: 'y', status: 'running' }];
  const items = collectInFlight(jobs, [root, child], 'root-1');
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.kind).sort(), ['job', 'subagent']);
});

test('collectInFlight: 畸形输入退化为空（fail-visible：宁可播报不静默）', () => {
  assert.deepEqual(collectInFlight(null, null, 'root-1'), []);
  assert.deepEqual(collectInFlight(undefined, undefined, 'root-1'), []);
  assert.deepEqual(collectInFlight([null, undefined], [null, undefined], 'root-1'), []);
});
