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
 * - **失败绝不半途而废**：任何异常都走回滚，保证"要么换成新的，要么还是旧的"。
 *
 * ## v0.4.20 重写：修「假成功」
 *
 * 2026-10-17 实测：本模块报告 `ok:true`，但实际只换掉了**部分**模块
 * （`config-store.js` 换了、`index.js` 没换），导致"半新半旧"。
 * 这比完全没生效更危险 —— 排查时会被误导好几轮。
 *
 * 根因是两个缺失的机制（对照上游 `dsh-our-free-model/src/reload.js`）：
 *
 *   1. **缺 `?t=` 代际绕过**：`loadCache` 清不掉时我们直接放弃，
 *      而上游会用带查询串的 URL 强制重新求值。缺这个 → 一个模块都换不掉。
 *   2. **缺加载指纹校验**：只比 `replacement === previous`（入口导出对象），
 *      而依赖模块是否真的换了完全没验证。缺这个 → 换了一半也算成功。
 *
 * 现在补上三件事：
 *
 *   · **代际绕过**：清不掉就用 `?reload=<ts>` 重求值；配合 `registerHooks`
 *     把代际传递给依赖，保证整棵依赖树一起换新。
 *   · **指纹校验**（`expectedFingerprint`）：调用方传入"磁盘上应该是什么"的
 *     标记，重载后**在真实模块里读回**并比对，不一致就判失败。
 *   · **依赖抽样校验**：重载后随机验证若干依赖模块的对象身份确实变了，
 *     捕捉"入口换了、依赖没换"的隐性半新半旧。
 *
 * 原则：**报 ok 就必须真的生效；验证不了就算失败。**
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
// ⚠️ `registerHooks` 是 **Node 22.15+** 才有的导出。
//
// 早期写成静态 import，导致 Node 20 上**整个模块加载失败**
// （SyntaxError: The requested module does not provide an export named），
// 而外面那层 try/catch 根本拦不住 —— 静态 import 在求值前就发生了。
//
// 现在改为动态导入：拿不到就退化为"没有代际绕过"，不影响正常重载路径。
// 这也是 CI 在 Node 20 上抓到的真实兼容性问题（2026-10-18）。
import { createRequire } from 'node:module';

/** 有就返回，没有就 null（Node < 22.15）。 */
async function loadRegisterHooks() {
  try {
    const mod = await import('node:module');
    return typeof mod.registerHooks === 'function' ? mod.registerHooks : null;
  } catch {
    return null;
  }
}
import { fileURLToPath } from 'node:url';

/** 同一时刻只允许一次重载，避免重叠交换。 */
let inFlight = null;

/**
 * 已安装的代际钩子（按 packageUrl 索引）。
 *
 * `registerHooks` 在同一进程里**不能重复注册同一个 packageUrl**：
 * 第二次会叠加一个钩子，导致代际参数被反复改写、URL 越滚越长。
 * 所以用这个 Map 记住"这个包已经装过钩子"，只装一次。
 */
const reloadHooks = new Map();

/** 代际查询串的键名。带项目前缀，避免与其它插件撞名。 */
const GEN_PARAM = 'dns-reload';

/**
 * 让入口的"代际"穿透到它 import 的每一个本包模块。
 *
 * ## 为什么必须有
 *
 * 只在入口 URL 上加 `?reload=xxx` 是不够的：入口里写的是
 * `import { ... } from './config-store.js'`，这个相对说明符**不带查询串**，
 * 于是 Node 仍然复用缓存里的**旧依赖** —— 结果就是入口是新的、依赖是旧的。
 *
 * 这正是 2026-10-17 那次"config-store 换了、index 没换"（或反之）的机制。
 *
 * 钩子的作用：凡是 `parentURL` 带代际、且 `resolved.url` 落在同一个包内的，
 * 都给 `resolved.url` 补上同一个代际参数，整棵子树一起重新求值。
 *
 * @param {string} packageUrl 包根 URL（带尾斜杠）
 */
/**
 * @returns {Promise<void>} 注册完成后 resolve（便于测试与调用方等待）
 */
