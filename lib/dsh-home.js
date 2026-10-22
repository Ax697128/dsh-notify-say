/**
 * DSH home 解析（本插件唯一的 home 事实源）。
 *
 * ## 为什么需要这个模块
 *
 * 用户实测反馈：点「保存」时设置页报 `保存失败：no-home`，且**任何**改配置的操作
 * （切换声音来源、改音量）都会失败。根因不是语音包没下载，而是本插件取不到
 * `$DSH_HOME`：
 *
 *   - 官方 DSH 的 home 解析优先级是 **显式配置 > `$DSH_HOME` > `~/.dsh`**；
 *   - 但本插件历史上只读 `process.env.DSH_HOME`，没值就直接返回空串，
 *     于是 `configPath()` 为空 → `writeConfig()` 返回 `{ok:false, reason:'no-home'}`。
 *
 * 用户机器上没设这个环境变量（它不是 DSH 安装时生成的，是可选覆盖项），
 * 所以设置卡片能显示（那是 `slots.register` 画的，与 home 无关），
 * 但一保存就失败。
 *
 * ## 为什么自己复刻，而不是直接调官方模块
 *
 * 官方的 `@deepseek-ai/dsh-home-paths` 是权威实现：
 *
 *     const DSH_HOME_DIR_NAME = ".dsh";
 *     function defaultDshHome() { return join(homedir(), DSH_HOME_DIR_NAME); }
 *     function resolveDshHome(configured, env) {
 *       return resolveRoot(configured, env, 'DSH_HOME', defaultDshHome);
 *     }
 *
 * **但插件拿不到它**：它随使用层打进 `app.asar`，不在 profile 的
 * `node_modules/@deepseek-ai/` 下（本机实测：该目录只有 cosmokit / dsh-brand /
 * schemastery）。四个锚点 `createRequire(...).resolve('@deepseek-ai/dsh-home-paths')`
 * 全部 `MODULE_NOT_FOUND`。
 *
 * 所以本模块采用**两段式**：
 *   1. 先尝试真解析官方模块 —— 一旦官方把它暴露到可解析位置，自动改用官方实现，
 *      不会因为"我们抄的规则过时"而漂移；
 *   2. 解析不到时，按官方规则**保底复刻**（`$DSH_HOME` 空白视为未设置 → `~/.dsh`）。
 *
 * ## 硬约束（改这里之前先读）
 *
 * - **空白即未设置**：官方 `resolveRoot` 明确把空串/纯空白当未设置，
 *   否则会解析成相对路径（当前工作目录），配置文件会随机落在各处。
 * - **不与官方抢优先级**：显式配置（第一个参数）优先级最高。插件没有也不该有
 *   显式配置入口，故本模块不提供该参数，避免出现第二条事实来源。
 * - **取不到 home 时返回空串**，而不是抛异常：插件功能不能因为一个路径解析失败就崩。
 */

import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 官方默认 home 目录名（与 `@deepseek-ai/dsh-home-paths` 的 `DSH_HOME_DIR_NAME` 一致）。 */
export const DSH_HOME_DIR_NAME = '.dsh';

/** 环境变量名（官方 `DSH_HOME_ENV`）。 */
export const DSH_HOME_ENV = 'DSH_HOME';

/**
 * 把候选值收敛成「干净路径」，并区分"未设置"与"有值"。
 *
 * 官方语义：空串与**纯空白**都视为未设置。历史实现只判断 `length > 0`，
 * 于是 `DSH_HOME='   '` 会拼出 `"   \storages\..."` 这种无效路径（实测）。
 *
 * 处理顺序：修剪空白 → 展开开头 `~` → 去尾部斜杠（但保住盘符根 `C:\`）。
 *
 * ⚠️ 这里**故意不做 `path.resolve()`**：官方 `resolveRoot` 会做，但本插件的
 * 测试与文档都用 `D:\DSH` 这类跨平台字面量，在 Linux CI 上 `resolve()`
 * 会把它变成 `<cwd>/D:\DSH`，测试全红。相对路径按原样透传（官方场景下
 * `DSH_HOME` 本就该是绝对路径），代价是异常输入不纠偏 —— 已知且可接受。
 *
 * @param {any} raw
 * @returns {string} 归一化路径；未设置时返回空串
 */
