/**
 * 自定义协议的所有权判定与清理决策（v0.4.83；v0.5.0 改判据）。
 *
 * ## 为什么单独一个文件
 *
 * 这段判定有三个真实的决策分支（是我们/不是我们/文件没了），
 * 而它原本埋在 `index.js` 的 `probeJumpProtocol()` 里，**依赖真实注册表**
 * 才能执行 —— 于是测试只能"复制一份逻辑"来验，那等于没验。
 *
 * 抽成纯函数后：
 *   · 输入是「注册表里读到的东西」+ 一个可注入的 `exists`
 *   · 输出只有四种状态之一
 *   · 测试可以覆盖全部分支，**不碰注册表、不碰文件系统**
 *
 * ## 四种状态
 *
 * ```
 * missing  —— 没注册（读不到命令值）
 * ok       —— 是我们的处理器，且文件存在
 * stale    —— 是我们的处理器，但文件已不存在（插件被删/换路径）
 * foreign  —— 键在，但指向别人的程序
 * ```
 *
 * `stale` 是「卸载后不留尾巴」的唯一判据 —— 只有它允许删除注册。
 *
 * ## v0.5.0：判据从「插件目录」改成「身份标记」
 *
 * 旧实现要求命令串里出现**本插件目录**（PLUGIN_ROOT）。这条判据的致命问题
 * 不是"不够优雅"，是**升级后永久坏掉**：
 *
 *   插件目录一改名（`dsh-notify-desktop` → `dsh-notify-say`），
 *   旧注册里的路径就与新目录对不上 → 判成 `foreign` →
 *   `planProtocolSync` 返回"不动它" → Toast 精准跳转**永久**退化为
 *   「只唤窗不跳会话」，而且用户关掉开关也修不好（foreign 分支连 unregister 都不做）。
 *
 * 而目录名本来就不能当身份：npm 上确实存在**别人的** `dsh-notify-desktop`
 * 包（author=paleech0，2026-10-17），所以"命令串里出现某个目录名"既不能
 * 证明是我们，也不能排除是别人。
 *
 * ⚠️ 关键事实：**命令串里没有协议名**。注册表项是
 * `HKCU\Software\Classes\<协议名>\shell\open\command`，协议词只出现在**键名**上，
 * 命令值里只有 `wscript.exe "…\jump-handler.vbs" "%1"`。所以"看命令串里有没有
 * 协议词"这条路根本不存在 —— 归属必须靠我们**自己写进键里的标记**。
 *
 * 现在的归属判据（从强到弱）：
 *   ① 键里的 `DSHNotifyOwner` 值 === `dsh-notify-say`  → 确定是我们的
 *   ② 命令串里出现我们的处理器文件名（`jump-handler.vbs|ps1`）→ 认作我们的
 *      （写标记前的旧版本 / 标记写失败的情形；下一次成功注册会补上标记）
 *   ③ 都不满足 → `foreign`，绝不碰
 *
 * 这样目录怎么搬都认得出，且删除动作仍然只在"有我们痕迹"时发生。
 */

/**
 * 本插件的身份标记值。写进注册表键的 `DSHNotifyOwner` 值里。
 *
 * 必须与 `package.json` 的 `name` 一致 —— 它是"这个协议键是谁建的"的唯一答案。
 */
export const OWNER_ID = 'dsh-notify-say';

/** 注册表里存标记用的值名。 */
export const OWNER_VALUE_NAME = 'DSHNotifyOwner';

/** 我们的处理器文件名（两个都认：vbs 是当前实现，ps1 是回退）。 */
const HANDLER_RE = /["']([^"']*jump-handler\.(?:vbs|ps1))["']/i;

/**
 * 解析出的 handler 路径是否落在**本插件目录**里（只读审查 B3）。
 *
 * ## 为什么需要
 *
 * 第一版只看文件名、不看目录，于是这个输入会被判成 `'ok'`：
 *     commandValue = '"C:\Windows\System32\wscript.exe" "D:\OtherApp\jump-handler.vbs" "%1"'
 *     ownerValue   = 无
 *     exists       = () => true
 * → 别人的 `D:\OtherApp\jump-handler.vbs` 恰好同名 → `'ok'`
 * → `planProtocolSync('ok', false)` = `{action:'unregister'}` → **删掉别人的键**。
 *
 * ## 规则
 *
 * 有身份标记时以标记为准（那是我们自己写的强信号），不因路径不同就否定它
 *（用户可能把插件装在别的盘，或用了 Junction/symlink）；
 * 无标记时才要求路径必须在本插件目录**内部**。
 *
 * @param {string} handlerPath 命令串里解析出的 handler 绝对路径
 * @param {string} pluginRoot  本插件根目录
 * @returns {boolean}
 */
