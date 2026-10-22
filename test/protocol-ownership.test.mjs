/**
 * 自定义协议的所有权判定与清理决策（v0.4.83）。
 *
 * ## 这组测试防什么
 *
 * 两个真实风险，都在 2026-10-20 的发布前审查中被点名：
 *
 * ### 1. 删别人的注册
 *
 * 原实现里 `syncJumpProtocol` 对所有非 `ok` 状态一律 `unregister` ——
 * 包括 `foreign`（键在、但指向别人的程序）。等于**别人的东西被我们删了**。
 *
 * ### 2. 卸载后留尾巴
 *
 * DSH 官方不区分「热重载」与「真正卸载」（源码 `dsh-plugin-manager`：
 * "With HMR, an installed package is removed before another version is
 * installed, so its plugins stop first"）。所以不能在 dispose 里注销 ——
 * 实测会误删热重载后的注册。
 *
 * 采用的方案：**启动时自清理**。判据是「注册指向的处理器文件已不存在」，
 * 这个判据在热重载/升级/正常运行时永远为假，所以**不会误删**。
 *
 * ## 测试策略（v0.4.83 改进）
 *
 * 判定与决策已经抽成 `lib/protocol-ownership.js` 的**纯函数**，
 * 所以这里直接测生产代码 —— 不再是"复制一份逻辑来验"。
 * `exists` 是注入的，测试不碰真实文件系统与注册表（只有一个集成用例除外）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProtocolOwner, planProtocolSync } from '../lib/protocol-ownership.js';

const ROOT = 'E:\\0Deepseek\\tools\\plugins\\dsh-notify-say';

/** 拼一条"像我们写的"注册命令。 */
const ourCmd = (handler) =>
  `"C:\\Windows\\System32\\wscript.exe" "${ROOT}\\${handler}" "%1"`;

// ══ C1~C4: classifyProtocolOwner 的四种状态 ═════════════════════════════

test('C1: 空值 → missing（没注册）', () => {
  assert.equal(classifyProtocolOwner('', ROOT), 'missing');
  assert.equal(classifyProtocolOwner(undefined, ROOT), 'missing');
  assert.equal(classifyProtocolOwner('   ', ROOT), 'missing');
});

test('C2: 指向本插件且文件存在 → ok', () => {
  const r = classifyProtocolOwner(
    ourCmd('jump-handler.vbs'), ROOT, { exists: () => true },
  );
  assert.equal(r, 'ok');
});

test('C3: 指向本插件但文件不存在 → stale（卸载后的尾巴）', () => {
  const r = classifyProtocolOwner(
    ourCmd('jump-handler.vbs'), ROOT, { exists: () => false },
  );
  assert.equal(r, 'stale', '文件没了必须判 stale —— 这是自清理的唯一入口');
});

test('C4: 指向别的程序 → foreign（绝不能碰）', () => {
  const r = classifyProtocolOwner(
    '"C:\\OtherApp\\other.exe" "%1"', ROOT, { exists: () => true },
  );
  assert.equal(r, 'foreign', '不是我们写的注册必须判 foreign');
});

// ══ C5~C7: 边界与容错 ══════════════════════════════════════════════════

test('C5: 同名文件但在别人目录下 → foreign（不能只看文件名）', () => {
  const r = classifyProtocolOwner(
    '"C:\\Windows\\System32\\wscript.exe" "D:\\OtherPlugin\\jump-handler.vbs" "%1"',
    ROOT,
    { exists: () => true },
  );
  assert.equal(r, 'foreign',
    '别的插件也可能叫 jump-handler.vbs —— 必须比对目录，否则会删别人');
});

test('C6: 路径大小写与斜杠混用仍能认出是我们', () => {
  const variants = [
    ourCmd('jump-handler.vbs'),
    ourCmd('jump-handler.vbs').toLowerCase(),
    ourCmd('jump-handler.vbs').toUpperCase(),
    ourCmd('jump-handler.vbs').replace(/\\/g, '/'),
  ];
  for (const v of variants) {
    assert.equal(
      classifyProtocolOwner(v, ROOT, { exists: () => true }), 'ok',
      `这个变体应被认出是我们的: ${v}`,
    );
  }
});

test('C7: 拿不到 exists 判定时不冒险（判 ok，不删）', () => {
  // 误删的代价（用户点 Toast 没反应）高于"多留一条注册"
  const r = classifyProtocolOwner(ourCmd('jump-handler.vbs'), ROOT, {});
  assert.equal(r, 'ok', '无法确认时宁可保留，不能删');
});

