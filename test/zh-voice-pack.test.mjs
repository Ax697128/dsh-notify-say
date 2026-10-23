/**
 * 中文语音包的结构与格式测试（v0.5.1）。
 *
 * ## 为什么需要这些测试
 *
 * 中文音色和日语音色走**完全相同的**播放与打包链路，这意味着任何一处
 * 命名错位都会静默失效：
 *
 *   - 文件名叫错 → 运行时找不到 → 用户切到中文音色后**没有任何声音**，
 *     而且日志里只有一句「没找到 wav」，很难定位。
 *   - 采样率不一致（比如 16000 而不是 24000）→ 播放不变调是运气，
 *     变调了用户只会觉得「这个插件坏了」。
 *   - `-extra-N` / `-kansai-N` 后缀归并不对 → 发布时被当成其他音色裁掉。
 *
 * 这三类问题都不会抛异常，只会让功能默默消失。所以必须用断言盯住。
 *
 * ## 与其他测试的分工
 *
 * `voice-label.test.mjs` 管**显示名与打包脚本一致**（防两份名字漂移）。
 * 本文件管**磁盘上的实际文件**是否合规（防文件本身出问题）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VOICE_DIR = join(ROOT, 'sounds', 'voice-lines');
const BUILD_PS1 = join(ROOT, 'tools', 'build-voice-packs.ps1');
const RELEASE_PS1 = join(ROOT, 'tools', 'release-build.ps1');

// ── 两种环境：自用目录 vs 发布包（npm 用户拿到的）──────────────────────────
//
// ⚠️ 这不是假设，是实测踩到的：2026-10-23 在 `<scratch>/rel-check`
// （release-build.ps1 的产物）里跑 `node --test`，Z1/Z2/Z5/Z6/Z7/Z8 六条全红。
// 原因有两个，都属于「测试假设了开发环境」而不是资产真有问题：
//
//   1. 发布包**只带 1 个中文音色**（zh-soft-female，12 个 wav），
//      而 Z1/Z2 断言四个音色都有文件。
//   2. 发布包的 `tools\` 里**只有 notify-config.ps1**，没有
//      build-voice-packs.ps1 / release-build.ps1（维护者工具不随包发布），
//      所以 Z5~Z8 读不到目标文件。
//
// 外部用户在 GitHub 上跑 `npm test` 看到六条红灯，会以为插件坏了。
// 处理方式与 docs-consistency.test.mjs 的 D6/D7/D8b 完全一致：//   · 结构性断言（Z1/Z2）改为**只校验磁盘上实际存在的音色子集**；
//   · 维护者工具相关断言（Z5~Z8）用 `skip` 明确跳过，不伪装成通过。

/** 发布包里没有维护者打包脚本 → 这些断言无从执行（跳过，不算通过）。 */
const SKIP_DEVONLY = existsSync(BUILD_PS1) && existsSync(RELEASE_PS1)
  ? false
  : 'build-voice-packs.ps1 / release-build.ps1 是维护者工具，不在发布包内';

/**
 * 当前环境「必须存在」的中文音色。
 *
 * 这是本文件的核心判据，2026-10-23 第二轮审查后重写。
 *
 * ⚠️ 上一版是 `presentZhVoices()`：遍历「磁盘上有文件的音色」。审查实测抓到
 * 它的致命退化 —— 把 `zh-mid-male` 整组 12 个 wav 全删，测试**依然全绿**，
 * 因为该音色自动退出了断言范围。判据从「必须存在」变成了「存在的必须合规」。
 * 而 `lib/client.js` 的音色下拉用的是**全量 VOICE_KEYS**（不按已安装过滤），
 * 缺文件的音色照样出现在设置页，用户选中即静音 —— 这正是最该防的静默故障。
 *
 * 现在的判据分两种环境，都是显式的：
 *   · 自用目录（有维护者脚本）→ **4 个必须全在**。删任何一组都红。
 *   · 发布包（无维护者脚本）→ release-build.ps1 只带 1 个，所以「至少 1 个」，
 *     但**有文件的那组必须四池齐全**（半缺一定红）。
 *
 * 为什么不按审查建议的「要么齐全要么整组缺席」：那个规则在自用目录里删整组
 * 同样是绿的，等于没修这个缺陷。
 */
