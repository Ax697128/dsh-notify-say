/**
 * 自定义协议的所有权判定与清理决策（v0.4.83；v0.5.0 改判据）。
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
 * ## v0.5.0：判据从「插件目录」改成「协议名」
 *
 * 起因是一个真实的老用户故障：升级/改名后插件目录变了，旧注册的路径
 * 对不上 → `classifyProtocolOwner` 判成 `foreign` → 既不清理也不重建 →
 * Toast 精准跳转**永久**降级为「只唤窗」，用户关掉开关也修不好。
 *
 * 改成按**本包独占的协议名**（`dshnotify-say`）判归属后，目录怎么搬都认得出。
 *
 * ## 测试策略
 *
 * 判定与决策是 `lib/protocol-ownership.js` 的**纯函数**，
 * 所以这里直接测生产代码 —— 不再是"复制一份逻辑来验"。
 * `exists` 是注入的，测试不碰真实文件系统与注册表。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyProtocolOwner, planProtocolSync, isLegacyRegistration,
  OWNER_ID,
} from '../lib/protocol-ownership.js';

/** 我们写进注册表键的身份标记值（应与 package.json 的 name 一致）。 */
const OWNER = OWNER_ID;

/** 拼一条"像我们写的"注册命令（目录随便写，归属只认身份标记/handler 名）。 */
const ourCmd = (handler) =>
  `"C:\\Windows\\System32\\wscript.exe" "E:\\0Deepseek\\tools\\plugins\\dsh-notify-say\\${handler}" "%1"`;

/** 构造一条注册记录。 */
const reg = (commandValue, ownerValue) => ({ commandValue, ownerValue });

// ══ C1~C4: classifyProtocolOwner 的四种状态 ═════════════════════════════

test('C1: 空值 → missing（没注册）', () => {
  assert.equal(classifyProtocolOwner(reg('', '')), 'missing');
  assert.equal(classifyProtocolOwner(reg(undefined, undefined)), 'missing');
  assert.equal(classifyProtocolOwner(reg('   ', '   ')), 'missing');
  assert.equal(classifyProtocolOwner({}), 'missing');
  assert.equal(classifyProtocolOwner(undefined), 'missing');
});

test('C2: 有我们的身份标记且文件存在 → ok', () => {
  const r = classifyProtocolOwner(
    reg(ourCmd('jump-handler.vbs'), OWNER), { exists: () => true },
  );
  assert.equal(r, 'ok');
});

test('C3: 指向本插件但文件不存在 → stale（卸载后的尾巴）', () => {
  const r = classifyProtocolOwner(
    reg(ourCmd('jump-handler.vbs'), OWNER), { exists: () => false },
  );
  assert.equal(r, 'stale', '文件没了必须判 stale —— 这是自清理的唯一入口');
});

test('C4: 指向别的程序、无标记 → foreign（绝不能碰）', () => {
  const r = classifyProtocolOwner(
    reg('"C:\\OtherApp\\other.exe" "%1"', ''), { exists: () => true },
  );
  assert.equal(r, 'foreign', '不是我们写的注册必须判 foreign');
});

// ══ C5~C10: 边界与容错 ═════════════════════════════════════════════════

test('C5: 同名文件但在别人目录下、且无我们的标记/命名 → foreign', () => {
  const r = classifyProtocolOwner(
    reg('"C:\\Windows\\System32\\wscript.exe" "D:\\OtherApp\\launcher.exe" "%1"', ''), 
    { exists: () => true },
  );
  assert.equal(r, 'foreign', '既无标记也无我们的 handler 名 → 不是我们');
});

