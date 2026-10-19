/**
 * dsh-notify-desktop 的官方 Config schema（v0.4.0）。
 *
 * ## 为什么改成这个方案（而不是自建 settings UI）
 *
 * 原计划是「自建 client 半侧，用 `slots.register('settings.section', ...)` 画表单」。
 * 查证后放弃，改走官方机制，理由：
 *
 *   1. 官方支持：DSH 0.1.7+ 的 Loader **自动接管**插件导出的 `Config` schema，
 *      直接在设置页生成表单，不需要 `ctx.settings.register(...)`。
 *      本机实证（app.asar 内）：`isVolatilePath` ×13、`volatileForm` ×9、
 *      `has no volatile fields` ×2，报错文案
 *      `Plugin entry "${ns}" has no volatile fields` / `Config field "${path}" is not volatile`。
 *   2. 少依赖未文档化 API：`slots` 不在官方插件文档里（属逆向所得），
 *      历史上 `ctx.sessions.open` 就曾从 0.1.6→0.1.7 被**无声删除**，
 *      导致插件点击变静默空操作。而 `Config`/`.volatile()` 是明确契约，坏也是**响亮地坏**。
 *   3. 配置持久化由官方 `settings.mutate` 负责，不必自己维护
 *      `$DSH_HOME/storages/.../config.json`（少一个文件、少一处能写坏的地方）。
 *   4. 本机已有可用先例：`dsh-opencode-go` 的 `z.object(...volatile())` 写法实测工作。
 *
 * ## 硬契约（写错就整个设置页报废）
 *
 * ⚠️ **每个可编辑字段都必须 `.volatile()`**。DSH 用 `isVolatilePath` 门控写入：
 *    - 非 volatile 路径 → `Config field "<path>" is not volatile`
 *    - 一个 volatile 字段都没有 → `Plugin entry "<ns>" has no volatile fields`（表单直接不出现）
 *
 * ## 优先级（官方语义）
 *
 *   schema 默认值 → base（cordis.patch.yml 的 config）→ 用户层（设置页）
 *
 * 注意这**改变了原有语义**：以前 patch 是最终值；现在 patch 是 base，
 * 设置页写的值会覆盖它。对用户意味着「设置页改过之后，再改 YAML 不生效」——
 * 这是官方设计，需在 CARD 里写明。
 *
 * ## 依赖解析
 *
 * `@deepseek-ai/schemastery` 随宿主提供，但本插件是 `link:` 到源码目录的，
 * Node 会从**真实路径**（link 的目标目录）向上找，找不到 profile 的 node_modules。
 * 故用 `createRequire` 锚定到 `$DSH_HOME`（不硬编码盘符，换机可用）。
 */

import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 解析 `$DSH_HOME`（与官方插件同款取法：去尾部斜杠）。
 * @param {object} [env] 环境包，默认 `process.env`
 * @returns {string} 绝对路径；取不到时返回空串
 */
export function safeHome(env) {
  try {
    const src = env != null ? env : (typeof process !== 'undefined' ? process.env : undefined);
    const raw = src != null ? src.DSH_HOME : '';
    return typeof raw === 'string' && raw.length > 0 ? raw.replace(/[\\/]+$/, '') : '';
  } catch {
    return '';
  }
}

/**
 * 从 `$DSH_HOME` 侧加载 `@deepseek-ai/schemastery`。
 *
 * 依次尝试几个已知能解析到它的锚点（不同安装布局下 profile 位置不同）：
 *   1. `<DSH_HOME>/profiles/desktop/package.json`
 *   2. `<DSH_HOME>/profiles/package.json`
 *   3. `<DSH_HOME>/package.json`
 *
 * 全部失败时返回 `null`（调用方降级：不导出 Config，插件照常工作，
 * 只是设置页不出现——**绝不因此让插件加载失败**）。
 *
 * @param {object} [env]
 * @returns {object|null} schemastery 实例
 */
