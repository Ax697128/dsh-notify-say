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
/** 长轮询：有新的完成信号就返回（v0.4.63）。 */
export const ROUTE_WAIT = ROUTE_PREFIX + '/wait';
/** 只确认某一条（前台跳转后调用，避免切回来重复跳）。 */
export const ROUTE_ACK = ROUTE_PREFIX + '/ack';

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
  /**
   * 待跳转队列（v0.4.62：原来只有一个 `last` 槽位）。
   *
   * 按 `at` 升序；**同一会话只保留第一次完成的时刻**。
   * 为什么：队列的排序含义是"谁先完成的"，如果重复完成就刷新 at，
   * 它会退化成"谁最后完成的"，那"跳最早错过的"这条规则就失效了。
   *
   * 上限 MAX_PENDING 纯防御：长时间不回来也不无限增长，超出丢最早的。
   *
   * @type {{ sessionId: string, at: number }[]}
   */
  let pending = [];

  /** 队列上限（正常使用远达不到）。 */
  const MAX_PENDING = 20;

  /** 记录一条通知对应的会话（供 client 取用）。 */
  function setLast(sessionId, now) {
    try {
      const sid = typeof sessionId === 'string' ? sessionId.trim() : '';
      if (!sid) return;
      if (pending.some((e) => e.sessionId === sid)) return;
      pending.push({ sessionId: sid, at: typeof now === 'number' ? now : Date.now() });
      pending.sort((a, b) => a.at - b.at);
      while (pending.length > MAX_PENDING) pending.shift();
      // 长轮询：新信号到达，立刻唤醒所有挂着的 /wait。
      wakeWaiters();
    } catch { /* 通知主流程不因此中断 */ }
  }

  /**
   * 从 POST 请求体里读 sessionId（/ack 用）。
   *
   * 失败一律返回空串（不让畸形请求把 handler 打挂）。体积设上限 4KB ——
   * 这个接口只需要一个 id，没必要读大 body。
   */
  function readBodySessionId(req) {
    return new Promise((resolve) => {
      try {
        if (!req || typeof req.on !== 'function') { resolve(''); return; }
        let raw = '';
        let over = false;
        req.on('data', (chunk) => {
          if (over) return;
          raw += chunk;
          if (raw.length > 4096) { over = true; raw = ''; }
        });
        req.on('end', () => {
          if (over) { resolve(''); return; }
          try {
            const j = JSON.parse(raw || '{}');
            const sid = j && typeof j.sessionId === 'string' ? j.sessionId.trim() : '';
            resolve(sid);
          } catch { resolve(''); }
        });
        req.on('error', () => resolve(''));
      } catch { resolve(''); }
    });
  }

  /**
   * 挂起的 /wait 响应池（长轮询）。
   *
   * 每项 { res, after, timer }：
   *   after = 客户端已知的最新 at，只有更新的条目才该唤醒它；
   *   timer = 25 秒兜底超时，防连接被代理/宿主悄悄掐断后客户端一直等。
   *
   * ⚠️ 必须在 res 的 close/error 上摘除自己 —— 否则客户端刷新或关页面会留下
   * 死引用，长跑内存只增不减。
   */
  const waiters = new Set();

  /** 超时上限：25 秒（低于常见 30 秒空闲超时）。 */
  const WAIT_TIMEOUT_MS = 25_000;

  /** 结束一个挂起响应并把它从池里摘掉（幂等）。 */
  function settleWaiter(w, code, body) {
    if (!w || w.done) return;
    w.done = true;
    try { clearTimeout(w.timer); } catch { /* ignore */ }
    waiters.delete(w);
    try { w.send(code, body); } catch { /* 客户端可能已断开 */ }
  }

  /**
   * 有新信号时唤醒**所有**满足条件的挂起响应。
   *
   * 条件：队列里存在 at > w.after 的条目。用"最新的那条"返回，
   * 这样客户端一次就能拿到当前最新的完成（无需为每条都往返一次）。
   */
  function wakeWaiters() {
    if (!waiters.size) return;
    for (const w of [...waiters]) {
      const newer = pending.filter((e) => e.at > w.after);
      if (!newer.length) continue;
      const latest = newer[newer.length - 1];
      settleWaiter(w, 200, { sessionId: latest.sessionId, at: latest.at, sessions: newer });
    }
  }

  /** 插件卸载/热重载：把所有挂起响应正常结束掉，避免残留句柄。 */
  function disposeAllWaiters() {
    for (const w of [...waiters]) settleWaiter(w, 204);
  }

  /** 只看不取：返回队列里**最早**的一条（单条时即原语义）。 */
  function peek() {
    return pending.length ? pending[0] : null;
  }

  /**
   * HTTP handler。
   *
   * 支持两种形态的 register 回调（本机实测不同插件用法不同）：
   *   - `{ request, response }` 风格（Node http）
   *   - `(req, res)` 位置参数风格
   * 统一从第一个参数上取 request/response，兼容两者。
   */
  async function handler(...args) {
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
      const isWait = head === 'wait';
      const isAck = head === 'ack';

      // ── /ack：只确认一条（前台跳转后用）────────────────────────────
      //
      // 与 /consume 的区别：consume 清空整个队列（"我回来处理完了"），
      // ack 只摘掉指定的那一条（"这一条我已经跳过去看了，其余的留着"）。
      if (isAck) {
        const method = String((req && req.method) || 'GET').toUpperCase();
        if (method !== 'POST') {
          if (res && typeof res.setHeader === 'function') res.setHeader('allow', 'POST');
          send(405, { error: 'method-not-allowed', allow: 'POST' });
          return;
        }
        const sid = await readBodySessionId(req);
        const before = pending.length;
        if (sid) pending = pending.filter((e) => e.sessionId !== sid);
        send(200, { ok: true, removed: before - pending.length, left: pending.length });
        return;
      }

      // ── /wait：长轮询（v0.4.63）────────────────────────────────────
      //
      // 客户端带上它已知的最新 at；有更新的就立刻返回，否则挂起。
      // 挂起期间不占 CPU、不发新请求 —— 这就是它比定时轮询好的地方。
      if (isWait) {
        const qs = url.includes('?') ? url.slice(url.indexOf('?') + 1) : '';
        const m = /(?:^|&)after=(\d+)/.exec(qs);
        const after = m ? Number(m[1]) : 0;
        const newer = pending.filter((e) => e.at > after);
        if (newer.length) {
          const latest = newer[newer.length - 1];
          send(200, { sessionId: latest.sessionId, at: latest.at, sessions: newer });
          return;
        }
        // 没有新信号 → 挂起。用 send 的同一个响应对象，保证头部设置一致。
        const w = {
          res,
          after,
          done: false,
          send,
          timer: (() => {
            const t = setTimeout(() => settleWaiter(w, 204), WAIT_TIMEOUT_MS);
            // ⚠️ 必须 unref：否则一个挂着的 /wait 会吊住整个 Node 进程不退出
            // （测试里尤其致命 —— 跑完所有用例后进程还在等）。
            try { if (t && typeof t.unref === 'function') t.unref(); } catch { /* ignore */ }
            return t;
          })(),
        };
        waiters.add(w);
        // 客户端断开（关页面/刷新/网络断）→ 摘除，否则死引用堆积。
        try {
          if (res && typeof res.once === 'function') res.once('close', () => settleWaiter(w, 204));
        } catch { /* ignore */ }
        return;
      }

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
        // 一次取走整个队列并清空（消费即清，避免重复跳转）。
        // 顶层仍保留 sessionId/at（= 队首）—— 老客户端只读这两个字段，
        // 新客户端优先读 sessions 数组（v0.4.62）。
        const taken = pending;
        pending = [];
        if (!taken.length) { send(204); return; }
        send(200, { sessions: taken, sessionId: taken[0].sessionId, at: taken[0].at });
        return;
      }
      // 默认走 last-session（只读，不改状态）：返回**队首**，保持旧的单条形状。
      const firstPending = pending.length ? pending[0] : null;
      if (!firstPending) { send(204); return; }
      send(200, firstPending);
    } catch {
      send(500, { error: 'internal' });
    }
  }

  return { handler, setLast, peek, disposeAllWaiters };
}
