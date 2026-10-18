/**
 * 一次性自重载的行为测试（v0.4.57）。
 *
 * ## 为什么这个文件存在
 *
 * 2026-10-18 宿主崩了。崩溃日志给了两条硬证据：
 *
 *   ① 45 条「热重载失败：fingerprint unchanged（旧代码仍在运行）」
 *      —— 那天为调 UI 改了 40 多次文件，每次保存都触发一次注定失败的尝试；
 *   ② 同一时刻反复「Session reference "..." is released」
 *      —— 每次重载都 dispose 旧实例，而 dispose 会释放渲染进程仍在用的
 *         会话引用；反复几十次后渲染进程拿到损坏的 client 包，抛
 *         SyntaxError，宿主退出。
 *
 * **危险的不是"重载失败"，是"反复重载"。**
 *
 * 所以设计改成：删掉 watcher，只在用户点按钮时尝试一次。
 * 而"该不该真的试"的判断抽成 `planReload()` 纯函数 —— 它就是这个文件的主角：
 *
 *   · 代码没变 → noop（**一次 dispose 都不做**，这是止血点）
 *   · 插件根路径变了（pnpm 升级）→ 拒绝，并如实说必须重启
 *   · 确实变了 → reload（一次，失败不重试）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { planReload } from '../lib/dev-reload.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IDX = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8');
const DR = readFileSync(join(ROOT, 'lib', 'dev-reload.js'), 'utf8');
const CLIENT = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');

/** 去掉注释，只看真正会执行的代码。 */
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter((l) => !/^\s*\/\//.test(l))
    .join('\n');
}

// ── P1: 代码没变 → 一次 dispose 都不做 ──────────────────────────────────
test('P1: 磁盘指纹与运行中一致时 → noop（不重载）', () => {
  // 这是整个修复的止血点：上次那 45 次失败尝试，全部属于"点了但没必要"或
  // "自动触发但没必要"的情形。noop 让它们连 dispose 都不会发生。
  const r = planReload({
    diskFingerprint: 'abc123',
    runningFingerprint: 'abc123',
    resolvedRootAtLoad: 'E:/p',
    resolvedRootNow: 'E:/p',
  });
  assert.equal(r.action, 'noop');
  assert.equal(r.reason, 'already-current');
});

// ── P2: 插件根路径变了 → 拒绝并说清原因 ─────────────────────────────────
test('P2: 插件根真实路径变了 → 拒绝重载，提示重启', () => {
  // pnpm 升级会把包装到新的 .pnpm/<name>@<ver>/ 下。
  // 我们从加载时的旧路径重新导入，拿到的仍是旧代码 —— 与其给一个
  // "看起来成功其实没换"的按钮，不如直接说清楚。
  const r = planReload({
    diskFingerprint: 'NEW',
    runningFingerprint: 'OLD',
    resolvedRootAtLoad: 'C:/d/.pnpm/pkg@0.4.56/node_modules/pkg',
    resolvedRootNow: 'C:/d/.pnpm/pkg@0.5.0/node_modules/pkg',
  });
  assert.equal(r.action, 'refuse-path-changed');
  assert.equal(r.reason, 'path-changed');
  assert.match(r.hint, /重启/, '必须明确告知只能重启');
});

// ── P3: 确实变了 → 重载一次 ─────────────────────────────────────────────
test('P3: 代码确实变了且路径未变 → reload', () => {
  const r = planReload({
    diskFingerprint: 'NEW',
    runningFingerprint: 'OLD',
    resolvedRootAtLoad: 'E:/p',
    resolvedRootNow: 'E:/p',
  });
  assert.equal(r.action, 'reload');
});

// ── P4: 读不到指纹 → 不能假装"已是最新" ─────────────────────────────────
test('P4: 读不到磁盘指纹时不清空判断（按 reload 处理）', () => {
  // 只读沙箱里 computeFingerprint 会返回 ''。
  // 这时若判 noop，用户会以为已生效；判 reload 至少有机会真的生效，
  // 失败也会如实报错。
  const r = planReload({
    diskFingerprint: '',
    runningFingerprint: 'abc',
    resolvedRootAtLoad: 'E:/p',
    resolvedRootNow: 'E:/p',
  });
  assert.equal(r.action, 'reload', '不能因为读不到指纹就静默 noop');
  assert.equal(r.reason, 'fingerprint-unreadable');
});

// ── P5: 唯一入口是 POST /reload，且算写操作 ─────────────────────────────
test('P5: 重载只经 POST /reload，且被当作写操作保护', () => {
  assert.match(IDX, /head === 'reload'/, '应有 /reload 路由');
  assert.match(IDX, /toUpperCase\(\) !== 'POST'/, '必须只接受 POST（不可逆操作）');
  // 写操作 → 走本地来源防护（Origin/跨站检查）
  const writeAt = IDX.indexOf('const isWriteRoute =');
  assert.ok(writeAt > 0, '应能定位 isWriteRoute');
  const seg = IDX.slice(writeAt, writeAt + 900);
  assert.match(seg, /head === 'reload'/, '/reload 必须列进 isWriteRoute');
});

// ── P6: 没有任何自动触发路径 ────────────────────────────────────────────
test('P6: 没有任何自动触发（无 watcher、无定时器驱动重载）', () => {
  // 这一条锁住"用户要求：点一下重载一下，不要一直在重载"。
  const dr = code(DR);
  assert.doesNotMatch(dr, /fs\.watch/, 'dev-reload.js 不应再监听文件系统');
  assert.doesNotMatch(dr, /watchPackage/, 'watchPackage 应已彻底移除');

  const idx = code(IDX);
  assert.doesNotMatch(idx, /watchPackage/, 'index.js 不应再调用 watchPackage');
  assert.doesNotMatch(idx, /devReload\)\s*\{\s*[\s\S]{0,200}selfReload/,
    '不应再有「配置开着就自动重载」的路径');
});

// ── P7: GUI 只有一个按钮，没有开关 ──────────────────────────────────────
test('P7: GUI 是按钮而不是开关', () => {
  assert.match(CLIENT, /重载现在生效/, '应有一次性重载按钮');
  assert.doesNotMatch(CLIENT, /apply\(\{ devReload: !!e\.target\.checked \}/,
    '不应再有自动热重载开关');
  // 按钮必须说明它不会自动重复，以及"升级后必须重启"
  assert.match(CLIENT, /不会自动重复/, '应说明不会自动重复');
  assert.match(CLIENT, /新版本装在另一个路径/, '应说明升级场景自重载做不到');
});

// ── P8: 每次尝试都留可观测痕迹 ──────────────────────────────────────────
test('P8: 成功与失败都写进 notify.log', () => {
  // watcher 时代的 `[watch]` 信号没了，可观测性要补在重载结果上，
  // 否则"点了没反应"无法排查。
  assert.match(IDX, /\[reload\] OK by-user/);
  assert.match(IDX, /\[reload\] FAILED/);
  const okAt = IDX.indexOf('[reload] OK by-user');
  const seg = IDX.slice(Math.max(0, okAt - 400), okAt + 80);
  assert.match(seg, /appendNotifyLog/, '必须写文件，不能只进 console');
});