// ══ C5b/C5c: 只读审查 B3 —— 同名 handler 在别人目录下 ══════════════════════
//
// C5 原本喂的是 `launcher.exe`，**根本没用到同名文件**，所以「别人目录里也有
// 一个叫 jump-handler.vbs 的文件」这个真实风险从来没被测到过。
// 实测后果（修复前）：判 'ok' → planProtocolSync('ok', false) 给 unregister
// → 我们会去删**别人的**注册键。
test('C5b: 别人目录下的同名 jump-handler.vbs（无标记）→ foreign，不删', () => {
  const OUR_ROOT = 'E:\\0Deepseek\\tools\\plugins\\dsh-notify-say';
  const r = classifyProtocolOwner(
    reg('"C:\\Windows\\System32\\wscript.exe" "D:\\OtherApp\\jump-handler.vbs" "%1"', ''),
    { exists: () => true, pluginRoot: OUR_ROOT },
  );
  assert.equal(r, 'foreign',
    '同名但不在本插件目录、又无身份标记 → 必须判 foreign（否则会删别人的注册）');
});

test('C5c: 我们自己的 handler 在 pluginRoot 下 → ok', () => {
  const OUR_ROOT = 'E:\\0Deepseek\\tools\\plugins\\dsh-notify-say';
  const r = classifyProtocolOwner(
    reg(`"C:\\Windows\\System32\\wscript.exe" "${OUR_ROOT}\\jump-handler.vbs" "%1"`, ''),
    { exists: () => true, pluginRoot: OUR_ROOT },
  );
  assert.equal(r, 'ok');
});

test('C5d: path-prefix 陷阱 —— `dsh-notify-say-backup` 不算在目录内', () => {
  const OUR_ROOT = 'E:\\0Deepseek\\tools\\plugins\\dsh-notify-say';
  const r = classifyProtocolOwner(
    reg('"C:\\Windows\\System32\\wscript.exe" "E:\\0Deepseek\\tools\\plugins\\dsh-notify-say-backup\\jump-handler.vbs" "%1"', ''),
    { exists: () => true, pluginRoot: OUR_ROOT },
  );
  assert.equal(r, 'foreign', '前缀相同但不是子目录 → 必须判 foreign');
});

// ══ C11: 只读审查 B2 —— 老键清理必须看身份标记 ═════════════════════════════
//
// 修复前 `isLegacyRegistration` 只看 handler 文件名、无视 ownerValue，于是：
//   { commandValue: '...D:\OtherApp\jump-handler.vbs', ownerValue: 'some-other-plugin' }
//   → isLegacyRegistration = true（会被 Remove-Item）
//   → 同输入 classifyProtocolOwner = 'foreign'（绝不碰）
// 两个函数判据不一致，正是「误删别人」的缝。
test('C11: 老键里明确写了别人的标记 → 不清理', () => {
  const r = isLegacyRegistration(
    reg('"C:\\Windows\\System32\\wscript.exe" "D:\\OtherApp\\jump-handler.vbs" "%1"', 'some-other-plugin'),
  );
  assert.equal(r, false, '标记不是我们的值 → 即使命令里有同名 handler 也不能删');
});

test('C11b: 老键无标记 + 我们的旧目录（真实现场）→ 清理', () => {
  // 本机真实升级前现场：老键指向改名前的 dsh-notify-desktop 目录
  const r = isLegacyRegistration(
    reg('"C:\\Windows\\System32\\wscript.exe" "E:\\0Deepseek\\tools\\plugins\\dsh-notify-desktop\\jump-handler.vbs" "%1"', ''),
  );
  assert.equal(r, true,
    '这是真实用户升级前的注册 —— 必须能识别并清掉，否则本次修复对老用户完全失效');
});

test('C11c: 老键无标记 + 别人目录下的同名 handler → 不清理', () => {
  const r = isLegacyRegistration(
    reg('"C:\\Windows\\System32\\wscript.exe" "D:\\OtherApp\\jump-handler.vbs" "%1"', ''),
  );
  assert.equal(r, false, '目录名不像 dsh-notify* → 不是我装的历史键，不能删');
});

test('C6: 标记指向别人 → foreign（别人明确写了身份，必须尊重）', () => {
  const r = classifyProtocolOwner(
    reg(ourCmd('jump-handler.vbs'), 'some-other-plugin'), { exists: () => true },
  );
  assert.equal(r, 'foreign', '标记不是我们的值时必须判 foreign');
});

