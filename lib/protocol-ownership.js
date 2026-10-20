/**
 * 自定义协议的所有权判定（v0.4.83）。
 *
 * ## 为什么单独一个文件
 *
 * 这段判定有三个真实的决策分支（是我们/不是我们/文件没了），
 * 而它原本埋在 `index.js` 的 `probeJumpProtocol()` 里，**依赖真实注册表**
 * 才能执行 —— 于是测试只能"复制一份逻辑"来验，那等于没验。
 *
 * 抽成纯函数后：
 *   · 输入是命令串 + 插件根路径 + 一个 `exists` 判定（可注入）
 *   · 输出只有四种状态之一
 *   · 测试可以覆盖全部分支，**不碰注册表、不碰文件系统**
 *
 * ## 四种状态
 *
 * ```
 * missing  —— 没注册（空值）
 * ok       —— 是我们的处理器，且文件存在
 * stale    —— 是我们的处理器，但文件已不存在（插件被删/换路径）
 * foreign  —— 键在，但指向别人的程序
 * ```
 *
 * `stale` 是「卸载后不留尾巴」的唯一判据 —— 只有它允许删除注册。
 *
 * ## 为什么"只看文件名"不够
 *
 * 别的插件完全可能也叫 `jump-handler.vbs`。所以必须先确认
 * 命令串里出现的是**本插件的目录**，再看文件在不在。
 */

/** 我们的处理器文件名（两个都认：vbs 是当前实现，ps1 是回退）。 */
const HANDLER_RE = /["']([^"']*jump-handler\.(?:vbs|ps1))["']/i;

/**
 * 把路径规范成可比较的形式。
 * Windows 路径不区分大小写、斜杠可混用。
 *
 * @param {string} s
 * @returns {string}
 */
function normPath(s) {
  return String(s || '').replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
}

/**
 * 判定一条 `shell\open\command` 注册值属于谁、还能不能用。
 *
 * @param {string} commandValue 注册表里读到的命令串（空/undefined 表示没注册）
 * @param {string} pluginRoot   本插件的根目录（绝对路径）
 * @param {{ exists?: (p: string) => boolean }} [opts]
 *        `exists` 可注入，默认不提供则按「无法确认」处理。
 *        生产代码传 fs.existsSync；测试传假函数。
 * @returns {'missing'|'ok'|'stale'|'foreign'}
 */
export function classifyProtocolOwner(commandValue, pluginRoot, opts = {}) {
  const val = String(commandValue || '').trim();
  if (!val) return 'missing';

  // ① 归属：命令串里必须出现本插件目录
  const root = normPath(pluginRoot);
  if (!root || !normPath(val).includes(root)) {
    // 键存在但不是我们写的 —— 别人的程序，绝不碰
    return 'foreign';
  }

  // ② 解析出处理器路径
  const m = val.match(HANDLER_RE);
  if (!m) {
    // 属于我们目录但解析不出 handler —— 状态可疑。
    // 按可清理处理：它指向的东西我们认不出来，留着也没用。
    return 'stale';
  }

  // ③ 文件还在不在
  const exists = opts.exists;
  if (typeof exists !== 'function') {
    // 拿不到判定手段时，**不冒险**：当作 ok（保留注册，不删）。
    // 理由：误删的代价（用户点 Toast 没反应）高于"多留一条注册"。
    return 'ok';
  }
  try {
    return exists(m[1]) ? 'ok' : 'stale';
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