// ══ D1~D5: planProtocolSync 的决策矩阵 ═════════════════════════════════

test('D1: foreign 无论开关如何，都不动它', () => {
  for (const enabled of [true, false]) {
    const p = planProtocolSync('foreign', enabled);
    assert.equal(p.action, 'none', 'foreign 绝不能产生 unregister/register 动作');
    assert.equal(p.downgrade, true, 'foreign 必须标记降级');
    assert.equal(p.usable, false, 'foreign 时精准跳转不可用');
  }
});

test('D2: ok + 开关开 → reuse（不重写注册表）', () => {
  const p = planProtocolSync('ok', true);
  assert.equal(p.action, 'reuse');
  assert.equal(p.usable, true);
});

test('D3: ok + 开关关 → unregister（是我们的，可以清）', () => {
  const p = planProtocolSync('ok', false);
  assert.equal(p.action, 'unregister');
  assert.equal(p.usable, false);
});

test('D4: stale + 开关开 → register 且先清理', () => {
  const p = planProtocolSync('stale', true);
  assert.equal(p.action, 'register');
  assert.equal(p.cleanupFirst, true, 'stale 必须先清理失效项再注册');
  assert.equal(p.usable, true);
});

test('D5: missing + 开关开 → register；开关关 → 什么都不做', () => {
  assert.equal(planProtocolSync('missing', true).action, 'register');
  assert.equal(planProtocolSync('missing', false).action, 'none');
});

// ══ D6: 不变量 —— 只有我们的东西才允许被删 ═════════════════════════════

test('D6: 任何输入组合下，unregister 只可能发生在 ok/stale', () => {
  const states = ['missing', 'ok', 'stale', 'foreign'];
  for (const s of states) {
    for (const enabled of [true, false]) {
      const p = planProtocolSync(s, enabled);
      if (p.action === 'unregister' || p.cleanupFirst) {
        assert.ok(
          s === 'ok' || s === 'stale',
          `违反不变量：state=${s} enabled=${enabled} 时产生了删除动作`,
        );
      }
    }
  }
});

// ══ I1: 真实集成 —— index.js 确实接到这套判定上 ═════════════════════════

test('I1: index.js 必须使用纯函数（不能自己又写一套判定）', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const SRC = readFileSync(join(ROOT_DIR, 'lib', 'index.js'), 'utf8');

  assert.match(SRC, /from '\.\/protocol-ownership\.js'/,
    'index.js 必须 import 判定模块 —— 否则规则会出现两份');
  assert.match(SRC, /classifyProtocolOwner\(/,
    'probe 必须调用 classifyProtocolOwner');
  assert.match(SRC, /planProtocolSync\(/,
    'sync 必须调用 planProtocolSync');

  // 反向断言：不能残留手写的四态判定（那说明有人又写了一份）
  const probeAt = SRC.indexOf('function probeJumpProtocol()');
  const probeBody = SRC.slice(probeAt, probeAt + 2000);
  assert.doesNotMatch(probeBody, /return 'foreign'/,
    'probe 里不该再有手写的 foreign 判定 —— 判定已收进纯函数');
});

// ══ I2: 设置页改开关必须立即生效（不是重启才生效）═════════════════════════
//
// ## 为什么必须有这条
//
// 2026-10-20 真机验收发现：在设置页切换「点击通知跳到对应会话」后，
// **注册表根本没动** —— 必须重启 DSH 才生效。而 README 写着"立即生效"。
//
// 根因：`syncJumpProtocol()` 只在 `apply()`（插件启动）里被调用过一次，
// 配置变更回调 `onChanged` 只调了 `refreshConfig()`。
//
// 这类缺陷特别难发现：改配置 → 界面显示已保存 → 但底层没动作。
// 用户会以为是"功能坏了"，而日志里连一行记录都没有。
test('I2: 配置变更回调必须同步协议状态（否则要重启才生效）', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const SRC = readFileSync(join(ROOT_DIR, 'lib', 'index.js'), 'utf8');

  // 取 createConfigRoute 的 onChanged 回调体
  const m = SRC.match(/onChanged:\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s{2}\},/);
  assert.ok(m, '找不到 configRoute 的 onChanged 回调（源码结构变了，请更新本测试）');

  const body = m[1];
  assert.match(body, /refreshConfig\(\)/, 'onChanged 必须重读配置');
  assert.match(body, /syncJumpProtocol\(\)/,
    'onChanged 必须同步协议状态 —— 否则设置页开关要重启 DSH 才生效'
    + '（2026-10-20 真机验收实测踩到）');
});

