/**
 * 配置读写 route（host 半侧）：给 client 半侧的设置卡片提供真正的读写能力。
 *
 * ## 为什么需要它
 *
 * 官方 `Config` schema 生成的是**插件配置编辑器**里的表单；本插件以 bundle 形态
 * 挂载时，那个表单并不出现在设置页的分区里（实测：分区里只有我们自己画的卡）。
 * 用户要的是"点一下就能改音量"，所以卡片必须自带控件。
 *
 * 而 client 跑在沙箱渲染进程里（无 process、无 fs），改不了 storages 下的文件，
 * 所以要开一条 host route：client `fetch` 读写，host 落地到
 * `$DSH_HOME/storages/dsh-notify-desktop/config.json`。
 *
 * ## 为什么写这个文件是安全的
 *
 * - 只写**本插件自己的**状态文件（与 config-store 同一路径、同一白名单校验）；
 * - 不碰 `cordis.patch.yml`、不碰凭据、不碰别的插件；
 * - 写入前 `sanitize()` 过滤：未知键丢弃、越界值拒绝；
 * - 文件损坏时 `writeConfig` 拒绝覆盖（保留用户原文件供人工救）。
 *
 * ## 与三源合并的关系
 *
 * 这里写的是**第 4 层（最高优先级）**。插件每轮播报前 `refreshConfig()` 重读，
 * 所以**改完立即生效，不需要重启**。想交还控制权给设置页 / YAML：`{ clear: true }`。
 */

import { existsSync, unlinkSync } from 'node:fs';

import {
  readConfig, writeConfig, sanitize, configPath, CONFIG_KEYS,
} from './config-store.js';
import { ROUTE_PREFIX } from './session-bridge.js';

/** 读配置。 */
export const ROUTE_CONFIG = ROUTE_PREFIX + '/config';
/** 写配置。 */
export const ROUTE_CONFIG_SET = ROUTE_PREFIX + '/config/set';

/**
 * 从 Node 的 req 上把 body 读完。
 * @param {object} req
 * @returns {Promise<object>}
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    try {
      if (!req) return resolve({});
      if (req.body != null && typeof req.body === 'object') return resolve(req.body);

      const chunks = [];
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve(text ? JSON.parse(text) : {});
        } catch {
          resolve({});
        }
      };
      if (typeof req.on !== 'function') return resolve({});
      req.on('data', (c) => {
        try { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); } catch { /* ignore */ }
      });
      req.on('end', finish);
      req.on('error', finish);
      setTimeout(finish, 3000);   // 防御：3 秒还没 end 就放弃
    } catch {
      resolve({});
    }
  });
}

/**
 * 写入响应（兼容两种 res 形态）。
 */
function send(res, code, body) {
  try {
    const text = body === undefined ? '' : JSON.stringify(body);
    if (res && typeof res.writeHead === 'function') {
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
      res.end(text);
    }
  } catch { /* 响应失败不影响后续 */ }
}

/**
 * 清空运行时覆盖层：删除本插件的 config.json。
 * 与 `notify-config.ps1 -Clear` 语义一致。
 * @returns {{ ok: boolean, reason?: string }}
 */
export function clearOverrides() {
  try {
    const p = configPath();
    if (!p) return { ok: false, reason: 'no-home' };
    if (existsSync(p)) unlinkSync(p);
    return { ok: true };
  } catch (ex) {
    return { ok: false, reason: String((ex && ex.message) || ex) };
  }
}