test('C7: 目录变了仍能认出是我们（v0.5.0 的核心修复）', () => {
  // 老用户升级后目录从 dsh-notify-desktop 变成 dsh-notify-say，或换盘符
  const variants = [
    `"C:\\Windows\\System32\\wscript.exe" "D:\\Old\\dsh-notify-desktop\\jump-handler.vbs" "%1"`,
    `"C:\\Windows\\System32\\wscript.exe" "C:\\Users\\u\\plugins\\whatever\\jump-handler.ps1" "%1"`,
  ];
  for (const v of variants) {
    assert.equal(
      classifyProtocolOwner(reg(v, OWNER), { exists: () => true }), 'ok',
      `目录变了也必须认得出是我们（靠标记）: ${v}`,
    );
    // 没有标记时靠 handler 文件名也认得出（旧版本写的注册）
    assert.equal(
      classifyProtocolOwner(reg(v, ''), { exists: () => true }), 'ok',
      `没有标记时靠 handler 名也认得出: ${v}`,
    );
  }
});

test('C8: 路径大小写与斜杠混用仍能认出是我们', () => {
  const variants = [
    ourCmd('jump-handler.vbs'),
    ourCmd('jump-handler.vbs').toLowerCase(),
    ourCmd('jump-handler.vbs').toUpperCase(),
    ourCmd('jump-handler.vbs').replace(/\\/g, '/'),
  ];
  for (const v of variants) {
    assert.equal(
      classifyProtocolOwner(reg(v, ''), { exists: () => true }), 'ok',
      `这个变体应被认出是我们的: ${v}`,
    );
  }
});

test('C9: 拿不到 exists 判定时不冒险（判 ok，不删）', () => {
  // 误删的代价（用户点 Toast 没反应）高于"多留一条注册"
  const r = classifyProtocolOwner(reg(ourCmd('jump-handler.vbs'), OWNER), {});
  assert.equal(r, 'ok', '无法确认时宁可保留，不能删');
});

test('C10: 标记值大小写不敏感（注册表值是我们自己写的，不该因大小写判错）', () => {
  const r = classifyProtocolOwner(
    reg(ourCmd('jump-handler.vbs'), OWNER.toUpperCase()), { exists: () => true },
  );
  assert.equal(r, 'ok');
});

// ══ D1~D6: planProtocolSync 的决策矩阵 ═════════════════════════════════

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

// ══ L1~L3: 历史协议清理的判据 ═══════════════════════════════════════════

test('L1: 老协议键指向我们的 handler → 可以清理', () => {
  assert.equal(isLegacyRegistration(reg(ourCmd('jump-handler.vbs'), '')), true);
  assert.equal(isLegacyRegistration(reg(ourCmd('jump-handler.ps1'), '')), true);
});

test('L2: 老协议键指向别人的程序 → 不清理', () => {
  assert.equal(isLegacyRegistration(reg('"C:\\OtherApp\\other.exe" "%1"', '')), false);
  assert.equal(isLegacyRegistration(reg('', '')), false);
  assert.equal(isLegacyRegistration(reg('   ', '   ')), false);
});

test('L3: 清理判据必须要求 handler 文件名（不能只看键名像）', () => {
  // 万一将来真有别的程序用了 dshnotify 这个词，我们不因为键名像就删它
  assert.equal(
    isLegacyRegistration(reg('"C:\\Windows\\System32\\wscript.exe" "C:\\x\\launcher.exe" "%1"', '')),
    false,
  );
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
  assert.match(SRC, /isLegacyRegistration\(/,
    'sync 必须调用 isLegacyRegistration 清理历史协议');

  // 反向断言：不能残留手写的四态判定（那说明有人又写了一份）
  const probeAt = SRC.indexOf('function probeJumpProtocol()');
  const probeBody = SRC.slice(probeAt, probeAt + 2000);
  assert.doesNotMatch(probeBody, /return 'foreign'/,
    'probe 里不该再有手写的 foreign 判定 —— 判定已收进纯函数');
});

// ══ I2: 协议名必须与历史名不同（改名迁移的硬约束）═════════════════════════

test('I2: index.js 的 JUMP_PROTOCOL 必须是 dshnotify-say，且历史名单含 dshnotify', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const SRC = readFileSync(join(ROOT_DIR, 'lib', 'index.js'), 'utf8');

  assert.match(SRC, /const JUMP_PROTOCOL = 'dshnotify-say'/,
    '当前协议名必须是 dshnotify-say');
  assert.match(SRC, /const LEGACY_JUMP_PROTOCOLS = \['dshnotify'\]/,
    '历史协议必须登记 dshnotify，否则升级后老键清不掉');
});

