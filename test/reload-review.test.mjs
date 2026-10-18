/**
 * 外部审阅（2026-10-18 第二轮）6 项修复的回归测试。
 *
 * 这些断言都是**审阅指出的具体缺陷**，每条对应一个真实后果：
 *   X1 钩子没 await  → 新入口在钩子装好前被导入，依赖仍是旧的
 *   X2 diskFingerprint 未使用 → "验证通过"不等于"加载了磁盘那份"
 *   X3 清理失败仍注册 → 两个实例同时持有监听（通知重复）
 *   X4 漏报文案过度声称 → 排查时被误导
 *   X5 监听整个目录 → 改文档也触发注定失败的重载
 *   X6 busted/verified 没返回 → 日志永远显示不出来
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DR = readFileSync(join(ROOT, 'lib', 'dev-reload.js'), 'utf8');
const IDX = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8');

/** 去掉注释，避免把注释里的说明当成代码。 */
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── X1: 代际依赖钩子必须 await ──────────────────────────────────────────
test('X1: enableFreshDependencies 调用必须 await（否则依赖仍是旧的）', () => {
  const c = code(DR);
  const hits = [...c.matchAll(/enableFreshDependencies\s*\(/g)];

  assert.ok(hits.length > 0, '应有调用点');

  for (const m of hits) {
    // 定义处（export async function ...）不算调用
    const before = c.slice(Math.max(0, m.index - 40), m.index);
    if (/function\s+$/.test(before)) continue;

    assert.match(before, /await\s+$/,
      'enableFreshDependencies 必须被 await —— 它要等 import("node:module") '
      + '拿到 registerHooks 才算装好；不 await 的话新入口会在钩子装好前导入，'
      + '依赖仍是旧的（这正是热重载要解决的问题）');
  }
});

// ── X1b: 并发调用要等同一个 Promise，不能因为占位就返回 ────────────────
test('X1b: 并发调用 enableFreshDependencies 不会拿到半装好的状态', () => {
  const c = code(DR);

  // 反例：先 set(..., null) 占位，然后 has() 就 return
  //   if (reloadHooks.has(packageUrl)) return;
  //   reloadHooks.set(packageUrl, null);
  const badPattern = /if\s*\(\s*reloadHooks\.has\([^)]*\)\s*\)\s*return\s*;/;
  assert.doesNotMatch(c, badPattern,
    '不能"有 key 就直接 return" —— 那会让第二个并发调用在钩子还没装好时返回');

  // 正确形态：Map 里存 pending Promise，后来者 await 它
  assert.match(c, /\.pending/,
    'reloadHooks 应存正在进行的 Promise（pending），后来者等同一个 Promise');
});

// ── X2: diskFingerprint 必须真的被用来校验 ──────────────────────────────
test('X2: diskFingerprint 传入后要作为期望指纹参与校验', () => {
  const c = code(DR);

  assert.match(c, /options\.diskFingerprint/,
    'dev-reload 必须读取 options.diskFingerprint —— '
    + '调用方算好了传进来却不用，「验证通过」就不等于「加载了磁盘那份代码」');

  // 它要被喂给 verifyReload 的 expectedFingerprint
  const at = c.indexOf('verifyReload({');
  assert.ok(at > 0);
  const seg = c.slice(at, at + 400);
  assert.match(seg, /expectedFingerprint:/, '应传 expectedFingerprint');
});

// ── X2b: 调用方要真的把 diskFingerprint 传下去 ─────────────────────────
test('X2b: index.js 把 diskFingerprint 传给 selfReload', () => {
  assert.match(IDX, /diskFingerprint\s*,?\s*$/m,
    'index.js 应把算好的磁盘指纹传进 selfReload');
  const at = IDX.indexOf('selfReload(ctx');
  assert.ok(at > 0);
  const seg = IDX.slice(at, at + 500);
  assert.match(seg, /diskFingerprint/, '参数里要有 diskFingerprint');
});