/**
 * 创建配置 route 的 handler。
 *
 * @param {object} [opts]
 * @param {() => void} [opts.onChanged] 配置变更后的回调（让插件立即重读）
 * @param {() => object} [opts.getEffective]
 *   返回**当前生效的完整配置**（三层合并结果）。
 *
 *   ⚠️ 为什么必须有它（独立审查 2026-10-17 指出，会导致用户配置被改坏）：
 *   `readConfig()` 只读第 4 层（`storages/.../config.json` 的覆盖值）。
 *   但实际生效值是「schema 默认 → cordis.patch.yml → 设置页 → 文件」四层合并。
 *   于是 GUI 打开时看到的是**文件层**（常常是空的），比如 patch 里 `volume: 100`
 *   而文件没存过 volume，GUI 就显示硬编码默认 80；用户一拖滑块，
 *   就把真实的 100 覆盖成 80 —— 他以为自己只是"确认一下"。
 *
 * @returns {{ handler: Function }}
 */
export function createConfigRoute(opts) {
  const onChanged = opts && typeof opts.onChanged === 'function' ? opts.onChanged : null;
  const getEffective = opts && typeof opts.getEffective === 'function' ? opts.getEffective : null;
  const notifyChanged = () => { try { if (onChanged) onChanged(); } catch { /* ignore */ } };

  /** 生效值（拿不到就退回文件层，保证有值可显示）。 */
  const effective = () => {
    try {
      if (getEffective) {
        const v = getEffective();
        if (v && typeof v === 'object') return v;
      }
    } catch { /* 落到文件层 */ }
    try { return readConfig().value || {}; } catch { return {}; }
  };

  async function handler(...args) {
    // 兼容 {request,response} 与 (req,res) 两种 register 风格（与 session-bridge 一致）
    const req = args[0] && args[0].request ? args[0].request
      : (args[0] && args[0].req ? args[0].req : args[0]);
    const res = args[0] && args[0].response ? args[0].response
      : (args[0] && args[0].res ? args[0].res : args[1]);

    try {
      const url = String((req && (req.url || req.path)) || '');
      const method = String((req && req.method) || 'GET').toUpperCase();
      // 只认 /config/set 为写；不再把"POST 到 /config"也算写（语义更自洽）。
      const isWrite = /\/config\/set(\/|$)/.test(url.split('?')[0]);

      if (isWrite && method !== 'POST') {
        return send(res, 405, { ok: false, reason: 'method-not-allowed' });
      }

      if (isWrite) {
        const body = await readJsonBody(req);

        // 交还控制权：删掉文件层覆盖，回到 patch/schema 的值
        if (body && body.clear === true) {
          const c = clearOverrides();
          if (!c.ok) return send(res, 500, { ok: false, reason: c.reason });
          notifyChanged();
          // 清空后返回的是**生效值**（即 patch 里的值），不是空对象
          return send(res, 200, { ok: true, values: effective() });
        }

        const patch = body && body.values && typeof body.values === 'object' ? body.values : body;
        const s = sanitize(patch);
        if (!s.ok) return send(res, 400, { ok: false, reason: 'bad-input', dropped: s.dropped });
        if (Object.keys(s.value).length === 0) {
          return send(res, 400, { ok: false, reason: 'nothing-to-write', dropped: s.dropped });
        }

        const w = writeConfig(s.value);
        if (!w.ok) return send(res, 409, { ok: false, reason: w.reason });
        notifyChanged();
        // ⚠️ 回**生效值**而不是 `w.value`（文件层快照）。
        // 否则：改一个开关后，没存过的键（volume 等）会从响应里消失，
        // client 用它整体替换本地态 → 滑块/下拉立刻退回硬编码默认值。
        return send(res, 200, { ok: true, values: effective() });
      }

      // 读：返回生效值 + 文件层覆盖值（后者用于判断"哪些是用户显式设过的"）
      const cur = readConfig();
      let overrides = {};
      try { overrides = cur.ok ? (cur.value || {}) : {}; } catch { overrides = {}; }
      return send(res, 200, {
        ok: true,
        values: effective(),
        overrides,
        corrupt: cur.ok ? false : cur.reason === 'corrupt',
        keys: CONFIG_KEYS,
      });
    } catch {
      return send(res, 500, { ok: false, reason: 'internal' });
    }
  }

  return { handler };
}
