/**
 * 第三轮审阅（2026-10-18）5 项的回归测试。
 *
 * ## 审阅给的最重要一条建议
 *
 * > 把「测试里检查代码是否出现某个字符串」逐步升级成
 * > 「构造真实输入并验证实际行为」。
 *
 * 这次有个典型教训：`entry.size` 那道防护代码存在、测试也绿，
 * 但字段名与真实 ZIP 结构不符 —— **代码和测试一起错了**。
 *
 * 所以这里尽量用**真实 ZIP 字节**和**真实目录**构造输入。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── Y1: ZIP 解析器确实返回 uncompSize（用真实字节验证）────────────────
test('Y1: listZipEntries 返回的条目带 uncompSize 字段', async () => {
  const { listZipEntries } = await import('../lib/voice-pack-download.js');

  // 造一个最小的 stored（method=0）ZIP：一个文件 "a.txt" 内容 "hi"
  const zip = makeStoredZip('a.txt', Buffer.from('hi', 'utf8'));
  const r = listZipEntries(zip);
  assert.equal(r.ok, true, `解析应成功：${r.error}`);

  const e = r.entries[0];
  assert.equal(e.name, 'a.txt');
  // 审阅指出防护代码查 entry.size，而解析器给的是 uncompSize。
  assert.ok('uncompSize' in e,
    '解析结果必须有 uncompSize —— 防护代码若查别的字段就是死代码');
  assert.equal(e.uncompSize, 2, 'stored 模式下 uncompSize = 内容长度');
  assert.ok(!('size' in e),
    '不应存在 size 字段 —— 它的存在会让"查 entry.size"看起来合理，掩盖 bug');
});

// ── Y2: 超大声明必须在解压前被拒（行为，不是查字符串）──────────────────
test('Y2: 声明解压大小超限的条目在解压前被拒（走 installVoicePack 真实路径）', async () => {
  // ⚠️ 第一版这里调用 mod.extractEntry，但它**没有导出** →
  // `if (typeof mod.extractEntry === 'function')` 恒为 false，整段被跳过。
  // 于是变异验证（把 uncompSize 改回 size）**没被抓到**。
  //
  // 现在改成通过 installVoicePack 走真实解压路径 —— 这是用户实际会走的入口。
  const { installVoicePack } = await import('../lib/voice-pack-download.js');

  // 造一个声明 uncompSize = 200MB、实际数据只有 4 字节的条目
  const big = makeStoredZipWithFakeSize('big.bin', Buffer.alloc(4), 200 * 1024 * 1024);

  const old = process.env.DSH_NOTIFY_SAY_DATA_DIR;
  const tmp = join(ROOT, '.tmp-y2-' + Math.random().toString(36).slice(2, 8));
  try {
    process.env.DSH_NOTIFY_SAY_DATA_DIR = tmp;

    // 伪造网络层：直接返回这个 ZIP
    const fakeFetch = async () => ({
      ok: true,
      headers: { get: () => String(big.length) },
      arrayBuffer: async () => big.buffer.slice(big.byteOffset, big.byteOffset + big.length),
    });

    // ⚠️ 必须给对的 sha256 —— 否则会在解压之前就被 sha256-mismatch 拦掉，
    // 测不到解压闸（第一版就是这么失败的）。
    const { createHash } = await import('node:crypto');
    const realSha = createHash('sha256').update(big).digest('hex');

    const r = await installVoicePack('y2-test', {
      url: 'https://example.invalid/x.zip',
      sha256: realSha,
      fetchImpl: fakeFetch,
      logger: { info() {}, warn() {} },
    });

    assert.equal(r.ok, false, '声明超限的包必须被拒绝');
    assert.match(String(r.error), /entry-too-large/,
      '应返回 entry-too-large。若返回 inflate 错误，说明「解压前检查」是死代码 —— '
      + '这正是审阅指出的 entry.size / uncompSize 字段错配。实际：' + r.error);
  } finally {
    if (old === undefined) delete process.env.DSH_NOTIFY_SAY_DATA_DIR;
    else process.env.DSH_NOTIFY_SAY_DATA_DIR = old;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ── Y3: 临时目录与备份目录不得参与播放（真实目录）─────────────────────
test('Y3: .installing / .bak-* 目录不会被当作音色根', async () => {
  const { regions, userVoiceRoot } = await import('../lib/voice-regions.js');

  const root = userVoiceRoot();
  const made = [];
  try {
    // 合法音色
    for (const name of ['y-good-voice', 'y-good-voice.installing', 'y-good-voice.bak-1699999999']) {
      const p = join(root, name);
      mkdirSync(p, { recursive: true });
      made.push(p);
    }

    const rs = regions(ROOT);
    const keys = rs.filter((r) => r.source === 'user').map((r) => r.key);

    assert.ok(keys.includes('y-good-voice'), '合法音色应出现在播放根里');
    assert.ok(!keys.some((k) => k && k.includes('.installing')),
      '.installing（安装中）不得参与播放 —— 它装到一半，wav 可能不全');
    assert.ok(!keys.some((k) => k && k.includes('.bak-')),
      '.bak-*（更新备份）不得参与播放 —— 那是回滚用的旧副本');
  } finally {
    for (const p of made) { try { rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
});

// ── Y4: 用户目录规则只有一个来源（override 生效）──────────────────────
test('Y4: voice-regions 尊重 DSH_NOTIFY_SAY_DATA_DIR（与 store 同源）', async () => {
  const store = await import('../lib/voice-pack-store.js');
  const regionsMod = await import('../lib/voice-regions.js');

  const old = process.env.DSH_NOTIFY_SAY_DATA_DIR;
  const tmp = join(ROOT, '.tmp-datadir-' + Math.random().toString(36).slice(2, 8));
  try {
    process.env.DSH_NOTIFY_SAY_DATA_DIR = tmp;
    mkdirSync(join(tmp, 'voice-lines', 'zz-test'), { recursive: true });
    writeFileSync(join(tmp, 'voice-lines', 'zz-test', 'zz-test.wav'), 'x');

    assert.equal(regionsMod.userVoiceRoot(), store.userVoiceRoot(),
      '两个模块必须算出同一个用户目录 —— 各写一套必然漂移');
    assert.ok(regionsMod.userVoiceRoot().startsWith(tmp),
      'DSH_NOTIFY_SAY_DATA_DIR 必须生效（便携模式/测试依赖它）');

    const rs = regionsMod.regions(ROOT);
    assert.ok(rs.some((r) => r.source === 'user' && r.key === 'zz-test'),
      '自定义数据目录下装的音色也要能参与播放');
  } finally {
    if (old === undefined) delete process.env.DSH_NOTIFY_SAY_DATA_DIR;
    else process.env.DSH_NOTIFY_SAY_DATA_DIR = old;
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ── Y5: 离线时卸载按钮不能禁用 ──────────────────────────────────────────
test('Y5: 已安装但不可下载时，卸载按钮仍可用', () => {
  const src = readFileSyncSafe(join(ROOT, 'lib', 'client.js'));
  // ⚠️ 不能用「全文第一个 `disabled: s.busy ||`」——
  // v0.4.54 加了试听按钮（`s.busy || (pvState.kind !== "")`），会先命中它。
  // 改成按上下文精确定位：找「卸载 / 下载」按钮那一段。
  const at = src.indexOf("removePack(p.key, p.name || p.key)");
  assert.ok(at > 0, '应能找到语音包的下载/卸载按钮');
  // 取该按钮前后一段，找其中的 disabled 条件
  const seg = src.slice(Math.max(0, at - 700), at + 120);
  const m = seg.match(/disabled:\s*s\.busy\s*\|\|\s*([^,\n]+)/);
  assert.ok(m, '应能找到下载/卸载按钮的 disabled 条件');
  const cond = m[1];
  assert.match(cond, /p\.installed/,
    'disabled 条件必须考虑 p.installed —— 离线时 downloadable 为 false，'
    + '但卸载动的是本地文件，不该依赖 GitHub 在线状态');
});

// ── 辅助：构造最小 ZIP ──────────────────────────────────────────────────
function readFileSyncSafe(p) {
  return readFileSync(p, 'utf8');
}

/** 造一个 stored（不压缩）的单文件 ZIP。 */
function makeStoredZip(name, content) {
  return buildZip(name, content, content.length);
}

