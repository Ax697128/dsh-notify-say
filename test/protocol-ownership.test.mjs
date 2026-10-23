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

// ══ 源码切片工具：按**真实函数边界**取函数体 ═══════════════════════════════
//
// ## 为什么不能用 `SRC.slice(at, at + 1200)`（只读审查 B3，2026-10-22 实测）
//
// 硬编码窗口是魔法数，和函数实际长度无关。实测（按闭合括号量的**函数体**长度）：
//   readProtocolRegistration 1572 > 窗口 1400
//   registerJumpProtocol     3246 > 窗口 1200
//   unregisterJumpProtocol   1083 < 窗口 1200
//   cleanupLegacyProtocols   1547 > 窗口  900
//   syncJumpProtocol         1652 > 窗口 1200
//   probeJumpProtocol         613 < 窗口 2000
//
// 也就是说 B3 不是「将来会坏」——**四个函数的旧窗口当时就已经小于函数体长了**，
// 守卫没被截掉纯属位置巧合（都在函数开头几行）。谁在前置加一段注释，
// 守卫就滑出窗口 → 静默变松（守护卫滑出去、而别处关键词滑进来），
// 或静默变红（守卫还在、但窗口截在它前面）。两种都是假信号。
//
// ## 做法
//
// 取 `function` 那一行**自己的缩进**，再按同一缩进取闭合括号。
// 顶层函数（0 空格，如 lib/client.js）与嵌套函数（2 空格，如 lib/index.js
// 里 apply() 内的那些）都适用。
// 找不到边界就 fail-closed 抛错 —— 宁可让测试红，也不要用一个猜出来的范围。
function functionBody(src, name) {
  const at = src.indexOf(`function ${name}(`);
  if (at < 0) throw new Error(`找不到函数 ${name}（源码结构变了，请更新本测试）`);

  // 取 `function` 那一行的缩进：lib/index.js 的内部函数都在 apply() 里（2 空格），
  // lib/client.js 的顶层函数是 0 空格。按同一缩进取闭合括号，两种源码都能用。
  const lineStart = src.lastIndexOf('\n', at) + 1;
  const indent = src.slice(lineStart, at); // 只含空格/Tab
  if (!/^[ \t]*$/.test(indent)) {
    throw new Error(`${name} 不在行首（源码结构变了，请更新本测试）`);
  }
  const end = src.indexOf(`\n${indent}}`, at);
  if (end < 0) throw new Error(`找不到 ${name} 的结束边界（源码结构变了，请更新本测试）`);
  return src.slice(at, end + indent.length + 2);
}

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
  // 用真实函数边界而不是 SRC.slice(at, at + 2000)：窗口是魔法数，
  // probeJumpProtocol 现在 613 字，但谁在前面加一段注释就可能滑出去。
  const probeBody = functionBody(SRC, 'probeJumpProtocol');
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
  const body = functionBody(SRC, 'readProtocolRegistration');

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
  const body = functionBody(SRC, 'cleanupLegacyProtocols');

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
// ## ⚠️ 第二版仍是假绿（只读审查 B1，2026-10-22 实测）
//
// 第二版按行号比大小：只要每个裸 cleanup 的行号都「晚于 probeLine」就算过。
// 但 `lib/index.js:1809` 的 `const probed = probeJumpProtocol();` 正是函数体
// **第 2 行** → probeLine 恒为 2 → 任何 cleanup 行号都 > 2 → 断言恒成立。
//
// 实测（复制整包到临时目录、注入后跑本文件）：
//   在 register 分支里、`registerJumpProtocol()` **之前**插一行裸
//   `cleanupLegacyProtocols();` → 35 pass / 0 fail，**依然全绿**。
// 而那正是 I8 注释自述要挡的「更糟的回归」。
//
// ## 现在的判据（白名单式，比大小 → 比归属）
//
// 不再问「它比谁早」，而是问「**它在哪个分支块里**」：
//   ① 三个分支块（unregister / reuse / register）的位置先解析出来；
//   ② 每一处 cleanup 调用必须**落在某个分支块内部** —— 落在函数顶层
//      （任何分支之外）就是「无条件先清」，直接红；
//   ③ register 块内部只允许 `if (okReg) cleanupLegacyProtocols();` 这一种形态，
//      裸调用一律红（注册可能失败，失败时必须保留老键）。
//
// 这样无论怎么调整语句顺序、加多少行注释，判据都不受影响。
function lineIndexOf(src, needle) {
  const at = src.indexOf(needle);
  if (at < 0) return -1;
  return src.slice(0, at).split('\n').length; // 1-based 行号
}

