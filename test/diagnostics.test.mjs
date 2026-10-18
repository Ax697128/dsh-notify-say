/**
 * 诊断导出测试（v0.4.35）。
 *
 * ## 为什么必须测这个
 *
 * 这是**唯一一个"把本机数据写到文件"且用户会主动外发**的功能。
 * 一旦脱敏失效，用户会以为安全、然后把它传到公开 Issue 里。
 *
 * 所以重点不是"能不能导出"，而是：
 *   · 导出的文件里有没有残留用户名 / 路径 / token
 *   · 路由是不是 POST（GET 可被任意网页用 <img> 触发，反复生成文件）
 *   · 头部是否明确提醒"仍需自己检查"
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { exportDiagnostics, readLogText, logDirPath } from '../lib/diagnostics.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8');
const CLIENT = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');

/** 在隔离的临时目录里跑（改 TEMP 环境变量）。 */
async function withTemp(fn) {
  const old = process.env.TEMP;
  const oldTmp = process.env.TMP;
  const dir = join(tmpdir(), `diag-${Math.random().toString(36).slice(2, 10)}`);
  mkdirSync(dir, { recursive: true });
  process.env.TEMP = dir;
  process.env.TMP = dir;
  try {
    return await fn(dir);
  } finally {
    if (old === undefined) delete process.env.TEMP; else process.env.TEMP = old;
    if (oldTmp === undefined) delete process.env.TMP; else process.env.TMP = oldTmp;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** 造一份假日志（含敏感内容）。 */
function seedLog(dir, text) {
  const logDir = join(dir, 'dsh-notify-say');
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, 'notify.log'), text, 'utf8');
  return logDir;
}

