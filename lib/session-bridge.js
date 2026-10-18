/**
 * 会话状态桥（host 半侧 HTTP route）。
 *
 * ## 为什么需要它
 *
 * client 半侧要「点 Toast 后跳到那条通知对应的会话」，但它拿不到会话 id：
 *
 *   - 渲染进程是 `sandbox:true / contextIsolation:true / nodeIntegration:false`
 *     （app.asar 实测）→ **没有 `process`**，读不了 `$DSH_HOME` 下的文件；
 *   - 也不能直接访问 host 的 Cordis 服务（只有白名单里的 remote 事件）。
 *
 * 所以走官方给的正路：host 注册一个 `/api/...` route，client 用 `fetch` 取。
 * 本机先例：`dsh-our-free-model` 用 `webServer.register({ kind:'prefix' })` +
 * client 侧 `fetch('api/our-free-model')`（注释里提醒要用 `document.baseURI` 解析，
 * 不能写 origin-absolute 的 `/api/...`，否则反向代理下会 404）。
 *
 * ## 稳定性设计（本插件首要目标）
 *
 * `webServer` 是可选依赖，**拿不到就整体不注册**，插件其余功能（Toast + 语音）
 * 完全不受影响。这与「配置层失败就降级」是同一套思路：
 * 任何增强能力都不得连累主功能。
 *
 * route 只做两件事：
 *   GET  /api/dsh-notify-say/last-session  → { sessionId, at } 或 204
 *   POST /api/dsh-notify-say/consume       → 读一次并清空（防重复跳转）
 */

/** route 前缀（client 侧据此拼接）。 */
export const ROUTE_PREFIX = '/api/dsh-notify-say';

/** 取最近通知会话的路径。 */
export const ROUTE_LAST = ROUTE_PREFIX + '/last-session';

/** 消费（读取并清空）的路径。 */
export const ROUTE_CONSUME = ROUTE_PREFIX + '/consume';

/**
 * 创建 route handler。状态放在闭包里，不落盘 ——
 * 这是**进程内、短生命周期**的一次性信号，重启即失效，正好符合语义
 * （重启后没有"刚才那条通知"了）。
 *
 * @returns {{ handler: Function, setLast: Function, peek: Function }}
 */
export function createSessionBridge() {
  /** @type {{ sessionId: string, at: number } | null} */
  let last = null;

  /** 记录一条通知对应的会话（供 client 取用）。 */
  function setLast(sessionId, now) {
    try {
      const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
      if (!sid) return;
      last = { sessionId: sid, at: typeof now === 'number' ? now : Date.now() };
    } catch { /* 通知主流程不因此中断 */ }
  }

  /** 只看不取。 */
  function peek() {
    return last;
  }

  /**
   * HTTP handler。
   *
   * 支持两种形态的 register 回调（本机实测不同插件用法不同）：
   *   - `{ request, response }` 风格（Node http）
   *   - `(req, res)` 位置参数风格
   * 统一从第一个参数上取 request/response，兼容两者。
   */
  function handler(...args) {
    const req = args[0] && args[0].request ? args[0].request
      : (args[0] && args[0].req ? args[0].req : args[0]);
    const res = args[0] && args[0].response ? args[0].response
      : (args[0] && args[0].res ? args[0].res : args[1]);

    const send = (code, body) => {
      try {
        if (res && typeof res.writeHead === 'function') {
          const text = body === undefined ? '' : JSON.stringify(body);
          res.writeHead(code, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          });
          res.end(text);
          return;
        }
        if (res && typeof res.setHeader === 'function' && typeof res.end === 'function') {
          res.statusCode = code;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.setHeader('cache-control', 'no-store');
          res.end(body === undefined ? '' : JSON.stringify(body));
        }
      } catch { /* 响应写失败不影响后续 */ }
    };

    try {
      const url = String((req && (req.url || req.path)) || '');
      // ⚠️ 必须按**路径段**判断，不能用 indexOf，
      // 否则 `/last-session?next=/consume` 会被误判成 consume（子串匹配）。
      const pathname = url.split('?')[0].split('#')[0];
      // ⚠️ 必须先剥掉 route 前缀再取第一段。
      // 否则 `/api/dsh-notify-say/consume` 的第一段是 `api`，
      // 永远匹配不到 consume —— 消费不会清状态（v0.4.25 实测踩到）。
      const rest = pathname.startsWith(ROUTE_PREFIX)
        ? pathname.slice(ROUTE_PREFIX.length)
        : pathname;
      const head = rest.replace(/^\/+/, '').split('/')[0];

      const isConsume = head === 'consume';

      if (isConsume) {
        // ⚠️ 只接受 POST：这个动作会**清除服务端状态**，用 GET 既语义不当，
        // 也会被浏览器的跨站简单请求（<img>/<a>）触发。
        // 客户端已改为 POST + JSON（见 client.js 的 consumeLastSession）。
        const method = String((req && req.method) || 'GET').toUpperCase();
        if (method !== 'POST') {
          if (res && typeof res.setHeader === 'function') {
            res.setHeader('allow', 'POST');
          }
          send(405, { error: 'method-not-allowed', allow: 'POST' });
          return;
        }
        const hit = last;
        last = null;                 // 消费即清，避免重复跳转
        if (!hit) { send(204); return; }
        send(200, hit);
        return;
      }
      // 默认走 last-session（只读，不改状态）
      if (!last) { send(204); return; }
      send(200, last);
    } catch {
      send(500, { error: 'internal' });
    }
  }

  return { handler, setLast, peek };
}
