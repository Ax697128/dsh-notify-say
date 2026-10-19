/**
 * v0.4.62：Toast 标题 / 第三行 / 多会话跳转规则 / 队列。
 *
 * 背景（用户 2026-10-19 的决定）：
 *   ① Toast 标题改成会话标题（sessionProjections 的 title 投影），
 *      因为点 Toast 跳不到指定会话（dsh://open 是固定串），
 *      至少让标题告诉用户"是哪个会话完成了"。
 *   ② 第三行放项目名，但只在标题里没包含它时才给。
 *   ③ 多会话跳转规则做成可选，默认 earliest。
 *
 * 这些断言的价值：三者都是"看着对但很容易悄悄做错"的地方 ——
 * 标题拿不到时的兜底、第三行的去重条件、队列的排序与去重语义。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = readFileSync(join(ROOT, 'lib/index.js'), 'utf8');
const CLIENT = readFileSync(join(ROOT, 'lib/client.js'), 'utf8');
const BRIDGE = readFileSync(join(ROOT, 'lib/session-bridge.js'), 'utf8');
const PS1 = readFileSync(join(ROOT, 'dsh-notify.ps1'), 'utf8');
const SCHEMA = readFileSync(join(ROOT, 'lib/config-schema.js'), 'utf8');

function grab(src, start, end) {
  const i = src.indexOf(start);
  assert.ok(i >= 0, '切片起点缺失: ' + start);
  // 终点：从起点之后找下一个「同缩进或更浅的 function 声明」或指定锚点
  const rest = src.slice(i + start.length);
  const m = rest.search(/\n {0,4}(?:function |\/\*\*)/);
  const j = m >= 0 ? i + start.length + m : -1;
  if (j <= i) { const k = src.indexOf(end, i); assert.ok(k > i, '切片终点缺失: ' + start); return src.slice(i, k); }
  return src.slice(i, j);
}

// ══ T1-T3：会话标题读取 ═════════════════════════════════════════════════
test('T1: 用 sessionProjections 的 title 投影读会话标题', () => {
  const fn = grab(INDEX, 'function sessionTitleOf(session) {', '\n  }\n');
  assert.match(fn, /svc\('sessionProjections'\)/, '必须取 sessionProjections 服务');
  assert.match(fn, /stateOf\(session, 'title'\)/, '必须读 title 投影');
});

test('T2: 标题三级兜底 —— 服务挂了也要有结果，绝不抛出', () => {
  const fn = grab(INDEX, 'function sessionTitleOf(session) {', '\n  }\n');
  // 三级来源都要在本函数体内（① sessionTitle ② sessionProjections ③ id 前缀）
  assert.match(fn, /svc\('sessionTitle'\)/, '① 先用 sessionTitle 服务');
  assert.match(fn, /svc\('sessionProjections'\)/, '② 再用 title 投影');
  assert.match(fn, /sessionKey\(session\)/, '③ 最后退回会话 id');
  assert.match(fn, /try\s*\{[\s\S]*?catch\s*\{/, '每一级都要自己兜异常');
  assert.doesNotMatch(fn, /^\s*throw /m, '任何路径都不该抛出');
});

test('T3: stateOf 的两种返回形状都要兼容（字符串 / {val}）', () => {
  const fn = grab(INDEX, 'function sessionTitleOf(session) {', '\n  }\n');
  assert.match(fn, /typeof v === 'string'/, '要兼容直接返回字符串');
  assert.match(fn, /v\.val/, '要兼容返回 { ver, seq, val } 行');
});

// ══ T4-T6：Toast 第三行 ═════════════════════════════════════════════════
test('T4: 项目名取 cwd 最后一段', () => {
  const fn = grab(INDEX, 'function projectNameOf(session) {', '\n  }\n');
  assert.match(fn, /session\.header\.cwd/, '从 header.cwd 取');
  assert.match(fn, /split\(\/\[\\\\\/\]\+\/\)/, '要同时兼容 \\ 和 /');
  assert.match(fn, /parts\[parts\.length - 1\]/, '取最后一段');
});

test('T5: 标题里已包含项目名时不给第三行（防重复）', () => {
  assert.match(
    INDEX,
    /if \(detail && String\(title \|\| ''\)\.toLowerCase\(\)\.includes\(detail\.toLowerCase\(\)\)\) detail = ''/,
    '去重条件必须存在且不区分大小写',
  );
});

test('T6: ps1 模板按需加第三行 —— 空 Detail 不加 <text>', () => {
  assert.match(PS1, /\[string\]\$Detail = "",/, '必须有 -Detail 参数且默认空');
  assert.match(PS1, /if \(\$Detail -ne ""\) \{ \$detailXml = "<text>"/, '空值不能加 <text>');
  assert.match(PS1, /\$bodyXml<\/text>\$detailXml<\/binding>/, '模板要接上 detailXml');
});

// ══ T7-T9：队列语义 ═════════════════════════════════════════════════════
test('T7: session-bridge 已从单槽改为队列', () => {
  assert.match(BRIDGE, /let pending = \[\];/, '必须是数组');
  assert.doesNotMatch(BRIDGE, /let last = null;/, '旧的单槽必须消失');
});

test('T8: 同一会话重复完成不刷新 at（否则"最早"语义失效）', () => {
  assert.match(BRIDGE, /if \(pending\.some\(\(e\) => e\.sessionId === sid\)\) return;/, '必须按会话去重');
  const fn = grab(BRIDGE, 'function setLast(sessionId, now) {', '\n  }\n');
  assert.match(fn, /pending\.sort\(\(a, b\) => a\.at - b\.at\)/, '必须按 at 升序');
});

test('T9: consume 取走整个队列并清空，同时保留旧字段', () => {
  assert.match(BRIDGE, /const taken = pending;/, '要整体取走');
  assert.match(BRIDGE, /pending = \[\];/, '取走即清空');
  assert.match(BRIDGE, /sessions: taken, sessionId: taken\[0\]\.sessionId, at: taken\[0\]\.at/, '顶层要保留旧字段给老客户端');
});

// ══ T10-T12：规则选择 ═══════════════════════════════════════════════════
test('T10: pickJumpTarget 规则 + 单会话不受规则影响', () => {
  const fn = grab(CLIENT, 'function pickJumpTarget(list, rule) {', '\n    }\n');
  assert.match(fn, /if \(list\.length === 1\) return list\[0\]/, '单会话必须直接返回它');
  assert.match(fn, /if \(rule === 'none'\) return null/, 'none 返回 null');
  assert.match(fn, /if \(rule === 'latest'\) return sorted\[sorted\.length - 1\]/, 'latest 取末尾');
  assert.match(fn, /return sorted\[0\]/, 'earliest 取最早（也是 clicked 没命中时的兜底）');
});

test('T11: 默认规则是 clicked（点哪个跳哪个）', () => {
  // v0.4.70：默认从 earliest 改为 clicked —— 多会话时用户点的是具体某个 Toast，
  // 按时间排序猜必然猜错。clicked 用 Toast 自带的 session id，精确。
  assert.match(SCHEMA, /multiJumpRule: 'clicked'/, 'FIELD_DEFAULTS 必须是 clicked');
  // ⚠️ schemastery 没有 z.enum，必须是 union+const（踩坑：z.enum 直接 TypeError）
  assert.match(SCHEMA, /\.union\(\[z\.const\('clicked'\), z\.const\('earliest'\), z\.const\('latest'\), z\.const\('none'\)\]\)/, '四值用 union+const');
  assert.doesNotMatch(SCHEMA, /z\.enum\(/, 'schemastery 不支持 z.enum');
  assert.match(CLIENT, /var curRule = typeof v\.multiJumpRule === 'string' \? v\.multiJumpRule : 'clicked'/, 'GUI 兜底也得是 clicked');
});

test('T11b: clicked 必须排在选项第一位（默认项）', () => {
  const m = CLIENT.match(/var JUMP_RULES = \[([\s\S]*?)\]/);
  assert.ok(m, '要有 JUMP_RULES');
  assert.match(m[1], /\['clicked'/, 'clicked 要出现在选项里');
  // 第一位 = 默认选中项
  const first = m[1].match(/\['([a-z]+)'/);
  assert.equal(first[1], 'clicked', 'clicked 必须在第一位');
});

test('T12: 客户端能同时吃新队列和旧单条响应', () => {
  assert.match(CLIENT, /if \(doc\.sessions && doc\.sessions\.length\)/, '优先读新字段');
  assert.match(CLIENT, /else if \(typeof doc\.sessionId === 'string' && doc\.sessionId\)/, '旧形状也要吃');
});

// ══ T13：配置透传链路 ══════════════════════════════════════════════════
test('T13: multiJumpRule 在 schema/store/index 三处白名单与透传都在', () => {
  const store = readFileSync(join(ROOT, 'lib/config-store.js'), 'utf8');
  for (const [name, src] of [['config-store', store], ['index', INDEX]]) {
    assert.match(src, /jumpWhenForeground', 'multiJumpRule'/, name + ' 白名单');
  }
  assert.match(store, /multiJumpRule: cfg\.multiJumpRule,/, 'config-store 透传');
  assert.match(INDEX, /multiJumpRule: g\.multiJumpRule,/, 'effectiveForClient 透传');
});

// ══ v0.4.71：前台点 Toast 也要跳 ════════════════════════════════════════
test('T14: 必须有 tryTopJump（不依赖 visibilitychange）', () => {
  // 用户 2026-10-19 指出：窗口一直在前台时点 Toast，visibilitychange 不触发，
  // 于是跳不过去。而"在前台点 Toast 直接过去看结果"恰恰是最省事的用法。
  assert.match(CLIENT, /function tryTopJump\(\)/, '要有前台跳转入口');
  const m = CLIENT.match(/function tryTopJump\(\)([\s\S]{0,900})/);
  assert.ok(m, '能读到函数体');
  assert.match(m[1], /fetchPendingJump\(\)/, '要读 pending-jump');
  assert.match(m[1], /openSession\(/, '要真的跳');
  assert.match(m[1], /lastTopJumpCheck/, '要有节流，避免 focus 抖动打爆请求');
});

test('T15: focus 与 mousedown 监听都要注册且要能移除', () => {
  assert.match(CLIENT, /addEventListener\('focus', tryTopJump\)/, 'window focus 要监听');
  assert.match(CLIENT, /addEventListener\('mousedown', tryTopJump/, 'document mousedown 要监听');
  // 闭环：卸载时必须移除，否则热重载会叠监听
  assert.match(CLIENT, /removeEventListener\('focus', tryTopJump\)/, '卸载要移除 focus');
  assert.match(CLIENT, /removeEventListener\('mousedown', tryTopJump\)/, '卸载要移除 mousedown');
});

test('T16: 前台跳转必须有 120 秒过期保护', () => {
  const m = CLIENT.match(/function tryTopJump\(\)([\s\S]{0,900})/);
  assert.ok(m);
  assert.match(m[1], /120000/, '超过 120 秒的点击不该跳（避免久等后突然跳走）');
});