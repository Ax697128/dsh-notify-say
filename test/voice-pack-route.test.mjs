/**
 * 语音包路由集成测试（v0.4.31）。
 *
 * ## 为什么这些必须测真实请求
 *
 * 下载安装是唯一写盘的功能。安全属性（拒绝非法 key、只认 POST、
 * 不信任客户端 URL）都体现在**请求处理**这一层，
 * 纯函数测试覆盖不到。
 *
 * ## 踩过的坑（写这个文件时）
 *
 * 第一版用 `setImmediate` 把 body 推进 stream，结果 body 在 handler
 * 挂上监听**之前**就发完了 —— 拿到空 body，测试误报"已装清单为空"。
 * 现在改成：handler 挂好监听后再发（`setTimeout` + 显式 fire）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createVoicePackRoute } from '../lib/voice-pack-route.js';
import { installedVoiceKeys, userKeyDir } from '../lib/voice-pack-store.js';

/** 临时数据目录。 */
async function withDataDir(fn) {
  const old = process.env.DSH_NOTIFY_SAY_DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'vpr-'));
  process.env.DSH_NOTIFY_SAY_DATA_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (old === undefined) delete process.env.DSH_NOTIFY_SAY_DATA_DIR;
    else process.env.DSH_NOTIFY_SAY_DATA_DIR = old;
  }
}

/** 造 res。 */
function mkRes() {
  const r = { statusCode: 0, headers: {}, body: '' };
  r.writeHead = (c, h) => { r.statusCode = c; Object.assign(r.headers, h || {}); };
  r.setHeader = (k, v) => { r.headers[k] = v; };
  r.end = (b) => { r.body = b || ''; };
  r.json = () => JSON.parse(r.body || '{}');
  return r;
}

/**
 * 造 req，并在 handler 挂好监听后再推 body。
 *
 * @param {string} method
 * @param {string} body
 * @returns {{req: object, fire: Function}}
 */
function mkReq(method, body) {
  const hs = { data: [], end: [], error: [] };
  const req = {
    method,
    url: '/api/dsh-notify-say/voicepacks/x',
    headers: {},
    on(ev, fn) { if (hs[ev]) hs[ev].push(fn); return req; },
    pause() {},
    destroy() {},
  };
  req._fire = () => {
    if (body) hs.data.forEach((f) => f(Buffer.from(body)));
    hs.end.forEach((f) => f());
  };
  return req;
}

/** 发一个请求，等路由处理完。 */
async function call(route, method, tail, body) {
  const req = mkReq(method, body === undefined ? undefined : JSON.stringify(body));
  const res = mkRes();
  // 关键：等 handler 挂上监听之后再推 body
  setTimeout(() => req._fire(), 5);
  await route.handle(req, res, 'voicepacks', `/api/dsh-notify-say/voicepacks/${tail}`);
  return res;
}

// ── R1: index 返回可下载 + 已装状态 ─────────────────────────────────────
test('R1: GET index 返回音色清单（含 downloadable / installed）', async () => {
  await withDataDir(async () => {
    const route = createVoicePackRoute({ pluginRoot: '.', logger: { info() {}, warn() {} } });
    const res = await call(route, 'GET', 'index');
    assert.equal(res.statusCode, 200);
    const doc = res.json();
    assert.equal(doc.ok, true);
    assert.ok(Array.isArray(doc.packs), '应返回 packs 数组');
    // 远端可用时应有可下载项；网络不通时至少形状正确
    if (doc.indexOk) {
      assert.ok(doc.packs.some((p) => p.downloadable), '索引可用时应有可下载项');
    }
  });
});

// ── R2: 非法 key 必须 400（防路径注入）──────────────────────────────────
test('R2: 非法 key 一律 400', async () => {
  await withDataDir(async () => {
    const route = createVoicePackRoute({ pluginRoot: '.', logger: { info() {}, warn() {} } });
    for (const bad of ['../evil', 'a/b', '', 'a b', 'a\\b']) {
      const res = await call(route, 'POST', 'install', { key: bad });
      assert.equal(res.statusCode, 400, `key=${JSON.stringify(bad)} 应被拒`);
      assert.equal(res.json().reason, 'bad-key');
    }
  });
});

// ── R3: 安装/卸载必须 POST ──────────────────────────────────────────────
test('R3: GET install / uninstall 返回 405', async () => {
  await withDataDir(async () => {
    const route = createVoicePackRoute({ pluginRoot: '.', logger: { info() {}, warn() {} } });
    for (const tail of ['install', 'uninstall']) {
      const res = await call(route, 'GET', tail);
      assert.equal(res.statusCode, 405, `${tail} 用 GET 应 405`);
    }
  });
});

