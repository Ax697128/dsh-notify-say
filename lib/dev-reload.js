/**
 * 插件自热重载（开发期用）。
 *
 * ## 为什么需要
 *
 * 宿主只在**启动时**加载一次 `lib/index.js`（Node ESM 模块缓存）。改了代码、
 * 磁盘已更新，但进程里跑的还是旧代码 —— 2026-10-17 就因此反复出问题：
 * 我把 `audioSource` 默认值改成 `tts`，磁盘是新的，可宿主仍在按旧的 `bundled`
 * 走，每次完成都 fallback 到 system 然后静默什么都不播。
 *
 * 那时的唯一解是重启 DSH。但重启会打断并行会话，且开发迭代极慢。
 *
 * ## 机制来源
 *
 * 移植自本机真实插件 `dsh-our-free-model` 的 `src/reload.js`（该插件确实能在
 * 运行中换掉自己）。它的注释点明了官方现状：
 *
 *   > The kernel's HMR service reloads plugins by watching files; it DELIBERATELY
 *   > ships with module watching off, and it has NO "reload this plugin now" API.
 *
 * 所以只能自己动 Node 的模块缓存。五步：
 *
 *   1. 快照当前 fibers 与各自 config
 *   2. 从 Node 的 ESM `loadCache` 与 CJS `require.cache` 里删掉本包所有条目
 *   3. 重新 import 入口 → 新代码被求值
 *   4. dispose 旧 fibers，用**同一份 config** 重新注册
 *   5. 任一步失败 → 回滚缓存并重注册旧代码
 *
 * ## 关键技术点（照抄不得）
 *
 * **必须用 `Map.prototype.delete.call(cache, key)`**，不能 `cache.delete(key)`：
 * Node 24 的 `loadCache` 是 Map 子类，它自己的 `.delete` 只清"类型槽"，
 * 模块本体仍留在表里，重新 import 会拿到旧对象。这是整套机制能否生效的分水岭。
 *
 * ## 与上游实现的差异（我们更保守）
 *
 * - **默认关闭**：只有 `devReload: true` 才启用。生产安装不会重写自己的文件，
 *   开着只是多一个可能出错的路径。
 * - **缓存清不掉就放弃**：上游会用 `?t=时间戳` 强制重求值绕过；我们直接返回
 *   失败并说明原因 —— 强制重求值会让 `import.meta.url` 带查询串，
 *   依赖相对路径的逻辑可能因此错乱，不值得冒这个险。
 * - **失败绝不半途而废**：任何异常都走回滚，保证"要么换成新的，要么还是旧的"。
 *
 * ## 风险（如实记录）
 *
 * 依赖三个**非公开**对象：`ctx.loader.internal`、`ctx.registry`、`ctx.fiber`。
 * DSH 升级后它们可能变。所以：
 *   - 只在开发期开；
 *   - 拿不到就返回 `{ ok:false, error:'no loader/registry...' }`，不影响插件运行；
 *   - 有测试覆盖"结构缺失时不抛异常"。
 *
 * @module lib/dev-reload.js
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** 同一时刻只允许一次重载，避免重叠交换。 */
let inFlight = null;

/** 是否正在重载。 */
export function isReloading() {
  return inFlight !== null;
}

/**
 * 包目录（`file://` URL，带尾斜杠）。
 * @param {string} entryModuleUrl `import.meta.url`
 */
export function packageUrlOf(entryModuleUrl) {
  return new URL('../', entryModuleUrl).href;
}

/**
 * 入口文件 URL。
 *
 * ⚠️ 本插件入口是 `lib/index.js`，而本模块就住在 `lib/` 里 ——
 * 所以从 `lib/dev-reload.js` 出发是 `./index.js`，**不是** `../index.js`。
 *
 * 上游 FreeModel 的 `src/reload.js` 用 `../index.js` 是对的（它的入口在包根），
 * 照抄会解析成 `<包>/index.js` —— 那个文件不存在，重载必失败。
 * 移植时踩到，测试 D7 抓住。
 *
 * @param {string} entryModuleUrl `import.meta.url`
 */
export function entryUrlOf(entryModuleUrl) {
  return new URL('./index.js', entryModuleUrl).href;
}

/**
 * 找出 loadCache 里属于本包的所有键。
 *
 * 键比较要容忍大小写与百分号编码差异（Node 解析器与 `new URL` 的产出可能不同）。
 *
 * @param {Map} loadCache
 * @param {string} packageUrl
 * @returns {string[]}
 */
