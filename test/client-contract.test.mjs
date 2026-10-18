/**
 * 客户端代码的静态契约测试（v0.4.23）。
 *
 * ## 为什么需要这一类测试
 *
 * 2026-10-18 外部代码审阅发现：`consumeLastSession()` 返回**字符串**，
 * 调用方却按 `doc.sessionId` 访问 —— 类型不匹配，导致**会话跳转功能
 * 从未生效过**，而且服务端信号已被 consume 清除，连重试机会都没有。
 *
 * 这类 bug 的特点：
 *   · 两端各自"看起来都对"
 *   · 跑起来不报错（只是静默不生效）
 *   · 没有端到端测试就发现不了
 *
 * 所以这里用**源码静态断言**锁住契约。不是替代运行时测试，
 * 而是防止"改一处忘另一处"的回归。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = join(ROOT, 'lib', 'client.js');
const NOTIFY_CONFIG = join(ROOT, 'tools', 'notify-config.ps1');

const client = readFileSync(CLIENT, 'utf8');

// ── C27: consumeLastSession 必须返回对象（不是裸字符串）──────────────────
test('C27: consumeLastSession 返回 {sessionId, at} 对象而非裸字符串', () => {
  const fn = client.match(/function consumeLastSession\(\)[\s\S]*?\n    \}/);
  assert.ok(fn, '应能找到 consumeLastSession 定义');
  const body = fn[0];

  // 必须返回对象字面量
  assert.match(body, /return\s*\{[\s\S]*sessionId:/,
    'consumeLastSession 必须返回含 sessionId 的对象；'
    + '返回裸字符串会让调用方的 doc.sessionId 恒为 undefined（2026-10-18 实际 bug）');

  // 不得再有 `return doc.sessionId`（裸字符串返回）
  assert.doesNotMatch(body, /return\s+doc\.sessionId\s*$/m,
    '不得返回裸字符串 doc.sessionId');
});

// ── C28: 调用方与返回形状必须一致（防单边修改）──────────────────────────
test('C28: 调用方按对象访问 sessionId（与 C27 形状一致）', () => {
  const call = client.match(/consumeLastSession\(\)\.then\(function \(doc\) \{[\s\S]{0,400}/);
  assert.ok(call, '应能找到调用点');
  assert.match(call[0], /doc\.sessionId/,
    '调用方应访问 doc.sessionId —— 每边都应跟着另一边改');
  assert.match(call[0], /!doc \|\| !doc\.sessionId/,
    '应保留空值短路判断');
});

// ── C29: jumpEnabled 必须"读不到配置就不跳" ─────────────────────────────
test('C29: jumpEnabled 读不到配置时两个开关都为 false', () => {
  // 用「从函数名到下一个 function/】」的宽松切片，避免依赖缩进宽度
  const start = client.indexOf('function jumpEnabled()');
  assert.ok(start >= 0, '应能找到 jumpEnabled 定义');
  const rest = client.slice(start);
  const endRel = rest.search(/\n\s*var onVisibility/);
  const body = endRel > 0 ? rest.slice(0, endRel) : rest.slice(0, 2000);

  // 原 bug：cfg.jumpWhenBackground !== false 在 {} 上求值为 true
  //
  // 注意：必须**剥掉注释行**再判断 —— 我们的修复注释里就写了
  // `{}.jumpWhenBackground !== false` 来解释这个 bug，
  // 直接搜全文会误报（第一次跑就是这么挂的）。
  const codeOnly = body
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  assert.doesNotMatch(codeOnly, /jumpWhenBackground\s*!==\s*false/,
    '不得用 `!== false` 判定 —— {} 会得到 true，与"拿不到就不跳"相反');

  // 必须是严格等于 true
  assert.match(body, /jumpWhenBackground:\s*v\.jumpWhenBackground === true/,
    '必须严格判断 === true，缺失/undefined 都不跳');

  // 必须显式处理空配置
  assert.match(body, /Object\.keys\(v\)\.length === 0/,
    '必须显式识别空配置（loadConfig 失败返回 {}）');
});

// ── C30: VOICE_KEYS 不得含许可被禁的音色 ────────────────────────────────
test('C30: GUI 音色列表不含 kasukabe-tsumugi / mochiko', () => {
  const m = client.match(/var VOICE_KEYS = \[[\s\S]*?\]/);
  assert.ok(m, '应能找到 VOICE_KEYS');
  const list = m[0];

  for (const banned of ['kasukabe-tsumugi', 'mochiko']) {
    // 只检查列表本体，注释里提到是可以的（那是解释为什么移除）
    const inList = new RegExp(`'${banned}'`).test(list);
    assert.equal(inList, false,
      `${banned} 不得出现在 GUI 音色列表里 —— `
      + '官方规约禁止再分发（见 docs/audio-audit/README.md）');
  }
});

// ── C31: 安装提示不得指向不存在的脚本 ───────────────────────────────────
test('C31: notify-config.ps1 不指向仓库里不存在的脚本', async () => {
  const { existsSync } = await import('node:fs');
  const src = readFileSync(NOTIFY_CONFIG, 'utf8');

  // 找出所有 "powershell ... -File <某 .ps1>" 的提示
  const refs = [...src.matchAll(/-File\s+\S*?([\w-]+\.ps1)/g)].map((m) => m[1]);
  for (const script of new Set(refs)) {
    const candidates = [
      join(ROOT, 'tools', script),
      join(ROOT, script),
    ];
    const found = candidates.some((p) => existsSync(p));
    assert.ok(found,
      `notify-config.ps1 提示用户运行 ${script}，但仓库里找不到它 —— `
      + '这是"照着做就失败"的文档 bug');
  }
});
