/**
 * 文档一致性测试（v0.4.29）。
 *
 * ## 为什么需要
 *
 * 2026-10-18 外部审阅指出两处文档漂移：
 *   · `docs/待做清单.md` 还停在 v0.4.24，里面列着已经修完的事项
 *   · 审核记录里有个 `ankokon`，实际音色 key 是 `ankomon`
 *
 * 这类错误不影响功能，但会误导读者 —— 而且**只要没人看就永远发现不了**。
 * 审阅者建议「用测试或校验脚本预防」，这个文件就是那个脚本。
 *
 * ## 检查什么
 *
 * 1. 文档里提到的音色 key 必须真实存在（拼写漂移）
 * 2. 待做清单的"最后更新"版本不能落后太多（进度漂移）
 * 3. 内部文档不得含本机绝对路径（发布物卫生）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** 磁盘上真实存在的音色 key（从 sounds/voice-lines 推）。 */
function realVoiceKeys() {
  const base = join(ROOT, 'sounds', 'voice-lines');
  const keys = new Set();
  if (!existsSync(base)) return keys;

  const scan = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { scan(join(dir, e.name)); continue; }
      if (!e.name.toLowerCase().endsWith('.wav')) continue;
      const k = e.name
        .replace(/\.wav$/i, '')
        .replace(/~\d+$/, '')
        .replace(/-(?:extra|kansai)-\d+$/, '');
      if (k) keys.add(k);
    }
  };
  scan(base);
  return keys;
}

// ── D1: 审核记录里的音色 key 必须真实存在 ───────────────────────────────
test('D1: docs/audio-audit/README.md 提到的音色 key 都真实存在', () => {
  const f = join(ROOT, 'docs', 'audio-audit', 'README.md');
  if (!existsSync(f)) return;

  const real = realVoiceKeys();
  if (real.size === 0) return;   // 发布包里只有 1 个音色也可能，跳过

  const md = readFileSync(f, 'utf8');

  // 抓「反引号包裹的、形如音色 key 的标识」
  // 音色 key 的特征：小写字母开头，含 - 或纯字母，长度 >= 4
  const candidates = new Set();
  for (const m of md.matchAll(/`([a-z][a-z0-9-]{3,})`/g)) {
    const k = m[1];
    // 排除明显不是音色 key 的（文件名、命令、配置键）
    if (/\.(md|js|mjs|ps1|json|wav|txt|yml)$/.test(k)) continue;
    if (k.startsWith('my-')) continue;          // 个人声音不参与公开清单
    if (['node-test', 'test-all', 'test-route'].includes(k)) continue;
    candidates.add(k);
  }

  // 只校验"看起来像音色 key"的：全部小写 + 含连字符 或 在已知音色集附近
  const suspect = [...candidates].filter((k) => {
    if (real.has(k)) return false;
    // 允许：多个音色用逗号连写的段落已被上面拆开；这里只关心单 token
    return /^[a-z]+(?:-[a-z0-9]+)+$/.test(k);
  });

  // 允许一些通用词
  const allowed = new Set(['third-party', 'audio-audit', 'not-recorded']);
  const bad = suspect.filter((k) => !allowed.has(k));

  assert.deepEqual(bad, [],
    '这些 key 在文档里出现但磁盘上没有对应音色（可能是拼写漂移）：\n  '
    + bad.join('\n  '));
});

// ── D2: 待做清单的更新版本不能落后于 package.json ───────────────────────
test('D2: docs/待做清单.md 的版本不落后于 package.json', () => {
  const f = join(ROOT, 'docs', '待做清单.md');
  if (!existsSync(f)) return;

  const md = readFileSync(f, 'utf8');
  const m = /最后更新[：:]\s*\d{4}-\d{2}-\d{2}[（(]v?([\d.]+)[）)]/.exec(md);
  if (!m) {
    // 没写版本号也算不漂移（只是格式不同）
    return;
  }
  const docVer = m[1];
  const pkgVer = PKG.version;

  const cmp = (a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    }
    return 0;
  };

  // 允许文档比包版本落后 1 个补丁号（写文档有滞后是合理的）；
  // 落后 2 个以上说明"改完没回头更新"，那才是漂移。
  const behind = cmp(pkgVer, docVer);
  assert.ok(behind <= 1,
    `待做清单停在 v${docVer}，而包已经是 v${pkgVer} —— `
    + '落后超过 1 个补丁号说明改完没回头更新（外部审阅已指出过一次）');
});

// ── D3: 公开文档不得含本机绝对路径 ──────────────────────────────────────
test('D3: docs/ 下的文档不含本机绝对路径', () => {
  const docsDir = join(ROOT, 'docs');
  if (!existsSync(docsDir)) return;

  const offenders = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(md|ps1|mjs|js|json|txt)$/i.test(e.name)) continue;
      const text = readFileSync(full, 'utf8');
      // 本机路径特征：盘符 + 已知开发目录
      if (/[A-Z]:\\+(?:0Deepseek|Codex|Users\\+audio)/i.test(text)) {
        offenders.push(full.replace(ROOT, '.'));
      }
    }
  };
  walk(docsDir);

  assert.deepEqual(offenders, [],
    '文档里出现本机绝对路径 —— 发布物是公开的，别人拿去跑不通：\n  '
    + offenders.join('\n  '));
});

// ── D4: THIRD-PARTY-NOTICES 必须给出可点的官方链接 ──────────────────────
test('D4: 第三方声明含官方条款链接（不能只有口头说明）', () => {
  const f = join(ROOT, 'THIRD-PARTY-NOTICES.md');
  if (!existsSync(f)) return;
  const md = readFileSync(f, 'utf8');

  assert.match(md, /https:\/\/voicevox\.hiroshiba\.jp\/term/,
    '必须给出 VOICEVOX 官方条款链接 —— 用户需要能自己核对');
  assert.match(md, /https:\/\/zunko\.jp\//,
    '必须给出ずんずんプロジェクト条款链接');
  // 绝不能把第三方音频说成 MIT/CC0
  assert.doesNotMatch(md, /语音.{0,8}(?:MIT|CC0).{0,8}(?:发布|许可)/,
    '不得声称语音文件以 MIT/CC0 发布 —— 我们无权变更第三方素材的许可');
});
