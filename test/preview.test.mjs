/**
 * 试听功能测试（v0.4.17）。
 *
 * ## 为什么要有试听
 *
 * 用户 2026-10-18 指出："是不是少了试听？"
 *
 * 对以下设置来说，试听是**必需品而不是锦上添花**：
 *   · 音量增益（1.0~4.0）—— 光看数字根本不知道多响
 *   · 发音人 / 音色        —— 名字看不出实际声音
 *   · 自定义音频           —— 确认选对了文件
 *   · 按事件覆盖           —— 确认每个事件的声音都对
 *
 * 没有试听就只能盲调，调一次听一次真实通知，效率极低。
 *
 * ## 与「测试通知」的区别（容易混淆，因此写死在这里）
 *
 *   试听     → 只出声，**不弹窗**（ps1 的 -Preview）
 *   测试通知 → 完整 notify()，含 Toast 弹窗
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8');
const CLIENT = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
const PS1 = readFileSync(join(ROOT, 'dsh-notify.ps1'), 'utf8');

// ── P1: host 必须有 preview 端点 ─────────────────────────────────────────
test('P1: host 注册了 /preview 试听端点', () => {
  assert.match(HOST, /head === 'preview'/, 'host 应有 preview 分支');
  // kind 参数用正则从查询串里解析（不写成字面量 '/preview?kind'）
  const start = HOST.indexOf("head === 'preview'");
  const seg = HOST.slice(start, start + 6000);  // 6KB：给限流与多音源分支留够窗口（v0.4.24 加限流后 3KB 不够）
  assert.match(seg, /kind=\(\[a-z\]\+\)/, '应从查询串解析 kind 参数');
});

// ── P2: 试听必须走 -Preview（只出声不弹窗）───────────────────────────────
test('P2: 试听调用 ps1 时带 -Preview（不弹 Toast）', () => {
  // 找到 preview 分支的代码段，确认里面 push 了 '-Preview'
  const start = HOST.indexOf("head === 'preview'");
  assert.ok(start > 0, '应存在 preview 分支');
  const seg = HOST.slice(start, start + 6000);  // 6KB：给限流与多音源分支留够窗口（v0.4.24 加限流后 3KB 不够）
  assert.match(seg, /'-Preview'/, '试听必须传 -Preview，否则会弹窗');
  // 而且不应在 preview 分支里调用 notify()（那会弹窗）
  assert.doesNotMatch(seg, /\bnotify\(/, 'preview 分支不该调用 notify()（会弹 Toast）');
});

// ── P3: 试听要遵循当前音源（tts/bundled/system/custom）────────────────────
test('P3: 试听按当前音源分流（不是无脑播语音包）', () => {
  const start = HOST.indexOf("head === 'preview'");
  const seg = HOST.slice(start, start + 6000);  // 6KB：给限流与多音源分支留够窗口（v0.4.24 加限流后 3KB 不够）
  for (const src of ['tts', 'bundled', 'custom', 'system']) {
    assert.ok(seg.includes(`'${src}'`), `试听应处理 ${src} 音源`);
  }
});

// ── P4: 试听要带上增益（否则调增益时听不出差别）──────────────────────────
test('P4: 试听应用 voiceGain（调增益后能听出差别）', () => {
  const start = HOST.indexOf("head === 'preview'");
  const seg = HOST.slice(start, start + 6000);  // 6KB：给限流与多音源分支留够窗口（v0.4.24 加限流后 3KB 不够）
  assert.match(seg, /-Gain/, '试听必须带 -Gain，否则调增益时听不到变化');
  assert.match(seg, /voiceGain/, '应从配置读 voiceGain');
});

// ── P5: client 必须有试听按钮 ───────────────────────────────────────────
test('P5: GUI 提供试听按钮', () => {
  assert.match(CLIENT, /function previewSound\(/, 'client 应有 previewSound 函数');
  assert.match(CLIENT, /'试听'|试听/, 'GUI 应有试听按钮文案');
  assert.match(CLIENT, /preview\?kind=/, '应请求 preview 端点');
});

// ── P6: 五种事件都能单独试听 ────────────────────────────────────────────
test('P6: 五种事件都能单独试听', () => {
  for (const k of ['done', 'fail', 'question', 'approval', 'blocked']) {
    assert.ok(CLIENT.includes(`['${k}',`) || CLIENT.includes(`'${k}'`),
      `应支持试听 ${k}`);
  }
});

// ── P7: ps1 的 -Preview 不弹窗（实现保证）────────────────────────────────
test('P7: ps1 在 -Preview 模式下不弹 Toast', () => {
  // ps1 里 Preview 分支应只调 Play-VoiceLine，不调 Toast 展示
  const idx = PS1.indexOf('if ($Preview)');
  assert.ok(idx > 0, 'ps1 应有 $Preview 分支');
  const seg = PS1.slice(idx, idx + 800);
  assert.match(seg, /Play-VoiceLine|试听/, 'Preview 分支应播放声音');
  assert.doesNotMatch(seg, /Show-Balloon|Toast\(/, 'Preview 分支不该弹窗');
});
