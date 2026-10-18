/**
 * effectiveForClient 测试：内部 cfg → 前端 schema 形状的映射。
 *
 * ## 为什么单独测这一层
 *
 * 2026-10-17 连续踩了两个坑，都是这一层的：
 *
 * ① `getEffective: () => effectiveForClient()` **忘了传 cfg** ——
 *    返回全空对象，于是界面上所有设置都显示默认值。
 *    用户看到的是"冷却调成 0 却显示 60 秒""选了音源却还是跟随默认"。
 *
 * ② 直接把内部 cfg 交给前端 —— cfg 用毫秒字段名（debounceMs），
 *    前端读秒字段名（debounceSeconds），键名对不上，同样显示默认值。
 *
 * 这两类错误**都不会让任何既有测试失败**，因为它们只影响"读回来的形状"。
 * 所以必须专门测映射函数本身。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { effectiveForClient } from '../lib/index.js';

/** 造一个典型的内部 cfg（normalizeConfig 的产物形状）。 */
function mkCfg(over) {
  return {
    voice: true,
    voiceMode: 'fixed',
    voiceName: 'zundamon-normal',
    volume: 80,
    notifyOnComplete: true,
    notifyOnError: true,
    notifyOnBlocked: true,
    notifyOnAborted: false,
    notifyOnApproval: true,
    notifyOnQuestion: true,
    subagents: false,
    idleGate: true,
    audioSource: 'tts',
    showToast: true,
    ttsVoice: '',
    ttsRate: 0,
    jumpWhenBackground: true,
    jumpWhenForeground: false,
    devReload: false,
    debounceMs: 60_000,
    globalCooldownMs: 0,
    audioSourceByKind: {},
    ttsTexts: {},
    kindTtsVoice: {},
    kindTtsRate: {},
    kindVoiceMode: {},
    kindVoiceName: {},
    kindSystemSound: {},
    customFiles: {},
    ...over,
  };
}

// ── E1: 基础字段直传 ──────────────────────────────────────────────────────
test('E1: 基础字段原样透传', () => {
  const r = effectiveForClient(mkCfg({ volume: 55, voice: false }));
  assert.equal(r.volume, 55);
  assert.equal(r.voice, false);
  assert.equal(r.audioSource, 'tts');
  assert.equal(r.showToast, true);
});

// ── E2: 毫秒 → 秒（关键：键名必须变）──────────────────────────────────────
test('E2: debounceMs 映射成 debounceSeconds（键名与单位都要变）', () => {
  const r = effectiveForClient(mkCfg({ debounceMs: 0, globalCooldownMs: 120_000 }));
  assert.equal(r.debounceSeconds, 0, '60 秒的默认值不能盖掉真实的 0');
  assert.equal(r.globalCooldownSeconds, 120);
  // 内部字段名不应泄漏到前端形状里
  assert.equal(r.debounceMs, undefined, '前端不该看到毫秒字段名');
  assert.equal(r.globalCooldownMs, undefined);
});

// ── E3: 字典 → 扁平键 ────────────────────────────────────────────────────
test('E3: 按事件的字典映射回扁平键', () => {
  const r = effectiveForClient(mkCfg({
    audioSourceByKind: { done: 'tts', fail: 'system' },
    ttsTexts: { done: '搞定啦' },
    kindSystemSound: { fail: 'Hand' },
    kindTtsVoice: { done: 'Microsoft Huihui Desktop' },
    kindVoiceName: { question: 'ankomon' },
    customFiles: { approval: 'D:\\a.wav' },
  }));
  // audioSourceByKind 两种形态都要有
  assert.deepEqual(r.audioSourceByKind, { done: 'tts', fail: 'system' },
    '字典形态要保留（GUI 的按事件覆盖读它）');
  assert.equal(r.kindSourceFail, 'system', '扁平形态也要有（便于排查）');
  assert.equal(r.kindSourceDone, 'tts');
  assert.equal(r.ttsTextDone, '搞定啦');
  assert.equal(r.kindSystemSoundFail, 'Hand');
  assert.equal(r.kindTtsVoiceDone, 'Microsoft Huihui Desktop');
  assert.equal(r.kindVoiceNameQuestion, 'ankomon');
  assert.equal(r.customFileApproval, 'D:\\a.wav');
});

// ── E4: 空字典不产生多余的键 ──────────────────────────────────────────────
test('E4: 字典为空时不产生扁平键（保持响应精简）', () => {
  const r = effectiveForClient(mkCfg());
  assert.deepEqual(r.audioSourceByKind, {});
  assert.equal(r.kindSourceFail, undefined);
  assert.equal(r.ttsTextDone, undefined);
  assert.equal(r.kindSystemSoundFail, undefined);
});

// ── E5: 传 undefined / null 不崩（这就是那个忘传参数的 bug）───────────────
test('E5: 传 undefined/null 时返回空对象而不是抛（防"忘传 cfg"）', () => {
  for (const bad of [undefined, null, 0, '', 'x', []]) {
    let r;
    assert.doesNotThrow(() => { r = effectiveForClient(bad); },
      `传 ${JSON.stringify(bad)} 不应抛`);
    assert.equal(typeof r, 'object');
    assert.ok(r !== null);
  }
});

// ── E6: 忘传 cfg 的后果可被识别 ───────────────────────────────────────────
test('E6: 忘传 cfg 时结果是"全空"，不是"看起来正常"', () => {
  const empty = effectiveForClient();
  // 关键：全空意味着所有值都是 undefined，
  // 前端会因此回落到默认值 —— 这正是用户看到"改了没生效"的原因。
  assert.equal(empty.volume, undefined);
  // debounceSeconds 会算成 0（Number(undefined)||0 → 0），不是 undefined。
  // 这反而是好事：宁可显示 0（关闭），也不要 NaN。
  assert.equal(empty.debounceSeconds, 0);
  assert.deepEqual(empty.audioSourceByKind, {});
});

// ── E7: 非法数值不产生 NaN ───────────────────────────────────────────────
test('E7: 冷却值非法时归零而不是 NaN', () => {
  for (const bad of [undefined, null, NaN, 'abc', -1]) {
    const r = effectiveForClient(mkCfg({ debounceMs: bad }));
    // 用 `=== 0` 而不是 assert.equal：-1/1000 四舍五入得 -0，
    // 而 Node 的严格断言把 -0 与 0 视为不同（Object.is 语义）。
    assert.ok(r.debounceSeconds === 0,
      `debounceMs=${String(bad)} 应归零，实际 ${String(r.debounceSeconds)}`);
    assert.ok(Number.isFinite(r.debounceSeconds), '不该出现 NaN');
  }
});
