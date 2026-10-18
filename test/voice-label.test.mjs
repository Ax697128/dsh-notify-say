/**
 * 音色友好显示名的一致性测试（v0.4.55）。
 *
 * ## 为什么要这些测试
 *
 * 用户反馈：下拉里显示 `zundamon-normal` 是开发者内部标识，应显示「角色名 · 风格名」。
 *
 * 这个改动本身很小，但它引入了**第二份音色名字**：
 *   ① `tools/build-voice-packs.ps1` 的 `$Approved[].Name`（打包用，权威）
 *   ② `lib/client.js` 的 `VOICE_LABELS`（显示用）
 *
 * 两份名字一旦漂移，用户会在「语音包列表」看到一个名字、
 * 在「音色下拉」看到另一个名字 —— 同一件事两种叫法。
 * 所以必须用测试把它们钉在一起。
 *
 * ## 关键的"不能改"约束
 *
 * 只改显示。**保存提交的仍是原 key** —— 如果哪天有人把 option 的 value
 * 改成友好名，用户的配置就会写入一个后端不认识的字符串。
 * Q3 专门盯这一条。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
const BUILD_PS1 = join(ROOT, 'tools', 'build-voice-packs.ps1');
const hasBuild = existsSync(BUILD_PS1);

/** 解析 client.js 里的 VOICE_KEYS。 */
function voiceKeys() {
  const m = CLIENT.match(/var VOICE_KEYS = \[([\s\S]*?)\n    \]/);
  assert.ok(m, '应能定位 VOICE_KEYS');
  return [...m[1].matchAll(/'([a-z0-9-]+)'/g)].map((x) => x[1]);
}

/** 解析 client.js 里的 VOICE_LABELS。 */
function voiceLabels() {
  const m = CLIENT.match(/var VOICE_LABELS = \{([\s\S]*?)\n    \}/);
  assert.ok(m, '应能定位 VOICE_LABELS');
  const out = {};
  for (const mm of m[1].matchAll(/'([a-z0-9-]+)':\s*'([^']+)'/g)) out[mm[1]] = mm[2];
  return out;
}

/** 解析打包脚本的 $Approved（key → 官方 Name）。 */
function approvedNames() {
  const src = readFileSync(BUILD_PS1, 'utf8');
  const out = {};
  for (const m of src.matchAll(/'([a-z0-9-]+)'\s*=\s*@\{\s*Name\s*=\s*'([^']+)'/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

/** `ずんだもん（ノーマル）` → `ずんだもん`；`四国めたん` → `四国めたん`。 */
function characterOf(official) {
  const m = /^(.+?)（(.+?)）$/.exec(official);
  return m ? m[1] : official;
}

// ── Q1: VOICE_KEYS 每一项都有友好名 ─────────────────────────────────────
test('Q1: 每个可选音色都有友好显示名', () => {
  const keys = voiceKeys();
  const labels = voiceLabels();
  assert.ok(keys.length >= 8, `音色数量偏少（${keys.length}）`);

  const missing = keys.filter((k) => !labels[k]);
  assert.deepEqual(missing, [],
    '这些音色还显示着英文 key（用户看不懂），应补进 VOICE_LABELS：\n' + missing.join('\n'));
});

// ── Q2: 友好名与打包脚本的官方名同源 ────────────────────────────────────
test('Q2: 友好名的角色部分与 build-voice-packs.ps1 一致', () => {
  if (!hasBuild) {
    // 发布包里没有维护者工具，跳过（与 D6/D7 同款处理）
    return;
  }
  const labels = voiceLabels();
  const approved = approvedNames();
  assert.ok(Object.keys(approved).length >= 8, '应能解析出打包脚本的音色表');

  const problems = [];
  for (const [key, official] of Object.entries(approved)) {
    const label = labels[key];
    if (!label) continue;                       // Q1 管缺失
    const wantChar = characterOf(official);
    const gotChar = label.split(' · ')[0];
    if (gotChar !== wantChar) {
      problems.push(`${key}: 显示「${label}」，但打包脚本的角色名是「${wantChar}」`);
    }
  }
  assert.deepEqual(problems, [],
    '两份音色名字漂移了 —— 用户会在不同位置看到不同叫法：\n' + problems.join('\n'));
});

// ── Q3: 保存的仍是原 key，不是友好名 ───────────────────────────────────
test('Q3: 音色下拉的 value 仍是原 key（只改显示）', () => {
  // 如果 value 被改成友好名，用户的配置会写入后端不认识的字符串。
  assert.match(CLIENT, /h\('option', \{ key: k, value: k, title: k \}, voiceLabel\(k\)\)/,
    '固定音色的 option 必须 value=原key、显示=友好名');
  assert.match(CLIENT, /h\('option', \{ key: x, value: x, title: x \}, voiceLabel\(x\)\)/,
    '按事件覆盖的音色 option 同理');
  // 原 key 要能在悬停提示里看到（用户排查问题时需要）
  assert.match(CLIENT, /title: k/, '原 key 应放在 title 里（悬停可见）');
});

// ── Q4: option 显示文本不再直接是 key ──────────────────────────────────
test('Q4: 音色 option 的显示文本走 voiceLabel，不是裸 key', () => {
  // 反面断言：不能再出现 `h('option', { key: k, value: k }, k)` 这种裸 key 显示
  assert.doesNotMatch(CLIENT, /h\('option', \{ key: k, value: k \}, k\)/,
    '固定音色不应再直接显示英文 key');
  assert.doesNotMatch(CLIENT, /h\('option', \{ key: x, value: x \}, x\)/,
    '按事件覆盖的音色不应再直接显示英文 key');

  // 语音包列表也要用统一风格（括号 → 点）
  assert.match(CLIENT, /prettyPackName\(p\.name\)/,
    '语音包列表的官方名应统一成「角色 · 风格」风格');
  assert.match(CLIENT, /function prettyPackName/, '应有 prettyPackName 工具函数');
});
