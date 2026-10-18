/**
 * dev-reload 测试：热重载的核心纯逻辑。
 *
 * ## 为什么这些能单独测
 *
 * 真正的 `selfReload()` 要操作活的 ctx / fiber / registry，只能在宿主里验。
 * 但**最容易写错、也最致命**的部分是纯逻辑：
 *
 *   - `packageCacheKeys` 该选哪些缓存键（选错 → 重载拿到旧代码，白折腾）
 *   - `purgeCaches` 是否真的删掉（用错 delete → 同上）
 *   - `restoreCaches` 能否完整回滚（回滚不全 → 插件半死）
 *
 * 这些都可以用**假 cache**（一个真 Map）穷举验证。
 *
 * ## 关键回归
 *
 * 上游 FreeModel 的注释明确记载：Node 24 的 `loadCache` 是 Map 子类，
 * **它自己的 `.delete` 只清"类型槽"**，模块本体仍在。必须用
 * `Map.prototype.delete.call(cache, key)`。本文件用"子类覆写 delete 但不清本体"
 * 的假 cache 来锁住这条 —— 如果用 `cache.delete()`，模块不会被真正删除。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  packageCacheKeys, purgeCaches, restoreCaches, packageUrlOf, entryUrlOf,
} from '../lib/dev-reload.js';

const PKG = 'file:///plugins/dsh-notify-say/';

// ── D1: 只选中本包的键 ────────────────────────────────────────────────────
test('D1: packageCacheKeys 只选本包路径下的键', () => {
  const cache = new Map([
    ['file:///plugins/dsh-notify-say/lib/index.js', 'a'],
    ['file:///plugins/dsh-notify-say/lib/client.js', 'b'],
    ['file:///plugins/other-plugin/index.js', 'c'],
    ['file:///plugins/dsh-notify-say-extra/index.js', 'd'],   // 前缀相似但不是本包
  ]);
  const keys = packageCacheKeys(cache, PKG);
  assert.deepEqual(keys.sort(), [
    'file:///plugins/dsh-notify-say/lib/client.js',
    'file:///plugins/dsh-notify-say/lib/index.js',
  ], '不该选中 other-plugin 或 dsh-notify-say-extra');
});

// ── D2: 大小写与百分号编码容错 ────────────────────────────────────────────
test('D2: 键比较容忍大小写与百分号编码差异', () => {
  const cache = new Map([
    ['file:///PLUGINS/dsh-notify-say/lib/index.js', 'x'],       // 大写
    ['file:///plugins/dsh-notify-say/lib/a%20b.js', 'y'],        // 含编码
  ]);
  const keys = packageCacheKeys(cache, PKG);
  assert.equal(keys.length, 2, '大写路径与含编码的路径都应命中');
});

// ── D3: 非字符串键不崩 ────────────────────────────────────────────────────
test('D3: 非字符串键被跳过，不抛异常', () => {
  const cache = new Map([[Symbol('s'), 'x'], [42, 'y'], ['file:///plugins/dsh-notify-say/a.js', 'z']]);
  assert.doesNotThrow(() => packageCacheKeys(cache, PKG));
  assert.equal(packageCacheKeys(cache, PKG).length, 1);
});

// ── D4: purge 真的删掉（关键：必须清微模块本体）────────────────────────────
test('D4: purgeCaches 用 Map.prototype.delete 真正删掉模块本体', () => {
  // 模拟 Node 24 的 LoadCache：是 Map 子类，自己的 delete 只清"类型槽"
  class FakeLoadCache extends Map {
    constructor(entries) {
      super(entries);
      this.types = new Map();
      for (const k of this.keys()) this.types.set(k, 'esm');
    }

    // ⚠️ 故意写坏：只清类型槽，不清本体 —— 这正是 Node 24 的行为
    delete(key) {
      this.types.delete(key);
      return true;
    }
  }

  const pkgEntry = 'file:///plugins/dsh-notify-say/lib/index.js';
  const other = 'file:///plugins/other/index.js';
  const cache = new FakeLoadCache([[pkgEntry, { id: 'old-index' }], [other, { id: 'other' }]]);

  const backup = purgeCaches({ loadCache: cache }, PKG);

  assert.equal(backup.esm.size, 1, '应备份 1 个本包模块');
  assert.equal(backup.esm.get(pkgEntry)?.id, 'old-index');

  // 关键断言：本体必须被真正删除
  assert.equal(Map.prototype.has.call(cache, pkgEntry), false,
    '模块本体必须被删掉；若用 cache.delete(key) 只会清类型槽，本体仍在 → 重载拿到旧代码');
  // 别人的模块不受影响
  assert.equal(Map.prototype.has.call(cache, other), true, '不该动其它包的模块');
});

// ── D5: 回滚能把缓存写回去 ────────────────────────────────────────────────
test('D5: restoreCaches 完整回滚', () => {
  const pkgEntry = 'file:///plugins/dsh-notify-say/lib/index.js';
  const cache = new Map([[pkgEntry, { id: 'old' }]]);

  // 清空并快照（用原生 Map，行为等价）
  const snap = new Map(cache);
  cache.clear();
  assert.equal(cache.size, 0);

  restoreCaches({ loadCache: cache }, { esm: snap, cjs: new Map() });
  assert.equal(cache.get(pkgEntry)?.id, 'old', '回滚后应恢复原模块');
});

// ── D6: 结构缺失时不崩 ────────────────────────────────────────────────────
test('D6: loadCache 缺失/畸形时安全返回空备份', () => {
  for (const internal of [undefined, null, {}, { loadCache: null }, { loadCache: {} }]) {
    let backup;
    assert.doesNotThrow(() => { backup = purgeCaches(internal, PKG); });
    assert.equal(backup.esm.size, 0, '拿不到缓存应返回空备份，而不是抛');
    assert.doesNotThrow(() => restoreCaches(internal, backup));
  }
});

// ── D7: URL 推导 ──────────────────────────────────────────────────────────
test('D7: packageUrlOf / entryUrlOf 正确推导', () => {
  const mod = 'file:///plugins/dsh-notify-say/lib/dev-reload.js';
  assert.equal(packageUrlOf(mod), 'file:///plugins/dsh-notify-say/');
  assert.equal(entryUrlOf(mod), 'file:///plugins/dsh-notify-say/lib/index.js');
});

// ── D8: 空 cache 不产生假备份 ─────────────────────────────────────────────
test('D8: 本包不在缓存里时返回空备份（调用方据此放弃重载）', () => {
  const cache = new Map([['file:///plugins/other/index.js', {}]]);
  const backup = purgeCaches({ loadCache: cache }, PKG);
  assert.equal(backup.esm.size, 0, '没清到任何东西 → 调用方应放弃，而不是当成成功');
});