export function packageCacheKeys(loadCache, packageUrl) {
  const base = decodeURIComponent(packageUrl).replace(/\/+$/, '').toLowerCase() + '/';
  const keys = [];
  let it;
  try {
    it = loadCache.keys();
  } catch {
    return keys;
  }
  for (const key of it) {
    if (typeof key !== 'string') continue;
    let normalized;
    try { normalized = decodeURIComponent(key).toLowerCase(); } catch { normalized = key.toLowerCase(); }
    if (normalized.startsWith(base)) keys.push(key);
  }
  return keys;
}

/**
 * 清掉本包在 ESM / CJS 两级缓存里的条目，返回可用于回滚的备份。
 *
 * @param {object} internal `ctx.loader.internal`
 * @param {string} packageUrl
 * @returns {{ esm: Map<string, unknown>, cjs: Map<string, object> }}
 */
export function purgeCaches(internal, packageUrl) {
  const backup = { esm: new Map(), cjs: new Map() };
  const cache = internal && internal.loadCache;
  if (cache && typeof cache.keys === 'function' && typeof cache.get === 'function') {
    const read = (key) => {
      try { return Map.prototype.get.call(cache, key); } catch { try { return cache.get(key); } catch { return undefined; } }
    };
    // ⚠️ 必须走 Map.prototype.delete：Node 24 的 LoadCache.delete 只清类型槽，
    // 模块本体仍留着，重新 import 会拿回旧对象（整套机制失效）。
    const drop = (key) => {
      try { Map.prototype.delete.call(cache, key); return; } catch { /* 不是真 Map */ }
      try { cache.delete(key); } catch { /* 尽力而为 */ }
    };
    for (const key of packageCacheKeys(cache, packageUrl)) {
      backup.esm.set(key, read(key));
      drop(key);
    }
  }

  const require = createRequire(import.meta.url);
  for (const key of [...backup.esm.keys()]) {
    try {
      const filePath = fileURLToPath(key);
      if (require.cache[filePath] !== undefined) {
        backup.cjs.set(filePath, require.cache[filePath]);
        delete require.cache[filePath];
      }
    } catch {
      // 非 file: URL —— CJS 侧无事可做
    }
  }
  return backup;
}

/**
 * 把备份写回缓存（回滚用）。
 * @param {object} internal
 * @param {{esm: Map, cjs: Map}} backup
 */
export function restoreCaches(internal, backup) {
  const cache = internal && internal.loadCache;
  for (const [key, job] of backup.esm) {
    try { Map.prototype.set.call(cache, key, job); } catch { try { cache.set(key, job); } catch { /* best effort */ } }
  }
  const require = createRequire(import.meta.url);
  for (const [filePath, mod] of backup.cjs) require.cache[filePath] = mod;
}

/**
 * 原地重载本插件。
 *
 * @param {object} ctx `apply` 收到的 ctx
 * @param {object} [options]
 * @param {object} [options.logger] 日志器（默认 console）
 * @param {string} [options.entryModuleUrl] 默认用本模块的 import.meta.url
 * @returns {Promise<{ok:boolean, error?:string, restored?:boolean, fibers?:number}>}
 */