// ══ I2b: 读注册表必须强制 UTF-8 输出（中文路径护栏）════════════════════════
//
// ## 为什么（只读审查 S2，2026-10-22 实证）
//
// `readProtocolRegistration` 用 `execFileSync(..., { encoding: 'utf8' })` 读回
// PowerShell 的输出。但 PS 5.1 经管道输出非 ASCII 时走**控制台代码页**
// （中文系统是 GBK），Node 侧按 UTF-8 解 → 中文路径变成替换字符。
//
// 实测（写入 `E:\测试\中文目录\jump-handler.vbs` 后读回）：
//   无修正 → "E:\\����\\����Ŀ¼\\jump-handler.vbs"   ← 中文全烂
//   有修正 → "E:\\测试\\中文目录\\jump-handler.vbs"   ← 正确
//
// 后果不是"少个字符"，而是 existsSync 必 false → 判 `stale`：
//   · 开关**开**着：每次配置变更都"删了再建"（空窗 + 重复 PowerShell）
//   · 开关**关**着：直接删掉一个其实能用的注册 → 用户点了没反应
// 中文用户（本插件的主要用户群）只要把插件装在中文路径下就必中。
test('I2b: readProtocolRegistration 的 PowerShell 必须设 OutputEncoding=UTF8', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const SRC = readFileSync(join(ROOT_DIR, 'lib', 'index.js'), 'utf8');

  const fnAt = SRC.indexOf('function readProtocolRegistration(');
  assert.ok(fnAt > 0, '找不到 readProtocolRegistration（源码结构变了，请更新本测试）');
  const body = SRC.slice(fnAt, fnAt + 1400);

  assert.match(body, /\[Console\]::OutputEncoding = \[Text\.Encoding\]::UTF8/,
    '读注册表的 PowerShell 必须先把 OutputEncoding 设成 UTF8 —— '
    + '否则中文路径会乱码，导致把能用的注册误判成 stale 并删掉');
});

// ══ I3: Toast 生成侧必须用新协议名 ══════════════════════════════════════

test('I3: dsh-notify.ps1 的 Toast launch 必须写新协议名', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const PS1 = readFileSync(join(ROOT_DIR, 'dsh-notify.ps1'), 'utf8');

  assert.match(PS1, /\$toastLaunch = 'dshnotify-say:\/\/jump\?session='/,
    'dsh-notify.ps1 必须生成 dshnotify-say:// 的 launch —— '
    + '否则点击走的是老协议词，新注册的 handler 收不到');
  // 反向断言：不能残留只写旧协议名的 launch 赋值
  assert.doesNotMatch(PS1, /\$toastLaunch = 'dshnotify:\/\/jump\?session='/,
    '不能残留旧协议名的 launch 赋值');
});

// ══ I4: 两个 handler 解析的协议名必须一致 ═══════════════════════════════

test('I4: jump-handler.vbs / .ps1 必须只接受新协议名', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

  const VBS = readFileSync(join(ROOT_DIR, 'jump-handler.vbs'), 'utf8');
  const PS1 = readFileSync(join(ROOT_DIR, 'jump-handler.ps1'), 'utf8');

  // VBS 的 Pattern 与 PS1 的 regex 都必须锚定新协议名
  assert.match(VBS, /\^dshnotify-say:\/\/jump/,
    'jump-handler.vbs 必须解析 dshnotify-say://');
  assert.match(PS1, /\^dshnotify-say:\/\/jump/,
    'jump-handler.ps1 必须解析 dshnotify-say://');

  // 反向断言：不能残留旧协议名的正则锚点
  assert.doesNotMatch(VBS, /Pattern = "\^dshnotify:\/\/jump/,
    'jump-handler.vbs 不能残留旧协议名（会被新 URL 全部跳过）');
  assert.doesNotMatch(PS1, /\^dshnotify:\/\/jump/,
    'jump-handler.ps1 不能残留旧协议名（会被新 URL 全部跳过）');
});

