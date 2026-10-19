/**
 * v0.4.64：锁住 jobs.list 的调用参数。
 *
 * ## 为什么必须单独写这条测试
 *
 * 空闲门（idleGate）从 v0.4.62 起就有一个**静默失效**的 bug：
 *
 *     jobs = js.list(agent)        // ✗ 传了 agent 对象
 *     jobs = js.list(agent?.id)    // ✓ 应传 id 字符串（DSH 官方用法）
 *
 * 参数类型不对 → 服务返回空数组 → `collectInFlight` 永远判定没有在飞工作
 * → 空闲门从不挂起，回合一结束就播报。
 *
 * **原有 20+ 条空闲门单测全部通过**，因为它们是直接给 `collectInFlight`
 * 喂假数据的 —— 绕过了 `jobs.list` 这一层。这正是"测试绿但功能坏"的典型：
 * 测了纯函数，没测调用契约。
 *
 * 所以这条测试不看行为，只看**传参形状**（静态断言源码）。丑，但有效。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = readFileSync(join(ROOT, 'lib/index.js'), 'utf8');

/** 从 inFlightOf 函数体里切片（到下一个同名缩进级 function 为止）。 */
function inFlightBody() {
  const start = INDEX.indexOf('function inFlightOf(agent) {');
  assert.ok(start >= 0, '应能找到 inFlightOf');
  const rest = INDEX.slice(start);
  const end = rest.search(/\n {0,4}(?:function |\/\*\*)/);
  return end > 0 ? rest.slice(0, end) : rest.slice(0, 3000);
}

test('J1: jobs.list 必须传 agent.id，不能传 agent 对象', () => {
  const body = inFlightBody();
  // ✗ 绝不能出现 js.list(agent) —— 参数是对象
  assert.doesNotMatch(body, /js\.list\(\s*agent\s*\)/,
    'jobs.list 收到 agent 对象会返回空数组，导致空闲门永不挂起（v0.4.62 起的真 bug）');
  // ✓ 必须取出 id 再传
  assert.match(body, /const aid = agent && agent\.id/,
    '必须先取 agent.id');
  assert.match(body, /js\.list\(aid\)/,
    '必须用 id 字符串调用 jobs.list');
});

test('J2: 还要查「无 agent 的全局任务」', () => {
  const body = inFlightBody();
  // DSH 官方是 [void 0, ...liveAgents]，插件对应 jobs.list(undefined)
  assert.match(body, /js\.list\(undefined\)/,
    '有些后台任务不属于任何 agent，只查当前 agent 会漏掉它们');
});

test('J3: jobs.list 抛异常时不能把空闲门打挂', () => {
  const body = inFlightBody();
  assert.match(body, /catch\s*\(e\)\s*\{[\s\S]*?jobs\.list failed/,
    '失败要 catch 住并记录，不能冒泡（否则回合一结束就抛错、通知丢失）');
});