// ══ 代码区判据：把「字符串冒充代码」的假绿堵死 ══════════════════════════════
//
// ## 为什么需要（只读复核 R3，2026-10-22 实测，两处都是全绿）
//
// 只要判据是「在这行里能匹配到某段文本」，那**把真代码换成一段含同样文本的
// 字符串**就能同时满足判据和破坏行为：
//   · 把 reuse 分支的 `cleanupLegacyProtocols();` 换成
//     `appendNotifyLog('…cleanupLegacyProtocols();…')` → I8 仍数到 3 处；
//   · 把两条真守卫换成 `const _g = "__STUB_CHILD_PROCESS__ === true"` → I9 仍绿，
//     而测试会真的写开发者注册表。
//
// ## 判据
//
// `scanSource().masked` 里**字符串内容与注释一律是空格**，只有真代码非空格。
// 于是「匹配起点那一列在 masked 里是不是空格」就是最小充分判据：
// 起点在空格上 = 这段文本长在字符串/注释里，不是代码。
//
// 为什么只查**起点**而不是整段：跨行模板串会让整段覆盖多行，逐字符比对要跨行拼接；
// 起点足以区分「代码里的 `foo();`」与「字符串里的 `foo();`」，实测这条就够。
function isCodeAt(masked, lineIdx, col) {
  const row = masked[lineIdx];
  if (row == null) return false;
  const ch = row[col];
  return ch !== undefined && ch !== ' ';
}

/**
 * 在单行 `lines[lineIdx]` 上跑 `re`，只返回**起点落在代码区**的匹配。
 *
 * @returns {Array<{col:number, text:string}>}
 */
function codeMatchesOnLine(lines, masked, lineIdx, re) {
  const line = lines[lineIdx] || '';
  const out = [];
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const rx = new RegExp(re.source, flags);
  let m;
  while ((m = rx.exec(line)) !== null) {
    if (isCodeAt(masked, lineIdx, m.index)) out.push({ col: m.index, text: m[0] });
    if (m[0] === '') rx.lastIndex += 1;   // 防零宽匹配死循环
  }
  return out;
}

/** 在多行上跑同一个 `re`，只返回代码区匹配（`line` 为 1-based）。 */
function codeMatches(lines, masked, re) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    for (const m of codeMatchesOnLine(lines, masked, i, re)) out.push({ line: i + 1, ...m });
  }
  return out;
}

/**
 * 整行 trim 后匹配 `re`，且要求**首个非空列落在代码区**。
 *
 * 用于「这一行是不是一句真语句」这类判据（`if (v) foo();` / `if (v) {`）。
 *
 * 为什么不直接用 `codeMatchesOnLine`：那些正则都带 `^` 锚点，
 * 而 `masked` 保留了原始缩进 —— `^` 只能匹配到行首空格，永远匹配不上。
 * 取 `trim()` 丢掉缩进后，再用「首个非空列」去问 `masked` 是不是空格，
 * 就同时满足了「带锚点」与「必须是代码」两个要求。
 *
 * 反例（都实测过）：`appendNotifyLog('if (okReg) cleanup();')` 的
 * 首个非空列是 `a`（代码），但 trim 后不匹配带 `^if` 的正则 → 正确判否；
 * `'   if (okReg) cleanup();'`（整行是字符串内容）首个非空列在 masked 里是空格 → 判否。
 */
function statementInCode(lines, masked, lineIdx, re) {
  const line = lines[lineIdx] || '';
  const trimmed = line.trim();
  if (!re.test(trimmed)) return false;
  const firstCol = line.length - line.trimStart().length;
  return isCodeAt(masked, lineIdx, firstCol);
}

/**
 * 从 `if (...)` 那行开始，按花括号配对找出这个分支块的 [起, 止] 行号（1-based，含）。
 *
 * @param {string[]} masked    `scanSource().masked`（数括号用）
 * @param {string[]} lines     `scanSource().lines`（匹配头部用，字符串原文在）
 * @param {RegExp} headerRe    匹配 `if (...)` 头部的正则
 * @param {number} [withinLine]  可选：只要**包含这一行**的那个块。
 *   不给则返回第一个匹配的块。
 *
 * ## 为什么需要 withinLine（自测发现，2026-10-22 实测）
 *
 * 原实现用 `findIndex` 取**第一个**匹配的 `if (v) {`。源码里只要出现两个
 * 同条件的 if 块，就会认错块 → 假红：
 *
 *     if (okReg) { /* 标记 *​/ }          // ← 被 findIndex 选中
 *     if (okReg) {
 *       cleanupLegacyProtocols();          // ← 合法，却因为不在第一个块里被判「裸调用」
 *     }
 *
 * 实测该形态 34 pass / 1 fail。假红和假绿一样有害 —— 它训练人改测试让它变绿。
 * 所以「找哪个块」必须由**被检查的那一行**决定，而不是靠「第一个匹配」。
 *
 * ## 为什么 lines 与 masked 分开（2026-10-22 实测）
 *
 * headerRe 要匹配 `if (plan.action === 'unregister')`，字符串原文必须在；
 * 数括号又不能把字符串里的 `{` 算进去。所以两个数组各管一件事。
 *
 * ## 为什么开头也必须查代码区（只读复核 R3，2026-10-22 实测）
 *
 * 头部原先直接 `headerRe.test(lines[i])`，而 `lines` 里字符串原文还在。
 * 于是**一条恰好含有这段文本的日志**会被认成「分支头」：
 *
 *     appendNotifyLog(`if (plan.action === 'unregister') { cleanupLegacyProtocols(); }`);
 *
 * 这类日志会多认一个分支头，并从字符串行开始数括号 → 假红 35p/1f。
 * 现在改用 `codeMatchesOnLine`：匹配**起点必须在代码区**。
 * 注意不能简单地改用 `masked` 匹配 —— 头部本身含字符串字面量
 * （`=== 'unregister'`），masked 会把它抹空，那样一条都匹配不到。
 */
