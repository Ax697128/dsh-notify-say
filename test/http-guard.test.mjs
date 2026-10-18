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

// ── H6: 写操作无 Origin 也拒绝 ──────────────────────────────────────────
test('H6: 写操作缺少 Origin/Referer 时拒绝', () => {
  const r = checkLocalOrigin(
    req({ 'content-type': 'application/json' }),
    { write: true },
  );
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'write-without-origin');
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
