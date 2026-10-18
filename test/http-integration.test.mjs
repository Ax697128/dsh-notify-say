/**
 * HTTP 端到端集成测试（v0.4.25）。
 *
 * ## 为什么这类测试必须有
 *
 * 2026-10-18 的教训：我为 `/consume` 加了"写操作必须 JSON"的防护，
 * 但客户端仍然用 **GET 无 body** 调用它 —— 结果实测 `GET /consume → 403`，
 * 会话跳转刚修好又被我自己打断。
 *
 * 单元测试全绿（H1~H11），因为它们各自只看自己那一半：
 *   · http-guard 的测试说"写操作要 JSON" ✅
 *   · client 的测试说"返回值是对象" ✅
 *   · **没有测试把两端接起来跑一次真实请求** ❌
 *
 * 所以这个文件起一个**真实的 HTTP 服务器**（用 Node 内置 http），
 * 把插件的真实 handler 挂上去，再用**客户端真实的调用方式**打过去。
 *
 * 这样"客户端怎么发"和"服务端怎么判"就在同一个测试里对齐了。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

import { createConfigRoute } from '../lib/config-route.js';
import { createSessionBridge, ROUTE_PREFIX } from '../lib/session-bridge.js';
import { checkLocalOrigin, throttle, __resetThrottle } from '../lib/http-guard.js';

/**
 * 起一个临时服务器，把「路由分流 + guard」按 index.js 的方式接起来。
 *
 * 刻意**复制** index.js 的分流逻辑而不是 import 它：
 * index.js 会加载整个插件（依赖 DSH 上下文），在纯 Node 里跑不起来。
 * 代价是这份逻辑与 index.js 有重复 —— 所以下面 E7 会断言两者的
 * 关键判据一致，防止单边漂移。
 */
async function startServer() {
  const bridge = createSessionBridge();
  const configRoute = createConfigRoute({
    read: () => ({}),
    effective: () => ({}),
    notifyChanged: () => {},
  });

  const server = createServer((req, res) => {
    const raw = String(req.url || '');
    const pathname = raw.split('?')[0].split('#')[0];
    const rest = pathname.startsWith(ROUTE_PREFIX)
      ? pathname.slice(ROUTE_PREFIX.length)
      : pathname;
    const head = rest.replace(/^\/+/, '').split('/')[0];

    // 与 index.js 完全一致的两条判定
    const isWriteRoute = (head === 'config' && /\/set\b/.test(pathname)) || head === 'consume';
    const guard = checkLocalOrigin(req, { write: isWriteRoute });
    if (!guard.ok) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, reason: guard.reason }));
      return;
    }

    if (head === 'config') return configRoute.handler(req, res);
    if (head === 'preview' || head === 'selftest') {
      const g = throttle(head, 3000);
      if (!g.ok) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, reason: 'throttled' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, kind: head }));
      return;
    }
    return bridge.handler(req, res);
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  return {
    port,
    base: `http://127.0.0.1:${port}`,
    bridge,
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}

/** 发一个真实请求（可控 method / headers / body）。 */
async function call(base, path, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(base + ROUTE_PREFIX + path, { method, headers, body });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null };
}

/**
 * 从 client.js 源码里解析出 consume 的真实调用方式。
 *
 * ## 为什么要这么绕
 *
 * 我第一版 E1 是**手写**一份"看起来对"的请求（POST + JSON）。
 * 但这有个致命弱点（实测暴露）：把客户端改回 GET 后，E1 依然全绿 ——
 * 因为它根本没读客户端代码，测的是我自己写的那份。
 *
 * 现在改成**从源码里抠出 method / 是否要求 JSON**，
 * 客户端一改回 GET，这里解析结果就变，E1 立刻变红。
 */
function clientConsumeShape() {
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const src = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');

  // 定位 consume 那一段 fetch（从 apiUrl('consume') 起 300 字符内）
  const at = src.indexOf("apiUrl('consume')");
  assert.ok(at >= 0, 'client.js 里应有 apiUrl(\'consume\')');
  const seg = src.slice(at, at + 400);

  const method = /method:\s*'([A-Z]+)'/.exec(seg);
  const hasJson = /content-type'\s*:\s*'application\/json'/.test(seg);
  return {
    method: (method ? method[1] : 'GET').toUpperCase(),
    hasJson,
    seg,
  };
}

// ── E0: 客户端 consume 必须是 POST + JSON（源码级契约）───────────────────
test('E0: client.js 里 consume 的调用必须是 POST 且带 JSON content-type', () => {
  const shape = clientConsumeShape();
  assert.equal(shape.method, 'POST',
    'consume 会清除服务端状态，必须用 POST；用 GET 会被 guard 拒绝（实测 403）');
  assert.equal(shape.hasJson, true,
    '必须声明 content-type: application/json —— 否则写操作会被 guard 拒为 write-requires-json');
});

