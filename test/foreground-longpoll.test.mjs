/**
 * v0.4.63：前台长轮询（/wait）、单条确认（/ack）与客户端环境判据。
 *
 * ## 为什么这些断言值得写
 *
 * 这轮改动踩到两个**只有跑起来才会暴露**的坑，都必须锁住：
 *
 *   ① `/wait` 的 25 秒兜底定时器没有 unref → 一个挂着的请求会吊住
 *      整个 Node 进程不退出（`npm test` 跑了 10 分钟不止）。
 *   ② 客户端在挂载时无条件启动轮询 → `client-bundle.test.mjs` 真实执行
 *      factory 时发出了真 fetch + 无限 setTimeout → 同样卡死。
 *
 * 这两条都不是"逻辑写错"，而是**生命周期没管住**，静态读代码很难发现。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE = readFileSync(join(ROOT, 'lib/session-bridge.js'), 'utf8');
const CLIENT = readFileSync(join(ROOT, 'lib/client.js'), 'utf8');
const INDEX = readFileSync(join(ROOT, 'lib/index.js'), 'utf8');

// ══ W1-W3：/wait 的生命周期 ═════════════════════════════════════════════
test('W1: /wait 的兜底定时器必须 unref（否则吊住进程）', () => {
  assert.match(BRIDGE, /WAIT_TIMEOUT_MS/, '必须有超时常量');
  // 从**使用处**（setTimeout 那一行）切片，不能从常量定义处切 ——
  // 常量在文件上方，切片会落空。
  const i = BRIDGE.indexOf('setTimeout(() => settleWaiter(w, 204), WAIT_TIMEOUT_MS)');
  assert.ok(i > 0, '应能找到挂起定时器');
  const seg = BRIDGE.slice(i, i + 500);
  assert.match(seg, /typeof t\.unref === 'function'/, '必须显式 unref');
});

test('W2: 客户端断开时要摘掉挂起项（防死引用堆积）', () => {
  assert.match(BRIDGE, /res\.once\('close', \(\) => settleWaiter\(w, 204\)\)/,
    '必须监听 close 并结算 waiter —— 否则刷新/关页面会留下永远不结束的响应');
});

test('W3: 插件卸载时结束所有挂起响应', () => {
  assert.match(BRIDGE, /function disposeAllWaiters\(\)/, 'bridge 要提供 disposeAllWaiters');
  assert.match(BRIDGE, /disposeAllWaiters \};|disposeAllWaiters\b.*return/, '必须导出');
  assert.match(INDEX, /bridge\.disposeAllWaiters\(\)/,
    'index.js 的卸载清理里必须调用 —— 否则热重载后旧连接永远等不到响应');
});

// ══ W4-W5：/ack 只摘一条 ════════════════════════════════════════════════
test('W4: /ack 只移除指定会话，不清空队列', () => {
  const seg = BRIDGE.slice(BRIDGE.indexOf("if (isAck)"), BRIDGE.indexOf("if (isWait)"));
  assert.match(seg, /pending\.filter\(\(e\) => e\.sessionId !== sid\)/,
    '必须只过滤掉那一条；像 /consume 那样整体清空会让你切回来时丢掉其余的');
  assert.doesNotMatch(seg, /pending = \[\];/, 'ack 不得清空整个队列');
});

test('W5: /ack 是写操作（要进 isWriteRoute，否则绕过 Origin 检查）', () => {
  assert.match(INDEX, /\|\| head === 'ack'/, '/ack 会改队列，必须按写操作做来源检查');
});

// ══ W6-W7：客户端的运行前提 ═════════════════════════════════════════════
test('W6: 非浏览器环境不得启动轮询（含 node --test 直接执行 factory）', () => {
  assert.match(CLIENT, /function canPollForeground\(\)/, '必须有环境判据');
  const seg = CLIENT.slice(CLIENT.indexOf('function canPollForeground()'), CLIENT.indexOf('function startForegroundPoll'));
  assert.match(seg, /typeof document === 'undefined'/, '要检查 document');
  assert.match(seg, /typeof fetch !== 'function'/, '要检查 fetch');
  assert.match(seg, /typeof AbortController !== 'function'/, '要检查 AbortController（长轮询要能中止）');
  assert.match(CLIENT, /if \(!canPollForeground\(\)\) return/,
    'startForegroundPoll 必须先过这道判据，否则测试里会发真请求');
});

test('W7: 循环有代际校验（stop 之后不能再发请求）', () => {
  assert.match(CLIENT, /var myGen = pollGen/, '要记录代际');
  const n = (CLIENT.match(/myGen !== pollGen/g) || []).length;
  assert.ok(n >= 3, '至少三处代际校验（入口/返回后/失败后），实际 ' + n);
  assert.match(CLIENT, /pollGen \+= 1/, 'stop 时递增代际');
});

// ══ W8-W9：配置缓存与生效 ═══════════════════════════════════════════════
test('W8: 轮询不每轮打 /config（用缓存）', () => {
  assert.match(CLIENT, /var enCache = null/, '要有配置缓存');
  assert.match(CLIENT, /var ready = enCache \? Promise\.resolve\(enCache\) : refreshJumpConfig\(\)/,
    '有缓存就用缓存，不能每轮都发 /config');
});

test('W9: 开关关着时定时探活，打开后无需刷新页面', () => {
  assert.match(CLIENT, /IDLE_RECHECK_MS/, '要有探活间隔');
  const seg = CLIENT.slice(CLIENT.indexOf('if (!en || !en.jumpWhenForeground)'), CLIENT.indexOf('var hidden =', CLIENT.indexOf('if (!en || !en.jumpWhenForeground)')));
  assert.match(seg, /setTimeout/, '关着时必须定时回来看，不能直接 return 掉');
  assert.match(CLIENT, /dsh-notify-say:config-changed/,
    'GUI 保存后要广播事件作废缓存，否则改了开关要刷新页面才生效');
});

// ══ W10：前后台两条路径不重复跳 ═════════════════════════════════════════
test('W10: 前台跳转后 ack，避免切回来再跳一次', () => {
  const seg = CLIENT.slice(CLIENT.indexOf('if (doc && doc.sessionId)'), CLIENT.indexOf('if (doc && doc.sessionId)') + 700);
  assert.match(seg, /ackSession\(doc\.sessionId\)/, '前台跳完必须 ack');
  assert.match(seg, /at > lastSeenAt/, '要靠 at 去重，同一条不能反复跳');
  assert.match(seg, /lastSeenAt = at/, '跳过后要推进 lastSeenAt');
});
