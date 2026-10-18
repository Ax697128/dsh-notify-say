/**
 * 语音包存储层（v0.4.29）。
 *
 * ## 为什么需要这个文件
 *
 * 2026-10-18 外部审阅指出：**三处代码各自硬编码「插件安装目录」**：
 *
 *   lib/index.js          → hasVoiceLine() 查 <plugin>/sounds/voice-lines
 *   dsh-notify.ps1        → 播放脚本从 <plugin>/sounds/voice-lines 找
 *   tools/notify-config.ps1 → Remove-VoicePack 直接删 <plugin>/sounds/voice-lines
 *
 * 自用没问题，但**下载功能写不进插件目录**（实测：node_modules 不可写，
 * npm 更新时还会被覆盖）。所以必须先有统一的存储层，否则会出现
 * 「下载成功但插件找不到音色」。
 *
 * ## 两个区域
 *
 * ```
 * ① 插件目录（只读，随 npm 安装）
 *    <plugin>/sounds/voice-lines/<key>.wav
 *
 * ② 用户目录（可写，下载与自定义）
 *    %LOCALAPPDATA%/dsh-notify-say/voice-lines/<key>.wav
 * ```
 *
 * **查找顺序：用户目录优先，插件目录兜底。**
 * 这样用户下载的音色能覆盖内置同名音色，而内置音色始终可用。
 *
 * ## 为什么不放 $DSH_HOME/storages
 *
 * 那是配置目录。语音包是几十 MB 的二进制资产，塞进配置区会污染
 * 备份/迁移/体积统计。`%LOCALAPPDATA%` 是 Windows 上用户级应用数据的标准位置。
 *
 * ## 设计约束（重要）
 *
 * · **纯函数优先**：路径计算、候选文件列举都不读盘（便于测试）
 * · **不碰网络**：下载逻辑留给上层，这里只管"文件放哪、怎么找"
 * · **失败安全**：读不到目录时返回空数组，不抛异常
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 语音包的三个子池 + 根池（done）。 */
export const POOLS = Object.freeze(['', 'question', 'approval', 'fail']);

/**
 * 用户级语音包根目录。
 *
 * Windows: `%LOCALAPPDATA%\dsh-notify-say\voice-lines`
 * 其他平台: `$XDG_DATA_HOME/dsh-notify-say/voice-lines` 或 `~/.local/share/...`
 *
 * 允许通过环境变量覆盖 —— 测试与"便携模式"都需要。
 *
 * @returns {string}
 */
export function userVoiceRoot() {
  const override = process.env.DSH_NOTIFY_SAY_DATA_DIR;
  if (override && String(override).trim()) {
    return join(String(override).trim(), 'voice-lines');
  }
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData && String(localAppData).trim()) {
    return join(String(localAppData).trim(), 'dsh-notify-say', 'voice-lines');
  }
  // 兜底：XDG / HOME
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && String(xdg).trim()) {
    return join(String(xdg).trim(), 'dsh-notify-say', 'voice-lines');
  }
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home && String(home).trim()) {
    return join(String(home).trim(), '.dsh-notify-say', 'voice-lines');
  }
  // 最后兜底：相对当前工作目录（几乎不该走到）
  return join('.dsh-notify-say', 'voice-lines');
}

/**
 * 一个区域的根目录（含所有池）。
 *
 * @typedef {{ kind: 'user'|'plugin', root: string, writable: boolean }} Region
 */

/**
 * 建立区域列表，**用户目录在前**（优先级高）。
 *
 * @param {string} pluginRoot 插件安装目录
 * @returns {Region[]}
 */
export function regions(pluginRoot) {
  const list = [];
  const user = userVoiceRoot();
  if (user) list.push({ kind: 'user', root: user, writable: true });
  if (pluginRoot) {
    list.push({
      kind: 'plugin',
      root: join(pluginRoot, 'sounds', 'voice-lines'),
      writable: false,
    });
  }
  return list;
}

/**
 * 某个区域的某个池目录。
 *
 * @param {Region} region
 * @param {string} pool '' = done 池
 * @returns {string}
 */
export function poolDir(region, pool) {
  return pool ? join(region.root, pool) : region.root;
}

/**
 * 列举某区域某池里的 wav（不递归）。
 *
 * 读不到目录时返回空数组 —— 沙箱限制、目录不存在都算"没有"。
 *
 * @param {Region} region
 * @param {string} pool
 * @returns {string[]} 文件名（不是全路径）
 */
export function listWavs(region, pool) {
  const dir = poolDir(region, pool);
  try {
    if (!existsSync(dir)) return [];
    if (!statSync(dir).isDirectory()) return [];
    return readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.wav'));
  } catch {
    return [];
  }
}

