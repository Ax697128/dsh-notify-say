/**
 * 日志脱敏与分级（v0.4.34）。
 *
 * ## 为什么需要
 *
 * 2026-10-18 外部审阅指出：日志会记录 **TTS 台词全文、Toast 标题与正文**，
 * 而用户提 Issue 时经常直接上传这个文件。
 *
 * 这些内容可能是：
 *   · 用户自己写的提醒台词（可能含项目名、人名）
 *   · 会话标题（DSH 自动生成，常含任务内容摘要）
 *   · 通知正文（插件写的固定文案，但也可能含任务描述）
 *
 * 它们都不是"运行时诊断"必需的信息。
 *
 * ## 两档设计
 *
 * ```
 * 默认（info）：时间、事件类型、音源、成功/失败、文件数量、错误码
 *              —— 足以定位"为什么不响"，但不含任何用户内容
 * debug：      额外记录台词正文、标题、配置快照
 *              —— 用户主动开启，界面明确提示"可能含敏感信息"
 * ```
 *
 * ## 为什么不做"自动脱敏"而是"分级"
 *
 * 自动脱敏（如把台词替换成 `***`）听起来更好，但：
 *   · 无法判断哪段文本是敏感的（"搞定啦"和"客户A的方案已完成"都可能是台词）
 *   · 脱敏规则本身可能漏（正则永远有边界）
 *
 * 分级更诚实：默认档**不记**，要记就明确告诉用户在记。
 */

/** 日志级别。 */
export const LEVELS = Object.freeze({
  /** 默认：只记元数据，不含用户内容 */
  INFO: 'info',
  /** 用户主动开启：记详细内容，可能含敏感信息 */
  DEBUG: 'debug',
});

/**
 * 归一化日志级别（容错：任何非法值都退回 info）。
 *
 * @param {unknown} v
 * @returns {'info'|'debug'}
 */
export function normalizeLevel(v) {
  return String(v || '').toLowerCase() === 'debug' ? LEVELS.DEBUG : LEVELS.INFO;
}

/**
 * 判断当前是否该记详细内容。
 *
 * @param {unknown} level
 * @returns {boolean}
 */
export function isDebug(level) {
  return normalizeLevel(level) === LEVELS.DEBUG;
}

/** 会话 id 只保留前 6 位（够区分，不足以定位具体会话）。 */
export function shortenSessionId(sid) {
  const s = String(sid || '');
  if (!s) return '(none)';
  return s.length <= 6 ? s : `${s.slice(0, 6)}…`;
}

/**
 * 脱敏文本：默认档用，只给"长度 + 是否为空"，不给内容。
 *
 * debug 档才返回原文。
 *
 * @param {unknown} text
 * @param {unknown} level
 * @returns {string}
 */
export function redactText(text, level) {
  const s = String(text == null ? '' : text);
  if (isDebug(level)) return JSON.stringify(s);
  if (!s) return '(empty)';
  return `(len=${s.length})`;
}

/**
 * 构造一条日志行。
 *
 * @param {object} opts
 * @param {string} opts.tag 事件标签，如 'plan' / 'tts-plan'
 * @param {object} opts.fields 键值对（值会按级别处理）
 * @param {unknown} opts.level
 * @param {string[]} [opts.sensitiveKeys] 哪些键在默认档要脱敏
 * @returns {string}
 */