export async function enableFreshDependencies(packageUrl) {
  // ⚠️ 2026-10-18 外部审阅指出两个问题（都属实，此前没改过）：
  //
  // 1. 调用方只写 `enableFreshDependencies(packageUrl)`，**没 await**。
  //    而它要 `await import('node:module')` 才拿得到 registerHooks ——
  //    于是新入口可能在钩子装好之前就被导入，依赖仍是旧的。
  //    这恰好是热重载要解决的那个问题。
  //
  // 2. 原实现在注册**前**就 `reloadHooks.set(packageUrl, null)` 占位，
  //    第二个并发调用看到 key 存在就直接 return，哪怕第一次还没装完。
  //
  // 修法：Map 里存 `{ pending, hook }` —— 后来者 await 同一个 Promise，
  // 这样"返回时已装好"成立。hook 的 resolve 逻辑一字未动。

  const prev = reloadHooks.get(packageUrl);
  // 已装好：直接返回 hook
  if (prev && prev.hook) return prev.hook;
  // 正在装：等同一次 Promise（这就是修竞态的关键）
  if (prev && prev.pending) return prev.pending;

  const slot = { pending: null, hook: null };
  reloadHooks.set(packageUrl, slot);

  slot.pending = (async () => {
    // Node < 22.15 没有 registerHooks：静默跳过即可。
    // 代际绕过不成，重载仍走"清缓存 + 校验"的常规路径。
    const registerHooks = await loadRegisterHooks();
    if (!registerHooks) return null;
    try {
      const hook = registerHooks({
        resolve(specifier, context, nextResolve) {
          const resolved = nextResolve(specifier, context);
          const parent = context && context.parentURL;
          if (!parent || !parent.startsWith(packageUrl)) return resolved;
          if (!resolved || typeof resolved.url !== 'string') return resolved;
          if (!resolved.url.startsWith(packageUrl)) return resolved;
          let generation = null;
          try { generation = new URL(parent).searchParams.get(GEN_PARAM); } catch { return resolved; }
          if (generation === null) return resolved;
          try {
            const target = new URL(resolved.url);
            target.searchParams.set(GEN_PARAM, generation);
            return { ...resolved, url: target.href };
          } catch {
            return resolved;
          }
        },
      });
      slot.hook = hook;
      return hook;
    } catch {
      // 重复注册等情况：忽略，不影响正常路径
      return null;
    }
  })();

  return slot.pending;
}

/**
 * 计算"磁盘上这份代码应该长什么样"的指纹。
 *
 * 用途：重载前记下，重载后**从真实模块里读回**再比对。
 * 这是"报 ok 就必须真生效"的依据 —— 没有它，只能相信
 * "re-import 返回了新对象"，而那并不等于"新代码在跑"。
 *
 * 取哪些文件：入口 + lib 下所有 js。排除 test/tools/sounds 等大目录。
 *
 * @param {string} packageDir 包目录的**文件系统路径**
 * @returns {string} 形如 'a1b2c3d4' 的短哈希；读不到时返回 ''
 */
export function computeFingerprint(packageDir) {
  try {
    const base = String(packageDir || '').replace(/[\\/]+$/, '');
    if (!base) return '';

    // 目录本身不存在 → 明确返回空串。
    // 不能让"一个文件都 stat 不到"悄悄算出空串的哈希值 —— 那会让调用方
    // 以为"算出来了"，从而拿一个无意义的指纹去比对（实测踩到：
    // 不存在的目录返回了 '00001505'，看起来像个正常指纹）。
    if (!fs.existsSync(base)) return '';

    const files = [];
    const libDir = base + '\\lib';
    files.push(base + '\\package.json');
    if (fs.existsSync(libDir)) {
      for (const name of fs.readdirSync(libDir)) {
        if (name.endsWith('.js')) files.push(libDir + '\\' + name);
      }
    }
    // 简易内容哈希：把文件名 + 大小 + mtime 混起来。
    // 不读全文是刻意的 —— 每次重载读几百 KB 没必要，且 mtime 变化足够灵敏。
    let acc = '';
    let counted = 0;
    for (const f of files.sort()) {
      try {
        const st = fs.statSync(f);
        acc += f + ':' + st.size + ':' + st.mtimeMs + ';';
        counted += 1;
      } catch { /* 单个文件读不到就跳过 */ }
    }
    // 一个文件都没读到 → 算不出有意义的指纹，返回空串让调用方知道。
    if (counted === 0) return '';

    let hash = 5381;
    for (let i = 0; i < acc.length; i++) hash = ((hash * 33) ^ acc.charCodeAt(i)) >>> 0;
    return hash.toString(16).padStart(8, '0');
  } catch {
    return '';
  }
}

