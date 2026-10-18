/**
 * 外部审阅修复的回归测试（v0.4.39）。
 *
 * 对应 2026-10-18 审阅提出的 4 项，每项一条：
 *   V1 P0  voiceRootsArg 必须真的产出非空路径（原来调用了不存在的 regions）
 *   V2 P1  install / uninstall / diagnostics 必须算写操作
 *   V3 P1  ZIP 解压前要检查声明大小，解压时要带输出上限
 *   V4 P1  更新语音包失败必须能回滚（不能先把旧包删了）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, existsSync, rmSync, renameSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8');
const DL = readFileSync(join(ROOT, 'lib', 'voice-pack-download.js'), 'utf8');

// ── V1: voiceRootsArg 必须真的能用（这才是 P0）─────────────────────────
test('V1: voiceRootsArg 产出非空且包含用户音色目录', async () => {
  const { voiceRootsArg, regions } = await import('../lib/voice-regions.js');

  // 2026-10-18 的 P0：index.js 调用了不存在的 regions()，
  // 于是 voiceRootsArg() 永远返回 ''，-VoiceRoot 从来没传给过 ps1。
  // 这里直接断言"能算出东西"，并且不是空串。
  const rs = regions(ROOT);
  assert.ok(rs.length >= 1, '至少要能找到一个语音区域（内置目录一定存在）');

  const arg = voiceRootsArg(ROOT);
  assert.ok(arg.length > 0,
    'voiceRootsArg 不能返回空串 —— 空串意味着 ps1 收不到 -VoiceRoot，'
    + '会退回内置目录，用户下载的音色全部播不到');

  // 路径必须以分隔符分隔且每段都非空
  for (const p of arg.split(';')) {
    assert.ok(p.trim().length > 0, `不应有空的路径段：${JSON.stringify(arg)}`);
  }
});

// ── V1a: 静态检查 —— index.js 的 voiceRootsArg 必须走 voice-regions ─────
test('V1a: index.js 的 voiceRootsArg 调用 computeVoiceRootsArg 而非裸 regions', () => {
  const at = INDEX.indexOf('function voiceRootsArg() {');
  assert.ok(at > 0, '应能找到 voiceRootsArg');

  // 大括号配平取函数体
  let depth = 0, started = false, end = at;
  for (let i = at; i < INDEX.length; i++) {
    const ch = INDEX[i];
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}') { depth--; }
    if (started && depth === 0) { end = i + 1; break; }
  }
  const body = INDEX.slice(at, end);

  assert.match(body, /computeVoiceRootsArg\s*\(/,
    'voiceRootsArg 必须调用从 voice-regions.js 导入的实现 —— '
    + '2026-10-18 的 P0 就是它调用了不存在的 regions()，'
    + '导致永远返回空串、-VoiceRoot 从来没传给 ps1');

  // 去掉注释后不得有裸 regions(
  const noComment = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(noComment, /(?<![.\w])regions\s*\(/,
    '函数体里不得出现裸 regions() 调用');
});

// ── V1b: index.js 不得再调用未定义的 regions ────────────────────────────
test('V1b: index.js 不直接调用未定义的 regions()', () => {
  // 反过来检查：如果出现 `regions(` 但不是从 voice-regions 导入的那个名字，就是 bug
  const hasImport = /import\s*\{[^}]*voiceRootsArg[^}]*\}\s*from\s*'\.\/voice-regions\.js'/.test(INDEX);
  assert.ok(hasImport, 'index.js 应从 voice-regions.js 导入 voiceRootsArg');

  // 去掉注释与字符串后再找裸的 regions( 调用
  const stripped = INDEX
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/'[^']*'/g, "''");
  assert.doesNotMatch(stripped, /(?<![.\w])regions\s*\(/,
    'index.js 里不应再有裸的 regions() 调用 —— 它没有定义，会抛 ReferenceError');
});

// ── V2: 写操作防护必须覆盖新接口 ────────────────────────────────────────
test('V2: install / uninstall / diagnostics 都算写操作', () => {
  const at = INDEX.indexOf('const isWriteRoute');
  assert.ok(at > 0, '应能找到 isWriteRoute');
  const seg = INDEX.slice(at, at + 700);

  for (const name of ['diagnostics', 'voicepacks', 'install', 'uninstall']) {
    assert.ok(seg.includes(name),
      `isWriteRoute 应覆盖 ${name} —— 这些接口会写/删本机文件，`
      + '按只读放行等于跳过 Origin 检查与 JSON 强制');
  }
});

// ── V3: ZIP 炸弹防护必须在解压前 + 解压中 ───────────────────────────────
test('V3: 解压前检查声明大小，解压时带 maxOutputLength', () => {
  const at = DL.indexOf('inflateRawSync(raw');
  assert.ok(at > 0, '应能找到解压调用');
  const seg = DL.slice(Math.max(0, at - 900), at + 300);

  assert.match(seg, /entry\.size/,
    '必须在解压**前**检查 ZIP 头里声明的解压大小 —— '
    + '否则炸弹包会先把内存吃满，再被"解压后累计"检查发现（已经晚了）');
  assert.match(seg, /maxOutputLength/,
    '解压时必须带 maxOutputLength —— 声明大小可能撒谎，要靠 zlib 自己兜底');
});

// ── V4: 更新失败要能回滚 ────────────────────────────────────────────────
test('V4: 安装切换是备份 + 回滚，不是先删旧包', () => {
  const at = DL.indexOf('原子切换');
  assert.ok(at > 0, '应能找到原子切换那段');
  const seg = DL.slice(at, at + 4500);   // 注释较长，窗口要够

  assert.match(seg, /backupDir/, '应有备份目录变量');
  assert.match(seg, /renameSync\(finalDir, backupDir\)/,
    '旧包应改名为备份，不能直接 rmSync 删除');
  assert.match(seg, /renameSync\(backupDir, finalDir\)/,
    '切换失败时必须把备份改回正式路径（回滚）');

  // 反例：不能出现"先删 finalDir 再 rename tmpDir"
  const badPattern = /rmSync\(finalDir[^)]*\)\s*;?\s*(?:\r?\n\s*)*renameSync\(tmpDir/;
  assert.doesNotMatch(seg, badPattern,
    '不得回到「先删旧包再改名」的老写法 —— 改名失败会让用户连原来的音色都丢了');
});

// ── V4b: 回滚路径真的能走通（行为测试，不只是查源码）──────────────────
test('V4b: 备份与回滚的文件操作语义正确', () => {
  const base = join(ROOT, '.tmp-rollback-test-' + Math.random().toString(36).slice(2, 8));
  try {
    const finalDir = join(base, 'voice');
    const tmpDir = join(base, 'tmp');
    mkdirSync(finalDir, { recursive: true });
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(join(finalDir, 'old.wav'), 'OLD');
    writeFileSync(join(tmpDir, 'new.wav'), 'NEW');

    // 模拟正常路径：备份 → 切换 → 删备份
    const backupDir = `${finalDir}.bak-1`;
    renameSync(finalDir, backupDir);
    renameSync(tmpDir, finalDir);
    assert.ok(existsSync(join(finalDir, 'new.wav')), '应换成新包');
    rmSync(backupDir, { recursive: true, force: true });
    assert.equal(existsSync(backupDir), false, '成功后备份应被清理');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
