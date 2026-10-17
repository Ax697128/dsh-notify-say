/**
 * TTS 台词库与选取逻辑。
 *
 * ## 为什么要多条而不是一句
 *
 * 固定一句会腻：一天听十几次「任务完成了」，很快就变成噪音。
 * 每条给几句轮换，听感自然得多，且不占空间（TTS 是实时合成的）。
 *
 * ## 用户自定义
 *
 * 用户 2026-10-17 要求："既然是这个 TTS 台词，是不是可以用户去输一段话呀？"
 * 所以每种事件都可以被单条文本覆盖（`ttsTextDone` / `ttsTextFail` …）。
 * 空串表示用内置的台词库。
 *
 * ## 校验（为什么必须做）
 *
 * 自定义文本会直接传给 PowerShell 的 `-Text` 参数，再交给 SAPI 合成。
 * 不加限制会有两个问题：
 *   1. **超长文本**：SAPI 会合成很久，期间占着一个进程；用户写了 1 万字
 *      会变成"点了完成、十秒后才出声"。
 *   2. **换行/控制字符**：文本里有换行会让合成断句怪异；`-Text` 是通过
 *      spawn 的 argv 传的（不经 shell 解释，无注入风险），但过长会被
 *      Windows 的命令行长度上限截断。
 * 所以：限长 + 去掉换行与控制字符 + 去首尾空白。
 */

/** 单条台词的最大字符数。60 字念完约 5 秒，符合"一句话提醒"的定位。 */
export const MAX_TEXT_LEN = 60;

/**
 * 内置台词库。每种事件 3~4 句，随机取一条。
 *
 * 刻意**不含"主人"**（用户 2026-10-17 反馈那样尴尬）。
 * 也不含 emoji 与特殊符号：SAPI 会把它们读成"颜文字"之类，很难听。
 *
 * @type {Record<string, string[]>}
 */
export const DEFAULT_LINES = Object.freeze({
  done: [
    '任务完成了',
    '搞定啦',
    '都做完了',
    '这一轮结束了',
  ],
  fail: [
    '任务失败了，抱歉',
    '出错了，来看看',
    '这一轮没成功',
  ],
  question: [
    '有个问题要问你',
    '需要你来定一下',
    '等你回答',
  ],
  approval: [
    '需要你确认一下',
    '有个操作等你批准',
    '请你过目',
  ],
  blocked: [
    '任务被拦下了',
    '这一轮没能开始',
  ],
});

/** 兜底台词（事件类型未知时）。 */
export const FALLBACK_LINE = '有新消息';

/**
 * 校验并规整用户自定义台词。
 *
 * @param {any} v
 * @returns {string} 合法则返回规整后的文本；空串表示"不自定义，用内置库"
 */
export function sanitizeTtsText(v) {
  if (typeof v !== 'string') return '';
  // 换行、制表、以及所有 C0/C1 控制字符都压成空格：
  // 它们在 SAPI 里会让断句很怪，也会干扰日志。
  let s = v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.length > MAX_TEXT_LEN) s = s.slice(0, MAX_TEXT_LEN).trim();
  return s;
}

/**
 * 为某事件挑一句台词。
 *
 * 优先级：用户自定义（非空） > 内置库随机 > 兜底句。
 *
 * @param {string} kind done | fail | question | approval | blocked
 * @param {object} [cfg] 可含 `ttsTexts: { done: '自定义' }`
 * @param {() => number} [rand] 随机源（测试注入，默认 Math.random）
 * @returns {string}
 */
export function pickTtsText(kind, cfg, rand = Math.random) {
  const k = typeof kind === 'string' ? kind.trim().toLowerCase() : '';

  // 1) 用户自定义优先
  const custom = cfg && cfg.ttsTexts && typeof cfg.ttsTexts === 'object' ? cfg.ttsTexts[k] : '';
  const clean = sanitizeTtsText(custom);
  if (clean) return clean;

  // 2) 内置库随机
  const pool = DEFAULT_LINES[k];
  if (Array.isArray(pool) && pool.length > 0) {
    let i = 0;
    try {
      const r = Number(rand());
      i = Number.isFinite(r) ? Math.floor(r * pool.length) : 0;
    } catch { i = 0; }
    if (!Number.isInteger(i) || i < 0 || i >= pool.length) i = 0;
    return pool[i];
  }

  // 3) 兜底
  return FALLBACK_LINE;
}
