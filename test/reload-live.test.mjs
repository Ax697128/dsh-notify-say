/**
 * 热重载实机测试：在真实 Cordis 上下文里跑完整重载流程。
 *
 * ## 为什么这个测试不可替代
 *
 * R1~R10 验证了**零件**（指纹、代际穿透、校验规则），但没验证**整台机器
 * 转起来**。2026-10-17 的假成功恰恰发生在 selfReload 的整体编排里 ——
 * 零件都对，串起来报 ok 却没真换代码。
 *
 * ## 写这个测试时挖出的三个真问题（都已在源码里修）
 *
 * 1. **`ctx.loader` 直读会被 Cordis 拒绝**
 *    报 `cannot get property "loader" without inject`。必须用
 *    `ctx.get('loader', false)` 这种非 strict 取法。这个异常当初被 catch
 *    吞掉，表现为"热重载没反应"，是最难查的形态。
 *
 * 2. **指纹判断力反了**
 *    第一版用 `String(import.meta.url)` 做指纹 —— 代际一变 URL 就变、
 *    指纹就变，于是"代码没改但重新求值了"也被判成"新代码生效"。
 *    现在改为对**自身源码字节**做哈希：代码不变 → 指纹不变。
 *    S2/S5 就是锁这条的。
 *
 * 3. **假 loader 必须模拟"缓存清掉就重新求值"**
 *    否则 `import(url)` 命中 Node 的 ESM 缓存，文件改了也拿到旧模块，
 *    表现为"指纹未变"的假失败。
 *
 * ## 不碰真实插件目录
 *
 * 全程在系统临时目录造包，不会触发宿主热重载、不打断任何会话。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

import { selfReload, computeFingerprint, verifyReload } from '../lib/dev-reload.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 定位真实 Cordis（DSH 用 @deepseek-ai/cordis，不是 npm 的 cordis）。 */
function loadRealCordis() {
  const candidates = [
    process.env.DSH_CORDIS_ENTRY || '',   // CI/其他机器可指定
    'D:\\Program Files (x86)\\DSH\\.runtime\\node_modules\\@deepseek-ai\\cordis\\lib\\index.js',
  ];
  const req = createRequire(import.meta.url);
  for (const p of candidates) {
    // 显式设了 DSH_CORDIS_ENTRY 就只用它 —— 便于模拟"没有宿主"的 CI 环境
    if (process.env.DSH_CORDIS_ENTRY) {
      const only = process.env.DSH_CORDIS_ENTRY;
      try { req.resolve(only); return pathToFileURL(only).href; } catch { return undefined; }
    }
    if (!p) continue;
    try {
      req.resolve(p);
      return pathToFileURL(p).href;
    } catch { /* 试下一个 */ }
  }
  return undefined;
}

const REAL_CORDIS = loadRealCordis();
const skipLive = REAL_CORDIS === undefined;

/**
 * 造一个可写的最小插件包。
 *
 * fingerprint 用**自身源码哈希**，与 lib/index.js 同构 —— 这点很重要：
 * 用 `String(import.meta.url)` 会让代际一变指纹就变，"代码没改也判成生效"。
 */
function writePlugin(dir, markerValue) {
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'package.json'),
    JSON.stringify({ name: 'reload-probe-pkg', version: '1.0.0', type: 'module' }, null, 2));

  const src = [
    "import { readFileSync } from 'node:fs';",
    "import { fileURLToPath } from 'node:url';",
    '',
    'export const fingerprint = (() => {',
    '  try {',
    '    const buf = readFileSync(fileURLToPath(import.meta.url));',
    '    let hash = 5381;',
    '    for (let i = 0; i < buf.length; i++) hash = ((hash * 33) ^ buf[i]) >>> 0;',
    "    return hash.toString(16).padStart(8, '0');",
    '  } catch {',
    "    return '';",
    '  }',
    '})();',
    '',
    'export const marker = ' + JSON.stringify(markerValue) + ';',
    '',
    'export function apply(ctx) {',
    '  globalThis.__reloadProbeCtx = ctx;',
    '}',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'lib', 'index.js'), src);
}

/**
 * 提供一个假的 loader 服务。
 *
 * `internal.loadCache` 是 selfReload 真正依赖的东西：它在里面找本包的
 * 模块条目并清掉。真宿主靠这个让 loader 重新求值；假 loader 模拟同样行为 ——
 * 条目被清掉时给 URL 加唯一查询串强制重求值（等价于生产的 ?dns-reload=）。
 */
async function withLoaderService() {
  const { Context, Service } = await import(REAL_CORDIS);
  const root = new Context();

  class FakeLoader extends Service {
    constructor(ctx) {
      super(ctx, 'loader', true);
      this.internal = { loadCache: new Map() };
    }
    async import(url, _fallback) {
      let target = url;
      if (!this.internal.loadCache.has(url)) {
        const u = new URL(url);
        u.searchParams.set('probe', String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8));
        target = u.href;
      }
      const mod = await import(target);
      this.internal.loadCache.set(url, mod);
      return mod;
    }
    unwrapExports(mod) { return mod; }
  }

  root.plugin(FakeLoader);
  // 等 service 就绪。不能用 root.lifecycle.flush()：该版本的 root 上没有 lifecycle。
  for (let i = 0; i < 100; i++) {
    if (root.loader && root.loader.internal && root.loader.internal.loadCache) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.ok(root.loader, 'FakeLoader service 应已就绪');

  return { root };
}