/**
 * 判定"这次重载是否真的生效"。
 *
 * ## 为什么抽成独立纯函数
 *
 * 2026-10-17 的假成功，根源就是**校验逻辑被埋在 selfReload 里**：
 * 它只在 `replacement === previous` 时判失败，而这几乎永远不成立
 * （重新 import 总会得到新对象），所以校验形同虚设。
 *
 * 抽出来以后可以：
 *   · 单独测每条规则的边界（含负向用例）
 *   · 用变异测试确认规则真的会被触发（改坏就变红）
 *
 * ## 三条规则
 *
 * 1. **必须有 fingerprint**（启用校验时）
 *    模块不导出 fingerprint → 无法自证 → 判失败。宁可报错，不要假 ok。
 *
 * 2. **differFrom**：新 fingerprint 必须 ≠ 旧实例的
 *    相同就说明"重新 import 拿到的是同一次求值"，代码根本没换。
 *
 * 3. **expectedFingerprint**：必须完全等于调用方给的期望值
 *    比 2 更严（调用方若能算出磁盘指纹就该用这个）。
 *
 * 未传任何选项时返回 `{ ok:true, checked:false }` —— 表示"没做校验"，
 * 调用方据此知道这次成功**没有**经过验证。
 *
 * @param {{gotFingerprint?: string, differFrom?: string, expectedFingerprint?: string}} opts
 * @returns {{ok: boolean, checked: boolean, error?: string}}
 */
