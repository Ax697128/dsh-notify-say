/**
 * 音源解析（纯函数，无 IO、无副作用）。
 *
 * ## 四种音源
 *
 * | id         | 来源                                   | 需要下载 |
 * |------------|----------------------------------------|----------|
 * | `tts`      | Windows SAPI 实时合成中文台词           | 零       |
 * | `bundled`  | `sounds/voice-lines/` 下的 VOICEVOX 语音包 | 按音色   |
 * | `system`   | `SystemSounds` 系统提示音               | 零       |
 * | `none`     | 不发声，只弹 Toast                      | 零       |
 *
 * 外加 `custom`：用户自己指定的音频文件（不复制、只记路径）。
 *
 * ## 两层继承（本模块的核心）
 *
 * 用户可能想让"完成"用日语语音包、而"出错"用系统警告音。所以音源是**按事件可覆盖**的：
 *
 *     audioSource          全局默认
 *     audioSourceByKind    { fail: 'system', question: 'custom' }   ← 只存偏离默认的
 *
 * 解析规则只有一行：**该事件有覆盖就用覆盖，否则用全局默认，再否则用 'tts'**。
 * 这样配置里只存差异，改动全局默认不会影响已单独设置过的事件。
 *
 * ## 为什么单独成模块
 *
 * 这段逻辑决定了"到底播什么"，是最容易写错、也最值得测的部分。
 * 抽成纯函数后，可以在没有宿主、没有音频设备的环境里穷举所有组合。
 */

/** 支持的音源 id。 */
export const AUDIO_SOURCES = Object.freeze(['tts', 'bundled', 'system', 'custom', 'none']);

/** 事件类型（与 ps1 的 -Kind 取值一致；'chime' 是内部兜底，不对外露出）。 */
export const AUDIO_KINDS = Object.freeze(['done', 'fail', 'question', 'approval', 'blocked']);

/** 默认音源：TTS（零下载即可说话）。 */
export const DEFAULT_SOURCE = 'tts';

/**
 * 各音源在「该事件没有单独设置」时的兜底顺序。
 *
 * 例：用户选了 `bundled` 但没下载任何语音包 → 没有音频可播 → 退到 `system`，
 * 这样**任何配置组合都保证有声音**（除非用户显式选 `none`）。
 */
export const FALLBACK_CHAIN = Object.freeze({
  bundled: ['system', 'none'],
  custom: ['system', 'none'],
  tts: ['system', 'none'],
  system: ['none'],
  none: [],
});

/** `SystemSounds` 的语义映射：失败类用低沉警告音，成功类用轻快音。 */
export const SYSTEM_SOUND_BY_KIND = Object.freeze({
  done: 'Asterisk',
  approval: 'Question',
  question: 'Question',
  fail: 'Hand',
  blocked: 'Exclamation',
});

/** 合法音效名（与 .NET SystemSounds 的属性名一致）。 */
export const SYSTEM_SOUNDS = Object.freeze(['Asterisk', 'Beep', 'Exclamation', 'Hand', 'Question']);

/**
 * 把任意输入收敛成合法音源 id。
 *
 * @param {any} v
 * @param {string} [fallback]
 * @returns {string}
 */
export function normalizeSource(v, fallback = DEFAULT_SOURCE) {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return AUDIO_SOURCES.includes(s) ? s : fallback;
}

/**
 * 把任意输入收敛成「按事件覆盖」的字典。
 *
 * 只保留：合法事件名 + 合法音源 + 与全局默认**不同**的项。
 * 与默认相同的项直接丢掉 —— 让配置保持最小，也避免"改了默认却对某些事件无效"的困惑。
 *
 * @param {any} raw
 * @param {string} [globalDefault]
 * @returns {Record<string, string>}
 */
export function normalizeByKind(raw, globalDefault = DEFAULT_SOURCE) {
  const out = {};
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const g = normalizeSource(globalDefault);
  for (const kind of AUDIO_KINDS) {
    const v = raw[kind];
    if (typeof v !== 'string') continue;
    const s = v.trim().toLowerCase();
    if (!AUDIO_SOURCES.includes(s)) continue;
    if (s === g) continue;          // 与默认相同 → 不存
    out[kind] = s;
  }
  return out;
}

