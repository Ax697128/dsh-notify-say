/**
 * HTTP 路由防护测试（v0.4.24）。
 *
 * ## 背景：这不是理论风险，是实测出来的
 *
 * 2026-10-18 实测：
 *   GET  /api                        → 401  宿主有鉴权
 *   POST /api/dsh-notify-say/config/set（**不带任何凭据**）→ 200，配置真的被改
 *
 * 也就是说插件通过 `webServer.register()` 注册的路由**绕过了宿主鉴权**。
 * 恶意网页可以用 `<img>` / 自动提交的 `<form>` 打到 127.0.0.1 上，
 * 这类"简单请求"不触发 CORS 预检，所以浏览器不会拦。
 *
 * ## 本测试锁住什么
 *
 * 1. 防护函数的判定规则（单元级，纯逻辑）
 * 2. 源码里确实接上了防护（防"写了模块但没接线"）
 * 3. 限流确实生效
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkLocalOrigin, throttle, __resetThrottle } from '../lib/http-guard.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GOOD = 'http://127.0.0.1:62120';

/** 造一个 req 形状。 */
function req(headers) {
  return { headers };
}

// ── H1: 本机来源放行 ────────────────────────────────────────────────────
test('H1: 本机回环 Origin 的读请求放行', () => {
  for (const origin of [GOOD, 'http://localhost:62120', 'http://[::1]:62120']) {
    const r = checkLocalOrigin(req({ origin }));
    assert.equal(r.ok, true, `${origin} 应放行，实际拒绝：${r.reason}`);
  }
});

// ── H2: 外部 Origin 必须拒绝（核心：恶意网页）───────────────────────────
test('H2: 外部域 Origin 一律拒绝', () => {
  for (const origin of [
    'https://evil.com',
    'http://evil.com:62120',
    'https://127.0.0.1.evil.com',   // 前缀伪装
    'file://',
  ]) {
    const r = checkLocalOrigin(req({ origin }));
    assert.equal(r.ok, false, `${origin} 必须拒绝`);
  }
});