// ── X3: 旧实例没停干净时不得继续注册 ───────────────────────────────────
test('X3: dispose 失败且 fiber 仍活时必须返回失败', () => {
  const c = code(DR);

  assert.match(c, /dispose-incomplete/,
    '清理失败且 fiber 仍活时，应返回结构化失败（dispose-incomplete），'
    + '而不是继续注册新实例 —— 否则两个实例同时持有监听，表现为"通知响两次"');
});

// ── X4: 漏报计数器的文案不能过度声称 ───────────────────────────────────
test('X4: 事件计数日志如实说明「非漏报数」', () => {
  // 计数器只在 session/event 回调里 +1：
  //   · 重载期间没有监听器 → 事件没被观察到，missed=0（漏检）
  //   · 旧/新实例正常处理了 → 计数增加但通知已发出（误报）
  // 所以它只能叫"观察到的事件数"，不能说"漏报数"。
  assert.match(IDX, /非漏报数/,
    '日志文案必须说明这个数字不是漏报数量 —— 否则排查时会被误导');

  assert.doesNotMatch(IDX, /对应播报可能已丢失/,
    '不能声称"播报已丢失"—— 计数器证明不了这件事');
});

// ── X5: 监听要有源码过滤 ────────────────────────────────────────────────
test('X5: 只有源码变更才触发重载', () => {
  const c = code(DR);

  assert.match(c, /isSourceFile/,
    '应有源码文件过滤 —— 否则改文档/测试也会触发一次注定失败的重载');

  // 过滤要覆盖指纹的同样范围：package.json + lib/*.js
  const at = c.indexOf('isSourceFile');
  const seg = c.slice(at, at + 600);
  assert.match(seg, /package\.json/, '应包含 package.json');
  assert.match(seg, /lib\//, '应包含 lib/ 目录');
  assert.match(seg, /\.js/, '应限定 .js');
});

// ── X6: 成功返回值要带 busted / verified ────────────────────────────────
test('X6: selfReload 成功时返回 busted 与 verified', () => {
  const c = code(DR);

  const at = c.indexOf('return { ok: true, fibers:');
  assert.ok(at > 0, '应能找到成功返回');
  const seg = c.slice(at, at + 200);

  assert.match(seg, /busted/, '要返回 busted —— 否则调用方无法显示"走了代际绕过"');
  assert.match(seg, /verified/, '要返回 verified —— 否则调用方无法显示"指纹校验通过"');

  // 反例：引用 try 块内部的 verdict（会 ReferenceError）
  assert.doesNotMatch(seg, /verdict\.checked/,
    '不能在返回语句里直接引用 verdict —— 它定义在 try 块内，'
    + '到这里已出作用域（S1 实测报过 "verdict is not defined"）');
});

// ── X7: watcher 必须可观测（区分"没触发"与"触发了但失败"）──────────────
test('X7: watcher 的注册与事件都写进 notify.log', () => {
  // 2026-10-18 我因为看错时间基准（把重启前的日志当成重启后），
  // 误判热重载"还是坏的"。真正的教训是：
  // **没有可观测信号时，只能靠猜。**
  //
  // 现在 watcher 起来会写 `[watch] watching <目录>`，
  // 收到事件会写 `[watch] event <文件> accepted=<bool>`。
  // 这样"没触发"和"触发了但失败"一眼可分。
  assert.match(DR, /opts\.diag\?\.\('watching '/,
    '应能观测到 watcher 注册成功');
  assert.match(DR, /opts\.diag\?\.\('event '/,
    '应能观测到收到文件事件（含是否被源码过滤接受）');

  // diag 必须接到真正的日志文件，而不是只进 console
  assert.match(IDX, /diag:\s*\([^)]*\)\s*=>\s*appendNotifyLog/,
    'diag 必须写进 notify.log —— 只进 console 的话我们看不到');
  assert.match(IDX, /\[watch\]/,
    '日志前缀应是 [watch]');
});