function normalizeCandidate(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  if (s.length === 0) return '';
  // 展开开头的 `~`（`~/x`、`~\x`、单独的 `~`）。官方 expandHomePath 也做这件事。
  if (s === '~') return defaultDshHome();
  if (/^~[\\/]/.test(s)) {
    const rest = s.slice(2);
    const base = defaultDshHome();
    if (!base) return '';
    s = rest ? join(base, rest) : base;
  }
  // 去尾部斜杠。盘符根（`C:\`）必须保住那个斜杠，否则 `C:` 是
  // **盘符相对路径**（相对该盘的当前目录），不是根目录。
  const stripped = s.replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:$/.test(stripped)) return stripped + '\\';
  return stripped.length > 0 ? stripped : s;
}

/**
 * 按官方规则计算默认 home：`~/.dsh`。
 * @returns {string}
 */
export function defaultDshHome() {
  try {
    return normalizeCandidate(join(homedir(), DSH_HOME_DIR_NAME));
  } catch {
    return '';
  }
}

/**
 * 尝试解析官方 `@deepseek-ai/dsh-home-paths`。
 *
 * 锚点顺序与 `loadSchema()` 解析 schemastery 时一致：官方包若出现在
 * profile 的 node_modules 里，这些锚点就能找到它。
 *
 * @param {string[]} anchors 用来 `createRequire` 的锚点文件绝对路径
 * @param {(msg: string) => void} [log] 诊断日志（**必须传**，否则走了哪条分支无法观测）
 * @returns {object|null} 官方模块；解析不到返回 null
 */
function tryOfficialModule(anchors, log) {
  if (!Array.isArray(anchors)) return null;
  for (const anchor of anchors) {
    try {
      const req = createRequire(anchor);
      const mod = req('@deepseek-ai/dsh-home-paths');
      if (mod && typeof mod.resolveDshHome === 'function') {
        if (log) log(`已解析到官方 @deepseek-ai/dsh-home-paths（锚点 ${anchor}）`);
        return mod;
      }
    } catch (e) {
      // 「解析不到」是正常情况（官方包通常不在可解析位置），不该刷日志；
      // 但**其它**错误（EACCES、官方包 package.json 损坏）值得留痕，
      // 否则两段式设计里"到底走了哪条分支"就永远查不出来。
      const code = e && e.code;
      if (log && code && code !== 'MODULE_NOT_FOUND' && code !== 'ERR_MODULE_NOT_FOUND') {
        log(`尝试官方 home 模块失败（${anchor}）：${code}`);
      }
    }
  }
  return null;
}

/**
 * 解析 DSH home。
 *
 * 优先级与官方一致：`$DSH_HOME`（空白视为未设置）→ `~/.dsh`。
 *
 * @param {object} [env] 环境包，默认 `process.env`
 * @param {object} [opts]
 * @param {string[]} [opts.anchors] 尝试解析官方模块的锚点；不给则不做模块解析
 * @param {(msg: string) => void} [opts.log]
 * @returns {string} 归一化绝对路径；都取不到时返回空串
 */
export function resolveDshHome(env, opts) {
  const log = opts && opts.log;

  // ① 官方模块可用则直接用（唯一能保证"跟着官方走"的路径）
  const official = tryOfficialModule(opts && opts.anchors, log);
  if (official) {
    try {
      // 不传显式配置：插件没有该入口，也不该有第二份事实来源
      const resolved = official.resolveDshHome(undefined, env);
      const normalized = normalizeCandidate(resolved);
      if (normalized) {
        if (log) log(`$DSH_HOME 由官方模块解析：${normalized}`);
        return normalized;
      }
      if (log) log('官方模块解析出空值，退回保底规则');
    } catch (e) {
      // 官方模块行为异常时退回保底规则，不让插件因此不可用。
      // 但要留痕 —— 静默降级会让"官方分支失效"这种事藏很久。
      if (log) log(`官方模块抛错，退回保底规则：${String((e && e.message) || e)}`);
    }
  }

  // ② 保底复刻官方规则
  try {
    const src = env != null ? env : (typeof process !== 'undefined' ? process.env : undefined);
    const fromEnv = normalizeCandidate(src != null ? src[DSH_HOME_ENV] : undefined);
    if (fromEnv) return fromEnv;
    return defaultDshHome();
  } catch {
    return '';
  }
}
