/**
 * 标量过滤测试：防 "[object Object]" 漏进 PowerShell 参数。
 *
 * ## 为什么这个 bug 值得专门测
 *
 * 2026-10-17 实测：`kindOr()` 从按事件字典取值时，拿到了 schemastery 的
 * **ref 对象**（带 .get() 的包装）。它被原样拼进 PowerShell 的 `-Voice`/`-Rate`
 * 参数，变成字符串 `"[object Object]"`：
 *
 *   - 弹窗**正常**（那部分参数没错）
 *   - 声音**完全静默**（SAPI 收到非法参数，合成失败）
 *
 * 表象是"通知能用但没声音"，非常容易误判成音频设备或播放链路问题。
 * 所以我之前查了半小时音源判断逻辑，真正的原因却在这里。
 *
 * ## 测试策略
 *
 * 直接测 `effectiveForClient` 的输出：它必须只产出**标量**，
 * 任何对象（包括 ref 包装）都要被丢弃或解包成标量。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { effectiveForClient } from '../lib/index.js';

/** 造一个 schemastery 风格的 ref（有 .get()）。 */
function mkRef(value) {
  return {
    __isRef: true,
    get() { return value; },
  };
}

/** 基础 cfg 骨架。 */
function mkCfg(over) {
  return {
    voice: true, volume: 80, audioSource: 'tts', showToast: true,
    voiceMode: 'fixed', voiceName: 'zundamon-normal', ttsVoice: '', ttsRate: 0,
    debounceMs: 60_000, globalCooldownMs: 0,
    audioSourceByKind: {}, ttsTexts: {},
    kindTtsVoice: {}, kindTtsRate: {}, kindVoiceMode: {},
    kindVoiceName: {}, kindSystemSound: {}, customFiles: {},
    ...over,
  };
}

// ── X1: 字典里的 ref 对象必须被解包成标量 ────────────────────────────────
test('X1: 按事件字典里的 ref 对象被解包成标量（不是 [object Object]）', () => {
  const r = effectiveForClient(mkCfg({
    kindTtsVoice: { done: mkRef('Microsoft Huihui Desktop') },
    kindTtsRate: { done: mkRef(-3) },
  }));

  // 关键断言：必须是字符串/数字，不能是对象
  assert.equal(typeof r.kindTtsVoiceDone, 'string',
    `必须解包成字符串，实际 ${typeof r.kindTtsVoiceDone}`);
  assert.equal(r.kindTtsVoiceDone, 'Microsoft Huihui Desktop');
  assert.equal(typeof r.kindTtsRateDone, 'number');
  assert.equal(r.kindTtsRateDone, -3);

  // 绝对不能出现 "[object Object]"
  assert.doesNotMatch(String(r.kindTtsVoiceDone), /\[object Object\]/);
});

// ── X2: 无法解包的对象被丢弃，而不是原样传出 ─────────────────────────────
test('X2: 无法解包的对象被丢弃（宁可跟随全局，也不要脏值）', () => {
  const r = effectiveForClient(mkCfg({
    kindSystemSound: { fail: { some: 'object' } },
    kindVoiceName: { question: ['array'] },
  }));
  assert.equal(r.kindSystemSoundFail, undefined,
    '不可解包的对象应被丢弃，否则会变成 [object Object]');
  assert.equal(r.kindVoiceNameQuestion, undefined);
});

// ── X3: 正常标量照常透传（防过度过滤）────────────────────────────────────
test('X3: 正常标量不受影响', () => {
  const r = effectiveForClient(mkCfg({
    kindSystemSound: { done: 'Asterisk', fail: 'Hand' },
    kindVoiceName: { question: 'ankomon' },
    ttsTexts: { done: '搞定啦' },
    customFiles: { approval: 'D:\\a.wav' },
    kindTtsRate: { done: 5 },
  }));
  assert.equal(r.kindSystemSoundDone, 'Asterisk');
  assert.equal(r.kindSystemSoundFail, 'Hand');
  assert.equal(r.kindVoiceNameQuestion, 'ankomon');
  assert.equal(r.ttsTextDone, '搞定啦');
  assert.equal(r.customFileApproval, 'D:\\a.wav');
  assert.equal(r.kindTtsRateDone, 5);
});

// ── X4: 所有按事件扁平键都必须是标量 ─────────────────────────────────────
test('X4: 所有 kind* / ttsText* / customFile* 输出都是标量', () => {
  // 故意塞入各种类型，看有没有漏出对象
  const r = effectiveForClient(mkCfg({
    kindTtsVoice: { done: mkRef('A'), fail: {}, question: [], approval: null, blocked: 0 },
    kindTtsRate: { done: mkRef(1), fail: 'abc' },
    kindVoiceMode: { done: mkRef('fixed') },
    kindVoiceName: { done: 'x' },
    kindSystemSound: { done: 'Beep' },
    ttsTexts: { done: 'hi', fail: {} },
    customFiles: { done: 'D:\\a.wav', fail: [] },
  }));

  const perKind = Object.keys(r).filter((k) => /^(kind|ttsText|customFile)[A-Z]/.test(k));
  assert.ok(perKind.length > 0, '应有按事件扁平键');

  const bad = perKind.filter((k) => {
    const v = r[k];
    return typeof v === 'object' || Array.isArray(v);
  });
  assert.deepEqual(bad, [],
    '以下按事件键的值是对象，会被 PowerShell 读成 [object Object]：' + JSON.stringify(bad));
});

// ── X5: 解包失败时不能抛异常 ─────────────────────────────────────────────
test('X5: ref.get() 抛异常时不崩，退回全局', () => {
  const boom = { get() { throw new Error('boom'); } };
  let r;
  assert.doesNotThrow(() => {
    r = effectiveForClient(mkCfg({ kindTtsVoice: { done: boom } }));
  });
  assert.equal(r.kindTtsVoiceDone, undefined, '解包失败应丢弃');
});