export function selfReload(ctx, options = {}) {
  if (inFlight !== null) return inFlight;
  inFlight = (async () => {
    const logger = options.logger || console;
    const entryModuleUrl = options.entryModuleUrl || import.meta.url;
    const packageUrl = options.packageUrl || packageUrlOf(entryModuleUrl);
    const entryUrl = options.entryUrl || entryUrlOf(entryModuleUrl);

    const loader = ctx && ctx.loader;
    const registry = ctx && ctx.registry;
    if (!loader || !registry) {
      return { ok: false, error: 'no loader/registry on this context', restored: false };
    }

    const previous = ctx.fiber && ctx.fiber.runtime && ctx.fiber.runtime.callback;
    if (!previous) {
      return { ok: false, error: 'no runtime to reload (plugin not registered the ordinary way)', restored: false };
    }

    const runtime = registry.get(previous);
    const fibers = [...((runtime && runtime.fibers) || [])].map((fiber) => {
      const entry = fiber.entry && fiber.entry.fiber && fiber.entry.fiber.uid === fiber.uid ? fiber.entry : undefined;
      return { fiber, entry, config: entry === undefined ? fiber._config : entry.options.config };
    });
    if (fibers.length === 0) {
      return { ok: false, error: 'runtime has no live fibers', restored: false };
    }

    const internal = loader.internal;
    const backup = purgeCaches(internal, packageUrl);
    try { logger.info?.(`[dsh-notify-say] reload: purged ${backup.esm.size} module(s)`); } catch { /* ignore */ }

    // 缓存没清掉就**放弃**（上游会用 ?t= 强制重求值，我们不愿意，理由见模块头注释）。
    if (backup.esm.size === 0) {
      return {
        ok: false,
        error: 'nothing was purged (loadCache shape changed or package not cached)',
        restored: true,
      };
    }

    const importFresh = async (url) => {
      const mod = await loader.import(url, () => []);
      return typeof loader.unwrapExports === 'function' ? loader.unwrapExports(mod) : mod;
    };

    let replacement;
    try {
      replacement = await importFresh(entryUrl);
      if (!replacement || typeof replacement.apply !== 'function') {
        throw new Error('reloaded module does not export apply()');
      }
      if (replacement === previous) {
        throw new Error('re-import returned the same object (cache purge had no effect)');
      }
    } catch (error) {
      restoreCaches(internal, backup);
      return { ok: false, error: `re-import failed: ${(error && error.message) || error}`, restored: true };
    }

    try {
      registry.delete(previous);
      await Promise.all(fibers.map(({ fiber }) => fiber.await()));
    } catch (error) {
      try { logger.warn?.(`[dsh-notify-say] reload: dispose reported ${(error && error.message) || error}`); } catch { /* ignore */ }
    }

    try {
      const created = [];
      for (const { fiber, entry, config } of fibers) {
        const registered = fiber.parent.registry.plugin(replacement, config);
        const fresh = registered.ctx.fiber;
        if (entry !== undefined) {
          fresh.entry = entry;
          entry.fiber = fresh;
        }
        created.push(fresh);
      }
      await Promise.all(created.map((fiber) => fiber.await()));
      try { logger.info?.(`[dsh-notify-say] reload: complete, ${created.length} fiber(s)`); } catch { /* ignore */ }
      return { ok: true, fibers: created.length };
    } catch (error) {
      restoreCaches(internal, backup);
      try { registry.delete(replacement); } catch { /* 可能从未启动 */ }
      try {
        const restored = [];
        for (const { fiber, entry, config } of fibers) {
          const registered = fiber.parent.registry.plugin(previous, config);
          const fresh = registered.ctx.fiber;
          if (entry !== undefined) {
            fresh.entry = entry;
            entry.fiber = fresh;
          }
          restored.push(fresh);
        }
        await Promise.all(restored.map((fiber) => fiber.await()));
        return {
          ok: false,
          error: `new code failed to start, previous version restored: ${(error && error.message) || error}`,
          restored: true,
        };
      } catch (restoreError) {
        return {
          ok: false,
          error: `new code failed to start (${(error && error.message) || error}); restore failed too `
            + `(${(restoreError && restoreError.message) || restoreError})`,
          restored: false,
        };
      }
    }
  })();

  return inFlight.finally(() => { inFlight = null; });
}

/**
 * 监听包目录，变更时触发回调（防抖）。
 *
 * 刻意**不自动重载**：由调用方决定怎么用（例如只在 devReload 开启时调 selfReload）。
 * 自动重载会在你保存到一半的文件上触发，拿到语法错误的半成品。
 *
 * @param {string} packageDir
 * @param {{ onChange?: Function, logger?: object, debounceMs?: number }} [opts]
 * @returns {() => void} 停止函数
 */
export function watchPackage(packageDir, opts = {}) {
  const logger = opts.logger || console;
  const debounceMs = Number.isFinite(opts.debounceMs) ? opts.debounceMs : 800;
  let timer;
  let paused = false;
  let watcher;
  try {
    watcher = fs.watch(packageDir, { recursive: true });
  } catch (error) {
    try { logger.warn?.(`[dsh-notify-say] cannot watch ${packageDir}: ${(error && error.message) || error}`); } catch { /* ignore */ }
    return () => {};
  }
  const schedule = () => {
    if (paused) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (paused) return;
      try { opts.onChange?.(); } catch (error) {
        try { logger.warn?.(`[dsh-notify-say] watch onChange threw: ${(error && error.message) || error}`); } catch { /* ignore */ }
      }
    }, debounceMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  };
  watcher.on('change', schedule);
  watcher.on('error', (error) => {
    try { logger.warn?.(`[dsh-notify-say] watcher error: ${(error && error.message) || error}`); } catch { /* ignore */ }
  });
  return () => {
    paused = true;
    clearTimeout(timer);
    try { watcher.close(); } catch { /* 已关闭 */ }
  };
}