function requiredZhVoices() {
  const all = Object.keys(ZH_VOICES);
  if (existsSync(RELEASE_PS1)) return all;          // 自用目录：一个都不能少
  const present = all.filter((v) => hasAnyWav(v));
  return present;                                     // 发布包：有文件的那几组
}

/** 某个音色在任意池里有 wav 吗。 */
function hasAnyWav(voice) {
  return Object.keys(POOLS).some((pool) => wavsInPool(voice, pool).length > 0);
}

/** 中文音色 key → 期望的中文名（与 build-voice-packs.ps1 的 Name 同源）。 */
const ZH_VOICES = {
  'zh-low-male': '低沉男声',
  'zh-mid-male': '平稳男声',
  'zh-clear-female': '清亮女声',
  'zh-soft-female': '温柔女声',
};

/** 四个池：done 在根目录，其余在子目录。 */
const POOLS = Object.freeze({
  done: '',
  question: 'question',
  approval: 'approval',
  fail: 'fail',
});

/** 读取 WAV 头，返回 { sampleRate, channels, bitsPerSample }。 */
function readWavHeader(path) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(44);
    readSync(fd, buf, 0, 44, 0);
    assert.equal(buf.toString('ascii', 0, 4), 'RIFF', `${path} 不是 RIFF`);
    assert.equal(buf.toString('ascii', 8, 12), 'WAVE', `${path} 不是 WAVE`);
    return {
      channels: buf.readUInt16LE(22),
      sampleRate: buf.readUInt32LE(24),
      bitsPerSample: buf.readUInt16LE(34),
    };
  } finally {
    closeSync(fd);
  }
}

/** 某个音色在某个池里的全部 wav 文件名（按池规则）。 */
function wavsInPool(voice, pool, voiceDir = VOICE_DIR) {
  const dir = POOLS[pool] ? join(voiceDir, POOLS[pool]) : voiceDir;
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => /\.wav$/i.test(f));
  if (pool === 'done') {
    // done 池：<voice>.wav / <voice>-extra-N.wav
    return files.filter((f) =>
      f === `${voice}.wav` || new RegExp(`^${voice}-extra-\\d+\\.wav$`).test(f));
  }
  // 子池：<voice>~N.wav
  return files.filter((f) => new RegExp(`^${voice}~\\d+\\.wav$`).test(f));
}

/**
 * 纯判据：给定一个语音目录，返回「缺池」问题列表。**不读磁盘以外的任何状态。**
 *
 * 抽成纯函数是为了让 Z11 能拿临时目录直接测它 —— 上一版把判据写成
 * 源码文本切片断言（Z9），审查实测既能绕过（加一行 `void presentZhVoices;`
 * 就骗过）又会误报（加一段无关遍历就红）。行为断言才是对的形态。
 *
 * @param {string} voiceDir 语音根目录
 * @param {string[]} required 必须存在的音色 key
 * @returns {string[]} 问题描述，空数组表示通过
 */
function findIncompleteVoices(voiceDir, required) {
  const problems = [];
  if (required.length === 0) {
    problems.push(`一个中文音色都没找到（${voiceDir}）—— 资产真的丢了，不是环境差异`);
    return problems;
  }
  for (const voice of required) {
    const per = {};
    for (const pool of Object.keys(POOLS)) {
      per[pool] = wavsInPool(voice, pool, voiceDir).length;
    }
    const missing = Object.keys(POOLS).filter((pool) => per[pool] === 0);
    if (missing.length === Object.keys(POOLS).length) {
      problems.push(`${voice}: 整组缺席 —— 但设置页的音色下拉是全量 VOICE_KEYS，`
        + `用户选中它会没有任何声音`);
    } else if (missing.length > 0) {
      problems.push(`${voice}: 缺 ${missing.join('/')} 池`
        + `（done=${per.done} q=${per.question} a=${per.approval} f=${per.fail}）`);
    }
  }
  return problems;
}

// ── Z1: 必须存在的中文音色，每个池都要有文件 ──────────────────────────────
test('Z1: 必须存在的中文音色在四个池里都有 wav', () => {
  const required = requiredZhVoices();
  const problems = findIncompleteVoices(VOICE_DIR, required);
  assert.deepEqual(problems, [],
    '中文音色缺文件 —— 运行时找不到会**静默无声**：\n' + problems.join('\n'));
});