/**
 * 从文件名推出音色 key。
 *
 * 命名规则（沿用现状）：
 *   zundamon-normal.wav           → zundamon-normal
 *   zundamon-normal~1.wav         → zundamon-normal   （fail/question/approval 池的变体）
 *   zundamon-normal-kansai-1.wav  → zundamon-normal   （风格变体）
 *   zundamon-normal-extra-2.wav   → zundamon-normal
 *
 * @param {string} filename
 * @returns {string}
 */
export function voiceKeyOf(filename) {
  const base = String(filename).replace(/\.wav$/i, '');
  return base
    .replace(/~\d+$/, '')
    .replace(/-(?:extra|kansai)-\d+$/, '');
}

/**
 * 列出某区域里**所有**出现过的音色 key（跨全部池）。
 *
 * @param {Region} region
 * @returns {string[]} 去重、排序
 */
export function listVoiceKeys(region) {
  const seen = new Set();
  for (const pool of POOLS) {
    for (const f of listWavs(region, pool)) {
      const k = voiceKeyOf(f);
      if (k) seen.add(k);
    }
  }
  return [...seen].sort();
}

/**
 * 合并多个区域的音色清单。
 *
 * **前面的区域优先**（用户目录在前）。返回的每一项标注它来自哪个区域，
 * 上层据此判断"这个是内置的还是用户下的"。
 *
 * @param {Region[]} regionList
 * @returns {Array<{ key: string, source: string, writable: boolean }>}
 */
export function mergeVoices(regionList) {
  const byKey = new Map();
  for (const r of regionList) {
    for (const key of listVoiceKeys(r)) {
      // 先到先得 —— 用户目录在前，所以同名时用户版本胜出
      if (!byKey.has(key)) {
        byKey.set(key, { key, source: r.kind, writable: r.writable });
      }
    }
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * 查找某个音色在某个池里的**实际文件全路径**。
 *
 * 查找顺序：
 *   1. 用户目录该池里同名文件（精确名 → 变体）
 *   2. 插件目录该池里同名文件（精确名 → 变体）
 *
 * 与 `dsh-notify.ps1` 的 Pick-RandomWav 逻辑对齐：先精确名，再 `~N` 变体。
 *
 * @param {Region[]} regionList
 * @param {string} key 音色 key
 * @param {string} pool
 * @param {(files: string[]) => string|undefined} [pick] 选择策略（默认取第一个变体）
 * @returns {string|null} 全路径，找不到返回 null
 */
export function findVoiceFile(regionList, key, pool, pick) {
  for (const r of regionList) {
    const files = listWavs(r, pool);
    if (files.length === 0) continue;

    const exact = files.find((f) => f.toLowerCase() === `${key}.wav`.toLowerCase());
    const variants = files.filter((f) => {
      const b = f.replace(/\.wav$/i, '');
      return new RegExp(`^${escapeRe(key)}~\\d+$`, 'i').test(b);
    });

    const candidates = exact ? [exact, ...variants] : variants;
    if (candidates.length === 0) continue;

    const chosen = pick ? pick(candidates) : candidates[0];
    if (chosen) return join(poolDir(r, pool), chosen);
  }
  return null;
}

/**
 * 判断某个音色是否存在于任一区域（任一池）。
 *
 * 这是 `hasVoiceLine()` 的新实现基础。
 *
 * @param {Region[]} regionList
 * @param {string} key
 * @returns {boolean}
 */
export function hasVoice(regionList, key) {
  for (const r of regionList) {
    for (const pool of POOLS) {
      const files = listWavs(r, pool);
      for (const f of files) {
        if (voiceKeyOf(f) === key) return true;
      }
    }
  }
  return false;
}

/**
 * 某音色在**哪些池**里有文件（供 GUI 显示"完整度"）。
 *
 * 例如某音色只有 done 池、没有 fail 池 —— GUI 可以提示。
 *
 * @param {Region[]} regionList
 * @param {string} key
 * @returns {{ done: boolean, question: boolean, approval: boolean, fail: boolean }}
 */
export function poolCoverage(regionList, key) {
  const out = { done: false, question: false, approval: false, fail: false };
  for (const r of regionList) {
    for (const pool of POOLS) {
      if (out[pool || 'done']) continue;
      const files = listWavs(r, pool);
      if (files.some((f) => voiceKeyOf(f) === key)) {
        out[pool || 'done'] = true;
      }
    }
  }
  return out;
}

/**
 * 用户目录的某个池目录（准备写入时用）。
 *
 * 注意：**只返回路径，不创建目录**。创建由调用方在真正要写时做，
 * 避免"只是查一下"却留下空目录。
 *
 * @param {string} pool
 * @returns {string}
 */
export function userPoolDir(pool) {
  const root = userVoiceRoot();
  return pool ? join(root, pool) : root;
}

/** 正则转义。 */
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