// ══ I5: 配置变更回调必须同步协议状态（否则要重启才生效）═════════════════════
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
test('I5: 配置变更回调必须同步协议状态（否则要重启才生效）', async () => {
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

// ══ I6: 历史协议清理必须只跑一次（性能护栏）═══════════════════════════════
//
// ## 为什么必须有这条
//
// `syncJumpProtocol()` 每次配置变更都会跑（设置页每改一项就一次）。
// `cleanupLegacyProtocols()` 里要开 PowerShell 读注册表，实测约 200 ms/次 ——
// 挂进去就等于"改个音量卡 200 毫秒"。
//
// 迁移本身是一次性动作：清掉了、或者确认不是我们的，都没有再查的理由。
// 所以有进程内标记 `legacyProtocolsChecked`。这条测试防的是"以后有人
// 觉得标记多余把它删了" —— 那会静默变成每改一项配置多一次 PowerShell。
test('I6: cleanupLegacyProtocols 必须有进程内缓存（只查一次）', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const SRC = readFileSync(join(ROOT_DIR, 'lib', 'index.js'), 'utf8');

  assert.match(SRC, /let legacyProtocolsChecked = false/,
    '应有一个进程内标记记录历史协议是否已查过');

  const fnAt = SRC.indexOf('function cleanupLegacyProtocols()');
  assert.ok(fnAt > 0, '找不到 cleanupLegacyProtocols（源码结构变了，请更新本测试）');
  const body = SRC.slice(fnAt, fnAt + 900);

  assert.match(body, /if \(legacyProtocolsChecked\) return;/,
    '重复调用必须直接返回 —— 否则每次配置变更都多开 PowerShell 读注册表');
  assert.match(body, /legacyProtocolsChecked = true;/,
    '查过之后必须置位（且要在读取注册表之前置位，避免异常时反复重试）');
});

// ══ I8: 清老协议必须排在新协议可用之后（防止"两头落空"）══════════════════
//
// ## 为什么（v0.5.0 自查发现）
//
// 第一版把 `cleanupLegacyProtocols()` 放在 syncJumpProtocol 的**第一行**：
//     function syncJumpProtocol() {
//       cleanupLegacyProtocols();     // ← 先删老键
//       const probed = probeJumpProtocol();
//       ... registerJumpProtocol()    // ← 再建新键，可能失败
//
// 隐患：如果新键注册失败（PowerShell 被执行策略挡住、注册表被占用……），
// 老键已经删掉、新键又没建起来 → 用户从「降级但还能唤窗」变成「点了完全没
// 反应」。而这次改动本来就是为了修「点了没反应」，等于给老用户挖了个更深的坑。
//
// 正确顺序：**先**确认新键可用（reuse / 注册成功），**再**清老键。
//
// ## ⚠️ 第一版是假绿（只读审查 B1 抓到，已修）
//
// 第一版用 `body.indexOf('registerJumpProtocol()')` 找锚点 —— 但它命中的是
// `unregisterJumpProtocol();` 这行（子串里就含 `registerJumpProtocol()`），
// 而不是真正的 `registerJumpProtocol()` 调用。位置更靠前，于是断言恒成立。
//
// 更糟的是它挡不住真正的回归：把 register 分支里的 cleanup 挪到 register 之前
// （保留 unregister 分支那条），第一版**依然通过**。
//
// 现在改为按「源码里的实际行」定位，并且**同时**验证两条：
//   ① register 分支内：`const okReg = registerJumpProtocol();` 在 `if (okReg) cleanup...` 之前
//   ② 函数整体：不存在比 register 更早的裸 cleanup 调用（unregister 分支除外）
function lineIndexOf(src, needle) {
  const at = src.indexOf(needle);
  if (at < 0) return -1;
  return src.slice(0, at).split('\n').length; // 1-based 行号
}

test('I8: cleanupLegacyProtocols 必须在 registerJumpProtocol 之后调用', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const SRC = readFileSync(join(ROOT_DIR, 'lib', 'index.js'), 'utf8');

  const fnAt = SRC.indexOf('function syncJumpProtocol()');
  assert.ok(fnAt > 0, '找不到 syncJumpProtocol（源码结构变了，请更新本测试）');
  const afterFn = SRC.indexOf('\n  function svc(', fnAt);
  assert.ok(afterFn > fnAt, '找不到 syncJumpProtocol 的结束边界（源码结构变了，请更新本测试）');
  const body = SRC.slice(fnAt, afterFn);

  // ── ① register 分支内部：先注册，再按结果决定是否清理 ──────────────────
  const regCall = body.indexOf('const okReg = registerJumpProtocol();');
  assert.ok(regCall > 0,
    '找不到 `const okReg = registerJumpProtocol();`（源码结构变了，请更新本测试）');
  const guardedCleanup = body.indexOf('if (okReg) cleanupLegacyProtocols();');
  assert.ok(guardedCleanup > 0,
    '注册结果必须被用来决定是否清老键（失败时保留老键）');
  assert.ok(guardedCleanup > regCall,
    'if (okReg) cleanupLegacyProtocols() 必须排在 registerJumpProtocol() 之后');

  // ── ② 全函数：不允许出现"比探测/注册更早"的裸 cleanup 调用 ────────────
  //
  // 判据取的是**最危险的那种错法**——把 cleanup 挪到函数最前面（先清后建）。
  // 所以只要每个裸调用的行号都晚于 `const probed = probeJumpProtocol();`，
  // 就说明它落在某个分支里（reuse / unregister / register 成功），不是"无条件先清"。
  const lines = body.split('\n');
  const probeLine = lineIndexOf(body, 'const probed = probeJumpProtocol();');
  assert.ok(probeLine > 0,
    '找不到 `const probed = probeJumpProtocol();`（源码结构变了，请更新本测试）');

  const guardedLine = body.slice(0, guardedCleanup).split('\n').length;
  for (let i = 0; i < lines.length; i++) {
    const ln = i + 1;
    // 只找**裸调用**（行首就是调用，不是 if (okReg) 包着的那种）
    if (!/^\s*cleanupLegacyProtocols\(\);/.test(lines[i])) continue;
    if (ln === guardedLine) continue; // 受 okReg 保护的，跳过
    assert.ok(ln > probeLine,
      `第 ${ln} 行有比 probeJumpProtocol()（第 ${probeLine} 行）更早的 cleanupLegacyProtocols() 裸调用 —— `
      + '那就是"先删老键再建新键"，新键一旦失败用户就两头落空（连唤窗都没了）');
  }
});

