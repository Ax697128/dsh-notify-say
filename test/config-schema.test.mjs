/**
 * config-schema 测试：官方 Config schema 的正确性与降级安全。
 *
 * 这是「设置页 GUI」的地基，错一处就整块报废（官方报错：
 * `Plugin entry "<ns>" has no volatile fields` / `Config field "<path>" is not volatile`），
 * 或更糟：schema 加载失败把插件一起拖挂。所以两类都测。
 *
 * 覆盖：
 *  - S1  schema 能从 $DSH_HOME 侧解析到 schemastery
 *  - S2  **每个字段**都有 volatile 标记（漏一个就是 has no volatile fields）
 *  - S3  默认值正确，且 readConfig 能从 ref 取值
 *  - S4  越界值被 schema 拒绝（volume 边界）
 *  - S5  降级：$DSH_HOME 缺失时 loadSchema 返回 null 且不抛
 *  - S6  降级：$DSH_HOME 指向不存在的目录时同样安全返回 null
 *  - S7  readConfig 兼容「普通对象」（Loader 已解析）与「缺失键」
 *  - S8  插件模块的 Config 导出与本 schema 一致（防两处各写一份漂移）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  safeHome, loadSchema, buildConfig, readConfig, FIELD_DEFAULTS,
} from '../lib/config-schema.js';

const HAS_HOME = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0;

// ── S1: 能解析到 schemastery ────────────────────────────────────────────────
test('S1: 从 $DSH_HOME 侧能解析 @deepseek-ai/schemastery',
  { skip: !HAS_HOME && '需要真实 $DSH_HOME（本机有；纯沙盒环境跳过）' }, () => {
    const z = loadSchema(process.env);
    assert.ok(z, '应解析到 schemastery');
    assert.equal(typeof z.object, 'function', 'schemastery 应提供 z.object');
  });

// ── S2: 每个字段都必须 volatile（官方硬契约）────────────────────────────────
test('S2: 每个字段都带 volatile 标记（漏一个设置页就报废）', () => {
  const z = loadSchema(process.env);
  if (!z) return; // 降级环境跳过（S5/S6 覆盖降级本身）
  const Config = buildConfig(z);
  const dict = Config.dict;
  assert.ok(dict, 'schema 应有 dict');

  const missing = [];
  for (const key of Object.keys(FIELD_DEFAULTS)) {
    const field = dict[key];
    if (!field) { missing.push(key + '(字段不存在)'); continue; }
    if (!field.meta || field.meta.volatile !== true) missing.push(key);
  }
  assert.deepEqual(missing, [],
    `以下字段缺少 .volatile()，会导致 "Plugin entry has no volatile fields"：${missing.join(', ')}`);
});

// ── S3: 默认值与取值 ────────────────────────────────────────────────────────
test('S3: 默认值正确，readConfig 能从 schemastery ref 取值', () => {
  const z = loadSchema(process.env);
  if (!z) return;
  const Config = buildConfig(z);
  const inst = Config({});
  const vals = readConfig(inst);

  assert.equal(vals.voice, FIELD_DEFAULTS.voice);
  assert.equal(vals.voiceMode, FIELD_DEFAULTS.voiceMode);
  assert.equal(vals.voiceName, FIELD_DEFAULTS.voiceName);
  assert.equal(vals.volume, FIELD_DEFAULTS.volume);
  assert.equal(vals.idleGate, FIELD_DEFAULTS.idleGate);
  assert.equal(Object.keys(vals).length, Object.keys(FIELD_DEFAULTS).length,
    'readConfig 应返回与 FIELD_DEFAULTS 同样多的键');
});

// ── S4: 越界值被拒 ──────────────────────────────────────────────────────────
test('S4: volume 越界被 schema 拒绝（0-100）', () => {
  const z = loadSchema(process.env);
  if (!z) return;
  const Config = buildConfig(z);
  assert.throws(() => Config({ volume: 101 }), /volume|100/, 'volume=101 应被拒');
  assert.throws(() => Config({ volume: -1 }), /volume|0/, 'volume=-1 应被拒');
  // 边界值合法
  assert.equal(readConfig(Config({ volume: 0 })).volume, 0);
  assert.equal(readConfig(Config({ volume: 100 })).volume, 100);
});

// ── S5: 降级 —— 没有 $DSH_HOME ──────────────────────────────────────────────
test('S5: $DSH_HOME 缺失时 loadSchema 安全返回 null（不抛）', () => {
  assert.doesNotThrow(() => {
    const z = loadSchema({});
    assert.equal(z, null, '没有 $DSH_HOME 时应返回 null 而不是抛异常');
  });
  assert.equal(safeHome({}), '');
  assert.equal(safeHome({ DSH_HOME: '' }), '');
});

// ── S6: 降级 —— $DSH_HOME 指向不存在的地方 ──────────────────────────────────
test('S6: $DSH_HOME 指向不存在的目录时安全返回 null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'notify-schema-'));
  try {
    // 用一个空临时目录当 DSH_HOME：没有任何 package.json 锚点
    assert.doesNotThrow(() => {
      const z = loadSchema({ DSH_HOME: dir });
      assert.equal(z, null, '解析不到 schemastery 应返回 null');
    });
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ── S7: readConfig 的兼容性 ─────────────────────────────────────────────────
test('S7: readConfig 兼容普通对象 / 缺失键 / null', () => {
  // Loader 已解析成普通对象的情况
  const plain = { volume: 42, voice: false, voiceMode: 'random' };
  const got = readConfig(plain);
  assert.equal(got.volume, 42);
  assert.equal(got.voice, false);
  assert.equal(got.voiceMode, 'random');
  // 缺失的键用默认值补齐（避免下游拿到 undefined 后静默走错分支）
  assert.equal(got.idleGate, FIELD_DEFAULTS.idleGate, '缺失键应回落到默认值');

  // null / undefined 不能崩
  assert.doesNotThrow(() => readConfig(null));
  assert.doesNotThrow(() => readConfig(undefined));
  assert.equal(readConfig(null).volume, FIELD_DEFAULTS.volume);
});

// ── S8: 插件导出的 Config 与本 schema 一致（防两处漂移）────────────────────
test('S8: lib/index.js 导出的 Config 与 buildConfig 结构一致', async () => {
  const mod = await import('../lib/index.js');
  assert.equal(typeof mod.apply, 'function', 'apply 必须导出');
  const z = loadSchema(process.env);
  if (!z) {
    assert.equal(mod.Config, undefined, '降级环境下 Config 应为 undefined');
    return;
  }
  assert.equal(typeof mod.Config, 'function', 'Config 应导出且可实例化');
  const mine = buildConfig(z);
  // 字段集合必须一致（防止 index.js 里另写一份）
  assert.deepEqual(
    Object.keys(mod.Config.dict).sort(),
    Object.keys(mine.dict).sort(),
    'index.js 导出的 Config 字段集合与 config-schema.js 必须一致',
  );
  // volatile 契约同样成立
  for (const key of Object.keys(FIELD_DEFAULTS)) {
    assert.equal(mod.Config.dict[key].meta.volatile, true, `${key} 在导出的 Config 里必须 volatile`);
  }
});
