/**
 * tts-lines 测试：台词选取与自定义文本校验。
 *
 * 覆盖用户 2026-10-17 的两个要求：
 *   1. "台词随机" —— 不要把同一句念一天
 *   2. "用户能不能自己输一段话" —— 可以，但有长度和格式限制
 *
 * 校验部分尤其重要：自定义文本会经 spawn argv 传给 PowerShell 再交给 SAPI。
 * 虽然 argv 不经 shell 解释（无注入风险），但**超长文本**会让合成拖很久、
 * **换行与控制字符**会让断句怪异，都必须挡掉。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_LINES, FALLBACK_LINE, MAX_TEXT_LEN,
  sanitizeTtsText, pickTtsText,
} from '../lib/tts-lines.js';

// ── T1: 内置库覆盖五种事件且每种多条 ──────────────────────────────────────
test('T1: 内置台词库覆盖五种事件，每种至少 2 条', () => {
  for (const kind of ['done', 'fail', 'question', 'approval', 'blocked']) {
    const pool = DEFAULT_LINES[kind];
    assert.ok(Array.isArray(pool), `${kind} 应有台词库`);
    assert.ok(pool.length >= 2, `${kind} 至少 2 条才谈得上"随机"`);
    for (const s of pool) {
      assert.ok(typeof s === 'string' && s.length > 0, `${kind} 的台词不应为空`);
      assert.doesNotMatch(s, /主人/, `${kind} 的台词不该含"主人"`);
    }
  }
});

// ── T2: 随机确实会取到不同条目 ────────────────────────────────────────────
test('T2: 随机源不同则取到不同台词', () => {
  const kind = 'done';
  const pool = DEFAULT_LINES[kind];
  // 用确定性的 rand 走遍所有下标
  const seen = new Set();
  for (let i = 0; i < pool.length; i++) {
    const r = (i + 0.5) / pool.length;      // 落在第 i 个区间
    seen.add(pickTtsText(kind, {}, () => r));
  }
  assert.equal(seen.size, pool.length, '每个下标都应能取到不同台词');
});

// ── T3: 随机源异常时兜底到第一条，不崩 ────────────────────────────────────
test('T3: 随机源返回异常值时不崩、退回第一条', () => {
  for (const bad of [() => NaN, () => -1, () => 99, () => { throw new Error('x'); }]) {
    let got;
    assert.doesNotThrow(() => { got = pickTtsText('done', {}, bad); });
    assert.equal(got, DEFAULT_LINES.done[0]);
  }
});

// ── T4: 未知事件类型用兜底句 ──────────────────────────────────────────────
test('T4: 未知事件类型返回兜底句', () => {
  assert.equal(pickTtsText('nonsense', {}), FALLBACK_LINE);
  assert.equal(pickTtsText('', {}), FALLBACK_LINE);
  assert.equal(pickTtsText(null, {}), FALLBACK_LINE);
});

// ── T5: 自定义台词优先于内置库 ────────────────────────────────────────────
test('T5: 用户自定义台词优先', () => {
  const cfg = { ttsTexts: { done: '我自己的台词' } };
  assert.equal(pickTtsText('done', cfg), '我自己的台词');
  // 未自定义的事件仍用内置库
  assert.ok(DEFAULT_LINES.fail.includes(pickTtsText('fail', cfg)));
});

// ── T6: 空白自定义等于没自定义 ────────────────────────────────────────────
test('T6: 空白自定义退回内置库', () => {
  for (const blank of ['', '   ', '\n\t', undefined, null, 123]) {
    const got = pickTtsText('done', { ttsTexts: { done: blank } }, () => 0);
    assert.equal(got, DEFAULT_LINES.done[0], `空白值 ${JSON.stringify(blank)} 应退回内置库`);
  }
});

// ── T7: 自定义文本的清洗 ──────────────────────────────────────────────────
test('T7: 自定义文本会去掉换行与控制字符并压空白', () => {
  assert.equal(sanitizeTtsText('  你好  '), '你好');
  assert.equal(sanitizeTtsText('第一行\n第二行'), '第一行 第二行');
  assert.equal(sanitizeTtsText('a\tb\r\nc'), 'a b c');
  assert.equal(sanitizeTtsText('a\u0000b'), 'a b');
  // 全角空格等不应被误删
  assert.equal(sanitizeTtsText('你好 世界'), '你好 世界');
});

// ── T8: 超长文本被截断 ────────────────────────────────────────────────────
test('T8: 超长自定义文本被截断到上限', () => {
  const long = '很'.repeat(MAX_TEXT_LEN + 50);
  const out = sanitizeTtsText(long);
  assert.equal(out.length, MAX_TEXT_LEN, `应截断到 ${MAX_TEXT_LEN} 字`);
  assert.ok(out.startsWith('很'), '截断后内容应保持');
});

// ── T9: 非字符串输入一律当作"未设置" ──────────────────────────────────────
test('T9: 非字符串输入返回空串（表示未设置）', () => {
  for (const v of [123, true, {}, [], null, undefined, () => {}]) {
    assert.equal(sanitizeTtsText(v), '', `${typeof v} 应返回空串`);
  }
});

// ── T10: 台词长度适合"一句话提醒" ─────────────────────────────────────────
test('T10: 内置台词都足够短（念完约 5 秒内）', () => {
  for (const [kind, pool] of Object.entries(DEFAULT_LINES)) {
    for (const s of pool) {
      assert.ok(s.length <= MAX_TEXT_LEN, `${kind} 的台词过长：${s}`);
      // 经验值：中文 TTS 约 4 字/秒，所以 20 字上下最舒服
      assert.ok(s.length <= 30, `${kind} 的台词建议不超过 30 字：${s}`);
    }
  }
});