export function loadSchema(env, opts) {
  const log = opts && opts.log;
  const home = safeHome(env);
  if (!home) {
    if (log) log('$DSH_HOME 未设置，跳过 Config schema（设置页不出现，插件功能不受影响）');
    return null;
  }
  const anchors = [
    join(home, 'profiles', 'desktop', 'package.json'),
    join(home, 'profiles', 'package.json'),
    join(home, 'package.json'),
  ];
  for (const anchor of anchors) {
    if (!existsSync(anchor)) continue;
    try {
      const req = createRequire(anchor);
      const z = req('@deepseek-ai/schemastery');
      if (z && typeof z.object === 'function') return z.default || z;
    } catch {
      // 这个锚点不行，继续试下一个
    }
  }
  if (log) log('未能在 $DSH_HOME 侧解析 @deepseek-ai/schemastery，跳过 Config schema（插件功能不受影响）');
  return null;
}

/** 各字段的默认值（与 lib/index.js 的 DEFAULTS 保持一致，勿各写一份）。 */
export const FIELD_DEFAULTS = Object.freeze({
  voice: true,
  voiceMode: 'fixed',
  voiceName: 'zundamon-normal',
  volume: 80,
  notifyOnComplete: true,
  notifyOnError: true,
  /** v0.4.68：子代理会话出错是否提醒。默认开 —— 完成可以合并，错误不能合并掉。 */
  notifyOnSubagentError: true,
  notifyOnBlocked: true,
  /** v0.4.68：回合因 token 上限中断是否提醒。默认**开** —— 任务没完成，用户需要知道。 */
  notifyOnMaxTokens: true,
  notifyOnAborted: false,
  notifyOnApproval: true,
  notifyOnQuestion: true,
  subagents: false,
  idleGate: true,
  // ── v0.4.2：音源与 Toast ────────────────────────────────────────────────
  /** 音源：tts=系统语音合成（零下载）、bundled=已装语音包、system=系统提示音、custom=自定义文件、none=不发声 */
  audioSource: 'tts',
  /** 是否弹 Toast（关掉后只出声）。默认开。 */
  showToast: true,
  /** 后台完成时跳转到对应会话。默认开。 */
  jumpWhenBackground: true,
  /** 前台完成时也跳转。默认关（别在用户眼前乱跳）。 */
  jumpWhenForeground: false,
  /**
   * 多个会话都完成时跳哪个（v0.4.62）。
   *
   * earliest = 跳「离开期间最早完成」的那个。推荐，理由：
   *   你回来时往往仍停在那条会话上，对它 openSession 等于无操作 ——
   *   于是「当前会话不被打断」自动成立，而你最先错过的那个正好被带过去。
   * latest   = 最后完成的覆盖先完成的（v0.4.61 及更早的行为）。
   * none     = 多个时不跳，靠侧栏绿点自己一个个看。
   */
  multiJumpRule: 'earliest',
  /** TTS 发音人（留空=系统默认）。 */
  ttsVoice: '',
  /** TTS 语速 -10..10。 */
  ttsRate: 0,
  /** 开发期自热重载（改代码立即生效）。默认关，见 lib/dev-reload.js。 */
  devReload: false,
  // v0.4.34 日志分级。
  //
  // info（默认）= 只记元数据：事件类型、音源、成功失败、数量。
  // debug        = 额外记台词正文、Toast 标题与正文。
  //
  // 为什么默认不记内容：日志写在 %TEMP%，用户提 Issue 时经常直接上传，
  // 而标题/正文可能含项目名、人名 —— 对诊断「为什么不响」却没帮助。
  logLevel: 'info',
  // v0.4.7 冷却。
  //
  // ⚠️ 名字必须与 schema 字段**完全一致**（秒），不能写成 debounceMs/globalCooldownMs：
  // FIELD_DEFAULTS 的每个键都会对应一个 schema 字段（S2/S8 测试强制），
  // 用毫秒名会造出"有默认值但没有字段"的孤儿键，测试立刻报"字段不存在"。
  // index.js 的 normalizeConfig 负责秒→毫秒换算（debounceSeconds * 1000）。
  /** 同会话去抖：60 秒。0 = 关闭。 */
  debounceSeconds: 60,
  /** 跨会话冷却：0 = 关闭（默认保持"不同会话都会响"）。 */
  globalCooldownSeconds: 0,
  // v0.4.8：TTS 自定义台词。空串 = 用内置台词库（每种事件有 2~4 句随机）。
  ttsTextDone: '',
  ttsTextFail: '',
  ttsTextQuestion: '',
  ttsTextApproval: '',
  ttsTextBlocked: '',
  // v0.4.16：语音包数字增益。
  //
  // 为什么需要：实测 247 个语音包峰值 最小 24.7% / 中位 40.4% / 最大 84.4%，
  // 素材本身录得偏轻；而 Windows MCI 的音量上限只等于原始幅度 1.0 倍，
  // **无法超过**，所以 GUI 音量拉满也还是偏小。只能靠数字增益补。
  // 默认 2.0：把中位补到 ~80%，明显变响且不冒削波风险（按峰值自动限幅）。
  voiceGain: 2.0,
  // 自定义音频是否"标准化"到统一响度。
  // 默认关 —— 那是用户自己的素材，可能特意做得轻/响，不该擅自改。
  normalizeCustomAudio: false,
});

