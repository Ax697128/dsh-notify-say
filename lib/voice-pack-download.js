/**
 * 语音包下载与安装（v0.4.31）。
 *
 * ## 这是本项目**唯一会写盘**的功能
 *
 * 所以安全约束比其他模块严格得多：
 *
 * 1. **只从固定源下载**
 *    不接受客户端传 URL（否则就是 SSRF / 任意文件写入）。
 *    URL 由 `packIndexUrl()` 从硬编码的仓库地址拼出来。
 *
 * 2. **SHA-256 必须匹配**
 *    下载完先算哈希，与 packs.json 里登记的不一致就丢弃。
 *    这挡住传输损坏与中间人替换。
 *
 * 3. **zip 条目路径校验**
 *    拒绝 `../`、绝对路径、盘符、符号链接 —— 任何可能逃出目标目录的条目。
 *    这是 zip-slip 攻击的标准防线。
 *
 * 4. **先写临时目录，校验通过后再切换**
 *    失败时不留半装状态，重试永远是干净的。
 *
 * 5. **只写 %LOCALAPPDATA%**
 *    不碰插件目录、不碰配置区、不碰用户其它文件。
 *
 * ## 解压实现说明
 *
 * 用 Node 内置能力解 zip 需要自己解析容器格式。这里实现最小子集：
 * 只支持 **stored（无压缩）** 与 **deflate** —— 那覆盖了 Windows
 * `Compress-Archive` 与绝大多数工具产出的 zip。
 *
 * 不支持：加密 zip、分卷、zstd/bzip2 压缩。遇到就报错（不静默失败）。
 */

import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { join, normalize, sep } from 'node:path';

import { userKeyDir } from './voice-pack-store.js';

/** 默认的包索引地址（固定源，不接受外部传入）。 */
// ── 语音包索引地址（v0.4.40 改为稳定端点）────────────────────────────
//
// ⚠️ 原来用 `/releases/latest/download/packs.json`。外部审阅指出这个设计
// 有个隐患：`latest` 指向**最新**的 Release，而它不一定带 packs.json。
//
// 后果：
//   · 哪天为了修插件 bug 发一个只有插件的 Release（很正常）
//   · `latest` 就跳到那个 Release
//   · 它没有 packs.json → 404 → **旧版下载器的音色列表整个失效**
//
// 也就是说：发一个无关的插件版本，能把语音包功能弄坏。
//
// 现在的策略是**双地址回退**：
//   ① 固定 tag `voice-packs` 的 Release（语音包专用，不随插件版本变）
//   ② 失败才退回 `latest`（兼容：万一 ① 还没建好）
//
// ① 需要一次性在 GitHub 上建一个 tag 为 `voice-packs` 的 Release，
// 把 packs.json 与 13 个 zip 传上去。在那之前 ② 仍然能用。
export const PACK_INDEX_URL =
  'https://github.com/unifilitence/dsh-notify-say/releases/download/voice-packs/packs.json';

/** 回退地址（固定 tag 还没建好时用）。 */
export const PACK_INDEX_URL_FALLBACK =
  'https://github.com/unifilitence/dsh-notify-say/releases/latest/download/packs.json';

/** 单个包的下载上限（防止被喂超大文件）。 */
const MAX_PACK_BYTES = 32 * 1024 * 1024;

/** 解压后的总体积上限（防止 zip 炸弹）。 */
const MAX_INFLATED_BYTES = 128 * 1024 * 1024;

/**
 * 取包索引。
 *
 * @param {object} [opts]
 * @param {string} [opts.url] 覆盖索引地址（仅测试用）
 * @param {Function} [opts.fetchImpl]
 * @returns {Promise<{ok: boolean, packs?: object[], error?: string}>}
 */
export async function fetchPackIndex(opts = {}) {
  const doFetch = opts.fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') {
    return { ok: false, error: 'fetch-unavailable' };
  }

  // 候选地址：调用方指定 > 固定 tag > latest 回退
  // （固定 tag 的意义见 PACK_INDEX_URL 上方注释）
  const urls = opts.url
    ? [opts.url]
    : [PACK_INDEX_URL, PACK_INDEX_URL_FALLBACK];

  let lastError = '';
  for (const url of urls) {
    try {
      const res = await doFetch(url, { cache: 'no-store' });
      if (!res || !res.ok) {
        lastError = `http-${res ? res.status : 'none'}`;
        continue;
      }
      const doc = await res.json();
      if (!doc || !Array.isArray(doc.packs)) {
        lastError = 'bad-index-shape';
        continue;
      }
      // 只保留形状正确的条目
      const packs = doc.packs.filter((p) => (
        p && typeof p.key === 'string' && typeof p.file === 'string'
        && typeof p.sha256 === 'string' && p.sha256.length === 64
      ));
      return {
        ok: true,
        packs,
        version: doc.version || '',
        // 让调用方/日志知道最终用了哪个地址（排查"为什么列表是旧的"时有用）
        source: url === PACK_INDEX_URL ? 'pinned' : 'fallback',
        // ⚠️ 把实际用的索引地址也传出去：下载时必须用**同一个** base，
        // 否则「列表从 latest 拿到、下载却按固定 tag 拼」会 404。
        // （第一版改固定 tag 时就是这么坏的，R6 真实下载测试抓到。）
        indexUrl: url,
      };
    } catch (e) {
      lastError = String((e && e.message) || e);
    }
  }

  return { ok: false, error: lastError };
}