/**
 * 解析某个事件最终用哪个音源。
 *
 * @param {string} kind 事件类型
 * @param {object} cfg 至少含 `audioSource` 与 `audioSourceByKind`
 * @returns {string} 音源 id
 */
export function resolveSource(kind, cfg) {
  const globalDefault = normalizeSource(cfg && cfg.audioSource);
  const byKind = cfg && cfg.audioSourceByKind;
  if (byKind && typeof byKind === 'object' && audioKindOf(kind)) {
    const over = byKind[kind];
    if (typeof over === 'string' && AUDIO_SOURCES.includes(over.trim().toLowerCase())) {
      return over.trim().toLowerCase();
    }
  }
  return globalDefault;
}

/**
 * 把 ps1 的 `-Kind` 值映射到"事件类型"。
 *
 * ps1 用 `chime` 表示"只蜂鸣"（blocked/aborted 走的路径），而配置面上
 * 我们对外只暴露 done/fail/question/approval/blocked 五类。
 *
 * @param {string} psKind
 * @returns {string}
 */
export function audioKindOf(psKind) {
  const k = typeof psKind === 'string' ? psKind.trim().toLowerCase() : '';
  if (k === 'chime') return 'blocked';
  if (k === 'done' || k === 'fail' || k === 'question' || k === 'approval' || k === 'blocked') return k;
  return '';
}

/**
 * 给定音源与实际可用条件，算出**真正该执行**的音源。
 *
 * 这个函数把"用户想要什么"与"现在能拿到什么"分开：GUI 显示用户选的，
 * 播放时用这里算出的。两者不一致时可以通过 `fellBack` 告知用户。
 *
 * @param {string} wanted `resolveSource()` 的结果
 * @param {object} avail 可用性
 * @param {boolean} [avail.hasBundledVoice] 该事件是否有可用的语音包文件
 * @param {boolean} [avail.hasCustomFile]   该事件是否配置了自定义文件
 * @param {boolean} [avail.hasTtsVoice]     系统是否有可用的 TTS 发音人
 * @returns {{ source: string, fellBack: boolean, from: string }}
 */
export function effectiveSource(wanted, avail) {
  const a = avail || {};
  const want = normalizeSource(wanted);
  const usable = (s) => {
    if (s === 'tts') return a.hasTtsVoice !== false;     // 默认认为可用
    if (s === 'bundled') return a.hasBundledVoice === true;
    if (s === 'custom') return a.hasCustomFile === true;
    if (s === 'system') return true;
    if (s === 'none') return true;
    return false;
  };
  if (usable(want)) return { source: want, fellBack: false, from: want };

  const chain = FALLBACK_CHAIN[want] || ['system', 'none'];
  for (const s of chain) {
    if (usable(s)) return { source: s, fellBack: true, from: want };
  }
  return { source: 'none', fellBack: true, from: want };
}

/**
 * 该事件应使用哪个系统音效名。
 *
 * @param {string} kind
 * @param {object} [cfg] 可含 `systemSounds: { fail: 'Hand' }`
 * @returns {string}
 */
export function resolveSystemSound(kind, cfg) {
  const raw = cfg && cfg.systemSounds;
  if (raw && typeof raw === 'object') {
    const v = raw[kind];
    if (typeof v === 'string' && SYSTEM_SOUNDS.includes(v)) return v;
  }
  return SYSTEM_SOUND_BY_KIND[kind] || 'Asterisk';
}

/**
 * 该事件应使用哪个自定义文件路径。
 *
 * 只接受绝对路径（盘符或 UNC）；相对路径一律拒绝 —— 播放进程的 cwd 不确定，
 * 相对路径会随启动方式漂移，属于"看起来能用、实际随机失败"的坑。
 *
 * @param {string} kind
 * @param {object} cfg 可含 `customFiles: { done: 'D:\\a.mp3' }`
 * @returns {string} 绝对路径；没有或不合法时返回空串
 */
export function resolveCustomFile(kind, cfg) {
  const raw = cfg && cfg.customFiles;
  if (!raw || typeof raw !== 'object') return '';
  const v = raw[kind];
  if (typeof v !== 'string') return '';
  const p = v.trim();
  if (!p) return '';
  const isAbs = /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p);
  if (!isAbs) return '';
  if (!/\.(wav|mp3|m4a|flac|ogg)$/i.test(p)) return '';
  return p;
}
