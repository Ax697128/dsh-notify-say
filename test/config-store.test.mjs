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
import { tmpdir, homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';

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
import { DSH_HOME_DIR_NAME } from '../lib/dsh-home.js';

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
  // v0.4.88 修复：没有 $DSH_HOME 时**不再**返回空串，而是回落到官方默认 ~/.dsh。
  // 历史 bug：返回空串 → configPath 为空 → 任何保存都 reason:'no-home'，
  // 用户看到「保存失败：no-home」，连切换声音来源都存不下来。
  assert.equal(safeHome({}), join(homedir(), '.dsh'), '没有 DSH_HOME 时应回落到 ~/.dsh');
  assert.equal(safeHome({ DSH_HOME: '' }), join(homedir(), '.dsh'), 'DSH_HOME 为空串时同样回落');
  // 空白串必须视为未设置（官方 resolveRoot 同口径）。否则会拼出 "   \storages\..."
  // 这种相对当前工作目录的无效路径，配置文件会随机落盘。
  assert.equal(safeHome({ DSH_HOME: '   ' }), join(homedir(), '.dsh'), '纯空白应视为未设置');
  assert.equal(safeHome({ DSH_HOME: '\t\n' }), join(homedir(), '.dsh'), '制表/换行也算空白');
  // 前后空白的合法路径要能剥掉空白后使用
  assert.equal(safeHome({ DSH_HOME: '  D:\\DSH  ' }), 'D:\\DSH', '前后空白应被剥掉');
  // null/undefined 的语义是「未提供」，按设计回退到 process.env ——
  // 所以这里不能断言具体值（ci 环境可能真有 DSH_HOME）。只断言类型与幂等。
  assert.equal(typeof safeHome(null), 'string');
  assert.equal(typeof safeHome(undefined), 'string');
  assert.equal(safeHome(null), safeHome(process.env), 'null 应等价于 process.env');

  // home 永远取得到（最差是 ~/.dsh），所以 configPath 不再返回空串。
  assert.match(configPath({}), /config\.json$/, '没有 DSH_HOME 也应给出可用路径');
  assert.match(configPath({ DSH_HOME: 'D:\\DSH' }), /config\.json$/);
  // 路径构成必须是本插件自己的目录
  assert.match(configPath({ DSH_HOME: 'D:\\DSH' }).replace(/\\/g, '/'), /storages\/dsh-notify-say\/config\.json$/);
});

// ── C1b: 回落的优先级与官方 resolveDshHome 一致（防静默漂移）───────────────
test('C1b: home 解析优先级 = $DSH_HOME > ~/.dsh，且空白视为未设置', () => {
  const explicit = 'D:\\ExplicitHome';
  assert.equal(safeHome({ DSH_HOME: explicit }), explicit, '$DSH_HOME 优先于默认值');
  // 官方默认值必须是 <os home>/.dsh（与 DSH_HOME_DIR_NAME 常量一致）
  assert.equal(safeHome({}), join(homedir(), '.dsh'));
  // 回归护栏：这条断言钉住"官方默认目录名"。官方若改名，这里先红，
  // 而不是等用户报「配置存不下来」才发现。
  assert.equal(DSH_HOME_DIR_NAME, '.dsh');
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

// ── C10: 无 $DSH_HOME 时不再失败（v0.4.88 起回落 ~/.dsh）───────────────────
// ⚠️ 这条测试**曾经断言的是相反的行为**（缺 $DSH_HOME → ok:false, reason:'no-home'）。
// 那个"安全降级"其实是 bug 的具象化：用户机器不设这个环境变量，
// 于是设置页任何保存都失败。现在缺环境变量 = 用官方默认 home，属正常路径。
//
// ⚠️ 这条测试**不能断言 `readConfig({}).value` 的具体内容**：
// `{}` 没有 DSH_HOME，会回落到**开发者机器上真实的 `~/.dsh`**，
// 而那个文件的内容取决于此人有没有用过本插件。一旦他保存过一次配置，
// 断言 `deepEqual(value, {})` 就会红 —— 测试在用户机器上必然假失败。
// （2026-10-22 只读审查抓到的正是这条；此处只断言"它不是错误"这一契约。）
// "文件不存在 → 空偏好" 的断言交给 C2，那里用 mkHome() 隔离了真实目录。
test('C10: 缺 $DSH_HOME 时回落到 ~/.dsh，不再返回 no-home', () => {
  const env = {};
  // 回落到 ~/.dsh 后，无论文件在不在，都必须是**成功**（而不是 no-home 错误）
  const r = readConfig(env);
  assert.equal(r.ok, true, '缺 DSH_HOME 不应再是错误路径');
  assert.notEqual(r.reason, 'no-home', '不应再出现 no-home');
  assert.equal(typeof r.value, 'object', '读出来的必须是对象（内容取决于真实 ~/.dsh，不断言）');

  // 路径必须落在 ~/.dsh 下，而不是相对当前工作目录
  const p = configPath(env);
  assert.equal(p, join(homedir(), '.dsh', 'storages', 'dsh-notify-say', 'config.json'));
});

// ── C10b: 回落目标就是官方默认目录，且可正常读写往返 ─────────────────────
// 用**真实的 ~/.dsh 路径**做断言，但**不往那儿写文件**：
// 这条测试只验证"回落算出来的位置对不对"，避免测试污染用户的真实配置。
test('C10b: 回落目标是 ~/.dsh 下的本插件目录，且该路径不依赖 cwd', () => {
  const expected = join(homedir(), '.dsh', 'storages', 'dsh-notify-say', 'config.json');
  assert.equal(configPath({}), expected);
  assert.equal(configPath({ DSH_HOME: '   ' }), expected, '纯空白与"未设置"等价');
  // 必须落在绝对路径上：历史上空白 DSH_HOME 会拼出 "   \storages\..."，
  // 那是相对 cwd 的路径，配置文件会随机落到各个工作目录里。
  assert.ok(isAbsolute(configPath({ DSH_HOME: '   ' })), '必须始终是绝对路径');
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