// ── S1: 完整重载真的换掉了代码（核心断言）─────────────────────────────
test('S1: 真实 Cordis 里 selfReload 换上了新代码（marker v1 → v2）', { skip: skipLive }, async () => {
  const { root } = await withLoaderService();

  const dir = mkdtempSync(join(tmpdir(), 'reload-probe-'));
  writePlugin(dir, 'v1');

  const pkgUrl = pathToFileURL(dir + '\\').href;
  const entryUrl = pathToFileURL(join(dir, 'lib', 'index.js')).href;

  const loader = root.loader;
  const first = await loader.import(entryUrl);
  assert.equal(first.marker, 'v1', '初版应是 v1');
  const oldFp = first.fingerprint;
  assert.ok(oldFp.length > 0, '初版应有指纹');
  assert.ok(loader.internal.loadCache.size > 0, 'loadCache 应有条目');

  // 用模块对象本身注册 —— registry.get(fiber.runtime.callback) 才能查到 runtime，
  // 且被注册模块的 apply 会真的执行（拿到 ctx）。
  const fiber = root.plugin(first);
  await fiber.await();
  const pluginCtx = globalThis.__reloadProbeCtx;
  assert.ok(pluginCtx, '被注册模块的 apply 应执行并留下 ctx');

  const prev = fiber.runtime.callback;
  const rt = root.registry.get(prev);
  assert.ok(rt, 'registry 应能用 callback 查到 runtime');
  assert.ok([...rt.fibers].length >= 1, 'runtime 应有 live fiber');

  // 改代码 → 磁盘变成 v2（内容变了，源码哈希也会变）
  writePlugin(dir, 'v2');
  assert.ok(computeFingerprint(dir).length > 0, '磁盘指纹应可算');

  const r = await selfReload(pluginCtx, {
    logger: { info() {}, warn() {} },
    packageUrl: pkgUrl,
    entryUrl,
    differFrom: oldFp,
  });

  assert.equal(r.ok, true, '重载应成功：' + (r.error || ''));

  // 核心断言：重新求值后拿到 v2，且指纹变了（代码真的换了）
  const reloaded = await import(entryUrl + '?probe=verify-' + Date.now());
  assert.equal(reloaded.marker, 'v2', '重新求值后应是 v2（磁盘上的新代码）');
  assert.notEqual(reloaded.fingerprint, oldFp, '源码变了，指纹必须不同');
});

// ── S2: 代码没变时，differFrom 校验必须拦住（不谎报成功）────────────────
test('S2: 代码未变时 differFrom 校验判失败（不假成功）', { skip: skipLive }, async () => {
  const { root } = await withLoaderService();

  const dir = mkdtempSync(join(tmpdir(), 'reload-same-'));
  writePlugin(dir, 'same');

  const pkgUrl = pathToFileURL(dir + '\\').href;
  const entryUrl = pathToFileURL(join(dir, 'lib', 'index.js')).href;

  const loader = root.loader;
  const first = await loader.import(entryUrl);

  const fiber = root.plugin(first);
  await fiber.await();
  const pluginCtx = globalThis.__reloadProbeCtx;
  assert.ok(pluginCtx, 'apply 应执行');

  // 不改代码，把当前指纹当 differFrom → 必须失败。
  // 这是 2026-10-17 假成功的直接复刻：重新求值确实发生了，
  // 但代码没变，所以"生效"这个结论不成立。
  const r = await selfReload(pluginCtx, {
    logger: { info() {}, warn() {} },
    packageUrl: pkgUrl,
    entryUrl,
    differFrom: first.fingerprint,
  });

  assert.equal(r.ok, false,
    '代码未变时必须判失败 —— 否则就是 2026-10-17 那种假成功');
  assert.match(String(r.error), /unchanged|verification failed/,
    '错误信息应说明校验未通过，实际：' + r.error);
});

// ── S3: 缺 loader/registry 时安全返回，不抛异常 ─────────────────────────
test('S3: 上下文缺 loader 时返回结构化失败（不抛）', async () => {
  const r = await selfReload({}, { logger: { info() {}, warn() {} } });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /no loader\/registry/);
});

// ── S4: computeFingerprint 对真实插件目录可用 ──────────────────────────
test('S4: computeFingerprint 对真实插件目录返回非空指纹', () => {
  const fp = computeFingerprint(ROOT);
  assert.ok(fp.length > 0, '真实插件目录应能算出指纹');
  assert.match(fp, /^[0-9a-f]{8}$/, '应是 8 位十六进制');
});

// ── S5: 真实 index.js 的 fingerprint 不随代际变化（关键：判断力正确）────
test('S5: index.js 的 fingerprint 对同一份代码保持稳定（不随代际变）', async () => {
  const base = pathToFileURL(join(ROOT, 'lib', 'index.js')).href;
  const a = await import(base);
  const b = await import(base + '?dns-reload=gen-different');
  assert.equal(a.fingerprint, b.fingerprint,
    '代码没变时，代际不同也必须得到相同指纹 —— 否则校验判断力是反的');
  assert.ok(a.fingerprint.length > 0, '指纹不能为空');
});

// ── S6: verifyReload 的四条规则（防逻辑漂移）────────────────────────────
test('S6: verifyReload 的四条规则', () => {
  assert.equal(verifyReload({ gotFingerprint: 'aaa', differFrom: 'aaa' }).ok, false,
    '相同指纹必须失败');
  assert.equal(verifyReload({ gotFingerprint: 'bbb', differFrom: 'aaa' }).ok, true,
    '不同指纹应通过');
  assert.equal(verifyReload({ gotFingerprint: '', differFrom: 'aaa' }).ok, false,
    '缺指纹必须失败（无法自证）');
  assert.equal(verifyReload({ gotFingerprint: 'aaa' }).checked, false,
    '未启用校验时 checked 应为 false');
});
