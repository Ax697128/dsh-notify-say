/**
 * 语音包存储层（v0.4.31 重构：一音色一目录）。
 *
 * ## 目录约定
 *
 * ```
 * ① 内置目录（只读，随 npm 安装）—— **平铺旧布局**
 *    <plugin>/sounds/voice-lines/zundamon-normal.wav        done 池
 *    <plugin>/sounds/voice-lines/fail/zundamon-normal~1.wav fail 池
 *
 * ② 用户目录（可写）—— **一音色一目录**
 *    %LOCALAPPDATA%/dsh-notify-say/voice-lines/
 *      zundamon-normal/
 *        zundamon-normal.wav          done
 *        fail/zundamon-normal~1.wav   fail
 *        question/…  approval/…
 *        TERMS.md   MANIFEST.json
 * ```
 *
 * ## 为什么不再用平铺
 *
 * 内置目录平铺是历史原因（当初只有一套语音，没考虑多音色分发）。
 * 从**用户**角度，一音色一目录明显更好：
 *
 *   · 卸载 = 删一个文件夹。旧方案要按文件名前缀匹配，
 *     删 `zundamon-normal` 时可能连带误删 `zundamon-normal-extra`。
 *   · "我装了哪些"一眼可见，不用在 195 个文件里数前缀。
 *   · 每个音色自带 TERMS.md / MANIFEST.json，不混在一起。
 *
 * ## 怎么做到两种布局共存
 *
 * 关键洞察：**`<key>/` 目录与内置的 `voice-lines/` 根是同构的** ——
 * 两者下面都是「done 平铺 + question/approval/fail 子池」。
 *
 * 所以查找逻辑可以统一：把「一个音色目录」和「内置根」都当作"池容器"，
 * 用同一个函数按池名取目录。差别只在于：
 *   · 内置根里装着**所有**音色 → 需要按 key 过滤文件名
 *   · 音色目录里只有**一个**音色 → 不需要过滤
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 池名（'' = done）。与 dsh-notify.ps1 的 -Kind 取值一致。 */
export const POOLS = Object.freeze(['', 'question', 'approval', 'fail']);

/**
 * 用户级语音包根目录。
 *
 * Windows: `%LOCALAPPDATA%\dsh-notify-say\voice-lines`
 * 可用 `DSH_NOTIFY_SAY_DATA_DIR` 覆盖（测试与便携模式）。
 *
 * @returns {string}
 */
export function userVoiceRoot() {
  const override = process.env.DSH_NOTIFY_SAY_DATA_DIR;
  if (override && String(override).trim()) {
    return join(String(override).trim(), 'voice-lines');
  }
  if (process.env.LOCALAPPDATA && String(process.env.LOCALAPPDATA).trim()) {
    return join(String(process.env.LOCALAPPDATA).trim(), 'dsh-notify-say', 'voice-lines');
  }
  if (process.env.XDG_DATA_HOME && String(process.env.XDG_DATA_HOME).trim()) {
    return join(String(process.env.XDG_DATA_HOME).trim(), 'dsh-notify-say', 'voice-lines');
  }
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home && String(home).trim()) {
    return join(String(home).trim(), '.dsh-notify-say', 'voice-lines');
  }
  return join('.dsh-notify-say', 'voice-lines');
}

/**
 * 内置语音根目录（平铺旧布局）。
 *
 * @param {string} pluginRoot
 * @returns {string}
 */
export function builtinVoiceRoot(pluginRoot) {
  return join(pluginRoot || '.', 'sounds', 'voice-lines');
}

/**
 * 某个"池容器"里的某池目录。
 *
 * 「池容器」有两种：
 *   · 内置根（含全部音色，平铺）
 *   · 单个音色目录（只含一个音色）
 *
 * 两者下面结构相同，所以这里只按池名拼子目录即可。
 *
 * @param {string} base 池容器根
 * @param {string} pool '' = done
 * @returns {string}
 */
export function poolDirOf(base, pool) {
  return pool ? join(base, pool) : base;
}

/**
 * 从文件名推出音色 key。
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

/** 读目录里的 wav 文件名（失败返回空数组）。 */
function wavsIn(dir) {
  try {
    if (!existsSync(dir)) return [];
    if (!statSync(dir).isDirectory()) return [];
    return readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.wav'));
  } catch {
    return [];
  }
}

/**
 * 列出**用户目录里已安装的音色**（每个子目录一个音色）。
 *
 * @returns {string[]}
 */
