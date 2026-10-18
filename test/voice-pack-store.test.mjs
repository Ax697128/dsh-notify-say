/**
 * 语音包存储层测试（v0.4.29）。
 *
 * ## 它解决什么问题
 *
 * 三处代码曾各自硬编码 `<plugin>/sounds/voice-lines`：
 *   lib/index.js            → hasVoiceLine
 *   dsh-notify.ps1          → 播放时找文件
 *   tools/notify-config.ps1 → 删除音色
 *
 * 但下载的音色**写不进插件目录**（实测 node_modules 不可写，npm 更新还会覆盖），
 * 必须放 `%LOCALAPPDATA%`。若不先统一存储层就做下载，会出现
 * 「下载成功但插件找不到」—— 这是本次重构的全部理由。
 *
 * ## 测什么
 *
 * 重点是**优先级**与**回退**：
 *   · 用户目录优先于插件目录（用户能覆盖内置同名音色）
 *   · 用户目录没有时回退到插件目录（内置始终可用）
 *   · 两个都没有时返回 null / false（上层据此降级）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  POOLS,
  voiceKeyOf,
  regions,
  poolDir,
  listWavs,
  listVoiceKeys,
  mergeVoices,
  findVoiceFile,
  hasVoice,
  poolCoverage,
  userPoolDir,
} from '../lib/voice-pack-store.js';

/** 造一个"区域"，写入指定的 wav 文件名。 */
function makeRegion(kind, filesByPool) {
  const root = mkdtempSync(join(tmpdir(), `vps-${kind}-`));
  for (const [pool, names] of Object.entries(filesByPool)) {
    const dir = pool ? join(root, pool) : root;
    mkdirSync(dir, { recursive: true });
    for (const n of names) writeFileSync(join(dir, n), 'RIFF____WAVE');
  }
  return { kind, root, writable: kind === 'user' };
}

// ── V1: 音色 key 推导（命名规则是跨模块契约）────────────────────────────
test('V1: voiceKeyOf 正确剥掉变体后缀', () => {
  const cases = [
    ['zundamon-normal.wav', 'zundamon-normal'],
    ['zundamon-normal~1.wav', 'zundamon-normal'],
    ['zundamon-normal~12.wav', 'zundamon-normal'],
    ['zundamon-normal-kansai-1.wav', 'zundamon-normal'],
    ['zundamon-normal-extra-2.wav', 'zundamon-normal'],
    ['my-voice-ja.wav', 'my-voice-ja'],
  ];
  for (const [input, want] of cases) {
    assert.equal(voiceKeyOf(input), want, `${input} 应推导为 ${want}`);
  }
});

// ── V2: 区域顺序 —— 用户目录必须在前 ────────────────────────────────────
test('V2: regions() 把用户目录排在前（优先级高于插件）', () => {
  const old = process.env.DSH_NOTIFY_SAY_DATA_DIR;
  process.env.DSH_NOTIFY_SAY_DATA_DIR = join(tmpdir(), 'vps-fake-data');
  try {
    const list = regions('C:\\fake\\plugin');
    assert.equal(list.length, 2);
    assert.equal(list[0].kind, 'user', '用户目录必须在第一位 —— 否则下载的音色覆盖不了内置');
    assert.equal(list[1].kind, 'plugin');
    assert.equal(list[0].writable, true);
    assert.equal(list[1].writable, false);
  } finally {
    if (old === undefined) delete process.env.DSH_NOTIFY_SAY_DATA_DIR;
    else process.env.DSH_NOTIFY_SAY_DATA_DIR = old;
  }
});

// ── V3: 池目录拼接 ──────────────────────────────────────────────────────
test('V3: poolDir 空池=根目录，其余加子目录', () => {
  const r = { kind: 'user', root: 'X:\\base', writable: true };
  assert.equal(poolDir(r, ''), 'X:\\base');
  assert.equal(poolDir(r, 'fail'), 'X:\\base\\fail');
});

// ── V4: 目录不存在时返回空数组（不抛）───────────────────────────────────
test('V4: listWavs 对不存在的目录返回空数组', () => {
  const r = { kind: 'user', root: join(tmpdir(), 'vps-does-not-exist-xyz'), writable: true };
  assert.deepEqual(listWavs(r, ''), []);
  assert.deepEqual(listWavs(r, 'fail'), []);
});

// ── V5: 只挑 wav，忽略其它文件 ──────────────────────────────────────────
test('V5: listWavs 只返回 .wav', () => {
  const r = makeRegion('user', { '': ['a.wav', 'readme.md', 'b.WAV', 'c.mp3'] });
  const got = listWavs(r, '').map((x) => x.toLowerCase()).sort();
  assert.deepEqual(got, ['a.wav', 'b.wav'], '.WAV 大小写也应算，mp3/md 不算');
});

// ── V6: 跨池汇总音色 key ────────────────────────────────────────────────
test('V6: listVoiceKeys 汇总全部池并去重', () => {
  const r = makeRegion('user', {
    '': ['zundamon-normal.wav', 'zundamon-normal-kansai-1.wav'],
    fail: ['zundamon-normal~1.wav', 'ankomon~1.wav'],
  });
  assert.deepEqual(listVoiceKeys(r), ['ankomon', 'zundamon-normal']);
});

