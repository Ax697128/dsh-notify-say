/**
 * 指纹覆盖范围回归（v0.4.38）。
 *
 * ## 这个测试为什么必须存在
 *
 * 2026-10-18 踩到的坑：`index.js` 导出的 `fingerprint` **只对 index.js 自己**
 * 做哈希。于是：
 *
 *   · 改 index.js      → 指纹变 → 热重载成功
 *   · 改 http-guard.js → 指纹**不变** → 热重载报 `fingerprint unchanged` 失败
 *
 * 表现是「我明明改了代码，热重载却一直说"代码没变"」。
 * 排查了半小时，最后靠"改一个非入口文件看指纹变不变"才定位。
 *
 * 现有 R1~R4 只测了「指纹存在」「不同代际 URL 得到不同指纹」，
 * **没有测「覆盖范围」** —— 所以这个 bug 能藏住。
 *
 * 这里补上：任何 lib/*.js 的改动都必须反映到 fingerprint。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, utimesSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, 'lib');

// ── F1: fingerprint 的实现必须覆盖整个包，不能只算入口文件 ──────────────
test('F1: fingerprint 覆盖整个 lib/ 而不是只看 index.js', () => {
  const src = readFileSync(join(LIB, 'index.js'), 'utf8');

  const at = src.indexOf('export const fingerprint = (() => {');
  assert.ok(at > 0, '应能找到 fingerprint 定义');
  const closeAt = src.indexOf('})();', at);
  const body = src.slice(at, closeAt > 0 ? closeAt : at + 1200);

  // 正确实现：复用 computeFingerprint(包目录)
  assert.match(body, /computeFingerprint\(/,
    'fingerprint 应复用 dev-reload 的 computeFingerprint —— '
    + '它覆盖 package.json + lib/*.js；只对 index.js 哈希会让改其它文件时指纹不变');

  // 反例：只读 index.js 自己
  assert.doesNotMatch(body, /readFileSync\(filePath\)\s*;?\s*$/m,
    '不得只对单个文件做哈希（这正是 2026-10-18 的 bug）');
});

// ── F2: 实测 —— 改任意一个 lib/*.js 都要让指纹变化 ──────────────────────
test('F2: 改非入口文件后 computeFingerprint 必须变化', async () => {
  const { computeFingerprint } = await import('../lib/dev-reload.js');

  const before = computeFingerprint(ROOT);
  assert.ok(before, '应能算出指纹');

  // 挑一个非入口文件（不是 index.js），动它的 mtime
  const others = readdirSync(LIB)
    .filter((f) => f.endsWith('.js') && f !== 'index.js');
  assert.ok(others.length > 0, 'lib/ 下应有除 index.js 外的模块');
  const target = join(LIB, others[0]);

  const orig = statSync(target);
  const bumped = new Date(orig.mtimeMs + 5000);
  try {
    utimesSync(target, bumped, bumped);
    const after = computeFingerprint(ROOT);
    assert.notEqual(after, before,
      `改了 lib/${others[0]} 之后指纹必须变 —— `
      + '否则热重载会误报 fingerprint unchanged（2026-10-18 实际踩到）');
  } finally {
    // 还原 mtime，别把仓库搞脏
    utimesSync(target, orig.atime, orig.mtime);
  }
});

// ── F3: 指纹必须包含所有 lib/*.js（不是只挑几个）────────────────────────
test('F3: 指纹输入覆盖 lib/ 下全部 .js 文件', () => {
  const src = readFileSync(join(LIB, 'dev-reload.js'), 'utf8');
  const at = src.indexOf('export function computeFingerprint');
  assert.ok(at > 0);
  const endAt = src.indexOf('\n}', at);
  const body = src.slice(at, endAt > 0 ? endAt : at + 2000);

  assert.match(body, /readdirSync/,
    '应遍历目录而不是硬编码文件列表 —— 硬编码会漏掉新加的模块');
  assert.match(body, /endsWith\('\.js'\)/,
    '应筛出所有 .js');
  assert.match(body, /lib/,
    '应包含 lib/ 目录');
});