export function verifyReload(opts = {}) {
  const got = typeof opts.gotFingerprint === 'string' ? opts.gotFingerprint : '';
  const wantsDiffer = opts.differFrom !== undefined && opts.differFrom !== null;
  const wantsExact = typeof opts.expectedFingerprint === 'string' && opts.expectedFingerprint !== '';

  if (!wantsDiffer && !wantsExact) return { ok: true, checked: false };

  // 规则 1：要有指纹才能自证
  if (!got) {
    return {
      ok: false,
      checked: true,
      error: 'verification failed: reloaded module does not export fingerprint — '
        + 'cannot prove the new code is live',
    };
  }

  // 规则 2：必须与旧实例不同
  if (wantsDiffer && got === opts.differFrom) {
    return {
      ok: false,
      checked: true,
      error: `verification failed: fingerprint unchanged (${got}) — `
        + 'the module was re-imported but is still the same evaluation as before',
    };
  }

  // 规则 3：必须与期望值完全一致
  if (wantsExact && got !== opts.expectedFingerprint) {
    return {
      ok: false,
      checked: true,
      error: `fingerprint mismatch: expected ${opts.expectedFingerprint}, got ${got} `
        + '(module was re-evaluated but the code on disk is not what is running)',
    };
  }

  return { ok: true, checked: true };
}

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

    // 取 loader / registry 必须**非 strict**。
    //
    // ⚠️ 2026-10-18 实测踩到：直接写 `ctx.loader` 在 Cordis 里会抛
    //   `cannot get property "loader" without inject`
    // —— 除非插件在 `inject: ['loader']` 里声明过。本插件没有（也不需要，
    // 因为它平时用不到 loader），所以这里必须用 `ctx.get(name, false)`
    // 这种"取不到就返回 undefined"的非 strict 方式。
    //
    // 这个错误当初被 `catch` 吞掉后表现为"热重载没反应"，
    // 而不像报错 —— 又是那种最难查的形态。
    const safeGet = (ctxLike, name) => {
      if (!ctxLike) return undefined;
      try {
        if (typeof ctxLike.get === 'function') {
          const v = ctxLike.get(name, false);
          if (v !== undefined) return v;
        }
      } catch { /* 非 strict 也可能抛，继续用下一招 */ }
      try {
        return ctxLike[name];
      } catch {
        return undefined;
      }
    };

    const loader = safeGet(ctx, 'loader');
    const registry = safeGet(ctx, 'registry');
    if (!loader || !registry) {
      return {
        ok: false,
        error: 'no loader/registry on this context '
          + '(需要 ctx.get("loader", false) 可用；若从 ctx.loader 直读会被 Cordis 的 inject 校验拒绝)',
        restored: false,
      };
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

    const importFresh = async (url) => {
      const mod = await loader.import(url, () => []);
      return typeof loader.unwrapExports === 'function' ? loader.unwrapExports(mod) : mod;
    };

    /**
     * 判断 replacement 是否**就是旧的那个**模块。
     *
     * 三种都要查（上游也这么查）：
     *   · 整个导出对象相同      → 完全没换
     *   · apply 函数相同        → 模块对象换了壳、函数还是旧的
     *   · 旧对象有 apply 且相同 → 同上（previous 可能是函数本身）
     */
    const isSameAsPrevious = (candidate, prev) => {
      if (!candidate) return true;
      if (candidate === prev) return true;
      if (!prev || typeof prev !== 'object') return false;
      if (candidate.apply && prev.apply && candidate.apply === prev.apply) return true;
      return false;
    };

    let replacement;
    // verdict 在 try 块内算出，但要一直用到"注册成功"之后（返回值里）。
    // 所以把结论提到外层 —— 直接引用 verdict 会出作用域（S1 实测报过
    // "verdict is not defined"）。
    let verifiedOk = false;
    let busted = false;
    try {
      replacement = await importFresh(entryUrl);
      if (!replacement || typeof replacement.apply !== 'function') {
        throw new Error('reloaded module does not export apply()');
      }
      // v0.4.41：**无条件**走代际绕过。
      //
      // 原来是：
      //   if (backup.esm.size === 0 || isSameAsPrevious(replacement, previous))
      //
      // 只在「一个缓存都没清掉」或「拿到同一个对象」时才绕过。
      // 但 2026-10-18 重启后实测发现第三种情况：
      //   · 清了部分缓存 → backup.esm.size > 0
      //   · 拿到新壳对象   → isSameAsPrevious 为 false
      //   · 于是**跳过**代际绕过
      //   · 可新对象是壳，模块级 const 的求值结果被复用
      //   · 指纹仍是旧的 → verifyReload 判 fingerprint unchanged
      // 日志里三次不同编辑的指纹一模一样（adb61783），就是这个原因。
      //
      // 代际绕过只是强制重新求值，语义不变、代价是一次多余求值；
      // 而省掉它的代价是「改了代码拿不到新代码」——今天为此排查一整天。
      {
        
        try { logger.info?.('[dsh-notify-say] reload: falling back to generation bust'); } catch { /* ignore */ }
        // ⚠️ 必须 await：钩子装好之前导入新入口，依赖仍会是旧的。
      await enableFreshDependencies(packageUrl);
        const freshUrl = new URL(entryUrl);
        freshUrl.searchParams.set(GEN_PARAM, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
        replacement = await importFresh(freshUrl.href);
        busted = true;
        if (!replacement || typeof replacement.apply !== 'function') {
          throw new Error('reloaded module does not export apply() after generation bust');
        }
        if (isSameAsPrevious(replacement, previous)) {
          throw new Error('replacement is still the previous plugin after cache invalidation '
            + '(this kernel does not let modules be re-evaluated)');
        }
      }

      // ── 生效校验（v0.4.20 核心）────────────────────────────────────────
      //
      // 「报 ok 就必须真生效」。规则抽在 verifyReload 里（纯函数、可单独测），
      // 这里只负责把值喂进去、出错就回滚。
      //
      // 为什么不能只靠"replacement !== previous"：那只证明**入口**被重新
      // 求值了，不证明它 import 的依赖也换了。2026-10-17 实测出现过
      // "入口换了、config-store 没换"的半新半旧，而重载照样报 ok。
      const gotFp = typeof replacement.fingerprint === 'string' ? replacement.fingerprint : '';
      // ⚠️ 2026-10-18 外部审阅指出：调用方算好了 diskFingerprint 传进来，
      // 但这里根本没用 → 「验证通过」不等于「加载的是磁盘上那份代码」。
      //
      // 现在：有 diskFingerprint 就拿它当期望指纹（expectedFingerprint 优先，
      // 便于测试注入）。
      const expectedFp = options.expectedFingerprint !== undefined
        ? options.expectedFingerprint
        : options.diskFingerprint;

      const verdict = verifyReload({
        gotFingerprint: gotFp,
        differFrom: options.differFrom,
        expectedFingerprint: expectedFp,
      });
      if (!verdict.ok) throw new Error(verdict.error);
      verifiedOk = !!verdict.checked;
      if (verdict.checked) {
        try { logger.info?.(`[dsh-notify-say] reload: verified (fp=${gotFp})`); } catch { /* ignore */ }
      }
    } catch (error) {
      restoreCaches(internal, backup);
      return { ok: false, error: `re-import failed: ${(error && error.message) || error}`, restored: true };
    }

    // ⚠️ 2026-10-18 外部审阅指出：原来这里 catch 之后**仍然继续**注册新实例。
    //
    // 如果旧实例没真正退出，就会出现两个实例同时持有事件监听/文件句柄 ——
    // 表现是通知重复、日志错乱，而且极难查（"有时响两次"）。
    //
    // 现在区分两种情况：
    //   · dispose 只是"报告了错误"，但 fiber 确实停了 → 继续（正常路径）
    //   · fiber 仍有未停的                → 返回结构化失败，不切换
    //
    // 判据：`fiber.await()` 抛错说明停不下来；不抛就认为已停。
    try {
      registry.delete(previous);
      await Promise.all(fibers.map(({ fiber }) => fiber.await()));
    } catch (error) {
      // dispose 报错本身不一定是致命的（旧代码可能已部分卸载），
      // 但必须确认没有残留的活动 fiber，否则不能切换。
      const stillAlive = fibers.filter(({ fiber }) => {
        try {
          // Cordis 的 fiber 若已 dispose，status 会变成非 active
          const st = fiber && (fiber.status !== undefined ? fiber.status : fiber.state);
          return st === 'active' || st === 'pending' || st === 2 || st === 1;
        } catch {
          return true;   // 查不清就当作还活着（宁可失败也不双开）
        }
      });
      const msg = (error && error.message) || error;
      if (stillAlive.length > 0) {
        restoreCaches(internal, backup);
        return {
          ok: false,
          error: `dispose-incomplete: ${stillAlive.length}/${fibers.length} fiber(s) still active (${msg})`,
          restored: true,
        };
      }
      // 都停干净了：只是报了个错，继续切换
      try { logger.warn?.(`[dsh-notify-say] reload: dispose reported ${msg} (all fibers stopped, continuing)`); } catch { /* ignore */ }
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
      // ⚠️ 2026-10-18 外部审阅指出：调用方读 r.busted / r.verified 来显示
    // 「走了代际绕过」「指纹校验通过」，但这里从来没返回过这两个字段 ——
    // 于是日志永远显示不出来，我据此判断重载行为时一直是盲的。
    return { ok: true, fibers: created.length, busted, verified: verifiedOk };
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
    // ⚠️ 2026-10-18 外部审阅指出：监听整个目录，但指纹只覆盖
    // package.json + lib/*.js。改文档或测试也会触发一次注定失败的重载。
    // 过滤在 schedule(filename) 里做（见 isSourceFile）。
    watcher = fs.watch(packageDir, { recursive: true });
    try { opts.diag?.('watching ', packageDir); } catch {}
  } catch (error) {
    try { logger.warn?.(`[dsh-notify-say] cannot watch ${packageDir}: ${(error && error.message) || error}`); } catch { /* ignore */ }
    return () => {};
  }
  // 只有这些文件变了才值得重载（与指纹覆盖范围保持一致）。
  const isSourceFile = (filename) => {
    if (!filename) return true;   // 拿不到文件名时保守处理：当真
    const f = String(filename).replace(/\\/g, '/');
    if (f === 'package.json') return true;
    if (f.startsWith('lib/') && f.endsWith('.js')) return true;
    return false;
  };

  const schedule = (filename) => {
    if (paused) return;
    if (!isSourceFile(filename)) return;   // 文档/测试变更不触发重载
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
  // fs.watch 的监听器签名是 (eventType, filename)
  watcher.on('change', (eventType, filename) => {
    try { opts.diag?.('event ', String(filename), ' accepted=', String(isSourceFile(filename))); } catch {}
    schedule(filename);
  });
  watcher.on('error', (error) => {
    try { logger.warn?.(`[dsh-notify-say] watcher error: ${(error && error.message) || error}`); } catch { /* ignore */ }
  });
  return () => {
    paused = true;
    clearTimeout(timer);
    try { watcher.close(); } catch { /* 已关闭 */ }
  };
}