// ── G1: 没有日志时给出明确原因（不崩）──────────────────────────────────
test('G1: 没有日志文件时返回 no-log-file', async () => {
  await withTemp(async () => {
    const r = exportDiagnostics({ version: '0.4.35', logLevel: 'info' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'no-log-file');
  });
});

// ── G2: 正常导出（文件真的写出来了）────────────────────────────────────
test('G2: 有日志时导出成功，文件存在且非空', async () => {
  await withTemp(async (dir) => {
    seedLog(dir, '2026-10-18 12:00:00 [plan] kind=done source=bundled\n');
    const r = exportDiagnostics({ version: '0.4.35', logLevel: 'info' });
    assert.equal(r.ok, true, `应成功，实际 ${r.error}`);
    assert.ok(existsSync(r.path), '导出文件应存在');
    assert.ok(r.bytes > 100, '文件不应是空的');
  });
});

// ── G3: 脱敏真的生效（核心）────────────────────────────────────────────
test('G3: 导出文件里没有用户名、绝对路径、长 token', async () => {
  await withTemp(async (dir) => {
    seedLog(dir, [
      'log=C:\\Users\\alice\\AppData\\Local\\dsh-notify-say\\notify.log',
      'src=E:\\secret-project\\lib\\index.js',
      'token=abcdefghijklmnopqrstuvwxyz0123456789ABCDEF',
      'normal [plan] kind=done',
    ].join('\n'));

    const r = exportDiagnostics({ version: '0.4.35', logLevel: 'info' });
    assert.equal(r.ok, true);

    const text = readFileSync(r.path, 'utf8');
    assert.doesNotMatch(text, /alice/, '用户名必须被替换');
    assert.doesNotMatch(text, /secret-project/, '绝对路径必须被替换');
    assert.doesNotMatch(text, /abcdefghijklmnopqrstuvwxyz/, '长 token 必须被替换');
    // 但正常内容要保留（诊断价值）
    assert.match(text, /\[plan\] kind=done/, '非敏感内容应保留');
  });
});

// ── G4: 头部必须声明已脱敏 + 提醒自查 ───────────────────────────────────
test('G4: 导出文件头部声明脱敏范围并提醒自查', async () => {
  await withTemp(async (dir) => {
    seedLog(dir, 'x\n');
    const r = exportDiagnostics({ version: '0.4.35', logLevel: 'debug' });
    const text = readFileSync(r.path, 'utf8');

    assert.match(text, /已自动脱敏/, '必须声明脱敏');
    assert.match(text, /仍请自行检查/, '必须提醒用户自己再看（脱敏不是万能的）');
    assert.match(text, /logLevel: debug/, '应记录导出时的日志级别（debug 说明可能含内容）');
    assert.match(text, /pluginVersion: 0\.4\.35/);
  });
});

// ── G5: 轮转的旧日志也要带上 ───────────────────────────────────────────
test('G5: 有 notify.log.1 时一并导出（事发记录可能在那里）', async () => {
  await withTemp(async (dir) => {
    const logDir = seedLog(dir, 'current line\n');
    writeFileSync(join(logDir, 'notify.log.1'), 'older line from rotation\n', 'utf8');

    const r = exportDiagnostics({ version: '0.4.35', logLevel: 'info' });
    const text = readFileSync(r.path, 'utf8');
    assert.match(text, /older line from rotation/, '轮转的旧日志必须带上');
    assert.match(text, /current line/, '当前日志也要有');
  });
});

// ── G6: 保留策略 —— 不留无限多的导出文件 ───────────────────────────────
test('G6: 多次导出只保留最近几份', async () => {
  await withTemp(async (dir) => {
    seedLog(dir, 'x\n');
    for (let i = 0; i < 8; i++) {
      const r = exportDiagnostics({ version: '0.4.35', logLevel: 'info' });
      assert.equal(r.ok, true);
      // 文件名按秒级时间戳，同秒会覆盖 —— 稍等一下保证 mtime 不同
      await new Promise((res) => setTimeout(res, 15));
    }
    const files = readdirSync(join(dir, 'dsh-notify-say')).filter((f) => /^diagnostics-/.test(f));
    assert.ok(files.length <= 5, `最多保留 5 份，实际 ${files.length}`);
  });
});

// ── G7: readLogText 对不存在目录返回结构化错误 ─────────────────────────
test('G7: readLogText 在无日志时返回结构化错误', async () => {
  await withTemp(async () => {
    const r = readLogText();
    assert.equal(r.ok, false);
    assert.ok(r.error, '应给出原因');
  });
});

// ── G8: 路由必须是 POST（GET 可被网页触发）──────────────────────────────
test('G8: /diagnostics 路由只接受 POST', () => {
  // ⚠️ 注意别匹配到 isWriteRoute 里那处（v0.4.39 后 head === 'diagnostics'
  // 同时出现在写操作判定中）。要定位到真正处理请求的分支。
  const at = INDEX.indexOf("if (head === 'diagnostics') {");
  assert.ok(at > 0, '应有 diagnostics 路由处理分支');
  const seg = INDEX.slice(at, at + 800);
  assert.match(seg, /!== 'POST'/, '必须显式拒绝非 POST');
  assert.match(seg, /405/, '非 POST 应回 405');
  assert.match(seg, /allow: 'POST'/, '应告知正确方法');
});

// ── G9: 路由把版本与级别传进去 ─────────────────────────────────────────
test('G9: 导出时带上插件版本与当前日志级别', () => {
  const at = INDEX.indexOf('exportDiagnostics({');
  assert.ok(at > 0);
  const seg = INDEX.slice(at, at + 300);
  assert.match(seg, /version: PLUGIN_VERSION/, '应传版本');
  assert.match(seg, /logLevel:/, '应传日志级别（debug 导出要标明可能含内容）');
});

// ── G10: 前端有按钮且用 POST ───────────────────────────────────────────
test('G10: 设置页有导出按钮，请求用 POST', () => {
  assert.match(CLIENT, /导出诊断文件/, '应有按钮文案');
  const at = CLIENT.indexOf("apiUrl('diagnostics')");
  assert.ok(at > 0, '应调用 diagnostics 路由');
  const seg = CLIENT.slice(at, at + 300);
  assert.match(seg, /method: 'POST'/, '前端必须用 POST（后端会拒 GET）');
});

// ── G11: 按钮提示里说明脱敏范围与自查 ──────────────────────────────────
test('G11: UI 提示说明会自动脱敏但需自查', () => {
  assert.match(CLIENT, /<user>/, '应说明用户名会被替换');
  assert.match(CLIENT, /<path>/, '应说明路径会被替换');
  assert.match(CLIENT, /仍请自己再看一遍/, '必须提醒自查 —— 脱敏不覆盖用户自己写的内容');
});