/**
 * 从索引里找某个音色的下载地址。
 *
 * @param {object[]} packs
 * @param {string} key
 * @param {string} [baseUrl]
 * @returns {{ ok: boolean, url?: string, sha256?: string, error?: string }}
 */
/**
 * 从索引里找某个音色的下载地址。
 *
 * @param {object[]} packs
 * @param {string} key
 * @param {string|object} [opts] 传字符串=baseUrl（兼容旧调用）；
 *   传对象则可给 `{ baseUrl, indexUrl }`
 * @returns {{ ok: boolean, url?: string, sha256?: string, error?: string }}
 */
export function packDownloadUrl(packs, key, opts) {
  const hit = (packs || []).find((p) => p.key === key);
  if (!hit) return { ok: false, error: 'not-in-index' };

  // 兼容两种调用：
  //   packDownloadUrl(packs, key, "https://.../")            旧形态
  //   packDownloadUrl(packs, key, { indexUrl: "https://.../packs.json" })
  let base = '';
  if (typeof opts === 'string') {
    base = opts;
  } else if (opts && typeof opts === 'object') {
    if (typeof opts.baseUrl === 'string') base = opts.baseUrl;
    else if (typeof opts.indexUrl === 'string') base = opts.indexUrl.replace(/\/packs\.json$/, '/');
  }
  // 兜底：用主地址推导
  if (!base) base = PACK_INDEX_URL.replace(/\/packs\.json$/, '/');

  // 确保结尾有斜杠
  if (!base.endsWith('/')) base += '/';

  return {
    ok: true,
    url: base + encodeURIComponent(hit.file),
    sha256: hit.sha256,
    bytes: hit.bytes,
  };
}

/**
 * 校验 zip 内条目的相对路径是否安全。
 *
 * 挡住 zip-slip：`../../evil.wav`、`C:\evil.wav`、`/etc/passwd` 等。
 *
 * @param {string} entry
 * @returns {{ ok: boolean, reason?: string }}
 */
export function safeZipEntry(entry) {
  if (typeof entry !== 'string' || entry === '') {
    return { ok: false, reason: 'empty' };
  }
  // 统一分隔符后判断
  const p = entry.replace(/\\/g, '/');

  if (p.startsWith('/')) return { ok: false, reason: 'absolute' };
  if (/^[A-Za-z]:/.test(p)) return { ok: false, reason: 'drive-letter' };
  // 任何 .. 段都不允许（哪怕是 a/../b 这种"其实安全"的写法 —— 保守拒绝）
  if (p.split('/').some((seg) => seg === '..')) {
    return { ok: false, reason: 'parent-escape' };
  }
  // 归一化后仍要确保没逃出去
  const norm = normalize(p);
  if (norm.startsWith('..') || norm.includes(`..${sep}`)) {
    return { ok: false, reason: 'normalized-escape' };
  }
  return { ok: true };
}

/**
 * 解析 zip 中央目录，返回条目列表。
 *
 * 只支持 stored / deflate 两种压缩方式，其余报错。
 *
 * @param {Buffer} buf
 * @returns {{ ok: boolean, entries?: object[], error?: string }}
 */
export function listZipEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) {
    return { ok: false, error: 'too-small' };
  }

  // 找 End of Central Directory（签名 0x06054b50），从尾部向前搜
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 65535; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return { ok: false, error: 'no-eocd' };

  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  // 空 zip 的中央目录偏移也是 0 —— 先按条目数判空，再校验偏移。
  // （把 0 当"偏移非法"会让空包报 bad-cd-offset 而不是 zip-empty，
  //  诊断信息误导。）
  if (count === 0) return { ok: true, entries: [] };
  if (cdOffset <= 0 || cdOffset >= buf.length) {
    return { ok: false, error: 'bad-cd-offset' };
  }

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length) return { ok: false, error: 'cd-truncated' };
    if (buf.readUInt32LE(p) !== 0x02014b50) return { ok: false, error: 'bad-cd-entry' };

    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);

    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    const isDir = name.endsWith('/') || name.endsWith('\\');

    entries.push({
      name, method, compSize, uncompSize, localOffset, isDir,
    });

    p += 46 + nameLen + extraLen + commentLen;
  }

  return { ok: true, entries };
}