// ── Z2: 每个音色恰好 12 条（done 3 + 其余各 3） ────────────────────────────
test('Z2: 每个中文音色正好 12 条台词', () => {
  const problems = [];
  for (const voice of requiredZhVoices()) {
    const per = {};
    let total = 0;
    for (const pool of Object.keys(POOLS)) {
      per[pool] = wavsInPool(voice, pool).length;
      total += per[pool];
    }
    if (total !== 12) {
      problems.push(`${voice}: 共 ${total} 条（done=${per.done} q=${per.question} a=${per.approval} f=${per.fail}）`);
    }
    // 每个池至少 2 条，否则随机轮换等于没有
    for (const pool of ['question', 'approval', 'fail']) {
      if (per[pool] < 2) problems.push(`${voice}/${pool}: 只有 ${per[pool]} 条，轮换不起来`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

// ── Z3: 格式与日语语音包一致（24000 Hz / 单声道 / 16 bit） ─────────────────
test('Z3: 中文 wav 的格式与现有日语语音包一致', () => {
  const bad = [];
  let checked = 0;
  for (const voice of requiredZhVoices()) {
    for (const pool of Object.keys(POOLS)) {
      const dir = POOLS[pool] ? join(VOICE_DIR, POOLS[pool]) : VOICE_DIR;
      for (const f of wavsInPool(voice, pool)) {
        const h = readWavHeader(join(dir, f));
        checked += 1;
        if (h.sampleRate !== 24000 || h.channels !== 1 || h.bitsPerSample !== 16) {
          bad.push(`${pool || 'done'}/${f}: ${h.sampleRate}Hz/${h.channels}ch/${h.bitsPerSample}bit`);
        }
      }
    }
  }
  assert.ok(checked > 0, '没有检查到任何中文 wav');
  assert.deepEqual(bad, [],
    '格式与日语包不一致，播放可能变调或失败（期望 24000Hz/1ch/16bit）：\n' + bad.join('\n'));
});

// ── Z4: 与日语包的量级接近（防止混进长音频） ──────────────────────────────
test('Z4: 单条中文 wav 时长在合理区间（0.8 ~ 4.0 秒）', () => {
  // 只算数据字节数推算时长：PCM_16/24kHz/单声道 → 每秒 48000 字节 + 44 头
  const BYTES_PER_SEC = 24000 * 1 * 2;
  const bad = [];
  for (const voice of requiredZhVoices()) {
    for (const pool of Object.keys(POOLS)) {
      const dir = POOLS[pool] ? join(VOICE_DIR, POOLS[pool]) : VOICE_DIR;
      for (const f of wavsInPool(voice, pool)) {
        const size = statSync(join(dir, f)).size;
        const sec = (size - 44) / BYTES_PER_SEC;
        if (sec < 0.8 || sec > 4.0) bad.push(`${pool || 'done'}/${f}: ${sec.toFixed(2)}s`);
      }
    }
  }
  assert.deepEqual(bad, [],
    '时长异常 —— 过短可能是空文件，过长会让提醒很吵：\n' + bad.join('\n'));
});

// ── Z5: 打包脚本认得这四个音色（否则打不出下载包） ────────────────────────
test('Z5: build-voice-packs.ps1 的审核清单含四个中文音色', { skip: SKIP_DEVONLY }, () => {
  const src = readFileSync(BUILD_PS1, 'utf8');
  const missing = [];
  for (const [key, name] of Object.entries(ZH_VOICES)) {
    // 形如：'zh-low-male' = @{ Name = '低沉男声'; ...
    const re = new RegExp(`'${key}'\\s*=\\s*@\\{\\s*Name\\s*=\\s*'${name}'`);
    if (!re.test(src)) missing.push(`${key}（期望名「${name}」）`);
  }
  assert.deepEqual(missing, [],
    '打包脚本不认这些音色 → 用户下载不到：\n' + missing.join('\n'));
});

// ── Z6: 中文包的 TERMS.md 不能写成 VOICEVOX 生成 ──────────────────────────
test('Z6: 打包脚本按引擎写 TERMS.md，中文包不冒用 VOICEVOX 署名', { skip: SKIP_DEVONLY }, () => {
  // 这是**诚实性**断言，不是格式断言。
  // 中文音频由 EmotiVoice 合成，若 TERMS.md 里写「由 VOICEVOX 生成」，
  // 就是对用户和权利人的双重误导。
  const src = readFileSync(BUILD_PS1, 'utf8');
  assert.match(src, /Engine\s*=\s*'EmotiVoice'/, '中文音色应标注 Engine');
  assert.match(src, /if\s*\(\s*\$meta\.Engine\s*-eq\s*'EmotiVoice'\s*\)/,
    'TERMS.md 生成必须按引擎分支');
  // 分支里提到 EmotiVoice，且提到 Apache-2.0 与 CC BY 4.0 两层许可
  const emoBlock = src.slice(src.indexOf("$meta.Engine -eq 'EmotiVoice'"));
  const block = emoBlock.slice(0, emoBlock.indexOf('} else {'));
  assert.match(block, /EmotiVoice/, '中文分支应说明由 EmotiVoice 生成');
  assert.match(block, /Apache/, '应写明 Apache-2.0');
  assert.match(block, /CC BY 4\.0/, '应写明训练语料的 CC BY 4.0');
  assert.doesNotMatch(block, /VOICEVOX/, '中文分支里不应出现 VOICEVOX');
});

// ── Z7: 发布脚本的 key 归并能认出 -extra-N ────────────────────────────────
test('Z7: release-build.ps1 带宽变体后缀归并，不会把 -extra-N 当成别的音色', { skip: SKIP_DEVONLY }, () => {
  const src = readFileSync(RELEASE_PS1, 'utf8');
  // 必须有 `-(extra|kansai)-N` 这一道，否则 zundamon-normal-extra-1 会被裁掉
  assert.match(src, /-replace\s+'-\(\?:extra\|kansai\)-\\d\+\$'/,
    'release-build.ps1 必须归并 -extra-N / -kansai-N 后缀（v0.5.0 曾因此丢 5 个自带 wav）');
  // 且必须仍保留 ~N 那一道（子池编号）
  assert.match(src, /-replace\s+'~\\d\+\$'/,
    '仍需归并子池的 ~N 后缀');
});

// ── Z8: 自带中文音色的默认 key 与 client.js 的说法一致 ────────────────────
test('Z8: 发布脚本默认自带的中文音色是 zh-soft-female', { skip: SKIP_DEVONLY }, () => {
  const src = readFileSync(RELEASE_PS1, 'utf8');
  assert.match(src, /\$VoiceKey\s*=\s*@\([^)]*'zh-soft-female'/,
    '默认应自带一个中文音色（温柔女声），否则中文用户开箱听到的是日语包念中文');
});

// ── Z11: 判据本身要能失败（行为断言，替代旧的文本切片元测试）──────────────
test('Z11: findIncompleteVoices 对「整组缺席」和「半缺」都必须报错', () => {
  // ## 为什么这条取代了原来的 Z9
  //
  // 旧 Z9 拿 `src.slice(indexOf("test('Z1"), indexOf("test('Z5"))` 切源码文本，
  // 断言里面出现 `presentZhVoices()` 字样。2026-10-23 只读审查实测出两个绕过 +
  // 一个误报：
  //   · 绕过 A：`const voices = Object.keys(ZH_VOICES).slice();` + 一行
  //     `void presentZhVoices;` → 语义回到全量，Z9 仍绿。
  //   · 绕过 B：把 presentZhVoices() 函数体改成 return 全量 key → Z9 仍绿
  //     （函数定义落在切片之外）。
  //   · 误报：在 Z1 里加一段与资产无关的 Object.keys(ZH_VOICES) 遍历 → Z9 立刻红。
  //
  // 结论：文本切片元测试不适合当"判据形态守卫"。改成**行为断言** ——
  // 造临时目录，直接看判据函数在该报错时到底报不报。
  const tmp = mkdtempSync(join(tmpdir(), 'zh-voice-probe-'));

  /** 在临时目录里造一个音色的四池 wav（内容是垃圾，这里只验文件是否存在）。 */
  const makeVoice = (dir, voice, pools) => {
    for (const pool of pools) {
      const sub = POOLS[pool] ? join(dir, POOLS[pool]) : dir;
      mkdirSync(sub, { recursive: true });
      const name = pool === 'done' ? `${voice}.wav` : `${voice}~1.wav`;
      writeFileSync(join(sub, name), 'RIFF----WAVEfmt ');
    }
  };

  try {
    const ALL = Object.keys(POOLS);

    // ① 齐全 → 不报错
    const okDir = join(tmp, 'ok');
    makeVoice(okDir, 'zh-a', ALL);
    assert.deepEqual(findIncompleteVoices(okDir, ['zh-a']), [],
      '四池齐全时不该报错');

    // ② 整组缺席 → 必须报错（这是旧子集判据放过的那类真缺陷）
    const goneDir = join(tmp, 'gone');
    makeVoice(goneDir, 'zh-b', ALL);   // 只有 zh-b，断言要求 zh-a
    const goneProblems = findIncompleteVoices(goneDir, ['zh-a']);
    assert.ok(goneProblems.length > 0, '整组缺席必须报错');
    assert.match(goneProblems.join('\n'), /zh-a.*整组缺席/s,
      '整组缺席的错误信息要指名道姓，否则排查时看不出少了谁');

    // ③ 半缺（有 done 缺 fail）→ 必须报错
    const halfDir = join(tmp, 'half');
    makeVoice(halfDir, 'zh-c', ['done', 'question', 'approval']);
    const halfProblems = findIncompleteVoices(halfDir, ['zh-c']);
    assert.ok(halfProblems.length > 0, '半缺必须报错');
    assert.match(halfProblems.join('\n'), /zh-c.*缺\s*fail/s,
      '半缺的错误信息要指出缺哪个池');

    // ④ 空要求 → 报「资产真的丢了」，不是静默通过
    const emptyProblems = findIncompleteVoices(join(tmp, 'nope'), []);
    assert.equal(emptyProblems.length, 1, '一个必需音色都没有时必须报错，不能空过');
    assert.match(emptyProblems[0], /资产真的丢了/);

    // ⑤ 发布包形态（只剩 1 个音色）不该误报 —— 这是当初引入子集判据的原因
    const packDir = join(tmp, 'pack');
    makeVoice(packDir, 'zh-soft-female', ALL);
    assert.deepEqual(findIncompleteVoices(packDir, ['zh-soft-female']), [],
      '发布包只带 1 个音色时不该报错');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── Z12: 自用目录必须 4 个中文音色全在 ────────────────────────────────────
test('Z12: 自用目录里 4 个中文音色一个都不能少', { skip: SKIP_DEVONLY }, () => {
  // Z11 证明「判据函数」会对整组缺席报错；本条证明「本环境喂给它的要求」是对的。
  // 两件事分开测：判据对 ≠ 输入对。
  const required = requiredZhVoices();
  assert.deepEqual([...required].sort(), Object.keys(ZH_VOICES).sort(),
    '维护者环境必须 4 个中文音色齐全，否则打包时会静默漏传');
});

// ── Z10: GUI 的授权提示必须提到中文音色的引擎 ─────────────────────────────
test('Z10: GUI 授权提示写上中文语音由 EmotiVoice 生成', () => {
  // 为什么这条要独立存在：
  //
  // `client-contract.test.mjs` 的 C33 断言的是 `/VOICEVOX 生成/`。加了中文音色后，
  // 那句文案改成了「日语语音由 VOICEVOX 生成，中文语音由 EmotiVoice 生成」——
  // C33 依然匹配（子串命中），但它**只约束了日语那一半**：如果哪天有人把
  // 「中文语音由 EmotiVoice 生成」删掉、只留日语半句，C33 还是绿的。
  //
  // 而这不是措辞问题：EmotiVoice 是 Apache-2.0，VOICEVOX 音色是各自条款，
  // 把中文音色冒称成 VOICEVOX 生成，就是署名错误（诚实性约束）。
  // 所以这里补一条只盯中文那一半的断言。C33 保持原样，两者互补。
  const client = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
  assert.match(client, /中文语音由 EmotiVoice 生成/,
    'GUI 必须如实写明中文语音由 EmotiVoice 生成，不能只写 VOICEVOX');
  assert.doesNotMatch(client, /这些语音由 VOICEVOX 生成/,
    '不能再笼统地说「这些语音由 VOICEVOX 生成」—— 中文音色不是 VOICEVOX 生成的');
});