/** 造一个 ZIP，但把头里声明的 uncompSize 改成谎报值。 */
function makeStoredZipWithFakeSize(name, content, fakeSize) {
  return buildZip(name, content, fakeSize);
}

function buildZip(name, content, declaredSize) {
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(content);

  // ── local file header ──
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);           // version needed
  lfh.writeUInt16LE(0, 6);            // flags
  lfh.writeUInt16LE(0, 8);            // method = stored
  lfh.writeUInt16LE(0, 10);           // mod time
  lfh.writeUInt16LE(0, 12);           // mod date
  lfh.writeUInt32LE(crc, 14);
  lfh.writeUInt32LE(content.length, 18);   // compSize
  lfh.writeUInt32LE(declaredSize, 22);     // uncompSize（可谎报）
  lfh.writeUInt16LE(nameBuf.length, 26);
  lfh.writeUInt16LE(0, 28);                // extra len

  // ── central directory ──
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0, 8);
  cd.writeUInt16LE(0, 10);
  cd.writeUInt16LE(0, 12);
  cd.writeUInt16LE(0, 14);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(content.length, 20);    // compSize
  cd.writeUInt32LE(declaredSize, 24);      // uncompSize（可谎报）
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt16LE(0, 30);
  cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34);
  cd.writeUInt16LE(0, 36);
  cd.writeUInt32LE(0, 38);                 // external attrs
  cd.writeUInt32LE(0, 42);                 // local header offset

  const localPart = Buffer.concat([lfh, nameBuf, content]);
  const cdPart = Buffer.concat([cd, nameBuf]);

  // ── EOCD ──
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);          // entries on disk
  eocd.writeUInt16LE(1, 10);         // total entries
  eocd.writeUInt32LE(cdPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localPart, cdPart, eocd]);
}

/** CRC32（ZIP 必需）。 */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}
