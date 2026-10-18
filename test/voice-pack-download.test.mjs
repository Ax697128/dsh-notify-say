/**
 * 语音包下载与安装测试（v0.4.31）。
 *
 * ## 这是本项目唯一写盘的功能，所以测的重点是**拒绝**
 *
 * 正常路径只有一条（下载 → 校验 → 解压 → 安装），
 * 但错误路径很多，每一条都可能是安全漏洞：
 *
 *   · zip 里藏 `../../evil.wav`          → zip-slip
 *   · 哈希不匹配（被替换/损坏）           → 必须丢弃
 *   · zip 炸弹（解压后几十 GB）           → 必须限流
 *   · 不支持的压缩方法                    → 必须报错，不能静默产出坏文件
 *
 * 所以下面的测试大多在验证「该失败的时候真的失败了」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

import {
  safeZipEntry,
  listZipEntries,
  sha256Of,
  packDownloadUrl,
  fetchPackIndex,
  installVoicePack,
  uninstallVoicePack,
  readInstalledManifest,
} from '../lib/voice-pack-download.js';
import { userKeyDir } from '../lib/voice-pack-store.js';

/**
 * 造一个最小 zip（支持 stored 与 deflate）。
 *
 * 手写而不是用库：本模块的解压逻辑就是自己实现的，
 * 用同一个库生成会掩盖实现对不上的问题。
 *
 * @param {Array<{name: string, data: Buffer, method?: number}>} entries
 * @returns {Buffer}
 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const method = e.method === undefined ? 0 : e.method;
    const raw = e.data;
    const comp = method === 8 ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cd, eocd]);
}

/** CRC32（zip 用）。 */
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? ((c >>> 1) ^ 0xEDB88320) : (c >>> 1);
    }
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** 假 fetch：返回指定 buffer。 */
function fakeFetch(buf, { status = 200 } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => String(buf ? buf.length : 0) },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    json: async () => JSON.parse(buf.toString('utf8')),
  });
}

/** 临时切换数据目录。 */
async function withDataDir(fn) {
  const old = process.env.DSH_NOTIFY_SAY_DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'vpd-'));
  process.env.DSH_NOTIFY_SAY_DATA_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (old === undefined) delete process.env.DSH_NOTIFY_SAY_DATA_DIR;
    else process.env.DSH_NOTIFY_SAY_DATA_DIR = old;
  }
}

// ── W1: zip-slip 路径必须拒绝 ───────────────────────────────────────────
test('W1: safeZipEntry 拒绝所有逃逸路径', () => {
  const bad = [
    '../../evil.wav',
    'a/../../evil.wav',
    '/etc/passwd',
    'C:\\Windows\\evil.wav',
    '..\\..\\evil.wav',
    '',
  ];
  for (const p of bad) {
    const r = safeZipEntry(p);
    assert.equal(r.ok, false, `应拒绝：${p}`);
  }
});

// ── W2: 正常路径放行 ────────────────────────────────────────────────────
test('W2: safeZipEntry 放行正常的相对路径', () => {
  for (const p of ['zundamon-normal/done/a.wav', 'a/b/c.wav', 'file.wav']) {
    assert.equal(safeZipEntry(p).ok, true, `应放行：${p}`);
  }
});

