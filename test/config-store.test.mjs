/**
 * config-store 测试：可持久配置层的正确性与 fail-closed 契约。
 *
 * 全部用合成 `$DSH_HOME`（临时目录），**不碰真实 profile / storages**。
 *
 * 覆盖重点（都是真会出事的路径）：
 *  - 三层优先级：文件值覆盖 patch 值，patch 值覆盖 DEFAULTS
 *  - fail-closed：坏 JSON 不被覆盖、不被当成"没有偏好"
 *  - 白名单：未知键丢弃，不会污染配置文件
 *  - 原子写：不留半截文件、不留 .tmp
 *  - 越界值：volume 101 / -1 / NaN 一律拒绝
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CONFIG_VERSION,
  CONFIG_RELATIVE_PATH,
  CONFIG_KEYS,
  safeHome,
  configPath,
  sanitize,
  readConfig,
  writeConfig,
  mergeConfig,
} from '../lib/config-store.js';

/** 造一个隔离的 $DSH_HOME。 */
function mkHome() {
  const dir = mkdtempSync(join(tmpdir(), 'notify-cfg-'));
  return { dir, env: { DSH_HOME: dir } };
}

function cleanup(h) {
  try { rmSync(h.dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

// ── C1: 路径解析 ────────────────────────────────────────────────────────────
test('C1: safeHome / configPath 正确解析 $DSH_HOME（含尾部斜杠）', () => {
  assert.equal(safeHome({ DSH_HOME: 'D:\\DSH' }), 'D:\\DSH');
  assert.equal(safeHome({ DSH_HOME: 'D:\\DSH\\\\' }), 'D:\\DSH');
  assert.equal(safeHome({}), '', '根本没有 DSH_HOME 键时应返回空串');
  assert.equal(safeHome({ DSH_HOME: '' }), '', 'DSH_HOME 为空串时应返回空串');
  // null/undefined 的语义是「未提供」，按设计回退到 process.env ——
  // 所以这里不能断言 ''（ci 环境可能真有 DSH_HOME）。只断言类型与幂等。
  assert.equal(typeof safeHome(null), 'string');
  assert.equal(typeof safeHome(undefined), 'string');
  assert.equal(safeHome(null), safeHome(process.env), 'null 应等价于 process.env');

  assert.equal(configPath({}), '', '$DSH_HOME 缺失时应返回空串而不是拼出相对路径');
  assert.match(configPath({ DSH_HOME: 'D:\\DSH' }), /config\.json$/);
  // 路径构成必须是本插件自己的目录
  assert.match(configPath({ DSH_HOME: 'D:\\DSH' }).replace(/\\/g, '/'), /storages\/dsh-notify-say\/config\.json$/);
});

// ── C2: 文件不存在 = 没有偏好，不是错误 ─────────────────────────────────────
test('C2: 文件不存在时返回 ok:true + 空值（调用方用 patch 默认值）', () => {
  const h = mkHome();
  try {
    const r = readConfig(h.env);
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, {});
  } finally { cleanup(h); }
});

// ── C3: 写入后能读回；白名单外的键被丢弃 ────────────────────────────────────
test('C3: 写入白名单键并读回；未知键被丢弃且不落盘', () => {
  const h = mkHome();
  try {
    const w = writeConfig({ volume: 42, voiceName: 'ankomon', evilKey: 'x', __proto__: 'y' }, h.env);
    assert.equal(w.ok, true, '写入应成功');
    assert.deepEqual(w.written.sort(), ['voiceName', 'volume'], '只应写入白名单键');
    assert.ok(w.dropped === undefined || w.dropped.includes('evilKey'));

    const r = readConfig(h.env);
    assert.equal(r.ok, true);
    assert.equal(r.value.volume, 42);
    assert.equal(r.value.voiceName, 'ankomon');
    assert.equal(r.value.evilKey, undefined, '未知键不得落盘');

    // 磁盘文件里也不该有 evilKey
    const raw = readFileSync(configPath(h.env), 'utf8');
    assert.ok(!raw.includes('evilKey'), '未知键不得出现在文件里');
  } finally { cleanup(h); }
});

// ── C4: 部分写入是合并，不是覆盖 ────────────────────────────────────────────
test('C4: 二次写入只改指定键，其余保留（合并语义）', () => {
  const h = mkHome();
  try {
    writeConfig({ volume: 30, voiceName: 'ankomon' }, h.env);
    writeConfig({ volume: 90 }, h.env);
    const r = readConfig(h.env);
    assert.equal(r.value.volume, 90, 'volume 应被更新');
    assert.equal(r.value.voiceName, 'ankomon', '未指定的键必须保留');
  } finally { cleanup(h); }
});

// ── C5: fail-closed —— 坏文件不被覆盖 ───────────────────────────────────────
test('C5: 磁盘上是坏 JSON 时报告 corrupt，且**不覆盖**用户原文件', () => {
  const h = mkHome();
  try {
    const p = configPath(h.env);
    // 先建目录再写坏内容
    writeConfig({ volume: 50 }, h.env);
    const bad = '{ this is not json';
    writeFileSync(p, bad, 'utf8');

    const r = readConfig(h.env);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'corrupt');

    // 关键：写入必须被拒绝，且原文件字节不变
    const w = writeConfig({ volume: 10 }, h.env);
    assert.equal(w.ok, false, 'corrupt 时写入必须被拒绝');
    assert.equal(w.reason, 'corrupt');
    assert.equal(readFileSync(p, 'utf8'), bad, '坏文件必须原样保留，便于人工救');
  } finally { cleanup(h); }
});

// ── C6: 版本不认识 → 也当 corrupt，不覆盖 ───────────────────────────────────
test('C6: version 不匹配时报告 corrupt，不覆盖', () => {
  const h = mkHome();
  try {
    writeConfig({ volume: 50 }, h.env);
    const p = configPath(h.env);
    writeFileSync(p, JSON.stringify({ version: 999, values: { volume: 1 } }), 'utf8');
    const r = readConfig(h.env);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'corrupt');
    assert.equal(writeConfig({ volume: 2 }, h.env).ok, false, '未知版本不得被覆盖');
  } finally { cleanup(h); }
});

