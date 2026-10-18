/**
 * 语音包可用性判定测试（v0.4.15）。
 *
 * ## 这里踩过的坑
 *
 * 用户选 `audioSource=bundled`，实际播放的却是系统蜂鸣。
 * 诊断日志显示：
 *
 *   `[voice-check] exists=true wav=-3 dir=E:\...\sounds\voice-lines`
 *
 * `existsSync` 为 true，但 `readdirSync` **抛异常**（-3 是 catch 标记）。
 * 原因是**宿主进程运行在沙箱里，fs 读取受限**；而 `dsh-notify.ps1`
 * 是独立子进程、不受此约束 —— 所以 ps1 明明能读到 103 个 wav 并正常播放，
 * 宿主却判定"没有语音包"，把用户主动选择降级成了蜂鸣。
 *
 * ## 核心原则
 *
 * **判断不了 ≠ 没有。** 只有"目录明确不存在"才是确定的坏状态；
 * 读取失败必须乐观放行，由真正能读的 ps1 裁决。
 *
 * 这些用例直接测 `effectiveSource` 的回退链——它是"选语音包却听蜂鸣"的决策点。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { effectiveSource, resolveSource } from '../lib/audio-source.js';

// ── V1: 判定为可用时必须保持 bundled，绝不回退 ────────────────────────────
test('V1: hasBundledVoice=true 时保持 bundled（不回退到 system）', () => {
  const r = effectiveSource('bundled', {
    hasTtsVoice: true, hasBundledVoice: true, hasCustomFile: false,
  });
  assert.equal(r.source, 'bundled', '用户选了语音包就该放语音包');
  assert.equal(r.fellBack, false, '不该发生回退');
  assert.equal(r.from, 'bundled');
});

// ── V2: 确实没有语音包时才回退（这是正确的降级）──────────────────────────
test('V2: hasBundledVoice=false 时回退到 system', () => {
  const r = effectiveSource('bundled', {
    hasTtsVoice: true, hasBundledVoice: false, hasCustomFile: false,
  });
  assert.equal(r.source, 'system');
  assert.equal(r.fellBack, true);
});

// ── V3: 关键——"读取失败"必须传 true，不能传 false ─────────────────────────
// hasVoiceLine 在 readdirSync 抛异常时应返回 true。这里锁住它的后果：
// 只要传 true，就不会降级成蜂鸣。
test('V3: 沙箱读不到文件时（应传 true）不会降级为蜂鸣', () => {
  // 模拟 hasVoiceLine 修复后的返回值：读不了 -> true
  const readFailedAssumeYes = true;
  const r = effectiveSource('bundled', {
    hasTtsVoice: true,
    hasBundledVoice: readFailedAssumeYes,
    hasCustomFile: false,
  });
  assert.equal(r.source, 'bundled',
    '读不到不等于没有；降级会把用户选的语音包变成蜂鸣（实测事故）');
});

// ── V4: resolveSource 在无覆盖时返回全局 bundled ──────────────────────────
test('V4: 无按事件覆盖时 resolveSource 返回全局音源', () => {
  assert.equal(resolveSource('done', { audioSource: 'bundled', audioSourceByKind: {} }), 'bundled');
  assert.equal(resolveSource('fail', { audioSource: 'bundled' }), 'bundled');
});

// ── V5: 按事件覆盖优先于全局（且不影响其它事件）──────────────────────────
test('V5: 按事件覆盖只作用于该事件', () => {
  const cfg = { audioSource: 'bundled', audioSourceByKind: { fail: 'system' } };
  assert.equal(resolveSource('done', cfg), 'bundled', 'done 仍用语音包');
  assert.equal(resolveSource('fail', cfg), 'system', 'fail 用系统音');
});

// ── V6: 回退链最终不会返回空 ──────────────────────────────────────────────
test('V6: 任何组合下 effectiveSource 都返回合法音源', () => {
  const sources = ['tts', 'bundled', 'system', 'custom', 'none'];
  const avails = [
    { hasTtsVoice: true, hasBundledVoice: true, hasCustomFile: true },
    { hasTtsVoice: true, hasBundledVoice: false, hasCustomFile: false },
    { hasTtsVoice: false, hasBundledVoice: false, hasCustomFile: false },
  ];
  for (const src of sources) {
    for (const av of avails) {
      const r = effectiveSource(src, av);
      assert.ok(sources.includes(r.source),
        `${src} + ${JSON.stringify(av)} 返回了非法音源: ${r.source}`);
    }
  }
});
