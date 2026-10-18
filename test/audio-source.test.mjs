/**
 * audio-source 测试：音源解析的穷举验证。
 *
 * 这块决定"到底播什么"，写错的表现往往是**静默**的（该说话的变成了静音、
 * 该用警告音的用了完成音），用户很难察觉。所以穷举所有组合。
 *
 * 覆盖：
 *  - A1  全局默认解析
 *  - A2  按事件覆盖优先于全局
 *  - A3  与默认相同的覆盖项被丢弃（保持配置最小）
 *  - A4  非法值一律收敛到安全默认，不产生半截脏配置
 *  - A5  回退链：想要的拿不到时，保证仍有声音（除非显式 none）
 *  - A6  ps1 的 chime → blocked 映射
 *  - A7  系统音效的语义映射（失败用警告音，不是完成音）
 *  - A8  自定义文件只接受绝对路径与合法扩展名（防"随机失败"）
 *  - A9  真实场景组合：完成用语音包、失败用系统音（用户举的例子）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUDIO_SOURCES, AUDIO_KINDS, DEFAULT_SOURCE, SYSTEM_SOUNDS,
  normalizeSource, normalizeByKind, resolveSource, audioKindOf,
  effectiveSource, resolveSystemSound, resolveCustomFile,
} from '../lib/audio-source.js';

// ── A1: 全局默认 ────────────────────────────────────────────────────────────
test('A1: 没设置时所有事件都用 tts（零下载即可说话）', () => {
  assert.equal(normalizeSource(undefined), 'tts');
  for (const kind of AUDIO_KINDS) {
    assert.equal(resolveSource(kind, {}), 'tts', `${kind} 应默认 tts`);
    assert.equal(resolveSource(kind, { audioSource: undefined }), 'tts');
  }
  assert.equal(DEFAULT_SOURCE, 'tts');
});

// ── A2: 按事件覆盖 ──────────────────────────────────────────────────────────
test('A2: 按事件覆盖优先于全局默认', () => {
  const cfg = { audioSource: 'tts', audioSourceByKind: { fail: 'system' } };
  assert.equal(resolveSource('fail', cfg), 'system', 'fail 应被覆盖');
  assert.equal(resolveSource('done', cfg), 'tts', '未覆盖的事件跟全局');
  assert.equal(resolveSource('question', cfg), 'tts');
});

// ── A3: 配置最小化 ──────────────────────────────────────────────────────────
test('A3: 与全局默认相同的覆盖项被丢弃', () => {
  const got = normalizeByKind({ done: 'tts', fail: 'system' }, 'tts');
  assert.deepEqual(got, { fail: 'system' },
    'done 与默认相同应被丢掉，只留真正偏离的 fail');
});

// ── A4: 非法值收敛 ──────────────────────────────────────────────────────────
test('A4: 非法音源/事件一律丢弃，不产生脏配置', () => {
  assert.equal(normalizeSource('nonsense'), 'tts');
  assert.equal(normalizeSource(123), 'tts');
  assert.equal(normalizeSource(null), 'tts');

  const got = normalizeByKind({
    done: 'nonsense',        // 非法音源
    fail: 'system',          // 合法
    notAKind: 'system',      // 非法事件名
    question: 123,           // 非法类型
  }, 'tts');
  assert.deepEqual(got, { fail: 'system' }, '只保留唯一合法项');

  // 非对象输入不应崩
  assert.doesNotThrow(() => normalizeByKind(null));
  assert.doesNotThrow(() => normalizeByKind([]));
  assert.deepEqual(normalizeByKind([]), {});
});

// ── A5: 回退链保证"有声音" ─────────────────────────────────────────────────
test('A5: 想要的拿不到时按回退链降级，绝不无声（除非显式 none）', () => {
  // 选了语音包但没下载 → 退到系统音
  let r = effectiveSource('bundled', { hasBundledVoice: false });
  assert.equal(r.source, 'system');
  assert.equal(r.fellBack, true);
  assert.equal(r.from, 'bundled');

  // 有语音包就直接用
  r = effectiveSource('bundled', { hasBundledVoice: true });
  assert.equal(r.source, 'bundled');
  assert.equal(r.fellBack, false);

  // 选了自定义但没配文件 → 退到系统音
  r = effectiveSource('custom', { hasCustomFile: false });
  assert.equal(r.source, 'system');
  assert.equal(r.fellBack, true);

  // TTS 不可用 → 系统音
  r = effectiveSource('tts', { hasTtsVoice: false });
  assert.equal(r.source, 'system');

  // 显式 none → 就是 none，不要自作聪明出声
  r = effectiveSource('none', {});
  assert.equal(r.source, 'none');
  assert.equal(r.fellBack, false);

  // 极端：系统音也被禁（不该发生，但要保证不返回空）
  r = effectiveSource('bundled', { hasBundledVoice: false, hasTtsVoice: false });
  assert.ok(AUDIO_SOURCES.includes(r.source), '必须返回合法音源');
});

// ── A6: chime → blocked 映射 ────────────────────────────────────────────────
test('A6: ps1 的 chime 映射到 blocked 事件', () => {
  assert.equal(audioKindOf('chime'), 'blocked');
  assert.equal(audioKindOf('done'), 'done');
  assert.equal(audioKindOf('fail'), 'fail');
  assert.equal(audioKindOf('approval'), 'approval');
  assert.equal(audioKindOf('question'), 'question');
  assert.equal(audioKindOf('unknown'), '');
  assert.equal(audioKindOf(''), '');
});

// ── A7: 系统音效语义 ───────────────────────────────────────────────────────
test('A7: 系统音效按语义映射（失败用警告音，不用完成音）', () => {
  assert.equal(resolveSystemSound('fail'), 'Hand');
  assert.equal(resolveSystemSound('done'), 'Asterisk');
  assert.equal(resolveSystemSound('question'), 'Question');
  assert.equal(resolveSystemSound('approval'), 'Question');
  assert.equal(resolveSystemSound('blocked'), 'Exclamation');

  // fail 绝不能和 done 同一个音（那会让"失败"听起来像"成功"）
  assert.notEqual(resolveSystemSound('fail'), resolveSystemSound('done'));

  // 用户可覆盖
  assert.equal(resolveSystemSound('done', { systemSounds: { done: 'Beep' } }), 'Beep');
  // 非法值回落到默认
  assert.equal(resolveSystemSound('done', { systemSounds: { done: 'NotASound' } }), 'Asterisk');

  // 所有返回值都必须是合法音效名
  for (const k of AUDIO_KINDS) {
    assert.ok(SYSTEM_SOUNDS.includes(resolveSystemSound(k)), `${k} 应返回合法音效名`);
  }
});

// ── A8: 自定义文件路径校验 ─────────────────────────────────────────────────
test('A8: 自定义文件只接受绝对路径 + 合法扩展名（防随机失败）', () => {
  const ok = { customFiles: { done: 'D:\\sounds\\done.wav' } };
  assert.equal(resolveCustomFile('done', ok), 'D:\\sounds\\done.wav');

  // 相对路径必须拒绝：播放进程 cwd 不确定，会随机失败
  assert.equal(resolveCustomFile('done', { customFiles: { done: 'sounds\\done.wav' } }), '');
  assert.equal(resolveCustomFile('done', { customFiles: { done: './done.wav' } }), '');

  // UNC 路径可接受
  assert.equal(
    resolveCustomFile('done', { customFiles: { done: '\\\\server\\share\\a.wav' } }),
    '\\\\server\\share\\a.wav',
  );

  // 非法扩展名拒绝
  assert.equal(resolveCustomFile('done', { customFiles: { done: 'D:\\a.exe' } }), '');
  assert.equal(resolveCustomFile('done', { customFiles: { done: 'D:\\a.txt' } }), '');

  // 支持的扩展名
  for (const ext of ['wav', 'mp3', 'm4a', 'flac', 'ogg']) {
    assert.ok(resolveCustomFile('done', { customFiles: { done: `D:\\a.${ext}` } }), `应接受 ${ext}`);
  }

  // 大小写不敏感
  assert.ok(resolveCustomFile('done', { customFiles: { done: 'D:\\A.WAV' } }));

  // 缺失/空值不崩
  assert.equal(resolveCustomFile('done', {}), '');
  assert.equal(resolveCustomFile('done', null), '');
});

// ── A9: 用户举的真实场景 ───────────────────────────────────────────────────
test('A9: 用户场景 —— 完成听日语语音包、失败听系统警告音', () => {
  const cfg = {
    audioSource: 'bundled',                    // 默认用语音包
    audioSourceByKind: { fail: 'system' },     // 但失败改成系统音
    systemSounds: { fail: 'Hand' },
    voiceName: 'zundamon-normal',
  };
  assert.equal(resolveSource('done', cfg), 'bundled', '完成用语音包');
  assert.equal(resolveSource('fail', cfg), 'system', '失败用系统音');
  assert.equal(resolveSystemSound('fail', cfg), 'Hand');

  // 失败时不该去拿语音包文件
  const eff = effectiveSource(resolveSource('fail', cfg), { hasBundledVoice: true });
  assert.equal(eff.source, 'system', '即使语音包可用，fail 也走 system');
});