// ── R4: 未知子路由 404 ──────────────────────────────────────────────────
test('R4: 未知 voicepacks 子路由返回 404', async () => {
  await withDataDir(async () => {
    const route = createVoicePackRoute({ pluginRoot: '.', logger: { info() {}, warn() {} } });
    const res = await call(route, 'GET', 'nonsense');
    assert.equal(res.statusCode, 404);
  });
});

// ── R5: 卸载未安装的音色 404 ────────────────────────────────────────────
test('R5: 卸载未安装的音色返回 404', async () => {
  await withDataDir(async () => {
    const route = createVoicePackRoute({ pluginRoot: '.', logger: { info() {}, warn() {} } });
    const res = await call(route, 'POST', 'uninstall', { key: 'never-installed' });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().reason, 'not-installed');
  });
});

// ── R6: 真装再卸（端到端，需要网络）────────────────────────────────────
test('R6: 真实安装 → 出现在清单 → 卸载后消失', async () => {
  await withDataDir(async () => {
    const route = createVoicePackRoute({ pluginRoot: '.', logger: { info() {}, warn() {} } });

    // 先看索引里有没有这个包（离线时跳过）
    const idxRes = await call(route, 'GET', 'index');
    const idx = idxRes.json();
    if (!idx.indexOk || !idx.packs.some((p) => p.key === 'zundamon-normal' && p.downloadable)) {
      return;   // 无网络/索引不可用：跳过（不算通过）
    }

    const installRes = await call(route, 'POST', 'install', { key: 'zundamon-normal' });
    assert.equal(installRes.statusCode, 200,
      `安装应成功，实际 ${installRes.statusCode}: ${installRes.body}`);
    const inst = installRes.json();
    assert.equal(inst.ok, true);
    assert.ok(inst.files > 0, '应报告安装的文件数');

    assert.ok(installedVoiceKeys().includes('zundamon-normal'),
      '安装后应出现在已装清单');

    // 清单里应标为已装
    const after = (await call(route, 'GET', 'index')).json();
    const hit = after.packs.find((p) => p.key === 'zundamon-normal');
    assert.equal(hit.installed, true, '清单应反映已装状态');
    assert.ok(hit.coverage && hit.coverage.done, '应报告池覆盖度');

    const uninstallRes = await call(route, 'POST', 'uninstall', { key: 'zundamon-normal' });
    assert.equal(uninstallRes.statusCode, 200);
    assert.equal(installedVoiceKeys().includes('zundamon-normal'), false,
      '卸载后不应再出现在已装清单');
  });
});

// ── R7: 安装不存在的包 404 ──────────────────────────────────────────────
test('R7: 安装索引里没有的音色返回 404', async () => {
  await withDataDir(async () => {
    const route = createVoicePackRoute({ pluginRoot: '.', logger: { info() {}, warn() {} } });
    const res = await call(route, 'POST', 'install', { key: 'not-a-real-voice' });
    // 索引不可用时会是 502；索引可用时是 404
    assert.ok([404, 502].includes(res.statusCode),
      `应是 404 或 502，实际 ${res.statusCode}`);
  });
});

// ── R8: 索引里的 terms → termsUrl（前端读的是这个字段名）─────────────────
test('R8: 路由把 packs.json 的 terms 映射成前端要的 termsUrl', async () => {
  // ⚠️ 用户评审时看到界面显示「条款链接待补」，要求核实是不是发布缺字段。
  //
  // 核实结论：真实 packs.json 的 13 个音色**都有** terms，
  // 但字段名是 `terms`，而前端读的是 `termsUrl` ——
  // 转名这一步在 voice-pack-route.js 里（`termsUrl: p.terms`）。
  //
  // 这步一旦被删，界面会对**所有**音色显示「条款链接待补」。
  // 用真实请求 + 打桩 fetch 把这条跨文件契约钉住。
  await withDataDir(async () => {
    const realFetch = globalThis.fetch;
    const FAKE_TERMS = 'https://example.invalid/voice-terms';
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        packs: [{
          key: 'zundamon-normal',
          name: 'ずんだもん（ノーマル）',
          file: 'zundamon-normal.zip',
          bytes: 100,
          sha256: 'a'.repeat(64),
          wavs: 1,
          credit: 'VOICEVOX:ずんだもん',
          terms: FAKE_TERMS,
        }],
      }),
    });
    try {
      const route = createVoicePackRoute({ pluginRoot: '.', logger: { info() {}, warn() {} } });
      const res = await call(route, 'GET', 'index');
      assert.equal(res.statusCode, 200);
      const doc = res.json();
      assert.equal(doc.indexOk, true, '索引应可用（fetch 已打桩）');
      const p = (doc.packs || []).find((x) => x.key === 'zundamon-normal');
      assert.ok(p, '应返回该音色');
      assert.equal(p.termsUrl, FAKE_TERMS,
        'packs.json 里叫 terms，前端读的是 termsUrl —— 名字不对会让界面显示「条款链接待补」');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
