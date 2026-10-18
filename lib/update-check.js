/**
 * 检查更新（v0.4.48）。
 *
 * ## 定位：只检查，不安装
 *
 * 本模块**只做三件事**：读出当前版本、查出最新版本、给出升级指引。
 * 它不下载、不覆盖文件、不执行命令、不重启宿主。
 *
 * 为什么不做自动更新：
 *   · 插件正在运行时替换自己的文件，失败后很难恢复
 *   · 用户可能装在任意 profile，插件无从得知
 *   · 本机安装可能是 Junction（指向开发源码），覆盖会直接毁掉开发目录
 *   · DSH 官方 CLI 已经能升级插件（`dsh plugin update`），重复实现没意义
 *
 * 所以分工是：**本插件发现新版本 + 说明变更 + 告诉用户命令；DSH 执行升级。**
 *
 * ## 为什么不用 GitHub Releases 的 latest
 *
 * ⚠️ 实测（2026-10-18）：本仓库的 `/releases/latest` 指向 **`voice-packs`**
 * —— 那是语音包索引的固定 tag，跟插件版本毫无关系。
 * 仓库里只有 `v0.4.30`（语音包下载支持那一版）和 `voice-packs` 两个 Release，
 * 插件版本只打 git tag、不发 Release。
 *
 * 所以用 `/releases/latest` 做更新检查会得出荒谬结论（"最新版是 voice-packs"）。
 *
 * ## 用什么当权威源
 *
 * 两个来源，都是"发布时同步更新"的：
 *   ① npm registry 的 `dist-tags.latest`（npm 安装的用户）
 *   ② GitHub 仓库 main 分支的 package.json（GitHub / link 安装的用户）
 *
 * 先查 ①，失败回退 ②。两者都由 `tools/release.ps1` 同时更新，正常情况下一致。
 *
 * ## 缓存
 *
 * 宿主侧缓存 24 小时：GUI 每次打开不必真的联网，
 * 但一天最多查一次，足够"发现有新版"。
 * 用户手动点「检查更新」时强制绕过缓存。
 *
 * @module lib/update-check.js
 */

import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

/** npm registry 的包元数据地址。 */
export const NPM_REGISTRY_URL = 'https://registry.npmjs.org/dsh-notify-say';

/** GitHub main 分支的 package.json（GitHub 安装的用户看这个）。 */
export const GITHUB_RAW_PKG_URL =
  'https://raw.githubusercontent.com/unifilitence/dsh-notify-say/main/package.json';

/** 更新日志（人看的页面）。 */
export const CHANGELOG_URL =
  'https://github.com/unifilitence/dsh-notify-say/blob/main/CHANGELOG.md';

/** 单次查询超时。网络不通时不要拖住界面。 */
export const FETCH_TIMEOUT_MS = 5000;

/** 自动检查的最小间隔：一天。 */
export const AUTO_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 读当前版本（读自己的 package.json，不联网）。
 *
 * @param {string} pluginRoot
 * @returns {string} 读不到时返回空串
 */
export function currentVersion(pluginRoot) {
  try {
    const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '';
  } catch {
    return '';
  }
}

/**
 * 把 `1.2.3` / `v1.2.3` 规整成可比较的数组。
 *
 * 只处理数字点分版本；带 `-rc.1` 之类后缀时只取前面的数字段
 * （预发布版不该被建议"升级到正式版"以外的东西，这里不做精细 semver）。
 *
 * @param {string} v
 * @returns {number[] | null}
 */
