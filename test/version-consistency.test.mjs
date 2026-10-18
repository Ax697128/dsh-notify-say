/**
 * 版本号一致性检查（v0.4.19）。
 *
 * ## 为什么需要这条检查
 *
 * 用户 2026-10-18 第三次指出："我感觉你的版本号经常会慢一点。"
 *
 * 确实如此。已发生 3 次：
 *   · v0.4.13~15 只在**提交说明**里写了版本号，没改 package.json
 *   · v0.4.17~18 又漏了两次，代码到 0.4.18 时文件还写 0.4.16
 *
 * 后果不是"难看"，而是**实质性的误导**：
 *   · 插件管理页面显示 0.4.12，用户以为重启没生效
 *   · 我判断"宿主加载了哪一版"时被这个数字骗过
 *   · 排查时无法用版本号区分代码状态
 *
 * ## 为什么靠检查而不是靠"记得"
 *
 * 已经漏了 3 次，说明"提交前记得改"不可靠。
 * 这条测试纳入 `npm run test:all`，改代码忘了升版本就会红。
 *
 * ## 检查什么
 *
 * 1. package.json 的 version 必须符合 semver
 * 2. 源码里如果有版本标记（如注释里的 v0.4.x），不能高于 package.json
 * 3. CHANGELOG（若有）的最新条目不能高于 package.json
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** 把 "0.4.18" 解析成可比较的数字数组。 */
function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** a > b 返回 true。 */
function gt(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

// ── A1: version 必须是合法 semver ────────────────────────────────────────
test('A1: package.json 的 version 是合法 semver', () => {
  assert.ok(pkg.version, 'package.json 必须有 version');
  const v = parseSemver(pkg.version);
  assert.ok(v !== null, `version 不合法: ${pkg.version}`);
  assert.ok(v[0] >= 0 && v[1] >= 0 && v[2] >= 0);
});

// ── A2: 源码里的版本标记不能超过 package.json ────────────────────────────
test('A2: 源码注释里的 v0.4.x 标记不高于 package.json 的 version', () => {
  const vPkg = parseSemver(pkg.version);
  assert.ok(vPkg, 'version 无法解析');

  // 扫描主要源码文件里出现的 v0.4.N 标记
  const files = ['lib/index.js', 'lib/client.js', 'lib/config-store.js',
    'lib/config-schema.js', 'dsh-notify.ps1', 'lib/wav-gain.ps1'];
  const tooHigh = [];
  for (const rel of files) {
    const p = join(ROOT, rel);
    if (!existsSync(p)) continue;
    const src = readFileSync(p, 'utf8');
    // 只认 v0.4.N 这种明确的版本标记
    const re = /\bv0\.4\.(\d+)\b/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const n = Number(m[1]);
      if (n > vPkg[2]) tooHigh.push(`${rel} 提到 v0.4.${n}`);
    }
  }
  assert.deepEqual(tooHigh, [],
    `源码里出现了高于 package.json (${pkg.version}) 的版本标记 —— `
    + '说明改了代码但忘了升版本号：\n  ' + tooHigh.join('\n  '));
});

// ── A3: CHANGELOG 最新条目不能高于 package.json ──────────────────────────
test('A3: CHANGELOG（若有）最新版本不高于 package.json', () => {
  const p = join(ROOT, 'CHANGELOG.md');
  if (!existsSync(p)) return;   // 还没建 CHANGELOG 时跳过
  const text = readFileSync(p, 'utf8');
  const m = /##\s*\[?v?(\d+\.\d+\.\d+)/.exec(text);
  if (!m) return;
  const vLog = parseSemver(m[1]);
  const vPkg = parseSemver(pkg.version);
  assert.ok(vLog && vPkg);
  assert.ok(!gt(vLog, vPkg),
    `CHANGELOG 最新是 ${m[1]}，高于 package.json 的 ${pkg.version}`);
});