// ── W3: 哈希校验 —— 不匹配必须拒绝 ──────────────────────────────────────
test('W3: sha256 不匹配时拒绝安装（挡住被替换的包）', async () => {
  await withDataDir(async () => {
    const zip = makeZip([{ name: 'k/a.wav', data: Buffer.from('hello') }]);
    const r = await installVoicePack('k', {
      url: 'x',
      sha256: '0'.repeat(64),      // 故意给错的
      fetchImpl: fakeFetch(zip),
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'sha256-mismatch');
    assert.equal(existsSync(userKeyDir('k')), false, '失败时不该留下任何目录');
  });
});

// ── W4: 正常安装（stored）──────────────────────────────────────────────
test('W4: stored 压缩的包能正常安装', async () => {
  await withDataDir(async () => {
    const zip = makeZip([
      { name: 'k/a.wav', data: Buffer.from('AAA'), method: 0 },
      { name: 'k/fail/b.wav', data: Buffer.from('BBB'), method: 0 },
    ]);
    const r = await installVoicePack('k', {
      url: 'x',
      sha256: sha256Of(zip),
      fetchImpl: fakeFetch(zip),
    });
    assert.equal(r.ok, true, `应成功，实际 ${r.error}`);
    assert.equal(r.files, 2);
    assert.ok(existsSync(join(userKeyDir('k'), 'a.wav')));
    assert.ok(existsSync(join(userKeyDir('k'), 'fail', 'b.wav')));
  });
});

// ── W5: deflate 压缩的包也能装 ──────────────────────────────────────────
test('W5: deflate 压缩的包能正常安装', async () => {
  await withDataDir(async () => {
    const content = Buffer.from('x'.repeat(2000));
    const zip = makeZip([{ name: 'k/a.wav', data: content, method: 8 }]);
    const r = await installVoicePack('k', {
      url: 'x',
      sha256: sha256Of(zip),
      fetchImpl: fakeFetch(zip),
    });
    assert.equal(r.ok, true, `应成功，实际 ${r.error}`);
    const got = readFileSync(join(userKeyDir('k'), 'a.wav'));
    assert.equal(got.length, 2000, '解压后内容应与原数据等长');
  });
});

// ── W6: zip 内含逃逸路径时整体拒绝 ──────────────────────────────────────
test('W6: zip 里有逃逸条目时整个安装失败（不留半装状态）', async () => {
  await withDataDir(async () => {
    const zip = makeZip([
      { name: 'k/ok.wav', data: Buffer.from('OK') },
      { name: '../../escape.wav', data: Buffer.from('EVIL') },
    ]);
    const r = await installVoicePack('k', {
      url: 'x',
      sha256: sha256Of(zip),
      fetchImpl: fakeFetch(zip),
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /zip-unsafe-entry/);
    assert.equal(existsSync(userKeyDir('k')), false, '不能留下任何安装痕迹');
  });
});

// ── W7: 空 zip 拒绝 ────────────────────────────────────────────────────
test('W7: 不含文件的 zip 被拒绝', async () => {
  await withDataDir(async () => {
    const zip = makeZip([]);
    const r = await installVoicePack('k', {
      url: 'x',
      sha256: sha256Of(zip),
      fetchImpl: fakeFetch(zip),
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /zip-empty/);
  });
});

// ── W8: 非法 key 拒绝（防路径注入）──────────────────────────────────────
test('W8: 非法音色 key 被拒绝（防把 ../ 当 key）', async () => {
  await withDataDir(async () => {
    for (const key of ['../evil', 'a/b', '', 'a b']) {
      const r = await installVoicePack(key, { url: 'x', sha256: '0'.repeat(64) });
      assert.equal(r.ok, false, `应拒绝 key：${key}`);
      assert.equal(r.error, 'bad-key');
    }
  });
});

// ── W9: 下载失败时给出结构化错误 ────────────────────────────────────────
test('W9: HTTP 404 时返回错误而不是抛', async () => {
  await withDataDir(async () => {
    const r = await installVoicePack('k', {
      url: 'x',
      sha256: '0'.repeat(64),
      fetchImpl: fakeFetch(Buffer.alloc(0), { status: 404 }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'http-404');
  });
});

// ── W10: 卸载只删用户目录 ───────────────────────────────────────────────
test('W10: uninstall 删掉整个音色目录', async () => {
  await withDataDir(async () => {
    const zip = makeZip([{ name: 'k/a.wav', data: Buffer.from('A') }]);
    await installVoicePack('k', { url: 'x', sha256: sha256Of(zip), fetchImpl: fakeFetch(zip) });
    assert.ok(existsSync(userKeyDir('k')));

    const r = uninstallVoicePack('k');
    assert.equal(r.ok, true);
    assert.equal(existsSync(userKeyDir('k')), false, '卸载后整个目录应消失');
  });
});

// ── W11: 卸载不存在的音色给明确原因 ─────────────────────────────────────
test('W11: 卸载未安装的音色返回 not-installed', async () => {
  await withDataDir(() => {
    const r = uninstallVoicePack('never-installed');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'not-installed');
  });
});

// ── W12: 索引解析只保留形状正确的条目 ───────────────────────────────────
test('W12: fetchPackIndex 过滤掉形状不对的条目', async () => {
  const index = {
    version: '1.0.0',
    packs: [
      { key: 'good', file: 'good.zip', sha256: 'a'.repeat(64) },
      { key: 'no-hash', file: 'x.zip' },                       // 缺 sha256
      { key: 'short-hash', file: 'y.zip', sha256: 'abc' },      // 长度不对
      { file: 'z.zip', sha256: 'b'.repeat(64) },                // 缺 key
    ],
  };
  const buf = Buffer.from(JSON.stringify(index));
  const r = await fetchPackIndex({ url: 'x', fetchImpl: fakeFetch(buf) });
  assert.equal(r.ok, true);
  assert.equal(r.packs.length, 1, '只有完整条目应保留');
  assert.equal(r.packs[0].key, 'good');
});

// ── W13: packDownloadUrl 拼出正确地址 ───────────────────────────────────
test('W13: packDownloadUrl 从索引算下载地址', () => {
  const packs = [{ key: 'k', file: 'k.zip', sha256: 'a'.repeat(64) }];
  const r = packDownloadUrl(packs, 'k', 'https://example.com/dl/');
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://example.com/dl/k.zip');

  const miss = packDownloadUrl(packs, 'nope', 'https://example.com/dl/');
  assert.equal(miss.ok, false);
  assert.equal(miss.error, 'not-in-index');
});

// ── W14: 读取已装包的 MANIFEST ──────────────────────────────────────────
test('W14: readInstalledManifest 能读回安装时写入的清单', async () => {
  await withDataDir(async () => {
    const manifest = { key: 'k', name: '测试音色', files: [] };
    const zip = makeZip([
      { name: 'k/a.wav', data: Buffer.from('A') },
      { name: 'k/MANIFEST.json', data: Buffer.from(JSON.stringify(manifest)) },
    ]);
    await installVoicePack('k', { url: 'x', sha256: sha256Of(zip), fetchImpl: fakeFetch(zip) });

    const got = readInstalledManifest('k');
    assert.ok(got, '应能读回 MANIFEST');
    assert.equal(got.name, '测试音色');
  });
});

// ── W15: 重复安装会覆盖（不是叠加）──────────────────────────────────────
test('W15: 重复安装同一音色是覆盖，不是叠加', async () => {
  await withDataDir(async () => {
    const zip1 = makeZip([{ name: 'k/old.wav', data: Buffer.from('OLD') }]);
    await installVoicePack('k', { url: 'x', sha256: sha256Of(zip1), fetchImpl: fakeFetch(zip1) });
    assert.ok(existsSync(join(userKeyDir('k'), 'old.wav')));

    const zip2 = makeZip([{ name: 'k/new.wav', data: Buffer.from('NEW') }]);
    await installVoicePack('k', { url: 'x', sha256: sha256Of(zip2), fetchImpl: fakeFetch(zip2) });

    assert.ok(existsSync(join(userKeyDir('k'), 'new.wav')));
    assert.equal(existsSync(join(userKeyDir('k'), 'old.wav')), false,
      '旧文件应被清掉 —— 否则升级后会留下"半新半旧"的语音');
  });
});

// ── W16: listZipEntries 能解析真实结构 ──────────────────────────────────
test('W16: listZipEntries 列出条目与压缩方法', () => {
  const zip = makeZip([
    { name: 'a.wav', data: Buffer.from('A'), method: 0 },
    { name: 'b/c.wav', data: Buffer.from('CC'), method: 8 },
  ]);
  const r = listZipEntries(zip);
  assert.equal(r.ok, true);
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].method, 0);
  assert.equal(r.entries[1].method, 8);
  assert.equal(r.entries[0].name, 'a.wav');
});

// ── W17: 损坏的 zip 给出明确错误 ────────────────────────────────────────
test('W17: 损坏的 zip 返回结构化错误而不是崩溃', () => {
  const r = listZipEntries(Buffer.from('not a zip at all'));
  assert.equal(r.ok, false);
  assert.ok(r.error, '应给出错误原因');
});