/**
 * 构造 `Config` schema。
 *
 * @param {object} z schemastery 实例
 * @returns {object} schemastery object schema
 */
export function buildConfig(z) {
  const fields = {
    // ── 语音（用户最常改的三项）──────────────────────────────────────────
    voice: z.boolean().default(FIELD_DEFAULTS.voice)
      .description('语音播报开关（关闭后只弹 Toast，不出声）'),
    voiceMode: z.union([z.const('fixed'), z.const('random')]).default(FIELD_DEFAULTS.voiceMode)
      .description('音色模式：fixed=固定用 voiceName；random=每次从语句池随机'),
    voiceName: z.string().pattern(/^\w[\w-]*$/).default(FIELD_DEFAULTS.voiceName)
      .description('固定音色 key（sounds/voice-lines/<key>~N.wav）'),
    volume: z.number().step(1).min(0).max(100).default(FIELD_DEFAULTS.volume)
      .description('音量 0-100（-1 跟随系统；MCI setaudio）'),

    // ── 事件开关 ─────────────────────────────────────────────────────────
    notifyOnComplete: z.boolean().default(FIELD_DEFAULTS.notifyOnComplete)
      .description('回合正常完成时提醒'),
    notifyOnError: z.boolean().default(FIELD_DEFAULTS.notifyOnError)
      .description('回合出错时提醒（播失败语音）'),
    notifyOnSubagentError: z.boolean().default(FIELD_DEFAULTS.notifyOnSubagentError)
      .description('子代理会话出错时也提醒（默认开：完成可以合并，错误不能静默）'),
    notifyOnBlocked: z.boolean().default(FIELD_DEFAULTS.notifyOnBlocked)
      .description('回合被拦截时提醒（蜂鸣，不播失败语音）'),
    notifyOnMaxTokens: z.boolean().default(FIELD_DEFAULTS.notifyOnMaxTokens)
      .description('回合因 token 上限中断时提醒（默认开：任务未完成）'),
    notifyOnAborted: z.boolean().default(FIELD_DEFAULTS.notifyOnAborted)
      .description('回合被中止/超长/中断时提醒（默认关闭）'),
    notifyOnApproval: z.boolean().default(FIELD_DEFAULTS.notifyOnApproval)
      .description('等待你批准操作时提醒'),
    notifyOnQuestion: z.boolean().default(FIELD_DEFAULTS.notifyOnQuestion)
      .description('向你提问时提醒'),

    // ── 行为 ─────────────────────────────────────────────────────────────
    subagents: z.boolean().default(FIELD_DEFAULTS.subagents)
      .description('子代理会话也提醒（默认只提醒主会话）'),
    idleGate: z.boolean().default(FIELD_DEFAULTS.idleGate)
      .description('等真正干完再提醒：有子代理/后台任务在跑时先不播「完成」，等全部结束再播一次'),

    // ── 音源（v0.4.2）────────────────────────────────────────────────────
    //
    // 默认 tts：**零下载也能说话**。这是发布时的核心卖点——
    // 不必带 48 MB 语音包，用户装完插件第一件事就能听到中文播报。
    audioSource: z.union([
      z.const('tts'), z.const('bundled'), z.const('system'), z.const('custom'), z.const('none'),
    ]).default(FIELD_DEFAULTS.audioSource)
      .description('声音来源：tts=系统语音合成（零下载）、bundled=已装语音包、'
        + 'system=系统提示音、custom=我指定的音频文件、none=不发声'),
    showToast: z.boolean().default(FIELD_DEFAULTS.showToast)
      .description('是否弹窗提示（关掉后只出声，不弹 Toast）'),
    ttsVoice: z.string().default(FIELD_DEFAULTS.ttsVoice)
      .description('语音合成的发音人（留空用系统默认；只列出本机可用的）'),
    ttsRate: z.number().step(1).min(-10).max(10).default(FIELD_DEFAULTS.ttsRate)
      .description('语音合成语速 -10..10（0 为正常）'),

    // ── 会话跳转（v0.4.2）────────────────────────────────────────────────
    //
    // 两个独立开关，组合出四种行为。交权给用户是因为诉求相反：
    // 有人想"回来就看到结果"，有人**故意不跳**，想自己按绿点逐个确认。
    jumpWhenBackground: z.boolean().default(FIELD_DEFAULTS.jumpWhenBackground)
      .description('在后台时收到完成提醒，回来后自动跳到那条会话'),
    jumpWhenForeground: z.boolean().default(FIELD_DEFAULTS.jumpWhenForeground)
      .description('窗口就在眼前时也跳过去（默认关，避免打断你正在看的会话）'),
    // ⚠️ schemastery 没有 z.enum —— 用 union+const（同类写法见 voiceMode）。
    multiJumpRule: z
      .union([z.const('earliest'), z.const('latest'), z.const('none')])
      .default(FIELD_DEFAULTS.multiJumpRule)
      .description('多个会话完成时跳哪个：earliest=最早错过的，latest=最后一个，none=都不跳'),

    // ── 开发开关（v0.4.3）─────────────────────────────────────────────────
    // 改代码后自动热重载，省去重启宿主。默认关：生产安装不会重写自己的文件，
    // 且它依赖 ctx.loader.internal 等非公开结构，DSH 升级可能失效。
    devReload: z.boolean().default(FIELD_DEFAULTS.devReload)
      .description('开发用：改插件代码后自动热重载（默认关）'),

    // ── 日志分级（v0.4.34）───────────────────────────────────────────
    //
    // info = 只记元数据（事件、音源、成败、数量）；
    // debug = 额外记台词正文与 Toast 标题正文。
    //
    // 为什么默认 info：日志写在 %TEMP%，用户提 Issue 时经常直接上传。
    // 那些内容可能含项目名、人名，但对诊断「为什么不响」没帮助。
    logLevel: z.union([z.const('info'), z.const('debug')]).default(FIELD_DEFAULTS.logLevel)
      .description('日志详细程度：info=只记元数据（默认），debug=含台词正文（可能敏感）'),

    // ── 冷却（v0.4.7）─────────────────────────────────────────────────────
    //
    // 两类人诉求相反，必须可调：
    //   · 每个结果都要听见 → 把同会话冷却调成 0
    //   · 听到一个就过来盯着了，再响就烦 → 打开跨会话冷却
    debounceSeconds: z.number().step(1).min(0).max(3600)
      .default(FIELD_DEFAULTS.debounceSeconds)
      .description('同一会话内两次提醒的最小间隔（秒）。0 = 关闭，每个结果都提醒'),
    globalCooldownSeconds: z.number().step(1).min(0).max(3600)
      .default(FIELD_DEFAULTS.globalCooldownSeconds)
      .description('跨会话冷却（秒）：任意会话提醒后，这段时间内其余会话不再出声。0 = 关闭（默认）'),

    // ── 音量增益（v0.4.16）───────────────────────────────────────────────
    //
    // 本包语音包峰值中位仅 40.4%，而 MCI 音量上限只有 1.0 倍、无法超过，
    // 所以"拉满仍偏轻"是素材特性，不是设置问题。默认 2.0 倍补齐。
    voiceGain: z.number().step(0.1).min(1.0).max(4.0)
      .default(FIELD_DEFAULTS.voiceGain)
      .description('语音包音量增益（1.0 = 原样，2.0 = 放大一倍）。'
        + '按峰值自动限幅，不会破音'),
    normalizeCustomAudio: z.boolean().default(FIELD_DEFAULTS.normalizeCustomAudio)
      .description('自定义音频也做音量标准化（默认关：尊重你原文件的响度）'),

    // ── TTS 自定义台词（v0.4.8）──────────────────────────────────────────
    //
    // 留空 = 用内置台词库（每种事件 2~4 句随机，避免听腻）。
    // 填了就用你写的这句，最多 60 字（念完约 5 秒）。
    ttsTextDone: z.string().max(60).default(FIELD_DEFAULTS.ttsTextDone)
      .description('「任务完成」时念的话（留空 = 用内置的几句随机）'),
    ttsTextFail: z.string().max(60).default(FIELD_DEFAULTS.ttsTextFail)
      .description('「任务失败」时念的话（留空 = 用内置的几句随机）'),
    ttsTextQuestion: z.string().max(60).default(FIELD_DEFAULTS.ttsTextQuestion)
      .description('「向你提问」时念的话（留空 = 用内置的几句随机）'),
    ttsTextApproval: z.string().max(60).default(FIELD_DEFAULTS.ttsTextApproval)
      .description('「待你批准」时念的话（留空 = 用内置的几句随机）'),
    ttsTextBlocked: z.string().max(60).default(FIELD_DEFAULTS.ttsTextBlocked)
      .description('「被拦截」时念的话（留空 = 用内置的几句随机）'),
  };

  // ── v0.4.9：每种音源的参数按事件覆盖 ──────────────────────────────────
  //
  // 这 25 个字段（5 事件 × 5 参数）**不进 GUI 主界面**（GUI 是我们自建卡片，
  // 不走 schemastery 表单），但必须在这里声明，原因有二：
  //   1. Loader 生成的「插件配置编辑器」里能看到并手改；
  //   2. config-store 的写入路径要求字段是 volatile（否则写不进去）。
  //
  // 空串一律表示"跟随全局"，所以默认值都是空。
  const KINDS = ['Done', 'Fail', 'Question', 'Approval', 'Blocked'];
  for (const k of KINDS) {
    fields['kindTtsVoice' + k] = z.string().max(120).default('')
      .description(`「${k}」用哪个朗读声音（留空 = 跟随全局）`);
    fields['kindTtsRate' + k] = z.number().step(1).min(-10).max(10).default(0)
      .description(`「${k}」的语速（0 = 跟随全局或正常）`);
    fields['kindVoiceMode' + k] = z.union([z.const(''), z.const('fixed'), z.const('random')]).default('')
      .description(`「${k}」的语音包音色模式（留空 = 跟随全局）`);
    // ⚠️ pattern 必须允许空串：空串表示"跟随全局"。
    // 若只写 /^\w[\w-]*$/，schemastery 会在 resolve 阶段对默认值 ''
    // 校验失败，整个 schema 报废（S3/S4 实测抓到）。
    fields['kindVoiceName' + k] = z.string().pattern(/^(\w[\w-]*)?$/).default('')
      .description(`「${k}」的语音包音色名（留空 = 跟随全局）`);
    fields['kindSystemSound' + k] = z.string().max(20).default('')
      .description(`「${k}」的系统提示音（Asterisk/Beep/Exclamation/Hand/Question，留空 = 按语义自动）`);
  }

  // 硬契约：每个字段都必须 volatile，否则设置页整块报废。
  // 用 map 而不是手写 12 次，避免新增字段时漏掉（漏了就是 has no volatile fields）。
  return z.object(Object.fromEntries(
    Object.entries(fields).map(([key, schema]) => [key, schema.volatile()]),
  ));
}

/**
 * 从 schema 化后的 config 读出普通值。
 *
 * 官方语义：`apply` 收到的 config 里每个字段是 schemastery 的 ref，
 * 要 `.get()` 才是实际值。同时兼容「已被 Loader 解析成普通对象」的情况。
 *
 * @param {object} config
 * @returns {object} 普通键值对
 */
export function readConfig(config) {
  const out = {};
  if (config == null || typeof config !== 'object') return { ...FIELD_DEFAULTS };
  for (const key of Object.keys(FIELD_DEFAULTS)) {
    const slot = config[key];
    if (slot != null && typeof slot === 'object' && typeof slot.get === 'function') {
      try { out[key] = slot.get(); } catch { out[key] = FIELD_DEFAULTS[key]; }
    } else if (slot !== undefined) {
      out[key] = slot;
    } else {
      out[key] = FIELD_DEFAULTS[key];
    }
  }
  return out;
}
