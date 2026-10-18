/**
 * 配置键覆盖检查（v0.4.18）。
 *
 * ## 为什么需要这条"元测试"
 *
 * 本项目反复栽在同一类错误上：**新加一个配置项，但某个环节忘了接**。
 *
 * 已发生 6 次：
 *   v0.4.4  customFiles        写了但 store 白名单没有
 *   v0.4.5  audioSourceByKind  同上
 *   v0.4.10 debounceSeconds    normalizeConfig 算了，effectiveForClient 没映射
 *   v0.4.11 devReload          GUI 有开关，白名单没有
 *   v0.4.16 systemSound        同上
 *   v0.4.18 voiceGain          又漏了 effectiveForClient（用户实测发现）
 *
 * 每次症状都一模一样：**设置能改，但保存后回读是旧值/默认值**，
 * 用户以为"功能不存在"，我要花好几轮才定位。
 *
 * 人工"记得每次都改全"是不可靠的（已经证明漏了 6 次）。
 * 所以改成**机器检查**：每个 CONFIG_KEYS 里的键，
 * 都必须能在 effectiveForClient 的输出里找到。
 *
 * ## 为什么用"造一个全值 cfg"的方式测
 *
 * 直接读源码字符串太脆（改名/重构就误报）。
 * 这里构造一个所有字段都有值的内部 cfg，跑一遍映射，
 * 然后检查输出里有没对应键 —— 这是**行为级**检查，抗重构。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CONFIG_KEYS } from '../lib/config-store.js';
import { effectiveForClient } from '../lib/index.js';

/**
 * 造一个**每个已知字段都有值**的内部 cfg。
 *
 * 键名是 normalizeConfig 的输出形状（内部名，如 debounceMs），
 * 不是 schema 键名。新增字段时这里也要补 —— 但即使忘了补，
 * 只要 effectiveForClient 里有映射，本测试仍会通过（因为测试只查输出）。
 */
function mkFullCfg() {
  const KINDS = ['done', 'fail', 'question', 'approval', 'blocked'];
  const cap = (k) => k.charAt(0).toUpperCase() + k.slice(1);
  const dict = (v) => Object.fromEntries(KINDS.map((k) => [k, v]));
  return {
    // 基础
    voice: true, voiceMode: 'fixed', voiceName: 'zundamon-normal', volume: 80,
    notifyOnComplete: true, notifyOnError: true, notifyOnBlocked: true,
    notifyOnAborted: true, notifyOnApproval: true, notifyOnQuestion: true,
    subagents: true, idleGate: true,
    // 音源
    audioSource: 'tts', showToast: true, ttsVoice: 'X', ttsRate: 1,
    jumpWhenBackground: true, jumpWhenForeground: true, devReload: true,
    // 冷却
    debounceMs: 1000, globalCooldownMs: 2000, idleGateTimeoutMs: 3000,
    // v0.4.16 增益
    voiceGain: 2.5, normalizeCustomAudio: true,
    // 按事件字典
    audioSourceByKind: dict('tts'),
    ttsTexts: dict('台词'),
    customFiles: dict('D:\\a.wav'),
    kindTtsVoice: dict('V'),
    kindTtsRate: dict(1),
    kindVoiceMode: dict('fixed'),
    kindVoiceName: dict('N'),
    kindSystemSound: dict('Beep'),
  };
}

// ── K1: 核心保证 —— 每个配置键都能从 effectiveForClient 读回来 ───────────
test('K1: CONFIG_KEYS 里的每个键都能从 effectiveForClient 读回', () => {
  const out = effectiveForClient(mkFullCfg());

  // 这两个是"内部字段"而非配置键，不参与比较
  const INTERNAL = new Set(['debounceMs', 'globalCooldownMs', 'idleGateTimeoutMs']);

  const missing = CONFIG_KEYS.filter((k) => {
    if (INTERNAL.has(k)) return false;
    // 出现即为映射成功（值可能 undefined 但键应存在）
    return !(k in out);
  });

  assert.deepEqual(missing, [],
    '以下配置键在 effectiveForClient 里没有映射 —— '
    + 'GUI 会读不到值、保存后显示默认值（本项目已因此栽过 6 次）：\n  '
    + missing.join('\n  '));
});

// ── K2: 映射出的值必须与输入一致（防"键在但值错"）───────────────────────
test('K2: 映射后的值与内部 cfg 一致', () => {
  const out = effectiveForClient(mkFullCfg());
  assert.equal(out.voiceGain, 2.5);
  assert.equal(out.normalizeCustomAudio, true);
  assert.equal(out.volume, 80);
  assert.equal(out.audioSource, 'tts');
  assert.equal(out.debounceSeconds, 1, '1000ms 应映射成 1 秒');
  assert.equal(out.globalCooldownSeconds, 2);
});

// ── K3: 默认值也必须能读回（不只是"设过才有"）───────────────────────────
test('K3: 空配置时关键默认值仍可读（前端要显示默认、不能一片 undefined）', () => {
  const out = effectiveForClient({});
  // 增益必须有合理默认，否则滑杆位置无从确定
  assert.equal(typeof out.voiceGain, 'number',
    'voiceGain 必须给出数值，否则滑杆无法定位');
  assert.ok(out.voiceGain >= 1 && out.voiceGain <= 4);
  assert.equal(typeof out.normalizeCustomAudio, 'boolean');
});