// ══ I9: 四个碰注册表的函数必须**全部**有测试守卫 ═════════════════════════════
//
// ## 为什么（v0.5.0 自查发现）
//
// 原本只有 `probeJumpProtocol` 和 `cleanupLegacyProtocols` 有
// `DSH_NOTIFY_NO_REGISTRY` / `__STUB_CHILD_PROCESS__` 守卫，
// **`registerJumpProtocol` 和 `unregisterJumpProtocol` 一个都没有**。
//
// 后果：测试里 probe 固定返回 'missing'，planProtocolSync 于是给 action='register'，
// 接着 register 就真的 `Set-ItemProperty HKCU:\Software\Classes\dshnotify-say` ——
// 单测会往开发者（乃至 CI）机器上写注册表。开关关着的测试则会真的删。
//
// 只给 cleanup 补守卫 = 只堵了一半。四个函数必须同一口径。
test('I9: probe/register/unregister/cleanup 四个函数都必须有测试守卫', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const SRC = readFileSync(join(ROOT_DIR, 'lib', 'index.js'), 'utf8');

  const fns = [
    'probeJumpProtocol',
    'registerJumpProtocol',
    'unregisterJumpProtocol',
    'cleanupLegacyProtocols',
  ];

  for (const fn of fns) {
    const at = SRC.indexOf(`function ${fn}(`);
    assert.ok(at > 0, `找不到 ${fn}（源码结构变了，请更新本测试）`);
    const body = SRC.slice(at, at + 1200);
    assert.match(body, /__STUB_CHILD_PROCESS__/,
      `${fn} 必须有 __STUB_CHILD_PROCESS__ 守卫 —— 否则走 loader 的测试会真的碰注册表`);
    assert.match(body, /DSH_NOTIFY_NO_REGISTRY/,
      `${fn} 必须有 DSH_NOTIFY_NO_REGISTRY 守卫 —— 否则单测会真的读写开发者机器注册表`);
  }
});
// ══ I7: 调用 apply() 的测试必须显式关闭注册表（防误删用户注册）════════════
//
// ## 为什么必须有这条（v0.5.0 实测踩到）
//
// v0.5.0 给 apply() 加了一条 `cleanupLegacyProtocols()`，它是**真实的
// Remove-Item HKCU\Software\Classes\dshnotify**。
//
// 而 `wiring.test.mjs` / `real-cordis.test.mjs` 会调 apply() 十几次，
// 原本只靠 `process.env.SystemRoot = 'Z:\__no_such_root__'` 让
// powershell.exe 路径失效 —— 那是"顺带没删成"，不是约定。
//
// 实测：把这个 SystemRoot 桩去掉（模拟有人改动它）再跑 wiring.test.mjs，
// 用户机器上真实的 `dshnotify` 键**当场被删**（已复现、已手动恢复）。
//
// 所以现在要求这两个文件必须显式设 DSH_NOTIFY_NO_REGISTRY=1。
test('I7: 调用 apply() 的测试必须显式关闭注册表访问', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join, resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const TEST_DIR = join(ROOT_DIR, 'test');

  const offenders = [];
  for (const name of readdirSync(TEST_DIR)) {
    if (!name.endsWith('.test.mjs')) continue;
    const src = readFileSync(join(TEST_DIR, name), 'utf8');
    // 只关心真正 import 了 index.js 并调 apply() 的文件
    // 动态 import('...') 与静态 from '...' 都要覆盖
    if (!/import\(\s*['"][^'"]*lib\/index\.js['"]\s*\)/.test(src)
        && !/from\s+['"][^'"]*lib\/index\.js['"]/.test(src)) continue;
    if (!/\bapply\(/.test(src)) continue;
    // 两种正当隔离，满足其一即可：
    //   ① DSH_NOTIFY_NO_REGISTRY=1 —— 插件内部所有注册表读写的共同开关
    //   ② __STUB_CHILD_PROCESS__ —— loader 把 child_process 整体换掉，
    //      PowerShell 根本起不来（audio-wiring / fail-route / toast-sound-channels
    //      走 --import route-loader-register.mjs 这条）
    // ⚠️ 必须匹配**真实赋值/真实条件**，不能只匹配关键词 ——
    // 注释里提到 DSH_NOTIFY_NO_REGISTRY 不算（本文件就提到了，会假绿）。
    const guarded = /process\.env\.DSH_NOTIFY_NO_REGISTRY\s*=\s*'1'/.test(src)
      || /globalThis\.__STUB_CHILD_PROCESS__\s*===\s*true/.test(src);
    if (!guarded) offenders.push(name);
  }

  assert.deepEqual(offenders, [],
    `这些测试调 apply() 却没关注册表访问，跑测试可能删掉用户真实的协议注册：\n`
    + offenders.map((f) => `  · test/${f}`).join('\n')
    + '\n修法：在 import 插件之前加 `process.env.DSH_NOTIFY_NO_REGISTRY = \'1\';`');
});
