/**
 * 语音包管理的 HTTP 路由（v0.4.31）。
 *
 * ## 为什么单独一个文件
 *
 * 下载安装是**唯一写盘**的功能，把它和其它路由混在 index.js 里
 * 会让安全审查变难。单独一个文件，配合 http-guard 的三个检查，
 * 审阅者能在一处看完全部逻辑。
 *
 * ## 安全约束（比其它路由严）
 *
 * 1. **所有写操作必须 POST + JSON** —— 由 http-guard 统一强制。
 *    `<form>` 发不出 JSON，所以跨站表单提交打不进来。
 *
 * 2. **不接受客户端传 URL**
 *    下载地址由服务端从固定源（GitHub Release）算出来。
 *    否则就是 SSRF：让本机去访问任意地址、把内容写到磁盘。
 *
 * 3. **key 必须匹配白名单字符集**
 *    它是目录名的一部分。`../` 之类必须在入口就被挡住，
 *    不能指望后面的路径校验兜底。
 *
 * 4. **操作有互斥锁**
 *    同时点两次"安装"会互相踩临时目录。用一个简单的布尔锁挡住。
 *
 * ## 路由
 *
 * ```
 * GET  /voicepacks/index        可下载的音色清单（含已装状态）
 * POST /voicepacks/install      安装一个音色（body: { key })
 * POST /voicepacks/uninstall    卸载（body: { key }）
 * ```
 */

import { fetchPackIndex, packDownloadUrl, installVoicePack, uninstallVoicePack } from './voice-pack-download.js';
import { installedVoiceKeys, mergeVoices, poolCoverage, userKeyDir } from './voice-pack-store.js';

/** key 的合法字符集 —— 它会被拼进路径，必须严。 */
const KEY_RE = /^\w[\w-]*$/;

/** 同时只允许一个安装/卸载操作（避免临时目录互踩）。 */
let busy = false;

/** 读 JSON body（带大小上限）。 */
function readJson(req, maxBytes = 8 * 1024) {
  return new Promise((resolve) => {
    try {
      if (!req) return resolve({});
      if (req.body != null && typeof req.body === 'object') return resolve(req.body);
      if (typeof req.on !== 'function') return resolve({});

      const chunks = [];
      let total = 0;
      let done = false;
      const finish = (v) => {
        if (done) return;
        done = true;
        if (v !== undefined) return resolve(v);
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve(text ? JSON.parse(text) : {});
        } catch {
          resolve({});
        }
      };
      req.on('data', (c) => {
        if (done) return;
        const buf = Buffer.isBuffer(c) ? c : Buffer.from(String(c));
        total += buf.length;
        if (total > maxBytes) {
          try { req.pause?.(); } catch { /* ignore */ }
          finish({ __tooLarge: true });
          return;
        }
        chunks.push(buf);
      });
      req.on('end', () => finish());
      req.on('error', () => finish());
      setTimeout(() => finish(), 3000);
    } catch {
      resolve({});
    }
  });
}

/** 写 JSON 响应（兼容两种 res 形态）。 */
function send(res, code, body) {
  try {
    const text = body === undefined ? '' : JSON.stringify(body);
    if (res && typeof res.writeHead === 'function') {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(text);
      return;
    }
    if (res && typeof res.setHeader === 'function' && typeof res.end === 'function') {
      res.statusCode = code;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('cache-control', 'no-store');
      res.end(text);
    }
  } catch { /* 响应写失败不影响后续 */ }
}

/**
 * 建立路由处理器。
 *
 * @param {object} opts
 * @param {string} opts.pluginRoot 插件根（用于判断内置音色）
 * @param {Function} [opts.logger]
 * @returns {{ handle: Function, isVoicepackPath: Function }}
 */