// ── H3: null Origin 拒绝（沙箱 iframe / file://）────────────────────────
test('H3: Origin: null 拒绝', () => {
  const r = checkLocalOrigin(req({ origin: 'null' }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'null-origin');
});

// ── H4: Sec-Fetch-Site: cross-site 优先拒绝 ─────────────────────────────
test('H4: Sec-Fetch-Site 为 cross-site 时拒绝（即使 Origin 看着正常）', () => {
  const r = checkLocalOrigin(req({
    origin: GOOD,
    'sec-fetch-site': 'cross-site',
  }));
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cross-site');
});

// ── H5: 写操作必须 JSON（堵死表单提交）──────────────────────────────────
test('H5: 写操作用表单 content-type 时拒绝', () => {
  const r = checkLocalOrigin(
    req({ origin: GOOD, 'content-type': 'application/x-www-form-urlencoded' }),
    { write: true },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'write-requires-json',
    '<form> 发不出 application/json —— 强制 JSON 等于堵死跨站表单提交');
});
// ── H6: 缺 Origin 但用表单 → 必须拒绝（真正的防线是 JSON 不是 Origin）──
test('H6: 写操作用表单提交时拒绝（JSON 防线）', () => {
  // ⚠️ 这条原本断言「缺 Origin 的写操作一律拒绝」，那是**基于错误假设**：
  // 我以为同源 fetch 会带 Origin。2026-10-18 实测推翻 ——
  // 浏览器只在**跨源**时才自动加 Origin，DSH 设置页同源，真实请求不带。
  //
  // 正确的防线是「写操作必须是 application/json」：
  // <form> 发不出这个类型，所以跨站表单提交仍然拦得住。
  const r = checkLocalOrigin(
    req({ 'content-type': 'application/x-www-form-urlencoded' }),
    { write: true },
  );
  assert.equal(r.ok, false, '表单提交必须拒绝');
  assert.equal(r.reason, 'write-requires-json');
});

// ── H7: 正常写操作放行 ──────────────────────────────────────────────────
test('H7: 本机 Origin + JSON 的写操作放行', () => {
  const r = checkLocalOrigin(
    req({ origin: GOOD, 'content-type': 'application/json; charset=utf-8' }),
    { write: true },
  );
  assert.equal(r.ok, true);
});

// ── H8: 限流生效 ────────────────────────────────────────────────────────
test('H8: throttle 在间隔内拒绝第二次', () => {
  __resetThrottle();
  assert.equal(throttle('preview', 3000).ok, true, '第一次应放行');
  const second = throttle('preview', 3000);
  assert.equal(second.ok, false, '间隔内第二次必须拒绝');
  assert.ok(second.retryAfterMs > 0, '应给出剩余等待时间');
});

// ── H9: 不同路由的限流互不影响 ──────────────────────────────────────────
test('H9: 不同 key 的限流相互独立', () => {
  __resetThrottle();
  assert.equal(throttle('preview', 3000).ok, true);
  assert.equal(throttle('selftest', 3000).ok, true,
    'selftest 不该被 preview 的限流影响');
});

// ── H10: 源码确实接上了防护（防"写了模块没接线"）────────────────────────
test('H10: index.js 实际调用了 checkLocalOrigin 与 throttle', () => {
  const src = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8');
  assert.match(src, /import\s*\{[^}]*checkLocalOrigin/,
    '必须 import checkLocalOrigin');
  assert.match(src, /checkLocalOrigin\(req/,
    '必须在请求处理里调用 checkLocalOrigin');
  assert.match(src, /throttle\(/,
    '必须对 preview/selftest 调用 throttle');
  assert.match(src, /reason: guard\.reason/,
    '拒绝时应把 reason 回给调用方，便于诊断');
});

// ── H11: config-route 必须有请求体上限 ──────────────────────────────────
test('H11: config-route 有请求体大小上限（不只是超时）', () => {
  const src = readFileSync(join(ROOT, 'lib', 'config-route.js'), 'utf8');
  assert.match(src, /MAX_BODY_BYTES/,
    '必须有大小上限常量 —— 3 秒超时不等于限流，慢速大包能绕过');
  assert.match(src, /__tooLarge/,
    '超限必须能被调用方识别');
  assert.match(src, /413/,
    '超限应回 413（与 400 格式错区分）');
});

// ── H12: 真实浏览器请求形态必须放行（这是 H6 的反面，也是我犯过的错）──
test('H12: 无 Origin 无 Referer 的 JSON 写请求必须放行', () => {
  // ⚠️ 这条对应 2026-10-18 的真实回归：
  //
  // 我原本断言「正常前端写配置一定经过 fetch，会带 Origin」—— 错的。
  // 浏览器**只在跨源请求时**才自动加 Origin；DSH 设置页与路由同源，
  // 真实请求不带 Origin 也不带 Referer。结果用户一拖音量滑杆就 403。
  //
  // 我当时所有验证都手动加了 `Origin: http://127.0.0.1:端口` 头 ——
  // 那正好绕过了这个 bug。**手动构造的请求不能代表真实浏览器的请求。**
  //
  // H6（写操作缺 Origin 要拒绝）与这条看似矛盾，实际不矛盾：
  // 区别在于 H6 没有 JSON content-type，而真实请求一定有。
  // 真正的防线是「写操作必须是 JSON」，不是「必须有 Origin」。
  const r = checkLocalOrigin(
    req({ 'content-type': 'application/json' }),
    { write: true },
  );
  assert.equal(r.ok, true,
    '同源 fetch 不带 Origin 是正常行为，必须放行 —— 否则 GUI 完全不能保存');
});

// ── H13: 「写操作必须是 JSON」这道防线不能因为上面放行而失效 ────────────
test('H13: 无 Origin 的表单提交仍必须拒绝（JSON 防线没被绕过）', () => {
  const r = checkLocalOrigin(
    req({ 'content-type': 'application/x-www-form-urlencoded' }),
    { write: true },
  );
  assert.equal(r.ok, false,
    '放行无 Origin 的 JSON 请求，不等于对表单开门 —— '
    + '<form> 发不出 application/json，这道防线必须始终有效');
  assert.equal(r.reason, 'write-requires-json');
});

// ── H14: 短路的 return 会跳过 JSON 检查（我写错过一次）──────────────────
test('H14: 无 Origin 分支必须走 finishWriteCheck 而不是直接 return ok', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const src = readFileSync(join(ROOT, 'lib', 'http-guard.js'), 'utf8');

  // 找"既无 Origin 也无 Referer"那段
  const at = src.indexOf('既无 Origin 也无 Referer');
  assert.ok(at > 0, '应能找到该分支');
  const seg = src.slice(at, at + 1800);

  assert.match(seg, /return finishWriteCheck\(req, headers, opts\)/,
    '该分支必须走 finishWriteCheck —— 直接 return { ok: true } 会跳过 JSON 检查，'
    + '等于对表单提交开门（我第一版就写错过，靠自测才发现）');
});