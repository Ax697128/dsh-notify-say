/**
 * 语音包存储层测试（v0.4.31：一音色一目录）。
 *
 * ## 两套布局必须共存
 *
 * ```
 * 内置（只读，平铺旧布局，247 个文件已经在用）
 *   voice-lines/zundamon-normal.wav
 *   voice-lines/fail/zundamon-normal~1.wav
 *
 * 用户（可写，一音色一目录）
 *   voice-lines/zundamon-normal/zundamon-normal.wav
 *   voice-lines/zundamon-normal/fail/zundamon-normal~1.wav
 * ```
 *
 * ## 为什么用户目录用新布局
 *
 * 从用户角度：
 *   · 卸载 = 删一个文件夹（旧方案按文件名前缀匹配，删 normal 会连带删 normal-extra）
 *   · "我装了哪些"一眼可见
 *   · 每个音色自带 TERMS.md / MANIFEST.json
 *
 * 内置保持平铺是**不动已经工作的东西** —— 247 个文件没必要为此迁移。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  POOLS,
  voiceKeyOf,
  userVoiceRoot,
  builtinVoiceRoot,
  poolDirOf,
  installedVoiceKeys,
  builtinVoiceKeys,
  mergeVoices,
  voiceFiles,
  hasVoice,
  poolCoverage,
  poolSummary,
  userKeyDir,
} from '../lib/voice-pack-store.js';

/** 临时切换数据目录，跑完恢复。 */
async function withDataDir(fn) {
  const old = process.env.DSH_NOTIFY_SAY_DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'vps-'));
  process.env.DSH_NOTIFY_SAY_DATA_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (old === undefined) delete process.env.DSH_NOTIFY_SAY_DATA_DIR;
    else process.env.DSH_NOTIFY_SAY_DATA_DIR = old;
  }
}

/** 造一个「平台根」（模拟 pluginRoot）。 */
function makePluginRoot() {
  return mkdtempSync(join(tmpdir(), 'vps-plugin-'));
}

/** 在平铺布局里放文件（模拟内置目录）。 */
function seedBuiltin(pluginRoot, filesByPool) {
  const base = builtinVoiceRoot(pluginRoot);
  for (const [pool, names] of Object.entries(filesByPool)) {
    const dir = poolDirOf(base, pool);
    mkdirSync(dir, { recursive: true });
    for (const n of names) writeFileSync(join(dir, n), 'RIFF____WAVE');
  }
}

/** 在「一音色一目录」布局里放文件（模拟用户目录）。 */
function seedUser(key, filesByPool) {
  const base = join(userVoiceRoot(), key);
  for (const [pool, names] of Object.entries(filesByPool)) {
    const dir = poolDirOf(base, pool);
    mkdirSync(dir, { recursive: true });
    for (const n of names) writeFileSync(join(dir, n), 'RIFF____WAVE');
  }
}

// ── V1: 音色 key 推导 ───────────────────────────────────────────────────
test('V1: voiceKeyOf 正确剥掉变体后缀', () => {
  const cases = [
    ['zundamon-normal.wav', 'zundamon-normal'],
    ['zundamon-normal~1.wav', 'zundamon-normal'],
    ['zundamon-normal-kansai-1.wav', 'zundamon-normal'],
    ['zundamon-normal-extra-2.wav', 'zundamon-normal'],
  ];
  for (const [input, want] of cases) {
    assert.equal(voiceKeyOf(input), want);
  }
});

// ── V2: 两种布局的结构同构 ──────────────────────────────────────────────
test('V2: <key>/ 目录与内置根同构（同一 poolDirOf）', () => {
  const builtin = 'C:\\p\\sounds\\voice-lines';
  const userKey = 'C:\\u\\voice-lines\\zundamon-normal';
  for (const pool of ['', 'fail', 'question', 'approval']) {
    const a = poolDirOf(builtin, pool);
    const b = poolDirOf(userKey, pool);
    assert.equal(a.replace(builtin, ''), b.replace(userKey, ''),
      `池 ${pool || '(根)'} 的相对结构应一致 —— 这是两套布局能共用读取逻辑的前提`);
  }
});

// ── V3: 用户目录识别子目录为音色 ────────────────────────────────────────
test('V3: installedVoiceKeys 把子目录当音色，忽略 .installing', async () => {
  await withDataDir(() => {
    seedUser('zundamon-normal', { '': ['zundamon-normal.wav'] });
    seedUser('ankomon', { '': ['ankomon.wav'] });
    // 解压中的临时目录不该算已安装
    mkdirSync(join(userVoiceRoot(), 'somekey.installing'), { recursive: true });

    assert.deepEqual(installedVoiceKeys(), ['ankomon', 'zundamon-normal']);
  });
});

// ── V4: 内置目录按文件名归纳音色 ────────────────────────────────────────
test('V4: builtinVoiceKeys 从平铺文件归纳出音色', () => {
  const pluginRoot = makePluginRoot();
  seedBuiltin(pluginRoot, {
    '': ['zundamon-normal.wav', 'zundamon-normal-kansai-1.wav'],
    fail: ['zundamon-normal~1.wav', 'ankomon~1.wav'],
  });
  assert.deepEqual(builtinVoiceKeys(pluginRoot), ['ankomon', 'zundamon-normal']);
});