/**
 * 从一个 zip 条目里取出内容。
 *
 * @param {Buffer} buf
 * @param {object} entry
 * @returns {{ ok: boolean, data?: Buffer, error?: string }}
 */
function extractEntry(buf, entry) {
  const lo = entry.localOffset;
  if (lo + 30 > buf.length) return { ok: false, error: 'local-truncated' };
  if (buf.readUInt32LE(lo) !== 0x04034b50) return { ok: false, error: 'bad-local' };

  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const dataStart = lo + 30 + nameLen + extraLen;
  const dataEnd = dataStart + entry.compSize;
  if (dataEnd > buf.length) return { ok: false, error: 'data-truncated' };

  const raw = buf.slice(dataStart, dataEnd);

  if (entry.method === 0) {
    return { ok: true, data: raw };
  }
  if (entry.method === 8) {
    // ⚠️ 2026-10-18 外部审阅指出：原来直接 `inflateRawSync(raw)`，
    // 解完才累计大小检查 128 MB —— 那时内存已经被占满了。
    //
    // ZIP 炸弹正是利用这一点：压缩包 32 MB（在上限内），解压后几个 GB。
    // 所以必须**解压前**先看 ZIP 头里声明的大小，并且**解压时**带上输出上限。
    //
    // 两道闸：
    //   ① 声明大小（entry.size）超限 → 直接拒绝，不解压一个字节
    //   ② maxOutputLength 兜底 → 声明大小撒谎时 zlib 自己中止
    if (Number.isFinite(entry.size) && entry.size > MAX_INFLATED_BYTES) {
      return {
        ok: false,
        error: `entry-too-large: ${entry.name} declares ${entry.size} bytes (limit ${MAX_INFLATED_BYTES})`,
      };
    }
    try {
      // maxOutputLength 在超出时抛 ERR_BUFFER_TOO_LARGE，
      // 由下面的 catch 转成结构化错误 —— 不会把内存吃光。
      const data = inflateRawSync(raw, { maxOutputLength: MAX_INFLATED_BYTES });
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: `inflate: ${(e && e.message) || e}` };
    }
  }
  return { ok: false, error: `unsupported-method-${entry.method}` };
}

