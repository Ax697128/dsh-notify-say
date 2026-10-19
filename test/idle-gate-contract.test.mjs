/**
 * 更新契约测试：`lastTurn` 递增判定已被删除（第 1 批 1.5）。
 *
 * ## 背景
 *
 * 原 K3 断言「必须有 lastTurn > p.lastTurn → 作废」这条规则。
 * 但 2026-10-19 真机实测证伪了它：
 *
 *     20:12:02  [idle-gate] pending dropped: new turn started turn 9->10
 *     （用户什么都没发，是 Agent 处理子任务返回时内部续跑）
 *
 * 按需求约定「不能用间接信号猜测用户输入」，该判定已删除。
 * 所以契约测试要**反过来断言：这个判定必须不存在**（防止有人再加回去）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = readFileSync(join(ROOT, 'lib/index.js'), 'utf8');

function fnBody(sig) {
  const lines = INDEX.split(/\r?\n/);
  const i = lines.findIndex((l) => l.includes(sig));
  assert.ok(i >= 0, '找不到函数: ' + sig);
  const indent = (lines[i].match(/^(\s*)/) || ['', ''])[1];
  let j = -1;
  for (let k = i + 1; k < lines.length; k++) {
    if (lines[k] === indent + '}') { j = k; break; }
  }
  assert.ok(j > i, '找不到函数终点: ' + sig);
  return lines.slice(i, j + 1).join('\n');
}

// ══ 已删除的规则（反断言，防回归）══════════════════════════════════════
test('K3: 不得再用 lastTurn 递增判定「用户新消息」（已实测证伪）', () => {
  const body = fnBody('function reevaluatePending(trigger) {');
  assert.doesNotMatch(body, /tb\.lastTurn\s*>\s*p\.lastTurn/,
    'lastTurn 递增不能当用户输入证据 —— 主 Agent 处理子任务返回时内部续跑也会递增');
});

test('K3b: 不得出现「pending dropped: new turn started」的日志', () => {
  // 该日志随判定一起删除。若它回来，说明有人把误判加回去了。
  assert.doesNotMatch(INDEX, /pending dropped: new turn started/,
    '这条日志对应被证伪的判定，不该存在');
});

// ══ 保留的规则 ═════════════════════════════════════════════════════════
test('K1: 不得因 agent.status === running 就 clearPending', () => {
  const body = fnBody('function reevaluatePending(trigger) {');
  assert.doesNotMatch(body, /agent\.status\s*===\s*'running'\)\s*\{\s*clearPending/,
    '主 Agent 处理子任务返回时也是 running（T3 的规则）');
});

test('K2: agent 拿不到时必须保留（continue），不能 flush', () => {
  const body = fnBody('function reevaluatePending(trigger) {');
  const idx = body.indexOf('if (!agent)');
  assert.ok(idx > 0, '要有 agent 判空');
  const seg = body.slice(idx, idx + 400);
  assert.match(seg, /continue/, 'agent 读不到 ≠ 完成，必须保留（T12）');
  assert.doesNotMatch(seg, /flushPending/, 'agent 读不到时绝不能 flush');
});

test('K4: 轮次还开着（open !== null）→ 保留，不播', () => {
  const body = fnBody('function reevaluatePending(trigger) {');
  assert.match(body, /tb\.open\s*!==\s*null/, '要有"轮次进行中"判定（T3）');
  const idx = body.indexOf('tb.open !== null');
  const seg = body.slice(idx, idx + 200);
  assert.match(seg, /continue/, '轮次开着要继续等');
});

test('K5: 只有工作树为空才 flushPending', () => {
  const body = fnBody('function reevaluatePending(trigger) {');
  assert.match(body, /inflight\.length > 0/, '要有在飞判定（T7）');
  const lastFlush = body.lastIndexOf('flushPending(id)');
  assert.ok(lastFlush > 0, '必须存在最终的 flushPending');
  assert.ok(lastFlush > body.indexOf('inflight.length > 0'),
    'flush 必须在"还有在飞工作"判定之后（先排除才放行）');
});

test('K6: 超时走 onIdleGateTimeout（进度提醒），不直接消耗完成通知', () => {
  // 定时器必须指向 onIdleGateTimeout
  assert.match(INDEX, /setTimeout\(\(\) => \{ try \{ onIdleGateTimeout\(id\); \}/,
    '超时定时器必须走进度提醒路径');

  const body = fnBody('function onIdleGateTimeout(id) {');
  assert.match(body, /progressNotified/, '进度提醒最多一次');
  assert.match(body, /这不是完成提醒/, '文案必须明确否定"完成"');
  // 关键：进度提醒路径不能 delete pending
  const progressBranch = body.slice(body.indexOf('if (!p.progressNotified)'), body.indexOf('recheckTimer'));
  assert.doesNotMatch(progressBranch, /pendingDone\.delete/,
    '进度提醒**不得**消耗 pending —— 真正完成时还要再播一次');
});

test('K7: flushPending 不再接受 viaTimeout 参数（职责已拆分）', () => {
  const body = fnBody('function flushPending(id) {');
  assert.doesNotMatch(body, /viaTimeout/,
    'viaTimeout 已拆到 onIdleGateTimeout，flushPending 只管"真完成"');
  assert.match(body, /worktree-idle/, 'flush 的 reason 固定是 worktree-idle');
});

test('K8: turnBoundaryOf 读不到要返回 null', () => {
  const body = fnBody('function turnBoundaryOf(session) {');
  assert.match(body, /catch/, '必须自己兜异常');
  assert.match(body, /return null/, '失败返回 null');
  assert.match(body, /openTurnStartSeq/, '要读 openTurnStartSeq');
});

test('K9: 对齐官方 hasDesktopActiveTasks —— 要查 inbox 排队', () => {
  const body = fnBody('function inFlightOf(agent) {');
  assert.match(body, /inbox/, '官方还会查 agent.inbox.nextTurn / nextStep（防"刚播完成又开始干"）');
  assert.match(body, /nextTurn/, '要查 nextTurn');
  assert.match(body, /nextStep/, '要查 nextStep');
});

test('K10: inbox 读不到时不能判定"有活"（防永远不播）', () => {
  const body = fnBody('function inFlightOf(agent) {');
  const idx = body.indexOf('inbox');
  assert.ok(idx > 0);
  // 该段必须包在 try/catch 里，且注释说明"读不到不算有活"
  const seg = body.slice(Math.max(0, idx - 400), idx + 800);
  assert.match(seg, /catch/, 'inbox 读取要兜异常');
});

// ══ 互斥（2026-10-19 真机抓到重复播报）══════════════════════════════════
test('K11: emitDone 必须有事件级互斥（同一 evKey 只播一次）', () => {
  const body = fnBody('function emitDone(session, psKind, title, body, evKey) {');
  assert.match(body, /lastEmittedKey/, '要有事件级去重表');
  assert.match(body, /seen === evKey/, '同一 evKey 要拦下');
  assert.match(body, /duplicate-event/, '拦下时要留痕');
});

test('K12: 两条播报路径必须用同一个 evKey（同一轮互斥）', () => {
  // scheduleOrNotify 生成的 evKey
  const sched = fnBody('function scheduleOrNotify(session, agent, psKind, title, body) {');
  assert.match(sched, /const evKey = tbNow \?/, 'scheduleOrNotify 要生成 evKey');
  assert.match(sched, /emitDone\(session, psKind, title, body, evKey\)/, '直接播报要带 evKey');
  assert.match(sched, /evKey,/, 'pending 要存 evKey');

  // flushPending 用 pending 里存的 evKey
  const flush = fnBody('function flushPending(id) {');
  assert.match(flush, /p\.evKey/, 'flush 要用 pending 里的 evKey');
});