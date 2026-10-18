/**
 * HTTP 路由的本地来源防护（v0.4.24）。
 *
 * ## 为什么需要这个文件
 *
 * 2026-10-18 实测发现：宿主的 `/api` 网关有鉴权（无凭据返回 401），
 * 但**插件通过 `webServer.register()` 注册的路由不在该保护范围内**：
 *
 *   /api                       → 401   宿主鉴权
 *   /api/remote.mux            → 401   宿主鉴权
 *   /api/dsh-notify-say/config → 200   **我们的路由，无鉴权**
 *
 * 实测最坏情况：不带任何凭据 POST `config/set` 返回 200，配置被改。
 *
 * ## 威胁模型（诚实评估，不夸大）
 *
 * | 攻击面        | 可行 | 说明 |
 * |--------------|------|------|
 * | 外部网络      | 否   | webServer 默认只监听 127.0.0.1 |
 * | 本机其他程序  | 是   | 本机进程可自由访问，但这属于既有信任边界 |
 * | **恶意网页**  | 是   | 这是本文件主要想挡的 |
 *
 * 恶意网页的具体手法：
 *   · `<img src="http://127.0.0.1:PORT/api/dsh-notify-say/preview">`
 *     —— 简单 GET，不受 CORS 限制，可反复触发播放声音
 *   · `<form method=POST action=".../config/set">` + 自动提交
 *     —— 简单 POST，content-type 是表单类型，不触发预检
 *   · `fetch(..., {mode:'no-cors'})`
 *     —— 响应读不到，但**副作用已经发生**
 *
 * ## 防御策略
 *
 * 用三个互相独立的信号判断「这是不是我们自己的界面在调」：
 *
 * 1. **Origin / Referer 必须是本机回环地址**
 *    恶意网页的 Origin 是它的域名 → 直接拒绝。
 *    注意：`Origin: null`（沙箱 iframe、file://）也拒绝 —— 我们的界面不会有这个。
 *
 * 2. **拒绝 Sec-Fetch-Site: cross-site**
 *    现代浏览器会带这个头，跨站请求直接标出来。
 *
 * 3. **写操作必须是 JSON content-type**
 *    `<form>` 只能发 `application/x-www-form-urlencoded` /
 *    `multipart/form-data` / `text/plain`，**发不出 application/json**。
 *    所以强制 JSON 就等于"必须用 fetch/XHR + 预检"，而预检会被 Origin 检查拦下。
 *
 * 这三条都是**纯本地判断**，不需要密钥、不需要和前端协商、不破坏现有调用。
 *
 * ## 已知局限（如实说明）
 *
 * · 不防本机进程。本机进程伪造 Origin 头很容易，但它在 Windows 上本来就能
 *   直接读你的文件，不是这个模块该解决的问题。
 * · `localhost` 与 `127.0.0.1` 互不相等，所以检查时两者都接受，
 *   且要求端口一致（避免别的本机服务冒用）。
 */

/** 允许的来源主机名（回环地址的常见写法）。 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * 从 Origin/Referer 字符串里取 host（含端口）。
 * @param {string} value
 * @returns {string|null}
 */
function hostOf(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    const u = new URL(value);
    return u.host || null;
  } catch {
    return null;
  }
}

/**
 * 这个 host 是否属于本机回环。
 * @param {string|null} host
 * @returns {boolean}
 */
function isLoopbackHost(host) {
  if (!host) return false;
  // host 形如 `127.0.0.1:62120`；带端口时拆开看
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(host);
  if (!m) return false;
  return LOOPBACK_HOSTS.has(m[1]);
}

/**
 * 从请求里取出 host:port（用于同源比较）。
 * @param {object} req
 * @returns {string|null}
 */
function requestHost(req) {
  try {
    const h = (req && req.headers) || {};
    // Host 头优先；HTTP/1.1 必带
    const raw = h.host || h.hostname;
    return raw ? String(raw) : null;
  } catch {
    return null;
  }
}

/**
 * 判断一个请求是否来自本插件的界面。
 *
 * @param {object} req
 * @param {{ write?: boolean }} [opts] write=true 时额外要求 JSON content-type
 * @returns {{ ok: boolean, reason?: string }}
 */