function branchRange(masked, lines, headerRe, withinLine) {
  const starts = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (codeMatchesOnLine(lines, masked, i, headerRe).length > 0) starts.push(i);
  }
  if (starts.length === 0) return null;

  const rangeOf = (start) => {
    const end = findBlockEnd(masked, start);
    return end < 0 ? null : [start + 1, end + 1];
  };

  if (withinLine == null) return rangeOf(starts[0]);

  // 只认**包含目标行**的那个块；有多个包含时取最靠后的起点（最贴近的块）。
  let best = null;
  for (const s of starts) {
    if (s + 1 > withinLine) continue;          // 块在目标行之后才开 → 不可能包含
    const r = rangeOf(s);
    if (r && withinLine >= r[0] && withinLine <= r[1]) best = r;
  }
  return best;
}

test('I8: cleanupLegacyProtocols 只能在「新键已可用」的分支里调用', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const SRC = readFileSync(join(ROOT_DIR, 'lib', 'index.js'), 'utf8');

  const rawBody = functionBody(SRC, 'syncJumpProtocol');
  // ⚠️ 必须用**剥掉注释**的行做扫描（只读审查 R2，2026-10-22 实测）：
  // 原先用原始行，把 reuse 分支的 `cleanupLegacyProtocols();` 注释掉
  // （行为消失、文本还在）→ ③ 照样数到 3 处 → I8 全绿。
  // 剥注释后这行不再计入，④ 的 `seen === 3` 就会红。
  const { lines, masked } = scanSource(rawBody);
  const body = lines.join('\n');

  // ── ① register 分支内部：先注册，再按结果决定是否清理 ──────────────────
  //
  // ⚠️ 不能用字面量匹配单个精确行（只读审查 R3，2026-10-22 实测）：
  // 原先断言 `if (okReg) cleanupLegacyProtocols();` 的**精确文本**，
  // 于是两种语义完全等价的合法重构都会假红：
  //   · `if (okReg) { cleanupLegacyProtocols(); }`（加花括号、拆多行）
  //   · 把变量 `okReg` 改名成 `registered`
  // 假红和假绿一样有害 —— 它训练人「改测试让它变绿」。
  //
  // 现在的判据是**语义**：先抓「哪个变量接住了 registerJumpProtocol() 的返回值」，
  // 再要求 register 分支里的 cleanup 受**那个变量**守卫。名字随便改都不影响。
  const regAssign = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*registerJumpProtocol\(\)\s*;/.exec(body);
  assert.ok(regAssign,
    '找不到 `const xxx = registerJumpProtocol();`（源码结构变了，请更新本测试）');
  const okVar = regAssign[1];
  const regCallLine = lineIndexOf(body, regAssign[0]);
  const escVar = okVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** 这个变量是否守卫了第 idx 行（0-based）的 cleanup 调用。 */
  function guardedByVar(idx, varName) {
    const esc = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // ⚠️ 两种形态都必须查**代码区**（只读复核 R3，2026-10-22 实测）：
    // 原先只看 `lines[idx].trim()` 能否匹配，于是字符串里的同名文本照样算数 ——
    // 一行 `appendNotifyLog('if (okReg) cleanupLegacyProtocols();')` 就算"受守卫"。
    // 现在用 `statementInCode`：整行 trim 后匹配，且**首个非空列必须在代码区**。
    //
    // 形态 A：同一行 `if (v) cleanupLegacyProtocols();`
    const formA = new RegExp(`^if\\s*\\(\\s*${esc}\\s*\\)\\s*cleanupLegacyProtocols\\s*\\(\\s*\\)\\s*;`);
    if (statementInCode(lines, masked, idx, formA)) return true;
    // 形态 B：包在 `if (v) { ... }` 块里 —— 往上找最近的 `if (v) {`，
    // 并且必须确认**这个块真的包含目标行**（不能只看「上面出现过」）。
    // ⚠️ 这里必须传 withinLine：源码里有两个同条件 if 块时，不传会认错块 → 假红。
    const formB = new RegExp(`^if\\s*\\(\\s*${esc}\\s*\\)\\s*\\{`);
    for (let j = idx - 1; j >= 0; j -= 1) {
      if (!statementInCode(lines, masked, j, formB)) continue;
      const r = branchRange(masked, lines, new RegExp(`^\\s*if\\s*\\(\\s*${esc}\\s*\\)\\s*\\{`), idx + 1);
      if (r && idx + 1 >= r[0] && idx + 1 <= r[1]) return true;
    }
    return false;
  }

  // ── ② 三个分支块的真实范围 ──────────────────────────────────────────────
  const ranges = {
    unregister: branchRange(masked, lines, /if \(plan\.action === 'unregister'\)/),
    reuse: branchRange(masked, lines, /if \(plan\.action === 'reuse'\)/),
    register: branchRange(masked, lines, /if \(plan\.action === 'register'\)/),
  };
  for (const [k, v] of Object.entries(ranges)) {
    assert.ok(v, `找不到 ${k} 分支块（源码结构变了，请更新本测试）`);
  }
  const inRange = (ln, [a, b]) => ln >= a && ln <= b;

  // ── ③ 每一处 cleanup 调用都必须落在某个分支块内 ─────────────────────────
  //
  // ⚠️ 必须是**代码区**的调用，不能用 `lines` 裸匹配（只读复核 R3，2026-10-22 实测）：
  // 把 reuse 分支的 `cleanupLegacyProtocols();` 换成
  // `appendNotifyLog('…cleanupLegacyProtocols();…')` —— 行为消失、文本还在 ——
  // 原实现照样数到 3 处 → **36p/0f 全绿**。现在走 `codeMatches`，
  // 匹配起点落在字符串里的一律不算。
  const CLEANUP_CALL_RE = /cleanupLegacyProtocols\s*\(\s*\)\s*;/;
  const calls = codeMatches(lines, masked, CLEANUP_CALL_RE);

  let seen = 0;
  let guardedInRegister = 0;
  for (const call of calls) {
    const ln = call.line;
    const i = ln - 1;
    seen++;
    const where = Object.entries(ranges).find(([, r]) => inRange(ln, r));
    assert.ok(where,
      `第 ${ln} 行的 cleanupLegacyProtocols() 不在任何分支块内：`
      + `「${lines[i].trim()}」—— 那是无条件先清老键。`
      + '新键一旦注册失败用户就两头落空（连唤窗都没了）');

    // register 分支里只允许受「注册结果」保护的那一种
    if (where[0] === 'register') {
      assert.ok(ln > regCallLine,
        `register 分支第 ${ln} 行的 cleanupLegacyProtocols() 排在 `
        + `第 ${regCallLine} 行 registerJumpProtocol() 之前 —— 还没注册就先清了`);
      assert.ok(guardedByVar(i, okVar),
        `register 分支第 ${ln} 行的 cleanupLegacyProtocols() 必须受 `
        + `«if (${escVar})» 守卫 —— 裸调用会在注册失败时也清掉老键。`
        + `「${lines[i].trim()}」`);
      guardedInRegister += 1;
    }
  }

  // ── ④ 防"整段被删掉后无人可查"────────────────────────────────────────
  assert.equal(seen, 3,
    `syncJumpProtocol 里应有且只有 3 处 cleanupLegacyProtocols() 调用`
    + `（unregister / reuse / register-success），实际 ${seen} 处。`
    + '少了 = 某条路径不再清老键；多了 = 出现了未经判定的新调用点。'
    + '（只数**代码区**的调用：写在字符串/注释里的同名文本不算，'
    + '否则「注释掉调用、留一段文本」就能冒充"还在清"）');
  assert.equal(guardedInRegister, 1,
    `register 分支里应有且只有 1 处受 ${escVar} 守卫的 cleanup，实际 ${guardedInRegister} 处`);
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
//
// ## ⚠️ 裸子串会假绿（只读审查 B2，2026-10-22 实测）
//
// 第一版断言的是 `/__STUB_CHILD_PROCESS__/` 与 `/DSH_NOTIFY_NO_REGISTRY/`。
// 「真守卫」和「注释里提一句关键词」对子串匹配是同一个信号。
// 实测（index.js 副本）：
//   删掉 register 的两条真守卫、只在旁边留一行
//   `// 这里原本有 __STUB_CHILD_PROCESS__ 和 DSH_NOTIFY_NO_REGISTRY 守卫`
//   → **I9 依然全绿**，而测试已经会真的写开发者的注册表。
//
// 现在要求匹配**守卫语句本身**（赋值/比较形态），且**必须在代码区**：
// 注释不可能满足（注释在 masked 里是空格），写在字符串里也不可能满足
// （字符串内容在 masked 里同样是空格）。
//
// ⚠️ 已删除 `stripComments`（只读复核 R3，2026-10-22 实测）：
// 它只去注释、**不动字符串**，于是 `const _g = "__STUB_CHILD_PROCESS__ === true";`
// 能同时骗过形态与位置断言 —— 36p/0f 全绿而测试会真写注册表。
// 判据只留 `scanSource` 一套口径，不再有第二套"去注释"实现。

/**
 * 词法扫描源码，产出两份**逐行等长**的数组（行号、列号都与原文一致）：
 *
 *   lines[i]   去掉注释，**字符串字面量原样保留**
 *              → 给正则匹配用（`if (plan.action === 'unregister')` 要能匹配到）
 *   masked[i]  去掉注释，且字符串/模板串的**内容抹成空格**
 *              → 给花括号计数用（`const m = "{";` 里的 `{` 不能算进深度）
 *
 * ## 为什么必须真词法扫描（2026-10-22 实测假红）
 *
 * 被扫的 `syncJumpProtocol` 里有跨行模板串：
 *     appendNotifyLog(
 *       `[jump-proto] 新键 ${JUMP_PROTOCOL}: 注册失败…`
 *       + `（${LEGACY_JUMP_PROTOCOLS.map((p) => p + '://').join(', ')}）—— `
 *       + '留着它用户至少还能跳，删了两头落空'
 *     );
 * 按字符裸扫 + 行尾复位 `'`/`"` 的实现，一进模板串就再也没出来（同一行后面的
 * `'://'` 被当成开了普通字符串），之后所有 `}` 都被当成字符串内容吞掉 →
 * 三个分支块全算成 [15,45]（函数末尾）→ I8 假红
 * 「register 分支里应有且只有 1 处受 okReg 守卫的 cleanup，实际 0 处」。
 *
 * 所以必须正确处理：模板串跨行、`${}` 嵌套（含嵌套里的字符串）、
 * 字符串里的转义、注释里的引号。这也是为什么不再手写第二套扫描。
 */
function scanSource(src) {
  const lines = [];   // 去注释，字符串原样
  const masked = [];  // 去注释，字符串内容抹空

  let line = '';
  let mask = '';

  const endLine = () => { lines.push(line); masked.push(mask); line = ''; mask = ''; };

  /** 代码字符：两边都保留。 */
  const keep = (ch) => {
    if (ch === '\n') { endLine(); return; }
    line += ch; mask += ch;
  };
  /** 字符串内容：`lines` 保留原文（正则需要），`masked` 抹空（括号不能算）。 */
  const hide = (ch) => {
    if (ch === '\n') { endLine(); return; }
    line += ch; mask += ' ';
  };
  /** 注释内容：两边都不算代码；`lines` 用空格占位以保住列号。 */
  const drop = (ch) => {
    if (ch === '\n') { endLine(); return; }
    line += ' '; mask += ' ';
  };

  // 模式栈，栈底是 code。元素：{m:'code'} | {m:'str',q} | {m:'tpl'} | {m:'expr',depth}
  // expr = 模板串 `${...}` 的表达式内部：按代码扫描，`}` 深度归零时弹回 tpl。
  const modes = [{ m: 'code' }];
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    const top = modes[modes.length - 1];

    // ── 普通字符串 ───────────────────────────────────────────────
    if (top.m === 'str') {
      if (ch === '\\' && src[i + 1] !== undefined) { hide(ch); hide(src[i + 1]); i += 2; continue; }
      if (ch === top.q) { hide(ch); modes.pop(); i += 1; continue; }
      if (ch === '\n') { hide(ch); modes.pop(); i += 1; continue; }  // 防呆：普通串不跨行
      hide(ch); i += 1; continue;
    }

    // ── 模板串 ───────────────────────────────────────────────────
    if (top.m === 'tpl') {
      if (ch === '\\' && src[i + 1] !== undefined) { hide(ch); hide(src[i + 1]); i += 2; continue; }
      if (ch === '`') { hide(ch); modes.pop(); i += 1; continue; }
      if (ch === '$' && src[i + 1] === '{') {
        hide(ch); hide('{');
        modes.push({ m: 'expr', depth: 0 });
        i += 2; continue;
      }
      hide(ch); i += 1; continue;   // 允许跨行
    }

    // ── ${...} 内部：} 归零则回到 tpl ─────────────────────────────
    if (top.m === 'expr') {
      if (ch === '{') { top.depth += 1; keep(ch); i += 1; continue; }
      if (ch === '}') {
        if (top.depth === 0) { hide(ch); modes.pop(); i += 1; continue; }
        top.depth -= 1; keep(ch); i += 1; continue;
      }
    }

    // ── 注释 ─────────────────────────────────────────────────────
    if (ch === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') { drop(src[i]); i += 1; }
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      drop('/'); drop('*'); i += 2;
      while (i < src.length) {
        if (src[i] === '*' && src[i + 1] === '/') { drop('*'); drop('/'); i += 2; break; }
        drop(src[i]); i += 1;
      }
      continue;
    }

    // ── 开串 ─────────────────────────────────────────────────────
    if (ch === "'" || ch === '"') { hide(ch); modes.push({ m: 'str', q: ch }); i += 1; continue; }
    if (ch === '`') { hide(ch); modes.push({ m: 'tpl' }); i += 1; continue; }

    keep(ch); i += 1;
  }

  endLine();
  return { lines, masked };
}