export function createVoicePackRoute(opts = {}) {
  const pluginRoot = opts.pluginRoot || '.';
  const log = opts.logger || { info() {}, warn() {} };

  /** 索引：可下载的 + 已装的 + 内置的，合并成一份状态。 */
  async function handleIndex(res) {
    const installed = new Set(installedVoiceKeys());
    const local = mergeVoices(pluginRoot);

    const idx = await fetchPackIndex().catch(() => ({ ok: false, error: 'fetch-failed' }));
    const downloadable = idx.ok ? idx.packs : [];

    // 以"本地已有 + 远端可下载"的并集为主体
    const byKey = new Map();
    for (const v of local) {
      byKey.set(v.key, {
        key: v.key,
        installed: installed.has(v.key),
        source: v.source,
        downloadable: false,
        coverage: poolCoverage(pluginRoot, v.key),
      });
    }
    for (const p of downloadable) {
      const cur = byKey.get(p.key) || { key: p.key, installed: installed.has(p.key), source: null };
      byKey.set(p.key, {
        ...cur,
        name: p.name,
        credit: p.credit,
        termsUrl: p.terms,
        bytes: p.bytes,
        wavs: p.wavs,
        downloadable: true,
        coverage: cur.coverage || poolCoverage(pluginRoot, p.key),
      });
    }

    send(res, 200, {
      ok: true,
      indexOk: idx.ok,
      indexError: idx.ok ? undefined : idx.error,
      packs: [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key)),
    });
  }

  async function handleInstall(req, res) {
    const body = await readJson(req);
    if (body && body.__tooLarge) {
      return send(res, 413, { ok: false, reason: 'body-too-large' });
    }
    const key = String((body && body.key) || '');
    if (!KEY_RE.test(key)) {
      return send(res, 400, { ok: false, reason: 'bad-key' });
    }
    if (busy) {
      return send(res, 429, { ok: false, reason: 'busy' });
    }

    busy = true;
    try {
      const idx = await fetchPackIndex();
      if (!idx.ok) {
        return send(res, 502, { ok: false, reason: 'index-unavailable', error: idx.error });
      }
      const dl = packDownloadUrl(idx.packs, key);
      if (!dl.ok) {
        return send(res, 404, { ok: false, reason: 'not-in-index' });
      }

      // ⚠️ 只用服务端算出的 URL，**不接受客户端传**
      const r = await installVoicePack(key, {
        url: dl.url,
        sha256: dl.sha256,
        logger: log,
      });
      if (!r.ok) {
        return send(res, 500, { ok: false, reason: 'install-failed', error: r.error });
      }
      return send(res, 200, { ok: true, key, files: r.files, bytes: r.bytes });
    } finally {
      busy = false;
    }
  }

  async function handleUninstall(req, res) {
    const body = await readJson(req);
    if (body && body.__tooLarge) {
      return send(res, 413, { ok: false, reason: 'body-too-large' });
    }
    const key = String((body && body.key) || '');
    if (!KEY_RE.test(key)) {
      return send(res, 400, { ok: false, reason: 'bad-key' });
    }
    if (busy) {
      return send(res, 429, { ok: false, reason: 'busy' });
    }

    busy = true;
    try {
      const r = uninstallVoicePack(key);
      if (!r.ok) {
        const code = r.error === 'not-installed' ? 404 : 500;
        return send(res, code, { ok: false, reason: r.error });
      }
      log.info(`[voicepack] uninstalled key=${key} dir=${userKeyDir(key)}`);
      return send(res, 200, { ok: true, key });
    } finally {
      busy = false;
    }
  }

  /**
   * 处理一个请求。返回 true 表示已处理。
   *
   * @param {object} req
   * @param {object} res
   * @param {string} head 路由首段（调用方已剥前缀）
   * @param {string} pathname 完整 pathname（用来区分二级路径）
   * @returns {Promise<boolean>}
   */
  async function handle(req, res, head, pathname) {
    if (head !== 'voicepacks') return false;

    const method = String((req && req.method) || 'GET').toUpperCase();
    const second = String(pathname || '').split('/').filter(Boolean).pop() || '';

    if (second === 'index') {
      if (method !== 'GET') return send(res, 405, { ok: false, reason: 'method-not-allowed' }), true;
      await handleIndex(res);
      return true;
    }
    if (second === 'install') {
      if (method !== 'POST') return send(res, 405, { ok: false, reason: 'method-not-allowed' }), true;
      await handleInstall(req, res);
      return true;
    }
    if (second === 'uninstall') {
      if (method !== 'POST') return send(res, 405, { ok: false, reason: 'method-not-allowed' }), true;
      await handleUninstall(req, res);
      return true;
    }
    send(res, 404, { ok: false, reason: 'unknown-voicepack-route' });
    return true;
  }

  return { handle };
}
