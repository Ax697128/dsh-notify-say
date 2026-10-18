/**
 * 日志隐私测试（v0.4.34）。
 *
 * ## 为什么这个特性需要测试
 *
 * 默认档"不记内容"是**安全属性**，一旦有人改坏了，不会有任何报错，
 * 只会在某天用户上传的日志里悄悄出现项目名和客户名。
 *
 * 所以这里既测纯函数，也测**源码接线**：
 *   · 函数：分级、脱敏规则
 *   · 接线：敏感调用点是否真的传了 detail、ps1 是否真的按级别写
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LEVELS,
  normalizeLevel,
  isDebug,
  redactText,
  formatLogLine,
  sanitizeDiagnostics,
  shortenSessionId,
  diagnosticsHeader,
} from '../lib/log-privacy.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8');
const PS1 = readFileSync(join(ROOT, 'dsh-notify.ps1'), 'utf8');
const STORE = readFileSync(join(ROOT, 'lib', 'config-store.js'), 'utf8');

// ── L1: 级别归一化容错 ──────────────────────────────────────────────────
test('L1: normalizeLevel 对非法值一律退回 info（安全默认）', () => {
  for (const v of [undefined, null, '', 'INFO', 'Debug', 'verbose', 123, {}]) {
    const got = normalizeLevel(v);
    assert.ok(got === 'info' || got === 'debug', `${String(v)} 应归一化`);
  }
  // 关键：不认识的值必须是 info（不能因为拼错就变成 debug）
  for (const v of ['debg', 'DEBUG ', 'true', 1]) {
    assert.equal(normalizeLevel(v), 'info',
      `非法值 ${JSON.stringify(v)} 必须退回 info —— 否则拼错一个字母就变成"记录敏感内容"`);
  }
  assert.equal(normalizeLevel('debug'), 'debug');
  assert.equal(normalizeLevel('DEBUG'), 'debug');
});

// ── L2: redactText —— 默认档不给内容，只给长度 ─────────────────────────
test('L2: redactText 默认档只返回长度，debug 档返回原文', () => {
  const secret = '客户A的方案已完成';
  const info = redactText(secret, 'info');
  assert.doesNotMatch(info, /客户A/, '默认档不得泄露内容');
  assert.match(info, /len=\d+/, '默认档应给出长度（可用于判断"有没有"）');

  const dbg = redactText(secret, 'debug');
  assert.match(dbg, /客户A/, 'debug 档应返回原文');
});

// ── L3: formatLogLine 按级别处理敏感键 ─────────────────────────────────
test('L3: formatLogLine 对敏感键分级处理', () => {
  const fields = { text: '机密内容', voice: '默认', rate: 0 };

  const infoLine = formatLogLine({ tag: 'tts-plan', fields, level: 'info' });
  assert.doesNotMatch(infoLine, /机密内容/, '默认档不得出现台词');
  assert.match(infoLine, /voice=默认/, '非敏感字段应保留（诊断需要）');
  assert.match(infoLine, /rate=0/);

  const dbgLine = formatLogLine({ tag: 'tts-plan', fields, level: 'debug' });
  assert.match(dbgLine, /机密内容/, 'debug 档应含台词');
});

// ── L4: 诊断脱敏 —— 用户名与路径 ───────────────────────────────────────
test('L4: sanitizeDiagnostics 去掉用户名与绝对路径', () => {
  const raw = [
    'log=C:\\Users\\alice\\AppData\\Local\\dsh-notify-say\\notify.log',
    'src=E:\\projects\\my-secret-project\\lib\\index.js',
    'home=/home/bob/.config/x',
    'token=abcdefghijklmnopqrstuvwxyz0123456789ABCDEF',
  ].join('\n');

  const out = sanitizeDiagnostics(raw);
  assert.doesNotMatch(out, /alice/, '用户名必须被替换');
  assert.doesNotMatch(out, /bob/, 'POSIX 用户名也要替换');
  assert.doesNotMatch(out, /my-secret-project/, '绝对路径必须整体替换');
  assert.doesNotMatch(out, /abcdefghijklmnopqrstuvwxyz/, '长 token 必须替换');
  assert.match(out, /<user>/, '应保留 <user> 标记（让用户知道这里原本是用户名）');
});

// ── L5: 脱敏不能把结构搞乱（分段替换会拼接错乱）────────────────────────
test('L5: 脱敏结果不应出现片段拼接（如 <path><user>）', () => {
  const raw = 'C:\\Users\\alice\\AppData\\Local\\x.log';
  const out = sanitizeDiagnostics(raw);
  assert.doesNotMatch(out, /<path><user>/, '不得出现 <path><user> 这种拼接');
  assert.match(out, /C:\\Users\\<user>\\/, '应保留 C:\\Users\\<user>\\ 结构');
});

// ── L6: 会话 id 只留前缀 ────────────────────────────────────────────────
test('L6: shortenSessionId 只保留前 6 位', () => {
  assert.equal(shortenSessionId('abcdef1234567890'), 'abcdef…');
  assert.equal(shortenSessionId('abc'), 'abc');
  assert.equal(shortenSessionId(''), '(none)');
});

// ── L7: 诊断头部不含用户内容 ────────────────────────────────────────────
test('L7: diagnosticsHeader 只含环境信息', () => {
  const h = diagnosticsHeader({
    version: '0.4.34', nodeVersion: 'v24.0.0', platform: 'win32',
    logLevel: 'info', now: '2026-10-18T00:00:00Z',
  });
  assert.match(h, /pluginVersion: 0\.4\.34/);
  assert.match(h, /已自动脱敏/, '头部必须声明已脱敏');
  assert.match(h, /仍请自行检查/, '必须提醒用户自己再看一遍');
});

// ── L8: 源码接线 —— appendNotifyLog 支持 detail 分级 ────────────────────
test('L8: index.js 的 appendNotifyLog 有 detail 分级', () => {
  assert.match(INDEX, /function appendNotifyLog\(message, opts\)/,
    '签名应支持 opts');
  assert.match(INDEX, /if \(opts && opts\.detail && !isDebug\(cfg\.logLevel\)\) return;/,
    '含内容的行在非 debug 档必须直接丢弃（不是脱敏，是不记）');
});

// ── L9: 台词正文那处调用必须分级 ────────────────────────────────────────
test('L9: tts-plan 的台词正文只在 debug 档记录', () => {
  const at = INDEX.indexOf('台词正文只在 debug 档记录');
  assert.ok(at > 0, '应有明确注释说明为什么分级');
  const seg = INDEX.slice(at, at + 700);
  assert.match(seg, /isDebug\(cfg\.logLevel\)/, '应判断级别');
  assert.match(seg, /\{ detail: true \}/, 'debug 分支应标 detail');
  assert.match(seg, /redactText\(/, '非 debug 分支应用 redactText');
});

// ── L10: ps1 侧 —— 参数与辅助函数 ───────────────────────────────────────
test('L10: ps1 有 -LogLevel 参数且默认 info', () => {
  assert.match(PS1, /\[ValidateSet\('info', 'debug'\)\]/,
    'ps1 应限制取值（防拼错）');
  assert.match(PS1, /\[string\]\$LogLevel = 'info'/,
    '默认必须是 info');
});

// ── L11: ps1 侧 —— Detail 只在 debug 档写 ───────────────────────────────
test('L11: Write-NotifyLog 的 Detail 受级别控制', () => {
  assert.match(PS1, /function Write-NotifyLog/,
    '应有统一的日志写入函数（避免三处各判断、漏一处）');
  const at = PS1.indexOf('function Write-NotifyLog');
  const seg = PS1.slice(at, at + 800);
  assert.match(seg, /\$LogLevel -eq 'debug'/, 'debug 档才写 Detail');
  assert.match(seg, /内容已隐藏/, '非 debug 档应留可见标记（让用户知道有内容被隐藏）');
});

// ── L12: ps1 的三个调用点都走统一函数 ──────────────────────────────────
test('L12: ps1 的 toast/FALLBACK/preview 都走 Write-NotifyLog', () => {
  // 不该再有裸 Add-Content 写日志
  const bare = PS1.match(/Add-Content -Path \$logFile/g) || [];
  assert.equal(bare.length, 1,
    `除 Write-NotifyLog 内部那一处外，不应再直接 Add-Content（实际 ${bare.length} 处）`);

  for (const tag of ['toast', 'FALLBACK', 'preview']) {
    assert.match(PS1, new RegExp(`Write-NotifyLog '${tag}'`),
      `${tag} 应走统一函数`);
  }
});

// ── L13: logLevel 必须完成五处接线 ─────────────────────────────────────
test('L13: logLevel 的五处接线齐全', () => {
  const schema = readFileSync(join(ROOT, 'lib', 'config-schema.js'), 'utf8');
  assert.match(schema, /logLevel: 'info'/, 'FIELD_DEFAULTS 应有默认值');
  assert.match(schema, /logLevel: z\.union/, 'schema 应有字段定义');
  assert.match(STORE, /logLevel: \(v\) =>/, 'config-store RULES 应有校验');
  assert.match(INDEX, /logLevel: g\.logLevel/, 'effectiveForClient 应有映射');
});

// ── L14: 前端把 logLevel 传给 ps1 ──────────────────────────────────────
test('L14: index.js 构造 ps1 参数时传 -LogLevel', () => {
  const hits = INDEX.match(/args\.push\('-LogLevel'/g) || [];
  assert.ok(hits.length >= 2,
    `两处参数构造（notifyArgs / baseNotifyArgs）都应传 -LogLevel，实际 ${hits.length} 处`);
  assert.match(INDEX, /cfg\.logLevel === 'debug' \? 'debug' : 'info'/,
    '传值应显式归一化（不把未定义值传过去）');
});

// ── L15: GUI 必须有日志级别开关（否则用户切不了）───────────────────────
test('L15: 设置页有日志级别下拉，且 debug 项明确标注风险', () => {
  const CLIENT = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');

  assert.match(CLIENT, /logLevel/,
    '前端应读写 logLevel');
  assert.match(CLIENT, /只记元数据（默认）/,
    '应有一档明确的"只记元数据"选项');
  assert.match(CLIENT, /含台词正文（可能敏感）/,
    'debug 选项必须写明风险 —— 不能让用户无意中开启记录敏感内容');
  assert.match(CLIENT, /可能敏感/,
    '选择 debug 时应有额外提醒');
});