// ── V7: 合并时用户版本胜出（核心优先级语义）─────────────────────────────
test('V7: mergeVoices 同名音色取前面的区域（用户覆盖内置）', () => {
  const user = makeRegion('user', { '': ['zundamon-normal.wav'] });
  const plugin = makeRegion('plugin', { '': ['zundamon-normal.wav', 'ankomon.wav'] });

  const merged = mergeVoices([user, plugin]);
  const map = new Map(merged.map((m) => [m.key, m]));

  assert.equal(map.get('zundamon-normal').source, 'user',
    '同名时应取用户版本 —— 用户下载的应该覆盖内置的');
  assert.equal(map.get('ankomon').source, 'plugin',
    '只有在插件目录里有的音色，来源应标为 plugin');
});

// ── V8: findVoiceFile 优先精确名，再变体 ────────────────────────────────
test('V8: findVoiceFile 先找精确名，没有再找 ~N 变体', () => {
  const r = makeRegion('user', {
    '': ['zundamon-normal.wav'],
    fail: ['zundamon-normal~1.wav', 'zundamon-normal~2.wav'],
  });
  const doneFile = findVoiceFile([r], 'zundamon-normal', '');
  assert.ok(doneFile.endsWith('zundamon-normal.wav'));

  const failFile = findVoiceFile([r], 'zundamon-normal', 'fail');
  assert.match(failFile, /zundamon-normal~\d\.wav$/,
    'fail 池没有精确名，应回退到 ~N 变体');
});

// ── V9: 用户目录找不到时回退插件目录（内置始终可用）──────────────────────
test('V9: findVoiceFile 在两个区域间回退', () => {
  const user = makeRegion('user', { '': ['only-in-user.wav'] });
  const plugin = makeRegion('plugin', { '': ['only-in-plugin.wav'] });

  assert.ok(findVoiceFile([user, plugin], 'only-in-user', '').includes('only-in-user'));
  assert.ok(findVoiceFile([user, plugin], 'only-in-plugin', '').includes('only-in-plugin'),
    '用户目录没有时必须回退到插件目录 —— 否则内置音色会"消失"');
});

// ── V10: 都没有时返回 null（上层据此降级，不抛）─────────────────────────
test('V10: findVoiceFile 找不到返回 null', () => {
  const r = makeRegion('user', { '': ['a.wav'] });
  assert.equal(findVoiceFile([r], 'no-such-voice', ''), null);
  assert.equal(findVoiceFile([], 'any', ''), null);
});

// ── V11: hasVoice 跨区域判断 ────────────────────────────────────────────
test('V11: hasVoice 任区域任池有即 true', () => {
  const user = makeRegion('user', { '': ['a.wav'] });
  const plugin = makeRegion('plugin', { fail: ['b~1.wav'] });
  const list = [user, plugin];

  assert.equal(hasVoice(list, 'a'), true);
  assert.equal(hasVoice(list, 'b'), true, '只在 fail 池也算有');
  assert.equal(hasVoice(list, 'c'), false);
});

// ── V12: 池覆盖度（供 GUI 显示"完整度"）─────────────────────────────────
test('V12: poolCoverage 报告各池有无', () => {
  const r = makeRegion('user', {
    '': ['zuk.wav'],
    question: ['zuk~1.wav'],
  });
  const cov = poolCoverage([r], 'zuk');
  assert.deepEqual(cov, { done: true, question: true, approval: false, fail: false });
});

// ── V13: userPoolDir 只给路径，不创建目录 ───────────────────────────────
test('V13: userPoolDir 返回路径但不创建目录', () => {
  const old = process.env.DSH_NOTIFY_SAY_DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'vps-nocreate-'));
  process.env.DSH_NOTIFY_SAY_DATA_DIR = dir;
  try {
    const p = userPoolDir('fail');
    assert.ok(p.includes('voice-lines'), '路径应含 voice-lines');
    assert.ok(p.endsWith('fail'));
    // 不该被创建 —— "只是查一下"不该留空目录
    assert.equal(existsSyncSafe(p), false, 'userPoolDir 不应创建目录');
  } finally {
    if (old === undefined) delete process.env.DSH_NOTIFY_SAY_DATA_DIR;
    else process.env.DSH_NOTIFY_SAY_DATA_DIR = old;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── V14: 池集合与 ps1 的 -Kind 对齐 ─────────────────────────────────────
test('V14: POOLS 与 ps1 的 Kind 取值一致', () => {
  assert.deepEqual([...POOLS].sort(), ['', 'approval', 'fail', 'question'].sort(),
    '池集合必须与 dsh-notify.ps1 的 -Kind 可选值一致，否则跨根查找会漏池');
});

/** existsSync 的薄封装（保持测试可读性）。 */
function existsSyncSafe(p) {
  return existsSync(p);
}