// ── C7: 越界值被拒 ──────────────────────────────────────────────────────────
test('C7: volume 越界/非法被拒，不写坏值', () => {
  const h = mkHome();
  try {
    const bad = sanitize({ volume: 101 });
    assert.equal(bad.value.volume, undefined, 'volume 101 必须被拒');
    assert.equal(sanitize({ volume: -1 }).value.volume, undefined);
    assert.equal(sanitize({ volume: 'abc' }).value.volume, undefined);
    assert.equal(sanitize({ volume: NaN }).value.volume, undefined);
    assert.equal(sanitize({ volume: 0 }).value.volume, 0, '0 是合法值（静音）');
    assert.equal(sanitize({ volume: 100 }).value.volume, 100, '100 是合法值（上限）');
    assert.equal(sanitize({ volume: 50.6 }).value.volume, 51, '小数应取整');
  } finally { /* no home needed */ }
});

// ── C8: 原子写 —— 不留 .tmp / 半截文件 ──────────────────────────────────────
test('C8: 写入后目录里只有 config.json，没有 .tmp 残留', () => {
  const h = mkHome();
  try {
    writeConfig({ volume: 60 }, h.env);
    const dir = join(h.dir, 'storages', 'dsh-notify-say');
    const files = readdirSync(dir);
    assert.deepEqual(files, ['config.json'], '不应留下 .tmp');
    // 文件必须是完整可解析 JSON
    const doc = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    assert.equal(doc.version, CONFIG_VERSION);
    assert.equal(doc.values.volume, 60);
  } finally { cleanup(h); }
});

// ── C9: 三层优先级 ──────────────────────────────────────────────────────────
test('C9: mergeConfig —— 文件值覆盖 patch 值；两者都没有的键不出现', () => {
  const patch = { volume: 80, voiceName: 'zundamon-normal', idleGate: true };
  const file = { volume: 100, voice: false };

  const merged = mergeConfig(patch, file);
  assert.equal(merged.volume, 100, '文件值必须覆盖 patch');
  assert.equal(merged.voice, false, '文件里的布尔也要覆盖');
  assert.equal(merged.voiceName, 'zundamon-normal', '文件没写的键沿用 patch');
  assert.equal(merged.idleGate, true, '文件没写的键沿用 patch');

  // 空 patch / 空 file 不应崩
  assert.deepEqual(mergeConfig(undefined, undefined), {});
  assert.deepEqual(mergeConfig(null, null), {});
  assert.deepEqual(mergeConfig({ a: 1 }, null), { a: 1 });
  assert.deepEqual(mergeConfig({ a: 1 }, { a: 2 }), { a: 2 });
});

