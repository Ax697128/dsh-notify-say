/**
 * 给 ps1 用的「语音搜索区域」列表。
 *
 * ## 为什么需要这个函数（v0.4.39）
 *
 * 2026-10-18 外部审阅指出 `index.js` 里调用了不存在的 `regions()` ——
 * 于是 `voiceRootsArg()` 永远走 catch 返回空串，`if (roots)` 永远为假，
 * **`-VoiceRoot` 从来没传给过 ps1**。
 *
 * 后果：下载器装好的音色根本播不到，ps1 一直退回内置 `sounds/voice-lines`。
 * 而内置目录里也有 `ameharu-hau.wav` 这类文件（6 个），所以"听起来有声音"，
 * 但那不是用户下载的那 15 个 —— **功能断裂被掩盖了**。
 *
 * ## 目录布局（关键）
 *
 * ```
 * 用户目录（一音色一子目录）：
 *   %LOCALAPPDATA%/dsh-notify-say/voice-lines/
 *     ameharu-hau/
 *       ameharu-hau.wav          ← done 池直接放这里
 *       fail/ameharu-hau~1.wav   ← 子池在子目录
 *       TERMS.md
 *     另一个音色/
 *       ...
 *
 * 内置目录（平铺，247 个文件）：
 *   <plugin>/sounds/voice-lines/
 *     ameharu-hau.wav
 *     fail/ameharu-hau~1.wav
 * ```
 *
 * ps1 的 `Pick-RandomWavFromRoots` 只遍历**传入根的直属文件**
 * （`Get-ChildItem -LiteralPath $dir -File`），不会递归进子目录。
 *
 * 所以用户目录**不能**把 `voice-lines/` 整个传进去 —— 那里面全是子目录，
 * 一个 wav 都没有。必须把**每个音色的子目录**分别作为独立的根传过去。
 *
 * 内置目录本身就是平的，直接传 `voice-lines/` 就对了。
 *
 * ## 顺序
 *
 * 用户目录在前（用户下载的版本优先于内置），内置在后。
 * ps1 的 `Pick-RandomWavFromRoots` 会收集**所有**根的文件再随机取，
 * 所以顺序只影响「同名文件谁被选中」时的概率权重（实现上是全部收进池子
 * 再 Get-Random），实际效果是用户版本会与内置版本一起参与随机。
 *
 * ⚠️ 这是刻意保留的：用户装了某个音色后，内置的同名音色**仍然存在**，
 * 两者音质/内容可能不同。要"用户版本完全覆盖内置"需要 ps1 支持
 * 「同名时跳过后续根」，那是另一个改动，且会改变 `-Mode random` 的语义。
 * 当前行为（都参与）与 v0.4.30 之前一致，不引入新风险。
 *
 * @module lib/voice-regions.js
 */


// ⚠️ v0.4.42 第三轮审阅指出两处不一致（都属实）：
//
// 1. 这个模块原来自己实现了 userVoiceRoot()，只读 LOCALAPPDATA/APPDATA，
//    **忽略了 DSH_NOTIFY_SAY_DATA_DIR** —— 而下载器的 voice-pack-store.js
//    支持那个覆盖（便携模式、测试都用它）。
//    后果：装了却播不到（装到 override 目录，播放器却看 LOCALAPPDATA）。
//
// 2. 枚举子目录时只排除 `.` 开头的名字，但安装器用的是
//    `<key>.installing`（安装中）和 `<key>.bak-<时间戳>`（更新备份）——
//    它们不以 `.` 开头，会被当成音色参与播放，甚至在被写入时被选中。
//
// 所以现在：**目录规则只有一个来源** = voice-pack-store.js。
// 这里只做"把每个已装音色展开成 ps1 的搜索根"这件事。

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { userVoiceRoot, builtinVoiceRoot, installedVoiceKeys } from './voice-pack-store.js';

export { userVoiceRoot, builtinVoiceRoot };
/** 目录存在且真的是目录。 */
function isDir(p) {
  try {
    return !!p && existsSync(p) && statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 列出所有语音搜索区域（ps1 的「根」）。
 *
 * 每个返回项都是一个**直接包含 wav 文件**的目录（或其 `fail/` 等子池）。
 *
 * @param {string} pluginRoot 插件根目录
 * @returns {{ root: string, source: 'user'|'builtin', key?: string }[]}
 */
export function regions(pluginRoot) {
  const out = [];

  // ── 用户目录：每个**已装音色**子目录单独作为根 ─────────────────────
  //
  // 用 installedVoiceKeys() 而不是自己 readdir + 过滤：
  // 那个函数已经做了合法 key 校验（\w[\w-]*），天然排除
  // `<key>.installing`、`<key>.bak-<ts>` 这类临时目录 ——
  // 自己另写一套判断就是第二个真相源，必然漂移。
  const userRoot = userVoiceRoot();
  if (isDir(userRoot)) {
    let keys = [];
    try {
      keys = installedVoiceKeys();
    } catch { /* 读不到就当没有 */ }

    for (const key of keys) {
      out.push({ root: join(userRoot, key), source: 'user', key });
    }

    // 兼容：万一有人把 wav 直接平铺在 voice-lines/ 下（旧版布局），
    // 也把根本身加进来 —— 否则那些文件会突然播不到。
    try {
      const flat = readdirSync(userRoot).some((f) => f.toLowerCase().endsWith('.wav'));
      if (flat) out.push({ root: userRoot, source: 'user' });
    } catch { /* ignore */ }
  }
  // ── 内置目录：本身就是平的，直接作为根 ──────────────────────────────
  const builtin = builtinVoiceRoot(pluginRoot);
  if (isDir(builtin)) out.push({ root: builtin, source: 'builtin' });

  return out;
}

/**
 * 拼成 ps1 `-VoiceRoot` 要的分号分隔字符串。
 *
 * ps1 也接受逗号（`-split '[;,]'`），但路径里可能含逗号，用分号更安全。
 *
 * @param {string} pluginRoot
 * @returns {string} 空串表示没有任何可用目录
 */
export function voiceRootsArg(pluginRoot) {
  try {
    const roots = regions(pluginRoot)
      .map((r) => r.root)
      .filter(Boolean);
    // 去重（用户目录与内置目录理论上不会重复，但便宜）
    const seen = new Set();
    const uniq = [];
    for (const r of roots) {
      if (!seen.has(r)) { seen.add(r); uniq.push(r); }
    }
    return uniq.join(';');
  } catch {
    // 算不出来就让 ps1 走它自己的默认路径，不因为新逻辑影响播放
    return '';
  }
}