export function parseVersion(v) {
  const s = String(v || '').trim().replace(/^v/i, '');
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(s);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * 比较两个版本。返回 -1 / 0 / 1；任一不可解析时返回 null。
 *
 * @param {string} a
 * @param {string} b
 * @returns {number | null}
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

/**
 * 判断当前安装形态，决定给什么升级建议。
 *
 * 三种情况：
 *   · `dev`    —— 目录是 junction/symlink，或本身就是 git 仓库
 *                 （开发模式：**绝不能**用升级命令覆盖源码）
 *   · `npm`    —— 其余情况，按 npm 包给出命令
 *
 * 判断失败一律当 `dev`（保守：宁可让用户看到"请手动处理"，
 * 也不要给一条会覆盖开发目录的命令）。
 *
 * @param {string} pluginRoot
 * @returns {'dev' | 'npm'}
 */
export function detectInstallMode(pluginRoot) {
  try {
    // ① 自身或父目录是 git 仓库 → 源码安装
    let dir = pluginRoot;
    for (let i = 0; i < 6; i++) {
      try {
        readFileSync(join(dir, '.git', 'HEAD'));
        return 'dev';
      } catch { /* 继续往上 */ }
      const parent = join(dir, '..');
      if (parent === dir) break;
      dir = parent;
    }
  } catch { /* ignore */ }

  try {
    // ② 真实路径与自身不同 → junction / symlink
    const real = realpathSync(pluginRoot);
    if (real && real !== pluginRoot) return 'dev';
  } catch { /* 拿不到就当 npm */ }

  return 'npm';
}

/**
 * 从 npm registry 取最新版本。
 *
 * @param {Function} doFetch
 * @returns {Promise<{ok:boolean, version?:string, error?:string}>}
 */
async function fetchFromNpm(doFetch) {
  try {
    const res = await doFetch(NPM_REGISTRY_URL, { cache: 'no-store' });
    if (!res || !res.ok) return { ok: false, error: `npm-http-${res ? res.status : 'none'}` };
    const doc = await res.json();
    const v = doc && doc['dist-tags'] ? doc['dist-tags'].latest : '';
    if (!v) return { ok: false, error: 'npm-no-latest-tag' };
    return { ok: true, version: String(v) };
  } catch (e) {
    return { ok: false, error: `npm: ${(e && e.message) || e}` };
  }
}

/**
 * 从 GitHub main 的 package.json 取版本。
 *
 * @param {Function} doFetch
 * @returns {Promise<{ok:boolean, version?:string, error?:string}>}
 */
async function fetchFromGithub(doFetch) {
  try {
    const res = await doFetch(GITHUB_RAW_PKG_URL, { cache: 'no-store' });
    if (!res || !res.ok) return { ok: false, error: `gh-http-${res ? res.status : 'none'}` };
    const doc = await res.json();
    const v = doc && doc.version;
    if (!v) return { ok: false, error: 'gh-no-version' };
    return { ok: true, version: String(v) };
  } catch (e) {
    return { ok: false, error: `gh: ${(e && e.message) || e}` };
  }
}

/** 带超时的 fetch 包装（超时不 abort 也没关系，只是不再等）。 */
function withTimeout(doFetch, ms) {
  return (url, opts) => Promise.race([
    doFetch(url, opts),
    new Promise((_, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), ms);
      if (t && typeof t.unref === 'function') t.unref();
    }),
  ]);
}

/**
 * 给某个安装形态的升级指引。
 *
 * ⚠️ profile 名无法可靠得知，所以命令里用占位符并说明要替换。
 * 不要假装知道用户装在哪。
 *
 * @param {'dev' | 'npm'} mode
 * @returns {{ command: string, note: string }}
 */
export function upgradeHint(mode) {
  if (mode === 'dev') {
    return {
      command: '',
      note: '检测到源码/链接安装（开发模式）。请直接更新源码目录后重启 DSH —— '
        + '**不要**用插件升级命令，那会覆盖你的源码。',
    };
  }
  return {
    command: 'dsh plugin --profile <你的 profile> update dsh-notify-say',
    note: '把 <你的 profile> 换成实际名称（常见是 desktop）。'
      + '更新后需要重启对应的 DSH profile 才会完整生效。',
  };
}

/**
 * 检查更新。
 *
 * @param {object} opts
 * @param {string} opts.pluginRoot
 * @param {boolean} [opts.force] 绕过缓存（用户手动点「检查更新」）
 * @param {Function} [opts.fetchImpl]
 * @param {object} [opts.cache] 宿主持有的缓存对象（`{ at, result }`）
 * @param {number} [opts.now]
 * @returns {Promise<object>} 结构化结果，**永不抛异常**
 */
export async function checkForUpdate(opts = {}) {
  const pluginRoot = opts.pluginRoot || '';
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const current = currentVersion(pluginRoot);
  const mode = detectInstallMode(pluginRoot);

  const base = {
    current,
    installMode: mode,
    changelogUrl: CHANGELOG_URL,
    ...upgradeHint(mode),
  };

  // 缓存命中（未强制刷新且未过期）
  const cache = opts.cache;
  if (!opts.force && cache && cache.at && cache.result
      && (now - cache.at) < AUTO_CHECK_TTL_MS) {
    return { ...cache.result, cached: true, checkedAt: cache.at };
  }

  const doFetch = typeof (opts.fetchImpl || globalThis.fetch) === 'function'
    ? (opts.fetchImpl || globalThis.fetch)
    : null;
  if (!doFetch) {
    return { ok: false, ...base, error: 'fetch-unavailable', cached: false, checkedAt: now };
  }

  const timed = withTimeout(doFetch, opts.timeoutMs || FETCH_TIMEOUT_MS);

  // 先 npm，失败回退 GitHub
  let r = await fetchFromNpm(timed);
  let source = 'npm';
  if (!r.ok) {
    const r2 = await fetchFromGithub(timed);
    if (r2.ok) { r = r2; source = 'github'; }
    else {
      // 两个都失败：明确报告，但**不影响插件任何功能**
      const result = {
        ok: false,
        ...base,
        error: `npm(${r.error}) / github(${r2.error})`,
        cached: false,
        checkedAt: now,
      };
      if (cache) { cache.at = now; cache.result = result; }
      return result;
    }
  }

  const cmp = compareVersions(r.version, current);
  const result = {
    ok: true,
    ...base,
    latest: r.version,
    // 解析不出（比如本地是 0.0.0-stage）时不下"有新版"的结论
    hasUpdate: cmp === null ? null : cmp < 0,
    source,
    cached: false,
    checkedAt: now,
  };

  if (cache) { cache.at = now; cache.result = result; }
  return result;
}