// ── C10: 无 $DSH_HOME 时安全降级 ────────────────────────────────────────────
test('C10: 缺 $DSH_HOME 时读写都安全失败，不抛异常', () => {
  const env = {};
  const r = readConfig(env);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-home');
  const w = writeConfig({ volume: 10 }, env);
  assert.equal(w.ok, false);
  assert.equal(w.reason, 'no-home');
});

// ── C11: 白名单键清单稳定（防有人悄悄删键导致 GUI 存的配置被丢）──────────
test('C11: CONFIG_KEYS 覆盖 GUI 需要的全部键', () => {
  const need = ['voice', 'voiceMode', 'voiceName', 'volume',
    'notifyOnComplete', 'notifyOnError', 'notifyOnBlocked',
    'notifyOnApproval', 'notifyOnQuestion', 'subagents', 'idleGate'];
  for (const k of need) {
    assert.ok(CONFIG_KEYS.includes(k), `CONFIG_KEYS 缺少 ${k}`);
  }
});

// ── S12-S15: v0.4.4 自定义音频路径校验 ────────────────────────────────────
// 自定义音频只记**绝对路径**，不复制文件。所以路径校验就是唯一的安全边界：
// 放行错了会让播放进程去读任意位置；放行相对路径则会随 cwd 漂移而随机失败。

test('S12: customFile* 接受绝对路径（盘符与 UNC）', () => {
  const a = sanitize({ customFileDone: 'D:\\Music\\a.mp3' });
  assert.equal(a.value.customFileDone, 'D:\\Music\\a.mp3');

  const b = sanitize({ customFileFail: '\\\\server\\share\\b.wav' });
  assert.equal(b.value.customFileFail, '\\\\server\\share\\b.wav');

  // 支持的扩展名
  for (const ext of ['wav', 'mp3', 'm4a', 'flac', 'ogg', 'WAV']) {
    const r = sanitize({ customFileDone: `D:\\a.${ext}` });
    assert.ok(r.value.customFileDone, `应接受 .${ext}`);
  }
});

test('S13: customFile* 拒绝相对路径（防随 cwd 随机失败）', () => {
  for (const p of ['relative.mp3', './a.wav', 'sounds\\a.wav', '..\\a.wav']) {
    const r = sanitize({ customFileDone: p });
    assert.equal(r.value.customFileDone, undefined, `应拒绝: ${p}`);
  }
});

test('S14: customFile* 拒绝设备命名空间前缀与非法扩展名', () => {
  // \\?\ 与 \\.\ 能绕开路径规范化，必须挡掉
  for (const p of ['\\\\?\\C:\\a.wav', '\\\\.\\PhysicalDrive0']) {
    const r = sanitize({ customFileDone: p });
    assert.equal(r.value.customFileDone, undefined, `应拒绝设备前缀: ${p}`);
  }
  // 非法扩展名
  for (const p of ['D:\\a.exe', 'D:\\a.txt', 'D:\\a.bat']) {
    const r = sanitize({ customFileDone: p });
    assert.equal(r.value.customFileDone, undefined, `应拒绝扩展名: ${p}`);
  }
});

test('S15: 五个事件的 customFile 键都可写', () => {
  const patch = {
    customFileDone: 'D:\\a.wav',
    customFileFail: 'D:\\b.wav',
    customFileQuestion: 'D:\\c.wav',
    customFileApproval: 'D:\\d.wav',
    customFileBlocked: 'D:\\e.wav',
  };
  const r = sanitize(patch);
  assert.deepEqual(Object.keys(r.value).sort(), Object.keys(patch).sort(),
    '五个事件键都应被白名单接受（否则配置存不进去，用户选了文件也不生效）');
});