/**
 * 找出 `masked` 里的**正则字面量**，返回 `{line, col, text}`（`line` 1-based）。
 *
 * ## 为什么需要（只读复核 R3，2026-10-22 实测）
 *
 * I10 原先只查「含 `\{` 或 `\}` 的正则」，于是下面这条完整绕过它：
 *     在 `if (okReg) {` 里塞 `const _re = /{/;`   ← 无转义，检查不到
 *     再把块撑到函数末尾，并在文件别处插 `const _c = /}/;` 补平括号
 *   → 整文件级配平仍然通过，而「块外裸调 cleanup」会被算成「受 okReg 守卫」，
 *     I8 的主判据整体旁路，**36p/0f 全绿**。
 * `/[{}]/`、`/[({]/` 这类字符类写法同样不在原检查面内。
 *
 * ## 判别方式（标准 JS 词法启发式）
 *
 * 正则字面量只能出现在「表达式起始」位置，即前一个非空字符是
 * `( , = : [ ! & | ? { } ;` 之一或行首；而 `/` 作为除号时前面是
 * 标识符、数字、`)`、`]`、字符串结尾。据此在本仓代码上无误判（已实测）。
 *
 * 只认**同一行闭合**的字面量：跨行正则里出现花括号的情况本仓不存在，
 * 漏检会由 I10 的「按函数体配平」兜住（正则撑歪括号 → 该函数体配不平）。
 */