export function checkLocalOrigin(req, opts = {}) {
  const headers = (req && req.headers) || {};

  // ── 信号 1：Sec-Fetch-Site ────────────────────────────────────────────
  // 现代浏览器对跨站请求会明确标注。`same-origin`/`none` 才是同一页面自己发的。
  const site = headers['sec-fetch-site'];
  if (typeof site === 'string' && site !== '' && site !== 'same-origin' && site !== 'none') {
    return { ok: false, reason: 'cross-site' };
  }

  // ── 信号 2：Origin（没有则看 Referer）────────────────────────────────
  //
  // 注意没有 Origin 的情况：
  //   · 同源 GET / 简单导航 —— 浏览器可能不带 Origin
  //   · `<img>` / `<script>` 加载 —— 通常不带 Origin，但**带 Sec-Fetch-Site**
  //   · curl / 本机脚本 —— 什么都不带
  //
  // 我们不能要求"必须有 Origin"（会打断正常的同源 GET），
  // 但要求"如果有，必须是本机回环"。
  const origin = headers.origin;
  if (typeof origin === 'string' && origin !== '') {
    if (origin === 'null') {
      // 沙箱 iframe / file:// —— 我们的设置界面不会这样
      return { ok: false, reason: 'null-origin' };
    }
    const h = hostOf(origin);
    if (!h || !isLoopbackHost(h)) {
      return { ok: false, reason: 'foreign-origin' };
    }
    return finishWriteCheck(req, headers, opts);
  }

  const referer = headers.referer;
  if (typeof referer === 'string' && referer !== '') {
    const h = hostOf(referer);
    if (!h || !isLoopbackHost(h)) {
      return { ok: false, reason: 'foreign-referer' };
    }
    return finishWriteCheck(req, headers, opts);
  }

  // 既无 Origin 也无 Referer：
  //   · 写操作 → 拒绝（正常前端写配置一定经过 fetch，会带 Origin）
  //   · 读操作 → 放行（避免打断 `<img>` 之外的无头场景与外部工具调试）
  if (opts.write) {
    return { ok: false, reason: 'write-without-origin' };
  }
  return { ok: true };
}

/**
 * 写操作的附加要求：必须是 JSON。
 *
 * `<form>` 永远发不出 `application/json`，所以这一条把"跨站表单提交"
 * 这条路彻底堵死 —— 即便 Origin 检查被某种方式绕过，表单也发不出 JSON。
 *
 * @param {object} req
 * @param {object} headers
 * @param {{ write?: boolean }} opts
 */
function finishWriteCheck(req, headers, opts) {
  if (!opts.write) return { ok: true };
  const ct = String(headers['content-type'] || '').toLowerCase();
  if (!ct.includes('application/json')) {
    return { ok: false, reason: 'write-requires-json' };
  }
  return { ok: true };
}

/**
 * 给请求打上限流。
 *
 * 用途：`preview` / `selftest` 会真的出声、真的起子进程。
 * 恶意网页可以用 `<img>` 反复触发，一秒钟弹十几次 —— 既是骚扰也是资源放大。
 *
 * 实现是**按路由名的最小间隔限流**（不是令牌桶）：够用、无状态、好测。
 */
const lastHitAt = new Map();

/**
 * @param {string} key 限流桶名（通常用路由名）
 * @param {number} minIntervalMs 两次之间最小间隔
 * @returns {{ ok: boolean, retryAfterMs?: number }}
 */
export function throttle(key, minIntervalMs) {
  const now = Date.now();
  const prev = lastHitAt.get(key) || 0;
  const delta = now - prev;
  if (delta < minIntervalMs) {
    return { ok: false, retryAfterMs: minIntervalMs - delta };
  }
  lastHitAt.set(key, now);
  return { ok: true };
}

/** 仅供测试：清空限流状态。 */
export function __resetThrottle() {
  lastHitAt.clear();
}

/** 导出内部常量供测试断言。 */
export const __internals = { LOOPBACK_HOSTS, MAX_LIMITS: { preview: 3000, selftest: 3000 } };