// ── E1: 客户端真实调用方式能消费成功（核心回归）──────────────────────────
test('E1: 按 client.js 的真实调用形状发请求能拿到会话（不是 403）', async () => {
  __resetThrottle();
  const srv = await startServer();
  try {
    srv.bridge.setLast('sess-e1', Date.now());

    // **用客户端源码里解析出的形状**，而不是手写一份
    const shape = clientConsumeShape();
    const headers = { origin: srv.base };
    if (shape.hasJson) headers['content-type'] = 'application/json';
    const r = await call(srv.base, '/consume', {
      method: shape.method,
      headers,
      body: shape.method === 'POST' ? '{}' : undefined,
    });

    assert.equal(r.status, 200,
      `按客户端形状（${shape.method}）应 200，实际 ${r.status}：${r.text}`);
    assert.equal(r.json.sessionId, 'sess-e1', '应拿到刚设置的会话');
  } finally {
    await srv.close();
  }
});

// ── E2: 旧的 GET 调用必须被拒（锁住"必须 POST"的契约）──────────────────
test('E2: GET /consume 被拒绝（405 或 403，但不是 200）', async () => {
  const srv = await startServer();
  try {
    srv.bridge.setLast('sess-e2', Date.now());
    const r = await call(srv.base, '/consume', {
      method: 'GET',
      headers: { origin: srv.base },
    });
    assert.notEqual(r.status, 200,
      'GET 不应消费成功 —— 这个动作会清除服务端状态，必须 POST');
    // 405 是服务端语义拒绝；403 是 guard 拒绝。两者都算正确拦截。
    assert.ok([405, 403].includes(r.status), `应是 405 或 403，实际 ${r.status}`);
  } finally {
    await srv.close();
  }
});

// ── E3: 消费后信号被清（不会重复跳转）──────────────────────────────────
test('E3: consume 之后 last-session 为空（消费即清）', async () => {
  const srv = await startServer();
  try {
    srv.bridge.setLast('sess-e3', Date.now());
    await call(srv.base, '/consume', {
      method: 'POST',
      headers: { origin: srv.base, 'content-type': 'application/json' },
      body: '{}',
    });
    const r = await call(srv.base, '/last-session', {
      method: 'GET',
      headers: { origin: srv.base },
    });
    assert.equal(r.status, 204, `消费后应 204，实际 ${r.status}`);
  } finally {
    await srv.close();
  }
});

// ── E4: 外部 Origin 写配置被拒（真实请求，不是单测）────────────────────
test('E4: 外部 Origin 的 config/set 被 403 拒绝', async () => {
  const srv = await startServer();
  try {
    const r = await call(srv.base, '/config/set', {
      method: 'POST',
      headers: { origin: 'https://evil.com', 'content-type': 'application/json' },
      body: JSON.stringify({ values: { volume: 99 } }),
    });
    assert.equal(r.status, 403);
    assert.equal(r.json.reason, 'foreign-origin');
  } finally {
    await srv.close();
  }
});

// ── E5: 表单式跨站提交被拒（<form> 发不出 JSON）────────────────────────
test('E5: 表单 content-type 的 config/set 被拒绝', async () => {
  const srv = await startServer();
  try {
    const r = await call(srv.base, '/config/set', {
      method: 'POST',
      headers: {
        origin: srv.base,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: 'volume=99',
    });
    assert.equal(r.status, 403);
    assert.equal(r.json.reason, 'write-requires-json');
  } finally {
    await srv.close();
  }
});

// ── E6: 限流在真实请求下生效 ────────────────────────────────────────────
test('E6: 连续两次 preview，第二次 429', async () => {
  __resetThrottle();
  const srv = await startServer();
  try {
    const h = { origin: srv.base };
    const a = await call(srv.base, '/preview?kind=done', { headers: h });
    const b = await call(srv.base, '/preview?kind=done', { headers: h });
    assert.equal(a.status, 200, '第一次应放行');
    assert.equal(b.status, 429, '第二次应被限流');
  } finally {
    await srv.close();
  }
});

// ── E7: 本测试的分流逻辑必须与 index.js 一致（防单边漂移）───────────────
test('E7: index.js 的 isWriteRoute 判据与集成测试一致', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const src = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8');

  assert.match(src, /head === 'consume'/,
    "index.js 必须把 consume 当作写路由 —— 与集成测试一致");
  assert.match(src, /checkLocalOrigin\(req, \{ write: isWriteRoute \}\)/,
    'index.js 必须用同一个 guard 调用形状');
});

// ── E8: config-route 超限回 413 而不是断连 ──────────────────────────────
test('E8: 超过 64 KB 的请求体得到 413（连接未被重置）', async () => {
  const srv = await startServer();
  try {
    const big = 'x'.repeat(70 * 1024);
    const r = await call(srv.base, '/config/set', {
      method: 'POST',
      headers: { origin: srv.base, 'content-type': 'application/json' },
      body: JSON.stringify({ values: { pad: big } }),
    });
    // 关键：能读到 status 就说明连接没被提前切断
    assert.equal(r.status, 413, `应 413，实际 ${r.status}`);
    assert.equal(r.json.reason, 'body-too-large');
  } finally {
    await srv.close();
  }
});