export function isHandlerInPluginRoot(handlerPath, pluginRoot) {
  const p = String(handlerPath || '').trim();
  const root = String(pluginRoot || '').trim();
  if (!p || !root) return false;
  // 统一分隔符 + 忽略大小写（Windows 路径两边都可能出现 / 与 \）
  const norm = (s) => s.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const np = norm(p);
  const nr = norm(root);
  if (!np.startsWith(nr)) return false;
  // 必须落在目录**内部**（`<root>\jump-handler.vbs`），不能是 `<root>xxx`
  return np.length > nr.length && np[nr.length] === '\\';
}

/**
 * 判定一条协议注册属于谁、还能不能用。
 *
 * @param {{ commandValue?: string, ownerValue?: string }} reg
 *        `commandValue` = 键的默认值（`shell\open\command`），空表示没注册
 *        `ownerValue`   = 键里 `DSHNotifyOwner` 的值，空表示没有标记
 * @param {{ exists?: (p: string) => boolean, pluginRoot?: string }} [opts]
 *        `exists` 可注入；不提供则按「无法确认」处理。
 *        生产代码传 fs.existsSync；测试传假函数。
 *        `pluginRoot` 传本插件根目录 → 无标记时校验 handler 路径归属；
 *        不传则跳过目录校验（保持旧测试的输入形状）。
 * @returns {'missing'|'ok'|'stale'|'foreign'}
 */
export function classifyProtocolOwner(reg, opts = {}) {
  const commandValue = String((reg && reg.commandValue) || '').trim();
  const ownerValue = String((reg && reg.ownerValue) || '').trim();

  // 没命令值 = 没注册（键可能只建了个空壳，也当没注册处理）
  if (!commandValue) return 'missing';

  // ── ① 强信号：我们自己写的身份标记 ──────────────────────────────────
  const markerOk = ownerValue.toLowerCase() === OWNER_ID.toLowerCase();

  // ── ② 弱信号：命令串里有我们的处理器文件名 ──────────────────────────
  const handlerMatch = commandValue.match(HANDLER_RE);

  if (!markerOk && !handlerMatch) {
    // 既没有我们的标记，也没有我们的处理器 —— 别人的程序，绝不碰
    return 'foreign';
  }

  // 标记存在但不是我们的值 → 有人在用这个键，且明确写了另一个身份
  if (ownerValue && !markerOk) return 'foreign';

  // ── ②b 没有我们的标记时，handler 必须落在本插件目录内（B3）────────
  // 否则"别人目录下的同名 jump-handler.vbs"会被误判成我们的 → 误删。
  if (!markerOk && handlerMatch && opts.pluginRoot) {
    if (!isHandlerInPluginRoot(handlerMatch[1], opts.pluginRoot)) return 'foreign';
  }

  // 到这里：是我们的（标记命中，或标记缺失但有我们的 handler）
  if (!handlerMatch) {
    // 属于我们但解析不出 handler —— 状态可疑。
    // 按可清理处理：它指向的东西我们认不出来，留着也没用。
    return 'stale';
  }

  // ── ③ 处理器文件还在不在 ────────────────────────────────────────────
  const exists = opts.exists;
  if (typeof exists !== 'function') {
    // 拿不到判定手段时，**不冒险**：当作 ok（保留注册，不删）。
    // 理由：误删的代价（用户点 Toast 没反应）高于"多留一条注册"。
    return 'ok';
  }
  try {
    return exists(handlerMatch[1]) ? 'ok' : 'stale';
  } catch {
    return 'stale';
  }
}

/**
 * 给定当前状态与开关，决定该做什么。
 *
 * 抽出来是为了让「foreign 不能删」这条规则**可测且只有一处**。
 *
 * @param {'missing'|'ok'|'stale'|'foreign'} probed
 * @param {boolean} enabled  用户是否开启「点击通知跳转」
 * @returns {{ action: 'none'|'unregister'|'register'|'reuse', usable: boolean, downgrade?: boolean }}
 */
export function planProtocolSync(probed, enabled) {
  // 别人的东西一律不碰 —— 我们宁可自己降级，也不删别人写的值
  if (probed === 'foreign') {
    return { action: 'none', usable: false, downgrade: true };
  }

  if (!enabled) {
    // 只有确认是我们的（ok/stale）才清理
    if (probed === 'ok' || probed === 'stale') {
      return { action: 'unregister', usable: false };
    }
    return { action: 'none', usable: false };
  }

  if (probed === 'ok') {
    // 已经是我们的且文件在 —— 不重写注册表
    return { action: 'reuse', usable: true };
  }

  if (probed === 'stale') {
    // 失效注册：先清再建（这是"卸载后留尾巴"的自清理路径）
    return { action: 'register', usable: true, cleanupFirst: true };
  }

  return { action: 'register', usable: true };
}