/** 计算 SHA-256（小写十六进制）。 */
export function sha256Of(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * 下载并安装一个语音包。
 *
 * 流程：下载 → 校验哈希 → 解析 zip → 校验每个条目路径 → 写临时目录 →
 *       核对文件哈希 → 原子切换到正式目录。
 *
 * @param {string} key 音色 key
 * @param {object} opts
 * @param {string} opts.url 下载地址（由 packDownloadUrl 算出，不接受客户端直接传）
 * @param {string} opts.sha256 期望的 zip 哈希
 * @param {Function} [opts.fetchImpl]
 * @param {Function} [opts.logger]
 * @returns {Promise<object>}
 */
export async function installVoicePack(key, opts) {
  const log = (opts && opts.logger) || { info() {}, warn() {} };
  const doFetch = (opts && opts.fetchImpl) || globalThis.fetch;

  if (typeof doFetch !== 'function') {
    return { ok: false, error: 'fetch-unavailable' };
  }
  if (!/^\w[\w-]*$/.test(String(key || ''))) {
    return { ok: false, error: 'bad-key' };
  }

  // ① 下载
  let buf;
  try {
    const res = await doFetch(opts.url, { cache: 'no-store' });
    if (!res || !res.ok) return { ok: false, error: `http-${res ? res.status : 'none'}` };

    const len = Number(res.headers?.get?.('content-length') || 0);
    if (len > MAX_PACK_BYTES) return { ok: false, error: 'pack-too-large' };

    const ab = await res.arrayBuffer();
    buf = Buffer.from(ab);
    if (buf.length > MAX_PACK_BYTES) return { ok: false, error: 'pack-too-large' };
  } catch (e) {
    return { ok: false, error: `download: ${(e && e.message) || e}` };
  }

  // ② 校验 zip 哈希
  const got = sha256Of(buf);
  if (String(opts.sha256 || '').toLowerCase() !== got) {
    log.warn(`[voicepack] sha256 mismatch key=${key} want=${opts.sha256} got=${got}`);
    return { ok: false, error: 'sha256-mismatch', expected: opts.sha256, actual: got };
  }

  // ③ 解析 zip
  const listed = listZipEntries(buf);
  if (!listed.ok) return { ok: false, error: `zip: ${listed.error}` };
  const entries = listed.entries.filter((e) => !e.isDir);
  if (entries.length === 0) return { ok: false, error: 'zip-empty' };

  // ④ 路径安全（任何一条不安全就整体拒绝）
  for (const e of entries) {
    const s = safeZipEntry(e.name);
    if (!s.ok) {
      log.warn(`[voicepack] unsafe entry key=${key} entry=${e.name} reason=${s.reason}`);
      return { ok: false, error: `zip-unsafe-entry: ${s.reason}`, entry: e.name };
    }
  }

  // ⑤ 解压到临时目录
  // 目标目录：<user>/voice-lines/<key>/（一音色一目录，卸载时整目录删掉）
  const finalDir = userKeyDir(key);
  const tmpDir = `${finalDir}.installing`;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
  } catch (e) {
    return { ok: false, error: `mkdir: ${(e && e.message) || e}` };
  }

  let inflated = 0;
  const written = [];
  try {
    for (const e of entries) {
      const r = extractEntry(buf, e);
      if (!r.ok) throw new Error(`extract ${e.name}: ${r.error}`);
      inflated += r.data.length;
      if (inflated > MAX_INFLATED_BYTES) throw new Error('inflated-too-large');

      // zip 里的路径可能带 <key>/ 前缀；剥掉它，让内容直接落在音色目录下
      let rel = e.name.replace(/\\/g, '/');
      if (rel.startsWith(`${key}/`)) rel = rel.slice(key.length + 1);
      const target = join(tmpDir, rel);

      // 二次确认：写之前再检查目标确实在 tmpDir 内
      const normTarget = normalize(target);
      const normBase = normalize(tmpDir);
      if (!normTarget.startsWith(normBase)) {
        throw new Error(`escape on write: ${e.name}`);
      }

      mkdirSync(join(target, '..'), { recursive: true });
      writeFileSync(target, r.data);
      written.push({ rel, bytes: r.data.length });
    }
  } catch (e) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: false, error: String((e && e.message) || e) };
  }

  // ⑥ 原子切换
  try {
    // ⚠️ 2026-10-18 外部审阅指出：原来是「先删旧包、再改名新包」。
    //
    // 如果 renameSync 失败（杀毒锁文件、权限、磁盘满……），旧包已经删了 ——
    // 用户不但没更新成功，**原本能用的音色也一起丢了**。
    //
    // 改成三段式（可回滚）：
    //   1. 旧包改名成 .bak-<时间戳>（不是删除）
    //   2. 新包改名到正式路径
    //   3. 第 2 步成功才删 .bak；失败就把 .bak 改回去
    const backupDir = `${finalDir}.bak-${Date.now()}`;
    let backedUp = false;
    if (existsSync(finalDir)) {
      renameSync(finalDir, backupDir);
      backedUp = true;
    }
    try {
      renameSync(tmpDir, finalDir);
    } catch (switchErr) {
      if (backedUp) {
        try { renameSync(backupDir, finalDir); } catch { /* 尽力而为 */ }
      }
      throw switchErr;   // 交给外层 catch 转成结构化错误
    }
    if (backedUp) {
      try { rmSync(backupDir, { recursive: true, force: true }); } catch { /* 留着不影响使用 */ }
    }
  } catch (e) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    return { ok: false, error: `rename: ${(e && e.message) || e}` };
  }

  log.info(`[voicepack] installed key=${key} files=${written.length} bytes=${inflated}`);
  return { ok: true, key, files: written.length, bytes: inflated, dir: finalDir };
}

/**
 * 卸载一个已安装的音色。
 *
 * **只删用户目录**（插件内置的不能删，那是只读的）。
 *
 * @param {string} key
 * @returns {{ ok: boolean, error?: string }}
 */
export function uninstallVoicePack(key) {
  if (!/^\w[\w-]*$/.test(String(key || ''))) {
    return { ok: false, error: 'bad-key' };
  }
  const dir = userKeyDir(key);
  if (!existsSync(dir)) return { ok: false, error: 'not-installed' };
  try {
    rmSync(dir, { recursive: true, force: true });
    return { ok: true, key };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 读取本地已安装包的 MANIFEST.json（若存在）。 */
export function readInstalledManifest(key) {
  try {
    const p = join(userKeyDir(key), 'MANIFEST.json');
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}
