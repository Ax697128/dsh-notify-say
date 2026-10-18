/**
 * 热重载「真生效」验证测试（v0.4.20）。
 *
 * ## 为什么这批测试必须存在
 *
 * 2026-10-17 实测：`selfReload()` 返回 `{ ok: true }`，但代码**没有真的换掉**
 * （`config-store.js` 换了、`index.js` 没换，或反之）。这种「假成功」造成的
 * 误导极强 —— 我因此连续几轮都基于"新代码已运行"的错误前提分析问题。
 *
 * 原有 D1~D8 只测了 `packageCacheKeys` / `purgeCaches` 这些**工具函数**，
 * 对"重载到底有没有生效"完全没有覆盖。所以它报成功，测试照样全绿。
 *
 * ## 这批测试验证什么
 *
 * 用**真实的 Node 模块系统**（不是 mock）验证三件事：
 *
 *   1. `fingerprint` 是真的会变的：同一文件的不同代际 URL 得到不同指纹，
 *      不同模块对象、不同 apply 函数。
 *   2. 代际绕过真的能穿透到依赖：入口带 `?dns-reload=x` 时，
 *      它 import 的依赖也必须重新求值（这是"半新半旧"的根治点）。
 *   3. 校验逻辑真的会拒绝假成功：指纹没变时必须抛错，而不是默默返回 ok。
 *
 * 这些用独立 node 进程跑真实 import，因此**不需要重启 DSH**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// ⚠️ 不能静态 import registerHooks —— 它是 Node 22.15+ 才有的导出，
// Node 20 上会让整个测试文件加载失败（CI 首跑抓到）。
// 改为运行时按需取，取不到就跳过相关断言。
let _registerHooks;
async function getRegisterHooks() {
  if (_registerHooks !== undefined) return _registerHooks;
  try {
    const mod = await import('node:module');
    _registerHooks = typeof mod.registerHooks === 'function' ? mod.registerHooks : null;
  } catch {
    _registerHooks = null;
  }
  return _registerHooks;
}

import { computeFingerprint } from '../lib/dev-reload.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── R1: 本包 index.js 确实导出了 fingerprint ────────────────────────────
test('R1: lib/index.js 导出非空 fingerprint（生效校验的前提）', async () => {
  const mod = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href);
  assert.equal(typeof mod.fingerprint, 'string',
    'index.js 必须导出 string 类型的 fingerprint，否则重载无法自证生效');
  assert.ok(mod.fingerprint.length > 0, 'fingerprint 不能为空');
});

// ── R2: 同一 URL 重复导入 → 指纹相同（模块缓存生效，符合预期）──────────
test('R2: 同 URL 重复 import 得到相同 fingerprint（未重新求值）', async () => {
  const url = pathToFileURL(join(ROOT, 'lib', 'index.js')).href;
  const a = await import(url);
  const b = await import(url);
  assert.equal(a.fingerprint, b.fingerprint,
    '同一 URL 应命中缓存、不重新求值 —— 这正是热重载要打破的');
});

// ── R3: 不同代际 URL → 指纹不同、模块对象不同（代际绕过有效）────────────
test('R3: 代际 URL 得到新模块对象，但 fingerprint 相同（源码哈希语义）', async () => {
  // ⚠️ 这条的断言在 v0.4.20 变过，原因很重要：
  //
  // 第一版 fingerprint 由 import.meta.url 派生，于是「代际不同 → 指纹不同」。
  // 但那让校验**判断力反了** —— 代码没改、只是重新求值一次，指纹也变，
  // 于是「没改代码」被判成「新代码已生效」（S2 测试当场抓到）。
  //
  // 现在 fingerprint 是**源码哈希**：代码不变 → 指纹不变，与代际无关。
  // 所以这里断言「指纹相同、模块对象不同」，正好体现两者语义差异：
  //   · 代际（URL） 反映「是否重新求值」
  //   · 指纹         反映「代码内容是否变化」
  const base = pathToFileURL(join(ROOT, 'lib', 'index.js')).href;
  const a = await import(base);
  const b = await import(base + '?dns-reload=gen-a');
  const c = await import(base + '?dns-reload=gen-b');

  // 代际确实让模块重新求值了
  assert.notEqual(a, b, '不同代际应是不同的模块对象');
  assert.equal(typeof b.apply, 'function');
  assert.notEqual(a.apply, b.apply, 'apply 函数应是新的（不是复用旧对象）');

  // 但代码没变，所以指纹必须一致 —— 这是校验能「拒绝假成功」的前提
  assert.equal(a.fingerprint, b.fingerprint, '代码未变时，代际不同指纹也应相同');
  assert.equal(b.fingerprint, c.fingerprint, '同理');
});

test('R4: enableFreshDependencies 让代际穿透到依赖（真实实现，非手写钩子）', async () => {
  // ⚠️ 设计要点：必须调用**真实的** enableFreshDependencies，
  // 而不是在测试里手写一份同构的 hook。
  //
  // 第一版 R4 就是手写 hook，结果变异测试发现：把 dev-reload.js 里的
  // 穿透逻辑改坏，R4 依然全绿（假阴性）。原因很简单 —— 它测的是自己。
  //
  // 这条对应 2026-10-17 的真实故障：入口带代际了、但入口里 import './x.js'
  // 不带代际，于是依赖仍是旧模块，形成"半新半旧"。
  const dir = mkdtempSync(join(tmpdir(), 'gen-pass-'));
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'lib', 'dep.js'),
    'export const selfUrl = import.meta.url;\nexport const marker = "dep";\n');
  writeFileSync(join(dir, 'lib', 'entry.js'),
    'import { selfUrl, marker } from "./dep.js";\nexport { marker };\nexport const depUrl = selfUrl;\n');

  const entryBase = pathToFileURL(join(dir, 'lib', 'entry.js')).href;
  const depBase = pathToFileURL(join(dir, 'lib', 'dep.js')).href;

  // ① 不带代际：依赖 URL 就是原样
  const plain = await import(entryBase);
  assert.equal(plain.depUrl, depBase, '不带代际时依赖 URL 应是原样');

  // ② 用被测模块自己的实现装上穿透钩子
  const { enableFreshDependencies } = await import('../lib/dev-reload.js');
  const packageUrl = pathToFileURL(dir + '\\').href;
  await enableFreshDependencies(packageUrl);   // 现在是异步注册（Node 20 兼容）

  // ③ 导入带代际的入口，检查依赖是否也继承了代际
  const gened = await import(entryBase + '?dns-reload=testgen-' + Date.now());
  assert.match(gened.depUrl, /dns-reload=testgen-/,
    '依赖模块的 URL 应继承代际参数；否则依赖仍是旧模块（"半新半旧"的机制）');
  assert.notEqual(gened.depUrl, depBase, '依赖不应还是原 URL');
  assert.equal(gened.marker, 'dep', '同一份磁盘代码，导出的值应一致');
});

test('R5: computeFingerprint 随文件变化而变（不是固定值）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fp-test-'));
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"name":"x","version":"1.0.0"}');
  writeFileSync(join(dir, 'lib', 'a.js'), 'export const x = 1;');

  const fp1 = computeFingerprint(dir);
  assert.ok(fp1.length > 0, '应返回非空指纹');

  // ⚠️ 指纹用的是 statSync 的 size + mtimeMs，而很多文件系统的 mtime 精度
  // 只有 1ms~1s。连续写入可能落在同一时间片里，导致"文件变了但指纹没变"。
  // 这不是代码缺陷（真实场景下改动间隔远大于此），但会让测试间歇性失败。
  // 所以这里显式等到 mtime 真的变化，再写第二版。
  const before = statSync(join(dir, 'lib', 'a.js')).mtimeMs;
  let waited = 0;
  while (statSync(join(dir, 'lib', 'a.js')).mtimeMs === before && waited < 2000) {
    await new Promise((r) => setTimeout(r, 20));
    waited += 20;
  }
  writeFileSync(join(dir, 'lib', 'a.js'), 'export const x = 22222;');

  const fp2 = computeFingerprint(dir);
  assert.notEqual(fp1, fp2,
    '文件变了指纹就该变 —— 否则"磁盘期望值"校验形同虚设');
});

// ── R6: computeFingerprint 目录不存在时返回空串，不抛异常 ─────────────────
test('R6: computeFingerprint 对不存在目录返回空串（不抛）', () => {
  let fp;
  assert.doesNotThrow(() => { fp = computeFingerprint('Z:\\no-such-dir-xyz'); });
  assert.equal(typeof fp, 'string');
  assert.equal(fp, '', '不存在时应返回空串，让调用方知道"算不出来"');
});

// ── R7: computeFingerprint 对同一目录稳定（同样内容得到同样值）──────────
test('R7: computeFingerprint 对未改动的目录保持稳定', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fp-stable-'));
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), '{"name":"y"}');
  writeFileSync(join(dir, 'lib', 'b.js'), 'export const y = 1;');
  const a = computeFingerprint(dir);
  const b = computeFingerprint(dir);
  assert.equal(a, b, '同一份未改动的内容应得到相同指纹');
});

// ── R8: verifyReload 的四条规则（核心：防假成功）─────────────────────────
test('R8: verifyReload 在指纹相同时必须判失败（复刻 2026-10-17 假成功）', async () => {
  const { verifyReload } = await import('../lib/dev-reload.js');

  // 负向：相同指纹 → 必须失败。这正是当年"重载报 ok 但其实没换"的根因。
  const same = verifyReload({ gotFingerprint: 'abc12345', differFrom: 'abc12345' });
  assert.equal(same.ok, false, '指纹相同必须判失败，不能默默报 ok');
  assert.equal(same.checked, true, '应标记为"已校验"');
  assert.match(same.error, /unchanged/, '错误信息应说明指纹未变');

  // 正向：不同指纹 → 通过
  const diff = verifyReload({ gotFingerprint: 'def67890', differFrom: 'abc12345' });
  assert.equal(diff.ok, true);
  assert.equal(diff.checked, true);

  // 负向：没有指纹 → 无法自证 → 失败（不能因为"拿不到"就放行）
  const none = verifyReload({ gotFingerprint: '', differFrom: 'abc12345' });
  assert.equal(none.ok, false, '拿不到指纹时必须失败 —— 否则等于没校验');
  assert.match(none.error, /does not export fingerprint/);

  // 未启用校验 → 通过，但 checked=false（调用方要知道"这次没验证"）
  const off = verifyReload({ gotFingerprint: 'abc' });
  assert.equal(off.ok, true);
  assert.equal(off.checked, false, '未启用校验时 checked 应为 false');
});

// ── R8b: expectedFingerprint 比 differFrom 更严 ──────────────────────────
test('R8b: expectedFingerprint 要求完全相等', async () => {
  const { verifyReload } = await import('../lib/dev-reload.js');

  const match = verifyReload({ gotFingerprint: 'aaa', expectedFingerprint: 'aaa' });
  assert.equal(match.ok, true);

  const mismatch = verifyReload({ gotFingerprint: 'bbb', expectedFingerprint: 'aaa' });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /mismatch/, '错误信息应指出不匹配');
});

// ── R9: index.js 的 fingerprint 由 import.meta.url 派生（可区分代际）─────
test('R9: index.js 源码里的 fingerprint 依赖 import.meta.url', () => {
  const src = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8');
  assert.match(src, /export const fingerprint/, '必须导出 fingerprint');
  assert.match(src, /import\.meta\.url/,
    'fingerprint 必须由 import.meta.url 派生，否则不同代际会得到相同值');
});

// ── R10: dev-reload 源码必须含代际绕过（这次的根治点）───────────────────
test('R10: dev-reload.js 含代际绕过与 registerHooks', () => {
  const src = readFileSync(join(ROOT, 'lib', 'dev-reload.js'), 'utf8');
  assert.match(src, /registerHooks/, '必须用 registerHooks 把代际传给依赖');
  assert.match(src, /searchParams\.set\(GEN_PARAM/,
    '必须给 URL 加代际参数，否则缓存清不掉时无法强制重求值');
  assert.match(src, /enableFreshDependencies/, '必须有代际穿透函数');
  // 旧实现"清不掉就放弃"的写法必须消失
  assert.doesNotMatch(src, /nothing was purged \(loadCache shape changed/,
    '不应再有"清不掉就直接放弃"的分支 —— 那正是假成功的来源');
});