export function installedVoiceKeys() {
  const root = userVoiceRoot();
  try {
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      // .installing 是解压中的临时目录，不算已安装
      .filter((e) => !e.name.endsWith('.installing'))
      .filter((e) => /^\w[\w-]*$/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * 列出**内置目录里的音色**（平铺，需要按文件名归纳）。
 *
 * @param {string} pluginRoot
 * @returns {string[]}
 */
export function builtinVoiceKeys(pluginRoot) {
  const base = builtinVoiceRoot(pluginRoot);
  const seen = new Set();
  for (const pool of POOLS) {
    for (const f of wavsIn(poolDirOf(base, pool))) {
      const k = voiceKeyOf(f);
      if (k) seen.add(k);
    }
  }
  return [...seen].sort();
}

/**
 * 合并后的音色清单（用户优先）。
 *
 * @param {string} pluginRoot
 * @returns {Array<{key: string, source: 'user'|'builtin', installed: boolean}>}
 */
export function mergeVoices(pluginRoot) {
  const out = new Map();
  for (const key of installedVoiceKeys()) {
    out.set(key, { key, source: 'user', installed: true });
  }
  for (const key of builtinVoiceKeys(pluginRoot)) {
    if (!out.has(key)) out.set(key, { key, source: 'builtin', installed: false });
  }
  return [...out.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * 某个音色在某个池里的**候选目录**，按优先级排列。
 *
 * 顺序：
 *   1. 用户目录里的 `<key>/<pool>/`     （新布局，用户优先）
 *   2. 内置根里的 `<pool>/`              （旧布局，需按 key 过滤文件名）
 *
 * @param {string} pluginRoot
 * @param {string} key
 * @param {string} pool
 * @returns {Array<{dir: string, filterByKey: boolean}>}
 */
export function candidateDirs(pluginRoot, key, pool) {
  const list = [];
  const userKeyDir = join(userVoiceRoot(), key);
  if (existsSync(userKeyDir)) {
    list.push({ dir: poolDirOf(userKeyDir, pool), filterByKey: false });
  }
  const builtin = builtinVoiceRoot(pluginRoot);
  if (existsSync(builtin)) {
    list.push({ dir: poolDirOf(builtin, pool), filterByKey: true });
  }
  return list;
}

/**
 * 该音色在某个池里的所有 wav 全路径（按优先级合并）。
 *
 * @param {string} pluginRoot
 * @param {string} key
 * @param {string} pool
 * @returns {string[]}
 */
export function voiceFiles(pluginRoot, key, pool) {
  const out = [];
  for (const c of candidateDirs(pluginRoot, key, pool)) {
    const files = wavsIn(c.dir);
    for (const f of files) {
      if (c.filterByKey && voiceKeyOf(f) !== key) continue;
      out.push(join(c.dir, f));
    }
    // 用户目录里找到就不再往内置找 —— 用户下载的版本应完全覆盖内置
    if (out.length > 0 && !c.filterByKey) break;
  }
  return out;
}

/**
 * 某音色是否有任何 wav（跨全部池、跨区域）。
 *
 * @param {string} pluginRoot
 * @param {string} key
 * @returns {boolean}
 */
export function hasVoice(pluginRoot, key) {
  for (const pool of POOLS) {
    if (voiceFiles(pluginRoot, key, pool).length > 0) return true;
  }
  return false;
}

/**
 * 某音色在哪些池里有内容（供 GUI 显示完整度）。
 *
 * @param {string} pluginRoot
 * @param {string} key
 * @returns {{done: boolean, question: boolean, approval: boolean, fail: boolean}}
 */
export function poolCoverage(pluginRoot, key) {
  const out = { done: false, question: false, approval: false, fail: false };
  for (const pool of POOLS) {
    if (voiceFiles(pluginRoot, key, pool).length > 0) out[pool || 'done'] = true;
  }
  return out;
}

/**
 * 某池是否有**任何**语音（不区分音色）—— 供 hasVoiceLine 的粗判。
 *
 * @param {string} pluginRoot
 * @param {string} pool
 * @returns {{total: number, unreadable: boolean}}
 */
export function poolSummary(pluginRoot, pool) {
  let total = 0;
  let unreadable = false;

  // 用户目录：所有已装音色目录 + 可能存在的平铺文件
  const userRoot = userVoiceRoot();
  if (existsSync(userRoot)) {
    // 新布局：<key>/<pool>/
    for (const key of installedVoiceKeys()) {
      const dir = poolDirOf(join(userRoot, key), pool);
      try {
        total += wavsIn(dir).length;
      } catch { unreadable = true; }
    }
    // 兼容：有人手动把 wav 平铺在用户根（少见，但别当作没有）
    try {
      total += wavsIn(poolDirOf(userRoot, pool)).filter((f) => {
        // 只算直接放在该层的（音色目录会被上面统计）
        return true;
      }).length;
    } catch { unreadable = true; }
  }

  // 内置目录（平铺旧布局）
  const builtin = builtinVoiceRoot(pluginRoot);
  const bdir = poolDirOf(builtin, pool);
  if (existsSync(bdir)) {
    try {
      total += wavsIn(bdir).length;
    } catch {
      unreadable = true;   // 沙箱限制：读不到不代表没有
    }
  }

  return { total, unreadable };
}

/** 用户目录里某音色的目录（安装目标）。 */
export function userKeyDir(key) {
  return join(userVoiceRoot(), key);
}

/** 正则转义（保留导出，供测试与上层复用）。 */
export function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