export function formatLogLine(opts) {
  const { tag, fields, level } = opts;
  const sensitive = new Set(opts.sensitiveKeys || ['text', 'title', 'body', 'line', 'msg']);
  const debug = isDebug(level);

  const parts = [];
  for (const [k, v] of Object.entries(fields || {})) {
    if (v === undefined) continue;
    if (sensitive.has(k)) {
      parts.push(`${k}=${redactText(v, level)}`);
    } else if (typeof v === 'string' && !debug && v.length > 60) {
      // 非敏感的长字符串也截断：可能是意外带进来的内容
      parts.push(`${k}=${v.slice(0, 60)}…`);
    } else {
      parts.push(`${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
    }
  }
  return `[${tag}] ${parts.join(' ')}`;
}

/**
 * 导出诊断信息时用的脱敏：把本机路径与用户名替换掉。
 *
 * 用户上传诊断包时用这个，而不是直接给原始日志。
 *
 * @param {string} text
 * @returns {string}
 */
export function sanitizeDiagnostics(text) {
  let s = String(text || '');

  // 一次性匹配整条 Windows 绝对路径，在回调里决定脱敏方式。
  //
  // 为什么不分两步做（先替换用户名、再替换整条路径）：
  // 分步必然出现片段拼接 —— 第一版得到 `<path><user>\AppData\...`，
  // 既没脱干净又难读。必须"整条路径进、整条替换出"。
  s = s.replace(/[A-Za-z]:\\+[^\s"'<>|]+/g, (p) => {
    // 含 Users/<name> 的路径：保留结构但把用户名去掉
    const m = /^([A-Za-z]:\\+Users\\+)([^\\/]+)/i.exec(p);
    if (m) return m[1] + '<user>' + p.slice(m[0].length);
    return '<path>';
  });

  // POSIX 家目录
  s = s.replace(/(\/home\/)([^/\s]+)/g, '$1<user>');
  s = s.replace(/(\/Users\/)([^/\s]+)/g, '$1<user>');

  // 长 token / base64 形态
  s = s.replace(/\b[A-Za-z0-9_-]{40,}\b/g, '<redacted-long-token>');

  return s;
}

/**
 * 诊断摘要的头部信息（不含任何用户内容）。
 *
 * ## 为什么要带 home 解析结果（v0.4.89）
 *
 * `no-home` 类问题（设置保存全部失败）的根因在**环境**，不在插件逻辑：
 * 用户机器上 `$DSH_HOME` 往往是未设置的，插件必须回落到 `~/.dsh`。
 * 上一个版本只输出插件版本/Node/平台/日志级别 —— 拿到诊断文件后
 * 仍然无法判断「这台机器上 home 是从哪来的、算出来的路径对不对」，
 * 只能来回问用户。所以把 home 的**来历**也写进头部。
 *
 * ⚠️ 这里的值**含用户名路径**，与正文一样必须整体过
 * `sanitizeDiagnostics()`；本函数只负责拼装，不负责脱敏。
 *
 * @param {object} info
 * @param {{ home?: string, source?: string, configPath?: string, exists?: boolean }} [info.home]
 * @returns {string}
 */
export function diagnosticsHeader(info) {
  const h = (info && info.home) || {};

  // home 段：没有传入时明确写「未采集」，不要留空 —— 空白会让人
  // 以为"正常"，而实际上只是这一版还没采。
  const homeLines = h.source
    ? [
      `dshHome: ${h.home || '(empty)'}`,
      `dshHomeSource: ${h.source}`,
      `configPath: ${h.configPath || '(empty)'}`,
      `configExists: ${h.exists === true ? 'yes' : 'no'}`,
    ]
    : ['dshHome: (not collected)'];

  const lines = [
    '# dsh-notify-say 诊断信息',
    '#',
    '# 本文件已自动脱敏：用户名替换为 <user>，绝对路径替换为 <path>。',
    '# 但仍请自行检查一遍再上传。',
    '',
    `pluginVersion: ${info.version || '(unknown)'}`,
    `nodeVersion: ${info.nodeVersion || '(unknown)'}`,
    `platform: ${info.platform || '(unknown)'}`,
    `logLevel: ${normalizeLevel(info.logLevel)}`,
    `generatedAt: ${info.now || new Date().toISOString()}`,
    '',
    '--- 环境 ---',
    '',
    ...homeLines,
    '',
    '--- 日志 ---',
    '',
  ];
  return lines.join('\n');
}