/**
 * handler 路径的**父目录名**是否像本插件的目录（`dsh-notify-*`）。
 *
 * ## 为什么老键不能用 isHandlerInPluginRoot（重要）
 *
 * 老键（`dshnotify`）**正是**从旧目录名注册来的。本机真实现场就是：
 *     "E:\0Deepseek\tools\plugins\dsh-notify-desktop\jump-handler.vbs"
 * 而当前 PLUGIN_ROOT 是 `...\dsh-notify-say`（v0.4.88 改的名）。
 *
 * 如果对老键也要求"路径必须在当前 PLUGIN_ROOT 下"，这条真实的老键会被判
 * `foreign` → 永不清理 → **本次修复对真实用户完全失效**（而这正是要修的场景）。
 *
 * 所以老键改用**较宽但仍有约束**的判据：路径的某一级目录名以 `dsh-notify`
 * 开头。这样：
 *   · `...\dsh-notify-desktop\jump-handler.vbs`  ✓ 认（升级前现场）
 *   · `...\dsh-notify-say\jump-handler.vbs`      ✓ 认
 *   · `D:\OtherApp\jump-handler.vbs`             ✗ 不认（别人目录）
 *
 * @param {string} handlerPath
 * @returns {boolean}
 */
export function looksLikeOurPluginDir(handlerPath) {
  const p = String(handlerPath || '').trim();
  if (!p) return false;
  const parts = p.replace(/\//g, '\\').split('\\');
  // 最后一段是文件名，倒数第二段是插件目录名
  if (parts.length < 2) return false;
  const dirName = parts[parts.length - 2].toLowerCase();
  return dirName.startsWith('dsh-notify');
}

/**
 * 判断一条**历史协议**的注册键是否该被清掉（v0.5.0 迁移用）。
 *
 * 背景：v0.5.0 把协议名从 `dshnotify` 换成 `dshnotify-say`。升级后老键会
 * 残留在 HKCU —— 它多半还指着**旧版本**目录里的 jump-handler，能用但陈旧。
 * 两份注册双活会让"点通知到底走哪个脚本"取决于历史状态，很难排查，所以要清。
 *
 * ## 为什么这里可以宽松判断"是我们的"
 *
 * 老键名 `dshnotify` 是**我们独占过的**：那位同名 npm 作者
 * （paleech0 的 `dsh-notify-desktop`）根本不注册 Windows 协议
 * （已核对包全文，`URL Protocol` / `shell\open\command` 零命中）。
 * 所以只要那个键里的 handler 指向 `jump-handler.vbs|ps1`，就是历史遗留。
 *
 * ⚠️ 但**仍然要求**命令串里有我们的 handler 文件名：
 * 万一将来真有别的程序用了 `dshnotify` 这个词，我们不能因为键名像就删它。
 *
 * ## ⚠️ 标记存在时必须对齐（只读审查 B2 抓到，已修）
 *
 * 第一版只看 handler 文件名、完全无视 `ownerValue`，于是这个输入会判 true：
 *     { commandValue: '...wscript.exe" "D:\OtherApp\jump-handler.vbs" "%1"',
 *       ownerValue: 'some-other-plugin' }
 * 而同一输入 `classifyProtocolOwner` 判 `foreign`（绝不碰）—— 两个函数判据不一致，
 * 结果是"别人明确标了名、命令里恰好有同名 handler"的老键会被我们删掉。
 *
 * 现在对齐 `classifyProtocolOwner` 的规则：**标记存在但不是我们的值 → 一律不删**。
 * 注意方向：标记存在且**是**我们的值仍然判 true；老版本没有标记，靠文件名兜底。
 *
 * @param {{ commandValue?: string, ownerValue?: string }} reg 老协议键读到的东西
 * @param {{ pluginRoot?: string }} [opts] 传本插件根目录 → 无标记时校验 handler
 *        路径归属（与 classifyProtocolOwner 同口径，防止误删别人目录下的同名 handler）
 * @returns {boolean} true = 可以安全删除
 */
export function isLegacyRegistration(reg) {
  const commandValue = String((reg && reg.commandValue) || '').trim();
  if (!commandValue) return false;

  // 标记存在 → 必须是我们；别人的标记一律不碰（与 classifyProtocolOwner 同口径）
  const ownerValue = String((reg && reg.ownerValue) || '').trim();
  const markerOk = ownerValue.toLowerCase() === OWNER_ID.toLowerCase();
  if (ownerValue && !markerOk) return false;

  const handlerMatch = commandValue.match(HANDLER_RE);
  if (!handlerMatch) return false;

  // ⚠️ 这里**不能**用当前 PLUGIN_ROOT 校验：老键正是从旧目录名注册来的
  // （本机真实老键指向 `dsh-notify-desktop`，当前目录是 `dsh-notify-say`）。
  // 用当前目录校验会把真实老键判成"别人的"→ 永不清理 → 修复失效。
  // 改用"目录名像不像本插件"（`dsh-notify*`），既认旧目录也不误伤别人。
  return looksLikeOurPluginDir(handlerMatch[1]);
}