function findRegexLiterals(masked) {
  const out = [];
  const BEFORE = /[(,=:[!&|?{};]/;   // 允许出现在正则左侧的字符
  for (let i = 0; i < masked.length; i += 1) {
    const line = masked[i] || '';
    for (let k = 0; k < line.length; k += 1) {
      if (line[k] !== '/') continue;
      if (line[k + 1] === '/' || line[k + 1] === '*') continue;  // 注释已被 scanSource 剥掉，防御性跳过
      // 前一个非空字符
      let p = k - 1;
      while (p >= 0 && line[p] === ' ') p -= 1;
      const atExpressionStart = p < 0 || BEFORE.test(line[p]);
      if (!atExpressionStart) continue;
      // 同一行内找闭合的 `/`（跳过转义与字符类）
      let q = k + 1;
      let inClass = false;
      let closed = -1;
      while (q < line.length) {
        const ch = line[q];
        if (ch === '\\') { q += 2; continue; }
        if (ch === '[') { inClass = true; q += 1; continue; }
        if (ch === ']') { inClass = false; q += 1; continue; }
        if (ch === '/' && !inClass) { closed = q; break; }
        q += 1;
      }
      if (closed < 0) continue;   // 跨行正则：不在此处判定，交给配平自检兜底
      out.push({ line: i + 1, col: k, text: line.slice(k, closed + 1) });
      k = closed;
    }
  }
  return out;
}

/**
 * 自检：`scanSource` 的两条硬保证 —— 逐行等长、括号配平。
 *
 * 为什么要在**生产测试里**做这个（2026-10-22 自查发现）：
 *
 * `scanSource` 是手写状态机，它不认识**正则字面量**。实测：
 *     const re = /\{/;   →  masked 里多出一个 `{`
 *     const re = /}/;    →  masked 里多出一个 `}`
 *     const re = /["']/; →  引号被当成开串，**整行后半截被抹空**
 * 前两种会让某个块的结束行算错 → 判据指向错误位置；第三种更糟，会把紧随其后的
 * 代码一起吞掉。行注释 `// foo({` 不受影响（注释先被识别）。
 *
 * 现在被扫的 5 个函数里**一个正则字面量都没有**（已实测），所以当前无误判。
 * 但这是个静默陷阱：将来有人在这些函数里写 `/^\{/`，判据会悄悄失准而不报错。
 * 所以这里把它变成**显式断言**：
 *   ① 两份数组必须逐行等长、且与原文同长（否则 code.slice(0,k) 取错列）
 *   ② 剥出来的代码里 `{` 与 `}` 必须配平（否则说明有字面量/正则被误算）
 *   ③ 被扫的函数体里不许出现**任何**含花括号的正则字面量 ——
 *      不论转义形态（`/\{/`）还是字符类形态（`/[{}]/`）
 *   ④ **每个函数体各自配平**（不只整文件配平）—— 见 findRegexLiterals 里的
 *      绕过实例：一处多算 `{`、别处补一个 `}`，整文件级看不出来
 * —— 一旦有人踩到，测试会红并直接告诉他原因，而不是等到判据莫名其妙地假红。
 */
test('I10: scanSource 自检（逐行等长 / 逐函数体配平 / 无含花括号正则）', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

  const SCANNED_FNS = ['probeJumpProtocol', 'registerJumpProtocol', 'unregisterJumpProtocol',
    'cleanupLegacyProtocols', 'syncJumpProtocol'];

  for (const rel of [['lib', 'index.js'], ['lib', 'client.js']]) {
    const src = readFileSync(join(ROOT_DIR, ...rel), 'utf8');
    const rawLines = src.split('\n');
    const { lines, masked } = scanSource(src);
    const name = rel.join('/');

    assert.equal(lines.length, rawLines.length,
      `${name}: scanSource 产出的行数必须与原文一致（换行不能被吞）`);
    assert.equal(masked.length, lines.length,
      `${name}: lines 与 masked 必须逐行等长`);

    for (let i = 0; i < rawLines.length; i += 1) {
      assert.equal(masked[i].length, lines[i].length,
        `${name}:${i + 1} 行 masked 与 lines 长度不等 —— 列号会错位，head 会取错`);
      assert.equal(lines[i].length, rawLines[i].length,
        `${name}:${i + 1} 行 lines 与原文长度不等 —— 行号会错位`);
    }

    // 括号配平：整文件级别的粗校验，能抓到「某个字面量里的括号被算进深度」
    const stripped = masked.join('\n').replace(/[^{}]/g, '');
    const open = (stripped.match(/\{/g) || []).length;
    const close = (stripped.match(/\}/g) || []).length;
    assert.equal(open, close,
      `${name}: 剥出的代码里 { (${open}) 与 } (${close}) 不配平 —— `
      + '说明有字符串/正则里的花括号被当成了代码括号。');

    // ③ + ④ 逐函数体：括号必须配平，且不许出现含花括号的正则字面量
    for (const fn of SCANNED_FNS) {
      const at = src.indexOf(`function ${fn}(`);
      if (at < 0) continue;   // 函数没了由 I8/I9 报，这里不管
      const body = functionBody(src, fn);
      const scanned = scanSource(body);

      const braces = scanned.masked.join('\n').replace(/[^{}]/g, '');
      const o = (braces.match(/\{/g) || []).length;
      const c = (braces.match(/\}/g) || []).length;
      assert.equal(o, c,
        `${fn} 的函数体自身括号不配平（{ ${o} / } ${c}）—— `
        + '这会让「找块边界」整段失准。\n'
        + '常见原因：函数里有含花括号的正则字面量（scanSource 不识别正则）。\n'
        + '修法：改用 new RegExp(\'\\\\{\') / new RegExp(\'}\')，或给 scanSource 补正则识别。');

      const bad = findRegexLiterals(scanned.masked)
        .filter((r) => /[{}]/.test(r.text));
      assert.deepEqual(bad, [],
        `${fn} 里出现了含花括号的正则字面量，scanSource 会把它们算进块深度：\n`
        + bad.map((r) => `  · 第 ${r.line} 行：${r.text}`).join('\n') + '\n'
        + '这会让 I8/I9 的块边界静默失准 —— 实测 `/ {/`（无转义）配合别处补一个 `/ }/` '
        + '可以整体旁路 I8 判据而仍然全绿。\n'
        + '修法二选一：① 改用 new RegExp(\'\\\\{\')；② 给 scanSource 补上正则字面量的识别。');
    }
  }
});

/**
 * 按花括号配对维护一个「开启块」栈，扫描 `masked` 里 [起, 止列] 这段。
 *
 * @param {string[]} masked   `scanSource().masked`（字符串内容已抹空）
 * @param {number} limitLine  扫到第几行（0-based，含）
 * @param {number} limitCol   limitLine 上扫到第几列（不含）
 * @returns {Array<{line:number, head:string}>} 未闭合块的栈
 *
 * ⚠️ 只接受 `masked`，不接受原始行 —— 见 scanSource 的注释：
 * 拿含字符串原文的行去数括号，会被 `const m = "{";` 或跨行模板串撑歪。
 */
function scanBlockOpeners(masked, limitLine, limitCol) {
  const openers = [];   // 栈：{ line, head }
  for (let i = 0; i <= limitLine; i += 1) {
    const code = masked[i] || '';
    const end = (i === limitLine) ? limitCol : code.length;
    for (let k = 0; k < end; k += 1) {
      const ch = code[k];
      if (ch === '{') openers.push({ line: i, head: code.slice(0, k + 1).trim() });
      else if (ch === '}') openers.pop();
    }
  }
  return openers;
}

/**
 * 从 `start` 行（0-based）开始，按花括号配对找出这个块的**结束行**（0-based，含）。
 * 找不到（文件里括号不配对）时返回 -1。
 *
 * @param {string[]} masked  `scanSource().masked`
 */
function findBlockEnd(masked, start) {
  let depth = 0;
  let opened = false;
  for (let i = start; i < masked.length; i += 1) {
    for (const ch of masked[i] || '') {
      if (ch === '{') { depth += 1; opened = true; } else if (ch === '}') depth -= 1;
    }
    if (opened && depth === 0) return i;
  }
  return -1;
}

/**
 * 这一行是否处在「函数体顶层」或「函数体顶层 try 块」里 —— 而不是嵌在
 * 别的 `if` / `while` / 回调里。
 *
 * ## 为什么需要（只读审查 R1 补充，2026-10-22 实测）
 *
 * 只查「守卫语句存在 + 排在效果语句之前」还会漏一种：把守卫塞进永不执行的分支
 *   `if (false) { <两条守卫> }`
 * —— 形态合规、行号也在效果之前，但守卫根本不执行，测试照样真的写注册表。
 * 实测该变异 **35p/0f 全绿**。
 *
 * 判据：从文件头一直扫到「守卫关键词所在的那一列（不含）」，
 * 最内层开启块的 head 必须是 `try {` 或函数声明行。
 * head 截到 `{` 为止，所以守卫与函数声明压在同一行时也不会被误杀。
 *
 * @param {string[]} masked  `scanSource().masked`
 */
function isTopLevelInFunction(masked, idx0, colOfGuard) {
  const limitCol = Number.isFinite(colOfGuard) ? colOfGuard : (masked[idx0] || '').length;
  const openers = scanBlockOpeners(masked, idx0, limitCol);
  if (openers.length === 0) return false;
  const inner = openers[openers.length - 1].head;
  // 顶层 try 块
  if (/^try\s*\{$/.test(inner)) return true;
  // 函数体本身：head 形如 `function foo() {` / `export function foo(a, b) {`
  // / `async function foo() {`
  if (/^(?:export\s+)?(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{$/.test(inner)) return true;
  return false;
}

/** 真正的守卫语句：把 `__STUB_CHILD_PROCESS__` / `DSH_NOTIFY_NO_REGISTRY` 当**条件**用。 */
//
// ⚠️ 只匹配「形态」还是不够（只读审查 R1，2026-10-22 实测）：
// 把 register 的两条守卫整体挪到**写注册表之后** —— 形态完全合规、
// 但已经守卫不了任何东西 —— I9 仍然 35p/0f 全绿。
// 所以位置也要查，见下面 I9 的 ④。
const STUB_GUARD_RE = /__STUB_CHILD_PROCESS__\s*===\s*true/;
const NOREG_GUARD_RE = /process\.env\.DSH_NOTIFY_NO_REGISTRY\s*===\s*['"]1['"]/;

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

  // ⚠️ ④ 位置判据（只读审查 R1，2026-10-22 实测）：
  // 光验「守卫语句存在且形态对」会 fail-open —— 把两条守卫整体**挪到
  // 写注册表之后**，形态完全合规、但已经守卫不了任何东西，仍然全绿。
  // 所以还要查：**每一条**碰注册表的语句都必须排在**最后一条守卫之后**。
  //
  // 「碰注册表」= 读/写/删三类的真实调用或命令串。宁可多列几个锚点，
  // 也不要漏 —— 判据方向是"我认识的必须都被挡住"，认不出来的新写法
  // 会被 fns 清单和 I8 的白名单分别兜一层。
  const REGISTRY_EFFECTS = [
    { re: /readProtocolRegistration\s*\(/, what: 'readProtocolRegistration()（读注册表）' },
    { re: /\bexecFileSync\s*\(/, what: 'execFileSync()（起 PowerShell 读写注册表）' },
    { re: /Remove-Item/, what: 'Remove-Item（删注册表键）' },
    { re: /Set-ItemProperty/, what: 'Set-ItemProperty（写注册表键）' },
    { re: /New-Item /, what: 'New-Item（建注册表键）' },
  ];

  for (const fn of fns) {
    const at = SRC.indexOf(`function ${fn}(`);
    assert.ok(at > 0, `找不到 ${fn}（源码结构变了，请更新本测试）`);
    const src = functionBody(SRC, fn);

    // ⚠️ 不再用 `stripComments` 的纯文本匹配（只读复核 R3，2026-10-22 实测）：
    // `stripComments` 只去注释、**不动字符串**，于是把两条真守卫整体换成
    //   const _g = "__STUB_CHILD_PROCESS__ === true";
    // 就能同时骗过形态断言与位置断言 —— **36p/0f 全绿**，而测试会真的写注册表。
    // 现在统一走 `scanSource`：`masked` 里字符串与注释都是空格，
    // 只有真代码非空格；`codeMatches` 只认起点在代码区的匹配。
    const scanned = scanSource(src);     // 按行剥注释，行号不变
    const code = scanned.lines;
    const masked = scanned.masked;

    const guardHits = (gre) => codeMatches(code, masked, gre);

    assert.ok(guardHits(STUB_GUARD_RE).length > 0,
      `${fn} 必须有 «__STUB_CHILD_PROCESS__ === true» 守卫 —— `
      + '否则走 loader 的测试会真的碰注册表。'
      + '（判据是**代码区**的守卫语句本身；写在注释或字符串里都不算）');
    assert.ok(guardHits(NOREG_GUARD_RE).length > 0,
      `${fn} 必须有 «process.env.DSH_NOTIFY_NO_REGISTRY === "1"» 守卫 —— `
      + '否则单测会真的读写开发者机器注册表。'
      + '（判据是**代码区**的守卫语句本身；写在注释或字符串里都不算）');

    // ④ 位置：守卫必须**排在所有碰注册表的语句之前**
    const idxOf = (gre) => {
      const hits = guardHits(gre);
      return hits.length > 0 ? hits[hits.length - 1].line : -1;
    };
    const lastGuard = Math.max(idxOf(STUB_GUARD_RE), idxOf(NOREG_GUARD_RE));
    assert.ok(lastGuard > 0, `${fn} 找不到守卫所在行（不该发生，上一步已匹配到）`);

    // ⑤ 守卫必须**真的会执行**：不能塞在 if/while/回调里（R1 补充，实测）
    for (const gre of [STUB_GUARD_RE, NOREG_GUARD_RE]) {
      for (const hit of guardHits(gre)) {
        const gLine = hit.line;
        assert.ok(isTopLevelInFunction(masked, gLine - 1, hit.col),
          `${fn} 第 ${gLine} 行的守卫不在函数体顶层（或顶层 try 的顶层）—— `
          + '它被包在别的条件/回调里，可能永远不执行。'
          + `「${code[gLine - 1].trim()}」\n`
          + '实测反例：`if (false) { <两条守卫> }` 形态合规、行号也够早，'
          + '但守卫不执行，测试照样真的写注册表。');
      }
    }

    for (const eff of REGISTRY_EFFECTS) {
      const hits = codeMatches(code, masked, eff.re);
      if (hits.length === 0) continue;
      const effLine = hits[0].line;
      assert.ok(effLine > lastGuard,
        `${fn} 的「${eff.what}」在第 ${effLine} 行，`
        + `但守卫在第 ${lastGuard} 行之后才结束 —— 守卫形同虚设。\n`
        + '守卫必须写在**任何**碰注册表的语句之前，'
        + '否则测试会真的读写开发者（乃至 CI）机器的注册表。');
    }
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