// ── V5: 合并时用户优先 ──────────────────────────────────────────────────
test('V5: mergeVoices 用户版覆盖内置版', async () => {
  const pluginRoot = makePluginRoot();
  await withDataDir(() => {
    seedBuiltin(pluginRoot, { '': ['zundamon-normal.wav', 'ankomon.wav'] });
    seedUser('zundamon-normal', { '': ['zundamon-normal.wav'] });

    const map = new Map(mergeVoices(pluginRoot).map((m) => [m.key, m]));
    assert.equal(map.get('zundamon-normal').source, 'user',
      '用户装了同名音色时，来源应为 user');
    assert.equal(map.get('ankomon').source, 'builtin');
    assert.equal(map.get('ankomon').installed, false, '内置的不算"已安装"');
  });
});

// ── V6: voiceFiles 在用户目录找到就不往内置找 ───────────────────────────
test('V6: voiceFiles 用户版完全覆盖内置版（不混用）', async () => {
  const pluginRoot = makePluginRoot();
  await withDataDir(() => {
    seedBuiltin(pluginRoot, { '': ['zundamon-normal.wav', 'zundamon-normal-kansai-1.wav'] });
    seedUser('zundamon-normal', { '': ['zundamon-normal.wav'] });

    const files = voiceFiles(pluginRoot, 'zundamon-normal', '');
    assert.equal(files.length, 1,
      '用户目录有该音色时，不应再把内置的同名文件混进来');
    assert.ok(files[0].includes('voice-lines'), '应来自用户目录');
    assert.ok(!files[0].includes('sounds'), '不应来自内置 sounds 目录');
  });
});

// ── V7: 用户目录没有时回退内置 ──────────────────────────────────────────
test('V7: voiceFiles 用户没装时回退内置（内置始终可用）', async () => {
  const pluginRoot = makePluginRoot();
  await withDataDir(() => {
    seedBuiltin(pluginRoot, { '': ['ankomon.wav'] });
    const files = voiceFiles(pluginRoot, 'ankomon', '');
    assert.equal(files.length, 1);
    assert.ok(files[0].includes('sounds'), '应回退到内置目录');
  });
});

// ── V8: 池隔离（fail 不串到 done）───────────────────────────────────────
test('V8: voiceFiles 严格按池取，不跨池', async () => {
  const pluginRoot = makePluginRoot();
  await withDataDir(() => {
    seedUser('zundamon-normal', {
      '': ['zundamon-normal.wav'],
      fail: ['zundamon-normal~1.wav'],
    });
    assert.equal(voiceFiles(pluginRoot, 'zundamon-normal', 'fail').length, 1);
    assert.equal(voiceFiles(pluginRoot, 'zundamon-normal', 'question').length, 0);
    assert.ok(voiceFiles(pluginRoot, 'zundamon-normal', 'fail')[0].includes('fail'),
      'fail 池的文件必须来自 fail 目录 —— 失败时播"完成了"语义完全相反');
  });
});

// ── V9: 跨池覆盖度 ──────────────────────────────────────────────────────
test('V9: poolCoverage 报告各池有无', async () => {
  const pluginRoot = makePluginRoot();
  await withDataDir(() => {
    seedUser('zuk', { '': ['zuk.wav'], question: ['zuk~1.wav'] });
    assert.deepEqual(poolCoverage(pluginRoot, 'zuk'),
      { done: true, question: true, approval: false, fail: false });
  });
});

// ── V10: poolSummary 统计两种布局 ───────────────────────────────────────
test('V10: poolSummary 同时统计用户与内置', async () => {
  const pluginRoot = makePluginRoot();
  await withDataDir(() => {
    seedBuiltin(pluginRoot, { fail: ['a~1.wav', 'b~1.wav'] });
    seedUser('a', { fail: ['a~1.wav'] });
    const s = poolSummary(pluginRoot, 'fail');
    assert.equal(s.unreadable, false);
    assert.ok(s.total >= 2, `至少应统计到内置的 2 个，实际 ${s.total}`);
  });
});

// ── V11: 目录不存在时安全返回 ───────────────────────────────────────────
test('V11: 目录不存在时各函数返回空而不抛', async () => {
  const pluginRoot = makePluginRoot();   // 空目录
  await withDataDir(() => {
    assert.deepEqual(installedVoiceKeys(), []);
    assert.deepEqual(builtinVoiceKeys(pluginRoot), []);
    assert.deepEqual(voiceFiles(pluginRoot, 'nope', ''), []);
    assert.equal(hasVoice(pluginRoot, 'nope'), false);
    assert.equal(poolSummary(pluginRoot, '').total, 0);
  });
});

// ── V12: userKeyDir 与 installedVoiceKeys 一致 ──────────────────────────
test('V12: userKeyDir 指向的目录就是 installedVoiceKeys 认的那个', async () => {
  await withDataDir(() => {
    seedUser('mykey', { '': ['mykey.wav'] });
    const keys = installedVoiceKeys();
    assert.ok(keys.includes('mykey'));
    assert.ok(existsSync(userKeyDir('mykey')), 'userKeyDir 应指向真实存在的目录');
    assert.equal(userKeyDir('mykey'), join(userVoiceRoot(), 'mykey'));
  });
});

// ── V13: POOLS 与 ps1 的 Kind 对齐 ──────────────────────────────────────
test('V13: POOLS 与 dsh-notify.ps1 的 -Kind 取值一致', () => {
  assert.deepEqual([...POOLS].sort(), ['', 'approval', 'fail', 'question'].sort());
});
