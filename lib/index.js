/**
 * dsh-notify-say — Host half（官方插件规范形态）。
 *
 * 证据基础（0.1.7-rc.2 app.asar 一手抽取，均存 scratch/asar-extract/）：
 *  - 导出形态：references/host-plugin.md「Host plugin export forms」——
 *    `export function apply(ctx, config) {}`，资源用 ctx.effect/ctx.on 注册。
 *  - 事件：@deepseek-ai/dsh-agent-preset-registry/lib/typert.host.js SessionEventMap（:647）——
 *      'turn/end': { turn: number; reason: TurnEndReason }（turn 是数字序号，不是对象）
 *      TurnEndReasonMap（:803）：completed / aborted / blocked / error / max-tokens /
 *      interrupted / forked，均为 { kind: ... } 对象 → 用 reason.kind 判分支。
 *      'approval/asked': { id, toolName, callId?, reason? }
 *      'approval/decided': { id, outcome }            （审批审计事件对）
 *    SessionHeader（:655）：parentSession? / origin?: 'subagent' / delegationDepth? → 子代判定。
 *  - 审批接缝：@deepseek-ai/dsh-user-approval/lib/index.js:176 —— approval/request 是
 *    waterfall，fail-closed 默认（无应答者 → 'unavailable'）。本插件 listener 必须
 *    return next() 并透传返回值，绝不阻断、不改写决定。
 *  - 事件消费方式：SessionEventMap 事件经 session/event 流观测（旧 dsh-notify-done 在
 *    同源 Cordis 事件系统上实证的做法；practices.md 亦把 session/event 订阅与
 *    sessionProjections 并列为观测手段）。turn/end 不是独立 ctx 事件名。
 *
 * 行为（v1 规格，见 CARD.md）：
 *  - F1 回合完成：仅 reason.kind==='completed' 播「完成」；error/blocked 换文案 +
 *    系统蜂鸣（无对应语句池资产，不播"完成"语音以免误导）；aborted/max-tokens/
 *    interrupted/forked 默认静默（notifyOnAborted）。按会话去抖（默认 60s）。
 *  - F2 审批：监听 approval/request waterfall（放行 + 提醒）与 approval/asked/
 *    approval/decided 审计对（幂等 + 对账：同一 id 只提醒一次，decided 后清除，
 *    连串审批按同会话同工具去抖，默认 15s）。替代旧插件的手工 pending 缓存。
 *  - F3 语音/Toast：spawn 本包自带 dsh-notify.ps1（fire-and-forget，带并发上限 +
 *    超时强杀，沿用旧插件加固逻辑）。
 *  - F4：无 client 半侧（references 无文档明载 client↔host 通道），Toast 按钮走
 *    官方 dsh://open 仅唤起窗口。
 *
 * 不做的事：不注册 Config schema（references 未给出 `export const Config` 的
 * schema 方言，臆造有激活失败风险）；config 只在本函数规范化，改配置 = 改
 * profile 补丁层的行 config 后重启/重载（practices.md 的推荐落点）。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * v0.3.0「空闲门（idle gate）」——修正误报（用户 2026-10-16 反馈）
 * ───────────────────────────────────────────────────────────────────────────
 * 问题：主会话这一轮跑完（turn/end completed）时，它派生的子代理或后台任务
 * 可能**仍在运行**；旧实现只看 reason.kind，于是弹出"任务完成"误导用户。
 *
 * 根因：`turn/end completed` 的语义是「这一轮对话跑完了」，不是「整个工作树空闲了」。
 *
 * 本机一手证据（0.1.7-rc.2 `.runtime` 源码）：
 *  - ctx.jobs（@deepseek-ai/dsh-jobs Service Definition）：
 *      list(caller) → JobSnapshot[]，status ∈ running|stopping|completed|killed|failed
 *        （dsh-jobs-local/lib/index.js:178）
 *      onJobsChanged(listener) → 可见集变化时回调，返回 disposer（同上 :264）
 *  - ctx.agents（@deepseek-ai/dsh-agent AgentRegistry）：
 *      list() → 全部活 agent；get(id)；isOwnedBy(id, owner)
 *        （dsh-agent/lib/types/index.d.ts:341,350,355）
 *  - agent/status：idle ⇄ running 边沿；文档原文「idle means no driver remains
 *    scheduled or active」（dsh-agent/lib/types/runtime-types.d.ts:247）——
 *    比 turn/end 更接近"真空闲"，故用作**主触发点**。
 *  - 子代理判定：SessionHeader.origin==='subagent' + parentSession 链
 *    （dsh-session/lib/types/types.d.ts:71,81,87）。
 *    ⚠️ **不能单用 parentSession**：sessions.fork 的分叉会话 header 也带
 *    parentSession 但 origin 为空，仍是顶层会话（dsh-messager src/index.ts:278-280
 *    同款结论，其注释明确点出这个坑）。
 *  - ⚠️ **continuable 子代理不注册 job**：dsh-base/cordis.patch.yml:354 的 subagent
 *    工具默认 backgroundMode=continuable，走 subagents.startContinuable →
 *    ctx.agents.create({parentAgent})（dsh-subagent/lib/index.js:1077）。
 *    只有 one-shot 后台子代理与后台 pwsh 走 jobs.start
 *    （dsh-tool-subagent/lib/index.js:538、dsh-tool-pwsh/lib/index.js:387）。
 *    ⇒ 空闲门必须**同时**查 jobs 与 agents 两路，否则漏判最常用的 continuable 子代理。
 *
 * 业界对照（2026-10-16 实读源码，非二手转述）：
 *  - Claude Code 官方 Stop hook 输入直接携带 `background_tasks` 与 `session_crons`，
 *    文档原文：这两个数组让 hook 区分 "session is done" 与 "session is paused waiting
 *    for background work to wake it back up"（code.claude.com/docs/en/hooks）。本实现的
 *    「空闲门」与它同构。
 *  - DSH 生态同类插件（dsh-notifier ★24 / dsh-messager ★9 / dsh-perlica-ding ★7 /
 *    dsh-workmate ★5 / dsh-plugin-notify ★7）**均只过滤子代理自身的完成事件，
 *    无一等待子代理结束**——即本问题在整个生态尚未被解决。
 *  - 借鉴其两处已验证细节：① 触发用 agent/status 的 running→idle 边沿；
 *    ② 子代理判定失败时走主任务分支（"宁可多报一条 done，不静默用户自己的任务"，
 *    dsh-notifier src/server/events/impl/session/index.ts:70-77 注释）。
 *
 * 设计：completed 时先过空闲门 → 有在飞工作则**挂起**（不播），订阅
 * onJobsChanged + agent/status 重估，全部清空后播**一次**（天然合并多个子代理）；
 * 超过 idleGateTimeoutSeconds 兜底播报（防子代理卡死导致永不播报）；
 * 主会话重新进入 running（用户已开始新一轮）则取消挂起。
 * 失败一律 fail-visible：判定异常时走主任务分支照常播报，不静默用户。
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { readConfig, mergeConfig, describe as describeConfig } from './config-store.js';
import { loadSchema, buildConfig, readConfig as readSchemaConfig, FIELD_DEFAULTS } from './config-schema.js';
import { createSessionBridge, ROUTE_PREFIX } from './session-bridge.js';
import { createConfigRoute } from './config-route.js';
import {
  audioKindOf, resolveSource, effectiveSource, resolveCustomFile,
} from './audio-source.js';
import { checkLocalOrigin, throttle } from './http-guard.js';
import { poolSummary } from './voice-pack-store.js';
import { voiceRootsArg as computeVoiceRootsArg } from './voice-regions.js';
import { checkForUpdate } from './update-check.js';
import { createVoicePackRoute } from './voice-pack-route.js';
import { isDebug, redactText } from './log-privacy.js';
import { exportDiagnostics } from './diagnostics.js';
// ⚠️ 不再导入 watchPackage（v0.4.57）：自动监听重载已移除，见 dev-reload.js 末尾注释。
import { selfReload, computeFingerprint, planReload } from './dev-reload.js';
import { pickTtsText, sanitizeTtsText, MAX_TEXT_LEN } from './tts-lines.js';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 加载那一刻插件根的**真实路径**（解开 Junction / 符号链接）。
 *
 * 用途：判断"自重载还能不能救"。
 *
 * 自重载只能重新导入「**同一路径上的**」代码。`dsh plugin update` 升级后，
 * pnpm 会把包装到新的 `.pnpm/<name>@<ver>/` 下，而这里的 PLUGIN_ROOT
 * 在加载时就已解析成旧路径 —— 那时从旧路径重新导入，拿到的仍是旧代码。
 * 所以点按钮时比一次，路径变了就**如实说"必须重启"**，不给假希望。
 */
const RESOLVED_PLUGIN_ROOT = (() => {
  try { return realpathSync(PLUGIN_ROOT); } catch { return PLUGIN_ROOT; }
})();


// 检查更新的宿主侧缓存（v0.4.48）。
//
// 为什么放宿主侧而不是浏览器：
//   · 一天最多查一次 —— 不管用户开几次设置页，都不该反复打 npm/GitHub
//   · 报错也不影响功能：查不到就是查不到，通知与语音照常
//   · 缓存跨会话存活（模块级），设置页重开不必重新联网
const UPDATE_CACHE = { at: 0, result: null };
// 插件版本（诊断导出用）。读 package.json，失败就返回 unknown ——
// 这只是个信息字段，不值得为它抛异常。
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
})();
const SCRIPT_PATH = join(PLUGIN_ROOT, 'dsh-notify.ps1');

/**
 * 语音包候选根目录，拼成 ps1 能吃的字符串（分号分隔，**前面的优先**）。
 *
 * 为什么由 Node 算而不是 ps1 自己拼：
 *   用户下载的音色在 %LOCALAPPDATA%，内置的在插件目录，两处都要查且优先级不同。
 *   这套规则只应存在一份（lib/voice-pack-store.js），ps1 只接收排好序的路径串，
 *   否则两边各维护一份、迟早漂移 —— 那正是这次重构要消除的问题。
 *
 * @returns {string} 空串表示不传（ps1 退回只看插件目录）
 */
function voiceRootsArg() {
  // ⚠️ 2026-10-18 修 P0：这里原本调用了一个**不存在**的 `regions()`。
  //
  // 后果链：
  //   regions 未定义 → ReferenceError → catch → 返回空串
  //   → `if (roots)` 永远为假 → `-VoiceRoot` 从来没传给过 ps1
  //   → ps1 退回内置 sounds/voice-lines
  //   → **用户下载的音色根本播不到**
  //
  // 更麻烦的是它"看起来能工作"：内置目录里也有 ameharu-hau.wav 这类文件，
  // 所以测试时能听到声音，但那不是用户下载的版本。
  // 外部审阅对照公开源码直接指出了这一点（此前我的端到端测试是手动传
  // -VoiceRoot 做的，恰好绕过了这个断裂 —— 又一次"手动构造不等于真实路径"）。
  //
  // 现在交给 lib/voice-regions.js：它把「用户目录下每个音色子目录」
  // 和「内置平铺目录」都作为独立的根返回（ps1 不递归子目录，必须这样给）。
  try {
    return computeVoiceRootsArg(PLUGIN_ROOT);
  } catch {
    return '';   // 算不出来就让 ps1 走默认路径，不因为新逻辑影响播放
  }
}
/** Windows 自带 TTS 的脚本（零下载也能说话）。 */
const TTS_PATH = join(PLUGIN_ROOT, 'tts-speak.ps1');

/**
 * 与 ps1 共用的日志文件路径（`%TEMP%\dsh-notify-say\notify.log`）。
 *
 * 让 host 侧的 `[skip]` 记录与 ps1 侧的 `[toast]` / `[preview]` 落在同一文件，
 * 事后能按时间顺序看出「这一刻到底播了还是没播、没播是因为什么」。
 *
 * @returns {string} 绝对路径
 */
function notifyLogPath() {
  const tmp = process.env.TEMP || process.env.TMP || '';
  return tmp ? join(tmp, 'dsh-notify-say', 'notify.log') : '';
}

/**
 * 追加一行到 notify.log。**永不抛异常**（日志失败不能影响播报）。
 * @param {string} message
 */
/**
 * 日志轮转阈值（字节）与保留策略。
 *
 * 加轮转的原因：本次新增的 `[skip]` 记录把"没播"也写进日志后，写入频率显著上升
 * （每次跳过都一行）。不轮转的话，长时间运行会无限增长。
 *
 * 策略：超过 1 MB 就改名为 `notify.log.1`（覆盖旧的），新日志重新开始。
 * 只保留 1 份历史，够事后排查，也不会占太多空间。
 */
/**
 * 热重载漏报诊断（v0.4.36）。
 *
 * ## 为什么需要
 *
 * 2026-10-18 实测：开发期开着 devReload=true 时，我改代码触发热重载，
 * 正好在这几秒内完成的回合**没有播报**，日志里也查不到任何痕迹 ——
 * 排查时无法区分"事件没进来"和"进来了但没播"。
 *
 * 这个计数器给出一个可查的信号：
 *   · 每次事件处理入口 +1（存 globalThis，跨实例存活）
 *   · 重载完成后对比"重载前计数"，差值就是重载期间可能漏掉的事件数
 *
 * ## 为什么用 globalThis 而不是模块变量
 *
 * 重载后是新模块、新变量，旧值全丢。只有 globalThis 能在实例之间传。
 * key 带插件名，避免与其它插件冲突。
 */
const EVENT_COUNTER_KEY = Symbol.for('dsh-notify-say.eventCount');

/** 记一次"事件进来了"（在任何可能播报的入口调用）。 */
function bumpEventCount() {
  try {
    globalThis[EVENT_COUNTER_KEY] = (Number(globalThis[EVENT_COUNTER_KEY]) || 0) + 1;
  } catch { /* ignore */ }
}

/** 读当前累计事件数。 */
function readEventCount() {
  try {
    return Number(globalThis[EVENT_COUNTER_KEY]) || 0;
  } catch {
    return 0;
  }
}


const LOG_MAX_BYTES = 1024 * 1024;

/** 超过阈值时轮转一次（尽力而为，失败不影响写入）。 */
function rotateNotifyLogIfNeeded(p) {
  try {
    if (!existsSync(p)) return;
    if (statSync(p).size < LOG_MAX_BYTES) return;
    renameSync(p, p + '.1');
  } catch { /* 轮转失败就继续往原文件追加 */ }
}

/**
 * 追加一行到 notify.log。**永不抛异常**（日志失败不能影响播报）。
 * @param {string} message
 */
function appendNotifyLog(message, opts) {
  try {

    // 含用户内容的行：非 debug 档直接丢弃（不是脱敏，是不记）。
    // 见 log-privacy.js 头注释：那些内容对诊断「为什么不响」没帮助，
    // 却可能带出项目名、人名，而用户提 Issue 时常直接上传日志。
    if (opts && opts.detail && !isDebug(cfg.logLevel)) return;
    const p = notifyLogPath();
    if (!p) return;
    mkdirSync(dirname(p), { recursive: true });
    rotateNotifyLogIfNeeded(p);
    const d = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
      + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    appendFileSync(p, `${ts} ${message}\n`, 'utf8');
  } catch { /* 日志失败不影响主流程 */ }
}

// 审查建议采纳：不依赖宿主 PATH，直接定位 System32 的 Windows PowerShell 5.1
// （Toast 用 WinRT 投影，只在 5.1 可用；用 env 兜底避免硬编码盘符）。
const POWERSHELL_EXE =
  `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

// 默认值**单一来源**：用户可见项全部来自 config-schema.js 的 FIELD_DEFAULTS
// （独立审查 B5 指出原先把它们抄了两份，注释里自己写着"勿各写一份"）。
// 这里只补 2 个**不对外暴露**的内部节流值 —— 它们不进 settings 表单。
const DEFAULTS = Object.freeze({
  ...FIELD_DEFAULTS,
  // 毫秒形态的运行时值，由秒换算而来（FIELD_DEFAULTS 里是秒，schema 也是秒）。
  // ⚠️ 不在这里写死 60_000 —— 默认值的唯一来源是 FIELD_DEFAULTS.debounceSeconds。
  debounceMs: FIELD_DEFAULTS.debounceSeconds * 1000,
  globalCooldownMs: FIELD_DEFAULTS.globalCooldownSeconds * 1000,
  // 下面两个不对外暴露，只留在本文件。
  approvalDebounceMs: 15_000,
  idleGateTimeoutMs: 600_000,     // 兜底：挂起超过此时长仍播报（防子代理卡死）
});

// ── 资源保护（移植自旧 dsh-notify-done lib/index.js:70-83 的实测加固）────────
// spawn 并发上限 + 30s 超时强杀（音频驱动/Toast 偶发 hang，旧踩坑 #13）；
// 去抖 Map 带 TTL 清理与条目上限，防会话 id 无限增长。
const SPAWN_TIMEOUT_MS = 30_000;
const MAX_PENDING_SPAWNS = 4;
const MAP_TTL_MS = 30 * 60_000;
const MAP_MAX = 512;
/** 子代理祖先链最大回溯跳数（防御性上界，正常深度远小于此）。 */
const MAX_ANCESTOR_HOPS = 64;

// ── 方案C：提问提醒（老壳时代功能补齐，2026-09-25）────────────────────────
// 提问期间回合不结束（turn/end 永不触发），须只读观测 session/event 的 tool/call。
// 工具名依据旧 dsh-notify-done（:64-67）：ask_user_question（dsh-tool-ask-user）、
// exit_plan_mode（dsh-plan-mode；/plan 是斜杠命令不是工具，见踩坑 #84）。
const QUESTION_TOOLS = new Set(['ask_user_question', 'exit_plan_mode']);
const QUESTION_TTL_MS = MAP_TTL_MS; // 同一提问 callId 只提醒一次的幂等窗口

function normalizeConfig(raw) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of ['notifyOnComplete', 'notifyOnError', 'notifyOnBlocked', 'notifyOnAborted',
    'notifyOnApproval', 'notifyOnQuestion', 'voice', 'subagents', 'idleGate',
    // v0.4.2
    'showToast', 'jumpWhenBackground', 'jumpWhenForeground', 'multiJumpRule',
    // v0.4.3：开发开关
    'devReload']) {
    if (typeof raw[k] === 'boolean') out[k] = raw[k];
  }
  if (raw.voiceMode === 'fixed' || raw.voiceMode === 'random') out.voiceMode = raw.voiceMode;
  if (typeof raw.voiceName === 'string' && /^\w[\w-]*$/.test(raw.voiceName)) out.voiceName = raw.voiceName;
  const v = Number(raw.volume);
  if (Number.isFinite(v) && v >= 0 && v <= 100) out.volume = Math.round(v);
  const d = Number(raw.debounceSeconds);
  if (Number.isFinite(d) && d >= 0 && d <= 3600) out.debounceMs = Math.round(d * 1000);
  const a = Number(raw.approvalDebounceSeconds);
  if (Number.isFinite(a) && a >= 0 && a <= 3600) out.approvalDebounceMs = Math.round(a * 1000);
  const g = Number(raw.idleGateTimeoutSeconds);
  if (Number.isFinite(g) && g >= 0 && g <= 86400) out.idleGateTimeoutMs = Math.round(g * 1000);
  // v0.4.7：跨会话冷却（0 = 关闭）
  const gc = Number(raw.globalCooldownSeconds);
  if (Number.isFinite(gc) && gc >= 0 && gc <= 3600) out.globalCooldownMs = Math.round(gc * 1000);

  // ── v0.4.2：音源与 TTS ───────────────────────────────────────────────────
  if (typeof raw.audioSource === 'string'
    && ['tts', 'bundled', 'system', 'custom', 'none'].includes(raw.audioSource)) {
    out.audioSource = raw.audioSource;
  }
  if (typeof raw.ttsVoice === 'string' && raw.ttsVoice.length <= 120) out.ttsVoice = raw.ttsVoice;
  const r = Number(raw.ttsRate);
  if (Number.isFinite(r) && r >= -10 && r <= 10) out.ttsRate = Math.round(r);

  // ── v0.4.16：语音包数字增益 ──────────────────────────────────────────────
  //
  // 为什么需要：实测 247 个语音包峰值 最小 24.7% / 中位 40.4% / 最大 84.4%，
  // 素材录得偏轻；而 MCI 音量上限只等于原始幅度 1.0 倍、**无法超过**，
  // 所以 GUI 拉满仍偏小。只能靠数字增益补（ps1 侧按峰值限幅，不会破音）。
  const vg = Number(raw.voiceGain);
  if (Number.isFinite(vg) && vg >= 1.0 && vg <= 4.0) out.voiceGain = Math.round(vg * 10) / 10;
  if (typeof raw.normalizeCustomAudio === 'boolean') out.normalizeCustomAudio = raw.normalizeCustomAudio;
  
  // ── v0.4.34：日志级别 ────────────────────────────────────────────────
  //
  // ⚠️ 漏过很多次的地方：新字段必须同时改 normalizeConfig + effectiveForClient。
  // 只改一边的话，写盘成功但读回是默认值 —— GUI 看着像"改了没生效"，
  // 而且极难查（磁盘上明明是对的）。
  if (raw.logLevel === 'info' || raw.logLevel === 'debug') out.logLevel = raw.logLevel;

  // v0.4.4：自定义音频。
  // 存储是扁平的 customFileDone / customFileFail / …（config-store 白名单只认标量），
  // 这里拼成 audio-source.js 期望的 `customFiles: { done: 路径 }`。
  // 路径合法性已在 config-store.sanitize 里校验过，这里只做搬运。
  const cf = {};
  for (const kind of ['done', 'fail', 'question', 'approval', 'blocked']) {
    const key = 'customFile' + kind.charAt(0).toUpperCase() + kind.slice(1);
    const val = raw[key];
    if (typeof val === 'string' && val.trim()) cf[kind] = val.trim();
  }
  out.customFiles = cf;

  // v0.4.5：按事件覆盖音源。
  // 存的是扁平键（kindSourceFail = 'system'），拼成 audio-source.js 期望的
  // `audioSourceByKind: { fail: 'system' }`。
  // 空串表示"跟随全局默认"，故不写进字典（保持配置最小）。
  const byKind = {};
  for (const kind of ['done', 'fail', 'question', 'approval', 'blocked']) {
    const key = 'kindSource' + kind.charAt(0).toUpperCase() + kind.slice(1);
    const val = raw[key];
    if (typeof val === 'string') {
      const s = val.trim().toLowerCase();
      if (s && ['tts', 'bundled', 'system', 'custom', 'none'].includes(s)) byKind[kind] = s;
    }
  }
  out.audioSourceByKind = byKind;

  // v0.4.8：TTS 自定义台词（每种事件可覆盖内置台词库）。
  // 存储是扁平键（ttsTextDone / ttsTextFail …），拼成 tts-lines.js 要的
  // `ttsTexts: { done: '...' }`。空值不写进字典（保持"用内置库"）。
  const tt = {};
  for (const kind of ['done', 'fail', 'question', 'approval', 'blocked']) {
    const key = 'ttsText' + kind.charAt(0).toUpperCase() + kind.slice(1);
    const val = sanitizeTtsText(raw[key]);
    if (val) tt[kind] = val;
  }
  out.ttsTexts = tt;

  // ── v0.4.9：每种音源的参数按事件覆盖 ─────────────────────────────────────
  //
  // 存储是扁平键（kindSystemSoundFail / kindTtsVoiceDone …），这里拼成
  // 几个按事件索引的字典，供 notify() 在组装参数时查。
  //
  // ⚠️ 只收**标量**（v0.4.13 修，2026-10-17 实测踩到）。
  //
  // merged 里的值可能来自 schema 层，而 schemastery 的值是 **ref 对象**
  // （带 .get() 的包装）。若原样存进字典，notify() 取出来就是对象，
  // 传给 PowerShell 变成字符串 "[object Object]" → SAPI 合成失败 → **没声音**。
  //
  // 实测症状：日志里 `voice=[object Object] rate=[object Object]`，
  // 播放静默失败，但弹窗正常 —— 极难从表象定位。
  //
  // 空串/缺失/无法解包的对象一律视为"跟随全局"，不写进字典。
  const scalarOf = (v) => {
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
    if (typeof v === 'boolean') return v;
    if (v && typeof v === 'object') {
      // schemastery ref
      if (typeof v.get === 'function') {
        try {
          const inner = v.get();
          if (typeof inner === 'string') return inner;
          if (typeof inner === 'number') return Number.isFinite(inner) ? inner : undefined;
          if (typeof inner === 'boolean') return inner;
        } catch { /* ignore */ }
      }
      // 其它可解包对象
      if (typeof v.valueOf === 'function') {
        try {
          const inner = v.valueOf();
          if (inner !== v) {
            if (typeof inner === 'string') return inner;
            if (typeof inner === 'number') return Number.isFinite(inner) ? inner : undefined;
          }
        } catch { /* ignore */ }
      }
    }
    return undefined;
  };

  const pick = (prefix) => {
    const m = {};
    for (const kind of ['done', 'fail', 'question', 'approval', 'blocked']) {
      const key = prefix + kind.charAt(0).toUpperCase() + kind.slice(1);
      const val = scalarOf(raw[key]);
      if (val === undefined || val === '') continue;
      m[kind] = val;
    }
    return m;
  };
  out.kindTtsVoice = pick('kindTtsVoice');
  out.kindTtsRate = pick('kindTtsRate');
  out.kindVoiceMode = pick('kindVoiceMode');
  out.kindVoiceName = pick('kindVoiceName');
  out.kindSystemSound = pick('kindSystemSound');

  return out;
}

/**
 * 取某事件的按事件覆盖值；没有或不是标量就用全局默认。
 *
 * ⚠️ 必须只返回**标量**（v0.4.13）。
 * 上游 normalizeConfig 已经过滤过一遍，但这里再挡一层：
 * 一旦对象漏到 PowerShell 参数里就变成 "[object Object]"，
 * SAPI 会静默失败（弹窗有、没声音），极难排查。
 *
 * @param {object} map 按事件索引的字典（如 cfg.kindSystemSound）
 * @param {string} kind done|fail|question|approval|blocked
 * @param {*} fallback 全局默认值
 */
function kindOr(map, kind, fallback) {
  if (map && typeof map === 'object') {
    const v = map[kind];
    if (typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return fallback;
}

/** 去抖 Map 记账：写入前清 TTL 过期项；条目超上限时整体重置（宁可漏一条通知）。 */
function rememberAt(map, key, now) {
  if (map.size >= MAP_MAX) {
    for (const [k, at] of map) if (now - at > MAP_TTL_MS) map.delete(k);
    if (map.size >= MAP_MAX) map.clear();
  }
  map.set(key, now);
}

/**
 * 有界记账（值不是时间戳的 Map 用这个）。
 *
 * `lastTurnEnd`（值 {kind, at}）与 `prevStatus`（值 'idle'|'running'）不能走
 * `rememberAt`（它写的是裸时间戳），但同样必须防无限增长：宿主进程长期运行下，
 * 每个见过 turn/end 的会话、每个注册过的 agent 都会留一条，只增不减。
 *
 * 策略：超上限时先按 `tsOf` 清过期的，仍超就整体重置——与 `rememberAt` 同口径
 * （宁可漏一条通知，也不让内存无界增长）。
 *
 * @param map - 目标 Map。
 * @param key - 键。
 * @param value - 值。
 * @param now - 当前时间戳（ms）。
 * @param tsOf - 从值取时间戳（用于判过期）。
 */
function rememberBounded(map, key, value, now, tsOf) {
  if (map.size >= MAP_MAX) {
    for (const [k, v] of map) {
      const at = tsOf(v);
      if (typeof at === 'number' && now - at > MAP_TTL_MS) map.delete(k);
    }
    if (map.size >= MAP_MAX) map.clear();
  }
  map.set(key, value);
}

function isRecent(map, key, now, windowMs) {
  const at = map.get(key);
  return at !== undefined && now - at < windowMs;
}

/** 从 tool/call 的原始参数提取通知文案（arguments 是模型产出的 JSON 字符串；移植自旧插件 :117-131）。 */
function questionSummary(toolName, rawArgs) {
  let args = {};
  try { args = typeof rawArgs === 'string' ? (JSON.parse(rawArgs || '{}') || {}) : (rawArgs || {}); } catch { args = {}; }
  if (toolName === 'exit_plan_mode') {
    const plan = typeof args.plan === 'string' ? args.plan : '';
    const first = plan.split(/\r?\n/).find((l) => l.trim().length > 0) || '计划已就绪';
    return { text: first.replace(/^#+\s*/, '').slice(0, 60), hint: '（计划待审阅）' };
  }
  const qs = Array.isArray(args.questions) ? args.questions : [];
  const first = qs[0] || {};
  const text = String(first.question || first.header || '有事情需要你确认').replace(/\s+/g, ' ').slice(0, 60);
  const n = Array.isArray(first.options) ? first.options.length : 0;
  const more = qs.length > 1 ? `（共 ${qs.length} 个问题）` : '';
  return { text, hint: (n > 0 ? `（${n} 个选项）` : '') + more };
}

/** 子代判定：SessionHeader 线谱字段（typert.host.js:655，与旧插件同构）。 */
function isSubagent(session) {
  try {
    const h = session && session.header;
    if (!h) return false;
    // ⚠️ v0.4.59 修正（外部审阅指出的规则矛盾）：
    //
    //   原来只要有 `parentSession` 就判为子代理。但本文件 `isDescendantOf()`
    //   的注释已经写明：`sessions.fork` 产生的**普通分叉会话** header 也携带
    //   parentSession（指向源会话），而 origin 为空、是用户自己的顶层会话。
    //
    //   后果很实际：默认 `subagents: false` 时，普通 fork 会话的完成
    //   通知会被当成"子代理的"过滤掉 —— 用户会发现"我这个会话怎么不响"。
    //
    //   现在与 isDescendantOf 用同一套语义：只有 origin === 'subagent'
    //   或 delegationDepth > 0 才算子代理。
    //
    //   为什么不是简单删掉 parentSession：真正的子代理关系仍需识别，
    //   只是**不能仅凭** parentSession 认定 —— 它的语义是「派生自谁」，
    //   不是「谁的子代理」。
    if (h.origin === 'subagent') return true;
    if ((h.delegationDepth || 0) > 0) return true;
    return false;
  } catch {
    return false;
  }
}

function sessionKey(session) {
  try {
    return session && session.id !== undefined ? String(session.id) : '__unknown__';
  } catch {
    return '__unknown__';
  }
}

/** turn/end 的 reason.kind（reason 是 { kind } 对象；字符串仅作向前兼容容错）。 */
export function reasonKindOf(data) {
  return data && data.reason && typeof data.reason === 'object'
    ? String(data.reason.kind || '')
    : String((data && data.reason) || '');
}

/**
 * 一个活 agent 是否为 rootId 的**子代理后代**（任意深度）。
 *
 * 判定分两步，缺一不可：
 *  ① 沿 parentSession 链向上回溯到 rootId；
 *  ② 链上每一跳的 header.origin 必须是 'subagent'。
 *
 * 第 ② 步是必需的：`sessions.fork` 产生的分叉会话 header 也携带 parentSession
 * （指向源会话），但 origin 为空、且它是用户自己的**顶层**会话——把它算作后代会让
 * 主会话的完成通知被另一个独立会话拖住。dsh-messager 在 src/index.ts:278-280
 * 记录了同款结论。
 *
 * @param agent - 待判定的活 agent。
 * @param rootId - 根会话 id。
 * @param byId - id → agent 的索引（Map）。
 * @returns 是后代则为 true；任何异常一律返回 false（调用方按"非后代"处理）。
 */
export function isDescendantOf(agent, rootId, byId) {
  try {
    const root = String(rootId);
    let cur = agent;
    let hops = 0;
    while (cur && hops < MAX_ANCESTOR_HOPS) {
      const h = cur.session && cur.session.header;
      if (!h || h.origin !== 'subagent') return false;
      const p = h.parentSession;
      if (p === undefined || p === null) return false;
      if (String(p) === root) return true;
      cur = byId && typeof byId.get === 'function' ? byId.get(String(p)) : undefined;
      hops += 1;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 汇总"仍在飞"的工作（纯函数，便于单测）。
 *
 * 两路缺一不可（见文件头 continuable 说明）：
 *  - jobSnapshots：后台任务（one-shot 子代理、后台 pwsh、PTY），running/stopping 即在飞。
 *  - agentList：活 agent 中，本会话的**子代理后代**且 status==='running' 即在飞
 *    （覆盖不注册 job 的 continuable 子代理）。
 *
 * @param jobSnapshots - ctx.jobs.list(caller) 的结果。
 * @param agentList - ctx.agents.list() 的结果。
 * @param rootId - 根会话 id。
 * @returns 在飞项数组（空数组 = 工作树空闲）。
 */
export function collectInFlight(jobSnapshots, agentList, rootId) {
  const items = [];
  const jobs = Array.isArray(jobSnapshots) ? jobSnapshots : [];
  for (const j of jobs) {
    if (!j) continue;
    if (j.status === 'running' || j.status === 'stopping') {
      items.push({ kind: 'job', id: String(j.id), label: String(j.label || '') });
    }
  }
  const list = Array.isArray(agentList) ? agentList : [];
  const byId = new Map();
  for (const a of list) {
    if (a && a.id !== undefined) byId.set(String(a.id), a);
  }
  for (const a of list) {
    if (!a || a.id === undefined) continue;
    if (String(a.id) === String(rootId)) continue;
    if (a.status !== 'running') continue;
    if (!isDescendantOf(a, rootId, byId)) continue;
    items.push({ kind: 'subagent', id: String(a.id), label: '' });
  }
  return items;
}

/**
 * 把内部 `cfg` 映射成**给前端看的 schema 形状**。
 *
 * ## 为什么需要这一层
 *
 * 内部 cfg 用"运行时友好"的字段名（`debounceMs` 毫秒、`voiceMode` 等），
 * 而设置页 GUI 收发的是 schema 键名（`debounceSeconds` 秒、`audioSource` …）。
 * 两者**不是同一个东西**。直接把 cfg 交给前端会导致：
 *
 *   cfg 里没有 `debounceSeconds` 这个键 → 前端从 DEFAULTS 展开拿到默认 60
 *   → 用户把冷却调成 0（关闭），界面却显示 60 秒，看起来"改了没生效"。
 *   （2026-10-17 用户实测反馈，就是这么来的。）
 *
 * ## 为什么不复用 config-store 的 describe()
 *
 * 那个函数只覆盖 v0.4.0 时代的 12 个老字段，此后新增的
 * audioSource / 冷却 / 台词 / 按事件覆盖全都没有 —— 复用它等于一半字段丢失。
 *
 * @param {object} c normalizeConfig 的产物
 * @returns {object} schema 键名的扁平对象
 */
export function effectiveForClient(c) {
  const g = c && typeof c === 'object' ? c : {};
  const out = {
    voice: g.voice,
    voiceMode: g.voiceMode,
    voiceName: g.voiceName,
    volume: g.volume,
    notifyOnComplete: g.notifyOnComplete,
    notifyOnError: g.notifyOnError,
    notifyOnBlocked: g.notifyOnBlocked,
    notifyOnAborted: g.notifyOnAborted,
    notifyOnApproval: g.notifyOnApproval,
    notifyOnQuestion: g.notifyOnQuestion,
    subagents: g.subagents,
    idleGate: g.idleGate,
    // v0.4.2+
    audioSource: g.audioSource,
    showToast: g.showToast,
    ttsVoice: g.ttsVoice,
    ttsRate: g.ttsRate,
    jumpWhenBackground: g.jumpWhenBackground,
    jumpWhenForeground: g.jumpWhenForeground,
    multiJumpRule: g.multiJumpRule,
    // v0.4.7 冷却：毫秒 → 秒（前端下拉用的是秒）
    debounceSeconds: Math.round((Number(g.debounceMs) || 0) / 1000),
    globalCooldownSeconds: Math.round((Number(g.globalCooldownMs) || 0) / 1000),
    // v0.4.3
    devReload: g.devReload,
    // v0.4.34 日志级别（info / debug）
    logLevel: g.logLevel,
    // v0.4.16：音量增益与自定义音频标准化。
    //
    // ⚠️ 这两个漏过一次（v0.4.18 补）：normalizeConfig 里算了，
    // 但没加到这里，于是前端 GET 拿不到 → 滑杆显示默认值 →
    // 用户拖动后写回的又是旧值，看起来"增益功能不存在"。
    // 这是 v0.4.10 那个"内部形状未映射到前端形状"的同类错误 ——
    // 每加一个配置项，**必须同时**改 normalizeConfig 和 effectiveForClient。
    //
    // 兜底给 2.0：即使 g 里没有这个字段（老配置文件 / 只读场景），
    // 前端也要能确定滑杆位置。用 undefined 会让滑杆跳到最左端（1.0），
    // 看起来像"增益被关了"。
    voiceGain: typeof g.voiceGain === 'number' ? g.voiceGain : 2.0,
    normalizeCustomAudio: g.normalizeCustomAudio === true,
  };

  // 按事件的字典 → 扁平键（与 config-store 白名单的键名一致）
  //
  // ⚠️ 同 normalizeConfig 的道理：**只输出标量**。
  // 这里是"给前端看"的形状，若混进 ref 对象，前端写回时又会被存成对象，
  // 下一轮就变成 "[object Object]" 传给 PowerShell（v0.4.13 修）。
  const KINDS = ['done', 'fail', 'question', 'approval', 'blocked'];
  const cap = (k) => k.charAt(0).toUpperCase() + k.slice(1);
  const asScalar = (v) => {
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
    if (typeof v === 'boolean') return v;
    if (v && typeof v === 'object') {
      if (typeof v.get === 'function') {
        try {
          const inner = v.get();
          if (typeof inner === 'string') return inner;
          if (typeof inner === 'number') return Number.isFinite(inner) ? inner : undefined;
          if (typeof inner === 'boolean') return inner;
        } catch { /* ignore */ }
      }
      if (typeof v.valueOf === 'function') {
        try {
          const inner = v.valueOf();
          if (inner !== v) {
            if (typeof inner === 'string') return inner;
            if (typeof inner === 'number') return Number.isFinite(inner) ? inner : undefined;
          }
        } catch { /* ignore */ }
      }
    }
    return undefined;
  };
  const dictToFlat = (dict, prefix) => {
    const d = dict && typeof dict === 'object' ? dict : {};
    for (const k of KINDS) {
      const val = asScalar(d[k]);
      if (val === undefined || val === '') continue;
      out[prefix + cap(k)] = val;
    }
  };
  dictToFlat(g.ttsTexts, 'ttsText');
  dictToFlat(g.kindTtsVoice, 'kindTtsVoice');
  dictToFlat(g.kindTtsRate, 'kindTtsRate');
  dictToFlat(g.kindVoiceMode, 'kindVoiceMode');
  dictToFlat(g.kindVoiceName, 'kindVoiceName');
  dictToFlat(g.kindSystemSound, 'kindSystemSound');
  dictToFlat(g.customFiles, 'customFile');

  // audioSourceByKind 两种形态都给：
  //   · 字典 —— GUI 的「按事件覆盖音源」读它（v0.4.10 的修法）
  //   · 扁平 kindSource<Kind> —— 与其它按事件键一致，便于排查
  const abk = (g.audioSourceByKind && typeof g.audioSourceByKind === 'object')
    ? { ...g.audioSourceByKind } : {};
  out.audioSourceByKind = abk;
  for (const k of KINDS) {
    if (abk[k] !== undefined && abk[k] !== '') out['kindSource' + cap(k)] = abk[k];
  }

  return out;
}

export function apply(ctx, config) {
  // 一次性自重载的实现槽（v0.4.57）。
  //
  // 路由在 apply 中段注册、实现挂在 apply 末尾 —— 用 let 槽连接两者。
  // （不写成函数声明：它包在 try 块里，严格模式下块级作用域不会提升出去。）
  let reloadOnce = null;
  // ── 配置来源（v0.4.0 起三源合并）──────────────────────────────────────────
  //
  // 优先级（后覆盖前）：
  //   1. DEFAULTS（本文件常量）
  //   2. schemastery Config 的解析值（官方 settings 层：schema 默认 + base(patch) + 用户设置页）
  //   3. `$DSH_HOME/storages/dsh-notify-say/config.json`（CLI 写的运行时覆盖）
  //
  // 为什么还要第 3 层：设置页要开浏览器点，而用户在终端里想「一条命令把音量调到 40」
  // 时 CLI 更顺手。CLI 走 config-store，GUI 走官方 settings，两者最终都汇进 cfg，
  // 不会出现「改了 A 但 B 还是旧值」的分裂。
  //
  // 稳定性设计（本插件的首要目标）：
  //   - 任一配置源出问题（缺 $DSH_HOME / JSON 坏 / schema 解析失败）都**静默降级**，
  //     插件行为退回到「只有 patch 配置」的旧语义，绝不因配置层导致通知丢失。
  //   - 整体 try/catch；失败时保持上一次成功解析的 cfg。
  //   - 只在生效值真的变化时记日志，避免每次播报刷屏。
  const rawConfig = config;
  const schemaLog = (m) => console.warn('[dsh-notify-say] ' + m);

  /**
   * 从 schema 化 config 取普通值；拿不到就退回原始对象。
   *
   * ⚠️ 注意（独立审查 B4 指出的注释与实现不符，已更正）：
   * `readSchemaConfig` 对**缺失的键会填 FIELD_DEFAULTS**，因此它**恒返回 12 个键**，
   * 不能用「键数 > 0」判断 schema 是否真的生效 —— 那样判定恒真。
   *
   * 正确的判据：看**输入对象本身**是否带 schemastery ref（字段有 `.get` 方法）。
   * 官方语义下 `apply(ctx, config)` 收到的是 ref；未接管时是普通值。
   */
  function entryFromSchema() {
    try {
      if (rawConfig == null || typeof rawConfig !== 'object') return null;
      // 以「输入里有没有 ref」判断，而不是看输出键数
      const looksLikeRefs = Object.keys(FIELD_DEFAULTS).some((k) => {
        const slot = rawConfig[k];
        return slot != null && typeof slot === 'object' && typeof slot.get === 'function';
      });
      if (!looksLikeRefs) return null;
      return readSchemaConfig(rawConfig);
    } catch {
      return null;
    }
  }

  let cfg = normalizeConfig(config);
  let lastConfigSig = '';

  /** 重新解析生效配置；失败时保持上一次的值（绝不因配置问题丢通知）。 */
  function refreshConfig() {
    try {
      // 第 2 层：官方 settings（schema）解析值
      const fromSchema = entryFromSchema();
      // 第 3 层：CLI 写的 storages 覆盖
      const file = readConfig();
      const fileValues = file.ok ? file.value : {};

      // 合并顺序：patch(原始) → schema 值 → 文件值
      const merged = mergeConfig(
        mergeConfig(rawConfig, fromSchema || {}),
        fileValues,
      );
      cfg = normalizeConfig(merged);

      const sig = JSON.stringify(describeConfig(cfg));
      if (sig !== lastConfigSig) {
        lastConfigSig = sig;
        if (!file.ok && file.reason !== 'no-home') {
          console.warn(`[dsh-notify-say] config.json 读取失败(${file.reason})，已回退到上层配置`);
        }
        console.log(`[dsh-notify-say] config: voice=${cfg.voice} mode=${cfg.voiceMode} name=${cfg.voiceName} vol=${cfg.volume}`);
      }
    } catch (e) {
      console.warn('[dsh-notify-say] refreshConfig failed, keeping previous config: '
        + String((e && e.message) || e));
    }
  }
  refreshConfig();

  // 会话状态桥实例：notify() 往里写，HTTP route 往外读（client 半侧消费）。
  // 进程内、不落盘 —— 重启后"刚才那条通知"就该失效，这是正确语义。
  const bridge = createSessionBridge();
  // ⚠️ v0.4.63：长轮询的挂起响应必须在卸载时结束，
  // 否则热重载会留下永远等不到响应的连接（2026-10-18 那次崩溃同源）。

  // 配置 route：client 设置卡片读写音量/音色/开关。
  // onChanged 立刻重读配置 —— 让"点一下即生效"成立，不必重启宿主。
  const configRoute = createConfigRoute({
    onChanged: () => { try { refreshConfig(); } catch { /* ignore */ } },
    // 返回**给前端看的形状**（schema 键名），而不是内部 cfg。
    //
    // ⚠️ 这里踩过一个隐蔽的坑（2026-10-17）：
    // 原先直接返回 `cfg`，但 cfg 是 normalizeConfig 的产物，用的是**内部字段名**：
    //   cfg.debounceMs = 0（毫秒）
    // 而前端读的是 schema 键名 `debounceSeconds`。cfg 里**没有**这个键，
    // 于是从 DEFAULTS 展开拿到 60 —— 用户把冷却调成 0（关闭），
    // 界面却显示 60 秒，看起来"改了没生效"。
    //
    // 正确做法：把内部值**映射回 schema 形状**再给前端。
    // 注意必须把当前 cfg 传进去 —— 写成 effectiveForClient() 会得到全空对象，
    // 表现为"所有设置都显示默认值"（2026-10-17 实测踩到）。
    getEffective: () => effectiveForClient(cfg),
  });
  // 语音包管理路由（v0.4.31）。
  //
  // 单独一个模块而不是塞进这里：下载安装是唯一写盘的功能，
  // 集中在一处便于安全审查（zip-slip / SSRF / 哈希校验都在那边）。
  const voicePackRoute = createVoicePackRoute({ pluginRoot: PLUGIN_ROOT, logger: console });

  let pendingSpawns = 0;
  const lastTurnNotify = new Map(); // sessionId -> ts  // 跨会话冷却用：**任意**会话最近一次播报的时刻。
  // 与 lastTurnNotify（按会话）是不同粒度，故单独一个标量而非 Map。
  let lastAnyNotifyAt = 0;
  const approvalSeen = new Map();   // 'id:<approvalId>' | 'session:<sid>|<tool>' -> ts
  const questionSeen = new Map();   // 'sid:callId' -> ts（同一提问只提醒一次；answered 即清）
  const lastTurnEnd = new Map();    // sessionId -> { kind, at }（agent/status idle 时取用）
  const pendingDone = new Map();    // sessionId -> { session, psKind, title, body, timer, inflight }
  const prevStatus = new Map();     // agentId -> 'idle' | 'running'（边沿判定）
  /** fire-and-forget spawn：并发上限 + 超时 taskkill /T 兜底（旧插件实测加固的移植）。 */
  function spawnNotify(args) {
    if (pendingSpawns >= MAX_PENDING_SPAWNS) {
      // 除了 console 还要写 notify.log —— 否则"通知被丢弃"在日志里完全看不到，
      // 排查时只会觉得"插件没反应"（2026-10-17 实测踩到）。
      const tail = (() => {
        try {
          const i = args.indexOf('-File');
          return i >= 0 ? String(args[i + 1]).split(/[\\/]/).pop() : '?';
        } catch { return '?'; }
      })();
      appendNotifyLog(`[spawn-drop] ${tail} pending=${pendingSpawns}/${MAX_PENDING_SPAWNS} (throttled)`);
      console.warn(`[dsh-notify-say] spawn throttled (${pendingSpawns} pending), dropping notification`);
      return;
    }
    pendingSpawns += 1;
    let child;
    try {
      child = spawn(POWERSHELL_EXE, args, { stdio: 'ignore', windowsHide: true });
    } catch (e) {
      pendingSpawns -= 1;
      console.warn('[dsh-notify-say] spawn failed: ' + String((e && e.message) || e));
      return;
    }
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      pendingSpawns = Math.max(0, pendingSpawns - 1);
    };
    const killer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } catch { /* ignore */ }
      setTimeout(settle, 1000);
    }, SPAWN_TIMEOUT_MS);
    child.once('exit', settle);
    child.once('error', settle);
  }

  /** 跑 TTS 脚本（与 spawnNotify 共用并发上限与超时兜底）。 */
  function spawnTts(args) {
    spawnNotify(args);
  }

  /**
   * 某个事件在 TTS 音源下该念什么台词。
   *
   * 委托给 lib/tts-lines.js（多条随机 + 用户自定义 + 文本校验），
   * 这样"念什么"这件事有独立的一方负责，也能单独测。
   *
   * @param {string} psKind done | fail | chime | approval | question
   * @returns {string}
   */
  function ttsTextFor(psKind) {
    const kind = audioKindOf(psKind) || 'done';
    try {
      return pickTtsText(kind, cfg);
    } catch {
      // 台词选取失败不该让整条通知哑掉，退回简短兜底
      return '有新消息';
    }
  }

  /** 组参并 spawn 本包自带 ps1（Toast + 可选语音；kind 决定语句池/chime）。 */
  /**
   * @param {string} psKind done | fail | chime | approval | question
   * @param {string} title
   * @param {string} body
   * @param {object} [session] 可选；用于记录"这条通知属于哪个会话"，
   *   client 半侧在窗口被唤到前台时据此跳转。缺失则该能力不生效，通知本身不受影响。
   */
  function notify(psKind, title, body, session) {
    // 播报前现读配置：让 CLI/GUI 改的值立即生效，无需重载宿主。
    refreshConfig();

    // Toast 第三行：项目名（v0.4.62）。
    //
    // 只在"标题里没包含它"时才给 —— 否则标题已经是「优化0Deepseek…」，
    // 再显示一遍 "0Deepseek" 就是重复。单项目用户看不到第三行，
    // 多项目并行的用户能靠它区分。
    let detail = projectNameOf(session);
    if (detail && String(title || '').toLowerCase().includes(detail.toLowerCase())) detail = '';

    // 记下"这条通知属于哪个会话"，供 client 半侧点击后跳转。
    // 失败绝不影响通知本身（跳会话是增强功能）。
    try {
      const sid = session && session.id !== undefined ? String(session.id) : '';
      if (sid) bridge.setLast(sid);
    } catch { /* ignore */ }

    // ── 音源分流（v0.4.2）────────────────────────────────────────────────
    //
    // 判定交给 lib/audio-source.js（纯函数，17 条测试锁住），
    // 这里只负责"按结果执行"。核心是：**任何配置组合都要有合理结果**，
    // 拿不到就按回退链降级，绝不静默。
    //
    // 注意初值：不能用 `let source = 'tts'` 这种"看着像默认值"的写法 ——
    // 它在 try 成功时被覆盖、失败时被设成 none，永远用不到，属于误导性死代码
    // （自测时发现：把它改成 'bundled' 所有测试仍然全绿，说明它确实无效）。
    // 这里显式用 null 表示"还没有结论"，解析失败才落到 none。
    let source = null;
    try {
      const kind = audioKindOf(psKind);
      const eff = effectiveSource(resolveSource(kind, cfg), {
        hasTtsVoice: true,                    // Windows 一定有可用 TTS（实测）
        hasBundledVoice: hasVoiceLine(psKind),
        hasCustomFile: !!resolveCustomFile(kind, cfg),
      });
      source = eff.source;
      if (eff.fellBack) {
        appendNotifyLog(`[audio] fallback ${eff.from}->${eff.source} kind=${psKind}`);
      }
    } catch {
      source = 'none';   // 解析本身炸了：宁可只弹窗，也不要乱出声
    }

    // 只有 "none" 是完全不出声；其余都走声音路径
    const wantSound = cfg.voice && source !== 'none';
    // ── 视觉通道（v0.4.59）────────────────────────────────────────────
    //
    // ⚠️ 外部审阅指出的真 bug：原来只有 TTS 分支看 `cfg.showToast`，
    // 语音包 / 系统提示音 / 自定义音频一律让 ps1 弹窗 —— 于是
    // **关掉「显示通知弹窗」后仍会弹 Toast**。
    //
    // 更糟的是两个都关的情况：旧代码照样 spawn ps1（带 -NoSound），
    // ps1 在没有 -SoundOnly 时就会弹窗 —— 与设置页刚加的
    // 「弹窗与声音都已关闭」提示直接矛盾。
    //
    // 现在把两个通道彻底分开：
    //   wantToast=false → 传 -SoundOnly（只出声，不弹窗）
    //   wantSound=false → 传 -NoSound（只弹窗，不出声）
    //   两个都 false   → **不启动任何进程**
    //
    // 默认值按 `!== false` 判：配置缺字段时按"开着"处理，
    // 不会因为 undefined 把用户的提醒静默掉。
    const wantToast = cfg.showToast !== false;
    if (!wantToast && !wantSound) {
      appendNotifyLog('[skip] 弹窗与声音都已关闭，不启动提醒进程');
      return;
    }
    // 本事件对应的事件类（done/fail/question/approval/blocked），
    // 用于查"按事件覆盖"的各种参数（v0.4.9）。
    const aKind = audioKindOf(psKind) || 'done';

    // 可观测性（v0.4.12）：每一步决策都留痕。
    // 2026-10-17 排查"有弹窗没声音"时，最耗时的就是分不清
    // "没走 TTS 分支" 还是 "走了但 spawn 被丢"，因为两种情况的日志一样。
    appendNotifyLog(`[plan] kind=${aKind} source=${String(source)} `
      + `audioSource=${String(cfg.audioSource)} voice=${String(cfg.voice)} `
      + `wantSound=${String(wantSound)} showToast=${String(cfg.showToast)} `
      + `byKind=${JSON.stringify(cfg.audioSourceByKind || {})}`);

    // ── TTS：零下载也能说话 ──────────────────────────────────────────────
    if (wantSound && source === 'tts') {
      const line = ttsTextFor(psKind);
      // 发音人与语速都可以按事件覆盖（kindTtsVoice*/kindTtsRate*），
      // 没设就用全局 ttsVoice / ttsRate。
      const vVoice = kindOr(cfg.kindTtsVoice, aKind, cfg.ttsVoice);
      const vRate = kindOr(cfg.kindTtsRate, aKind, cfg.ttsRate || 0);

      // 可观测性（v0.4.12）：把"决定走 TTS"和"槽位是否够"写进日志。
      // 2026-10-17 排查"弹窗有、声音无"时，卡在无法区分
      //   (a) 没走 TTS 分支  (b) 走了但 spawn 被并发上限丢弃
      // 这两者日志长得一样（都只有一条 [toast]），只能靠猜。
      // 现在明确留痕，后续同类问题一眼可辨。
      // 台词正文只在 debug 档记录。
      // 默认档只留长度 —— 足以判断"有没有走到 TTS"，但不泄露用户写了什么。
      if (isDebug(cfg.logLevel)) {
        appendNotifyLog(`[tts-plan] text=${JSON.stringify(line)} voice=${vVoice || '(默认)'} rate=${vRate} pending=${pendingSpawns}/${MAX_PENDING_SPAWNS}`, { detail: true });
      } else {
        appendNotifyLog(`[tts-plan] text=${redactText(line, cfg.logLevel)} voice=${vVoice || '(默认)'} rate=${vRate} pending=${pendingSpawns}/${MAX_PENDING_SPAWNS}`);
      }

      const ttsArgs = [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File',
        TTS_PATH, '-Text', line, '-Volume', String(cfg.volume), '-Rate', String(vRate),
      ];
      if (vVoice) ttsArgs.push('-VoiceName', vVoice);
      // TTS 自己会出声，所以 notify.ps1 只负责弹窗（-NoSound）
      if (wantToast) spawnNotify(notifyArgs(psKind, title, body, true, false, detail));
      spawnTts(ttsArgs);
      return;
    }

    // ── 系统提示音：不碰语音池 ───────────────────────────────────────────
    //
    // 默认传 `-SystemSound auto`，由 ps1 按 `-Kind` 映射：
    //   失败/拦截 → Hand/Exclamation（警告感）
    //   提问/审批 → Question
    //   完成     → Asterisk（轻快）
    // 这样"失败"和"完成"听起来不一样，不会被误判。
    //
    // v0.4.9：如果用户给这个事件单独指定了音效（kindSystemSoundFail 等），
    // 就传那个具体的名字，不再用 auto。
    //
    // **不传 -Voice/-Mode**，并且 ps1 侧见到 -SystemSound 就跳过语音池
    // （否则 -Kind fail 会先选中 fail 池的 wav，永远走不到系统音效）。
    if (wantSound && source === 'system') {
      const a = baseNotifyArgs(psKind, title, body, false, !wantToast, detail);
      const explicitTone = kindOr(cfg.kindSystemSound, aKind, '');
      a.push('-SystemSound', explicitTone || 'auto');
      spawnNotify(a);
      return;
    }

    // ── 自定义音频：播放用户指定的文件 ───────────────────────────────────
    //
    // 路径来自 `cfg.customFiles[kind]`（normalizeConfig 已把扁平键拼好）。
    // 播放交给 dsh-notify.ps1 的 -CustomFile：它直接用 MCI 播这个文件，
    // 不碰语音池，也不回落（用户明确指定了要放什么）。
    if (wantSound && source === 'custom') {
      const kind = audioKindOf(psKind);
      const file = resolveCustomFile(kind, cfg);
      if (file) {
        const a = baseNotifyArgs(psKind, title, body, false, !wantToast, detail);
        a.push('-CustomFile', file);
        // v0.4.16：自定义音频的"标准化"是**可选**的。
        //
        // 默认不做 —— 那是用户自己的素材，可能特意做得轻或响，不该擅自改。
        // 打开后按统一目标峰值处理（ps1 侧对 16-bit PCM wav 生效）。
        if (cfg.normalizeCustomAudio === true) {
          a.push('-Gain', String(Number(cfg.voiceGain) > 1 ? Number(cfg.voiceGain) : 2.0));
        }
        spawnNotify(a);
        return;
      }
      // 没配文件：不要静默无声，退到系统提示音（audio-source 的回退链已算过，
      // 但这里再兜一次，防止 effectiveSource 的 hasCustomFile 判断与读取不一致）
      const a2 = baseNotifyArgs(psKind, title, body, false, !wantToast, detail);
      a2.push('-SystemSound', 'auto');
      spawnNotify(a2);
      return;
    }

    // ── 其余音源（bundled）走 dsh-notify.ps1 ──────────────────────────────
    // 第 5 个参数是 soundOnly（v0.4.59）。原来这里传的是 source，
    // 而 notifyArgs 只认 4 个参数 —— 那个多传的值一直被静默忽略。
    spawnNotify(notifyArgs(psKind, title, body, !wantSound, !wantToast, detail));
  }

  /** 只有基础参数的 notify 调用（供 system 音源拼装）。 */
  function baseNotifyArgs(psKind, title, body, noSound, soundOnly, detail) {
    const args = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File',
      SCRIPT_PATH, '-Kind', psKind, '-Title', title, '-Body', body,
    ];
    // 第三行可选（v0.4.62）：空就不传，ps1 侧相应不加 <text>。
    if (detail) args.push('-Detail', detail);
    if (noSound) args.push('-NoSound');
    // 只出声不弹窗（v0.4.59）。与 -NoSound 互斥，调用方保证。
    if (soundOnly) args.push('-SoundOnly');

  // v0.4.29：把「用户目录;插件目录」传给 ps1，让它两个区域都查
  const roots = voiceRootsArg();
  if (roots) args.push('-VoiceRoot', roots);
  // v0.4.34：把日志级别传给 ps1（它决定要不要把标题/正文写进日志）
  args.push('-LogLevel', cfg.logLevel === 'debug' ? 'debug' : 'info');
    args.push('-Volume', String(cfg.volume));
    return args;
  }

  /** 构造 dsh-notify.ps1 的参数。noSound=true 表示只弹窗不出声。 */
  function notifyArgs(psKind, title, body, noSound, soundOnly, detail) {
    const args = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File',
      SCRIPT_PATH, '-Kind', psKind, '-Title', title, '-Body', body,
    ];
    // 第三行可选（v0.4.62）：空就不传，ps1 侧相应不加 <text>。
    if (detail) args.push('-Detail', detail);
    if (noSound) args.push('-NoSound');
    // 只出声不弹窗（v0.4.59）。与 -NoSound 互斥，调用方保证。
    if (soundOnly) args.push('-SoundOnly');
  // v0.4.29：把「用户目录;插件目录」传给 ps1，让它两个区域都查
  const roots = voiceRootsArg();
  if (roots) args.push('-VoiceRoot', roots);
  // v0.4.34：把日志级别传给 ps1（它决定要不要把标题/正文写进日志）
  args.push('-LogLevel', cfg.logLevel === 'debug' ? 'debug' : 'info');
    // v0.4.9：音色模式与音色名都可按事件覆盖（kindVoiceMode*/kindVoiceName*），
    // 没设就用全局 voiceMode / voiceName。
    const aKind = audioKindOf(psKind) || 'done';
    const mode = kindOr(cfg.kindVoiceMode, aKind, cfg.voiceMode);
    const name = kindOr(cfg.kindVoiceName, aKind, cfg.voiceName);
    if (mode === 'random') args.push('-Mode', 'random');
    else if (name) args.push('-Voice', name);
    args.push('-Volume', String(cfg.volume));
    // v0.4.16：语音包数字增益。
    // MCI 的音量上限只等于原始幅度 1.0 倍，而本包素材峰值中位仅 40.4%，
    // 所以"GUI 拉满仍偏轻"是必然 —— 只能靠数字增益补。
    // 只对语音包（bundled）生效；自定义音频默认原样，由用户单独开标准化。
    const g = Number(cfg.voiceGain);
    if (Number.isFinite(g) && g > 1) args.push('-Gain', String(g));
    return args;
  }

  /**
   * 某个事件是否有可用的语音包文件。
   *
   * 只做"够不够决定走哪条路"的粗判，不做精确选曲
   * （精确选曲在 ps1 里，那里才知道 -Voice/-Mode 的完整语义）。
   */
function hasVoiceLine(psKind) {
  try {
    const sub = (psKind === 'question' || psKind === 'approval' || psKind === 'fail') ? psKind : '';
    const summary = poolSummary(PLUGIN_ROOT, sub);

    // 读不到目录（宿主沙箱限制）→ 乐观放行，交给 ps1 裁决。
    //
    // 2026-10-17 实测：宿主进程里 existsSync=true 但 readdirSync 抛异常，
    // 于是被判成"没有语音包" → fallback bundled->system → 用户选了语音包
    // 却只听到蜂鸣。而 ps1 是独立子进程、不受沙箱限制，明明能正常播放。
    // 结论：判断不了 ≠ 没有，宁可放行。
    if (summary.unreadable) return true;

    appendNotifyLog(`[voice-check] pool=${sub || 'done'} wav=${summary.total}`);
    return summary.total > 0;
  } catch (e) {
    appendNotifyLog(`[voice-check] error(${(e && e.message) || e}) -> assume-yes`);
    return true;
  }
}

  function shouldNotifySession(session) {
    return cfg.subagents || !isSubagent(session);
  }

  /**
   * 项目名（cwd 最后一段），用作 Toast 第三行（v0.4.62）。
   * 只在"标题里没有它"时才显示，避免重复。
   */
  function projectNameOf(session) {
    try {
      const cwd = session && session.header && session.header.cwd;
      if (!cwd) return '';
      const parts = String(cwd).split(/[\\/]+/).filter(Boolean);
      return parts.length ? parts[parts.length - 1] : '';
    } catch {
      return '';
    }
  }

  /** 读宿主服务（非 strict：容许由其它作用域提供；任何失败都返回 undefined）。 */
  function svc(name) {
    try { return ctx.get(name, false); } catch { return undefined; }
  }

  /**
   * 当前"仍在飞"的工作快照。
   * 只读旁路：任一路取不到就退化为空（fail-visible —— 宁可多播一条完成，
   * 也不因为读不到服务而静默用户自己的任务）。
   */
  function inFlightOf(agent) {
    let jobs = [];
    let agents = [];
    try {
      const js = svc('jobs');
      if (js && typeof js.list === 'function') {
        // ⚠️ 必须传 **agent.id 字符串**，不能传 agent 对象。
        // DSH 官方用法是 jobs.list(agent?.id)（见 app.asar 的 updateTaskControl），
        // 传对象会让它返回空数组 → 空闲门永远判定「没有在飞工作」→
        // 回合一结束就播报（2026-10-19 用户演示空闲门时实测抓到）。
        // 单测没发现：测试直接喂 collectInFlight 的假数据，绕过了本函数。
        //
        // 另照官方做法补查「无 agent 的全局任务」——有些后台任务不属于任何 agent。
        const aid = agent && agent.id !== undefined ? agent.id : undefined;
        const mine = js.list(aid) || [];
        const glob = aid === undefined ? [] : (js.list(undefined) || []);
        jobs = mine.concat(glob);
      }
    } catch (e) {
      console.warn('[dsh-notify-say] jobs.list failed: ' + String((e && e.message) || e));
    }
    try {
      const as = svc('agents');
      if (as && typeof as.list === 'function') agents = as.list() || [];
    } catch (e) {
      console.warn('[dsh-notify-say] agents.list failed: ' + String((e && e.message) || e));
    }
    return collectInFlight(jobs, agents, agent && agent.id);
  }

  /**
   * 记录「为什么这一次没有播报」。
   *
   * ## 为什么需要它
   *
   * 用户 2026-10-17 问「刚才那次完成了怎么没响」。当时我查不出来，因为：
   *   - 去抖拦下 → **完全不写日志**
   *   - 事件开关关闭 → **完全不写日志**
   *   - 空闲门挂起 → 只写 console（宿主 stdout，不在 notify.log）
   *
   * 也就是说，只有「播了」才有记录，「没播」是黑盒。这条缺陷比任何功能都更该先修：
   * 看不到原因，就无法判断是配置问题还是代码问题，也没法回答用户的疑问。
   *
   * ## 统一格式
   *
   *   YYYY-MM-DD HH:MM:SS [skip] <reason> kind=<kind> sess=<id> <detail>
   *
   * 与 ps1 写的 `[toast]` / `[preview]` 行共用同一个 notify.log，便于对照阅读。
   *
   * @param {string} reason 简短的机器可读原因：debounce / switch-off / subagent / idle-gate / ...
   * @param {string} kind   事件类别（completed/error/blocked/...）
   * @param {object} session
   * @param {string} [detail] 附加说明（如具体时长、哪个开关）
   */
  function skipLog(reason, kind, session, detail) {
    try {
      const sid = session && session.id !== undefined ? String(session.id) : '?';
      const line = `[skip] ${reason} kind=${kind || '?'} sess=${sid}${detail ? ' ' + detail : ''}`;
      // 与 ps1 相同的落点，便于在同一文件里对照「播了 / 没播」
      appendNotifyLog(line);
    } catch { /* 日志失败绝不影响主流程 */ }
  }

  /** 实际播报（按会话去抖 + 可选跨会话冷却；返回是否真的发出）。 */
  function emitDone(session, psKind, title, body) {
    const key = sessionKey(session);
    const now = Date.now();

    // ── 第一级：同会话去抖 ────────────────────────────────────────────────
    // 语义：同一会话连续完成多次，只提醒最后一次（几乎是噪音）。
    // 可调为 0 表示关闭 —— 有人希望"每个结果都听见"。
    if (cfg.debounceMs > 0 && isRecent(lastTurnNotify, key, now, cfg.debounceMs)) {
      // 去抖拦下时**必须留痕**：这是最容易被误判成"插件坏了"的情形
      skipLog('debounce', psKind, session,
        `same session within ${Math.round(cfg.debounceMs / 1000)}s`);
      return false;
    }

    // ── 第二级：跨会话冷却（v0.4.7）──────────────────────────────────────
    //
    // 语义完全不同，所以是**独立**的一级：
    //   · 同会话去抖 = "这次和上次是同一件事，别重复"
    //   · 跨会话冷却 = "我已经被叫过来了，不必再叫"
    //
    // 用户 2026-10-17 指出两类人诉求相反：
    //   A 型：每个结果都要听见，否则不知道做完了 → 默认关闭（0）
    //   B 型：听到一个就过来盯着了，再响就烦 → 自己打开
    // 所以默认值为 0（关闭），保持现有行为不变。
    if (cfg.globalCooldownMs > 0) {
      const lastAny = Number(lastAnyNotifyAt) || 0;
      if (lastAny > 0 && now - lastAny < cfg.globalCooldownMs) {
        skipLog('global-cooldown', psKind, session,
          `any session within ${Math.round(cfg.globalCooldownMs / 1000)}s `
          + `(last ${Math.round((now - lastAny) / 1000)}s ago)`);
        return false;
      }
    }

    rememberAt(lastTurnNotify, key, now);
    lastAnyNotifyAt = now;
    notify(psKind, title, body, session);
    return true;
  }

  /** 清除某个会话的挂起项（含计时器）。 */
  function clearPending(id) {
    const p = pendingDone.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    pendingDone.delete(id);
  }

  /** 兑现挂起项：播报一次。viaTimeout 表示是超时兜底（文案加提示，不误导为"全部完成"）。 */
  function flushPending(id, viaTimeout) {
    const p = pendingDone.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    pendingDone.delete(id);
    const body = viaTimeout ? `${p.body}（仍有子任务在跑，先提醒你）` : p.body;
    // 这条是「终于播了」，不是「跳过」——用 [flush] 前缀，避免与 [skip] 混淆。
    // （独立审查 2026-10-17 指出：原先写成 [skip] idle-gate-flush，会让人误判成没播。）
    appendNotifyLog(`[flush] idle-gate kind=${p.psKind} sess=${sessionKey(p.session)} `
      + (viaTimeout ? 'timeout-fallback' : 'worktree-idle'));
    emitDone(p.session, p.psKind, p.title, body);
  }

  /**
   * 空闲门：工作树空闲就播报，否则挂起等待。
   * 挂起期间新的同类完成会重置挂起项（合并为一次播报）。
   */
  function scheduleOrNotify(session, agent, psKind, title, body) {
    const id = sessionKey(session);
    const inflight = inFlightOf(agent);
    if (inflight.length === 0) {
      clearPending(id);
      emitDone(session, psKind, title, body);
      return;
    }
    clearPending(id);
    const timer = setTimeout(() => flushPending(id, true), cfg.idleGateTimeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    pendingDone.set(id, { session, psKind, title, body, timer, inflight });
    // 双写：console（宿主 stdout，开发/测试断言用）+ notify.log（用户与事后排查用）。
    // 之前只写 console，导致用户问"刚才怎么没响"时在 notify.log 里查不到任何痕迹；
    // 但**不能**用 notify.log 取代 console —— 既有测试与宿主日志都依赖这一行。
    console.log(`[dsh-notify-say] idle-gate: 挂起完成播报，等待 ${inflight.length} 项在飞工作 `
      + `(${inflight.map((i) => i.kind + ':' + i.id).join(', ')})`);
    skipLog('idle-gate-hold', psKind, session,
      `waiting ${inflight.length} inflight (${inflight.map((i) => i.kind + ':' + i.id).join(', ')})`);
  }

  /**
   * 重估所有挂起项（由 jobs 变化 / agent 状态变化触发）。
   * 三种归宿：① 主会话已重新 running → 取消（用户已在交互）；② 工作树空闲 → 播报；
   * ③ agent 已消失 → 视为结束，播报。
   */
  function reevaluatePending(trigger) {
    if (pendingDone.size === 0) return;
    for (const id of [...pendingDone.keys()]) {
      const p = pendingDone.get(id);
      if (!p) continue;
      let agent;
      try {
        const as = svc('agents');
        agent = as && typeof as.get === 'function' ? as.get(id) : undefined;
      } catch { agent = undefined; }
      if (!agent) { flushPending(id, false); continue; }
      if (agent.status === 'running') { clearPending(id); continue; }
      const inflight = inFlightOf(agent);
      if (inflight.length === 0) {
        flushPending(id, false);
      } else {
        p.inflight = inflight;
      }
    }
  }

  /** completed / error / blocked / 其它 四分支 → 文案 + 门控 → 交给空闲门。 */
  function handleDone(session, agent, kind) {
    let gate;
    let psKind;
    let title;
    let body;
    if (kind === 'completed') {
      gate = cfg.notifyOnComplete; psKind = 'done';
      title = 'DSH 任务完成'; body = '一轮任务跑完了，回来看看结果吧';
    } else if (kind === 'error') {
      // v0.3.1：error 改播 fail 语句池（日语道歉语音，用户 2026-10-17 拍板）。
      // 池缺失时由 ps1 侧落到系统蜂鸣——**不**回落到 done 池（否则会播成"完成了"）。
      gate = cfg.notifyOnError; psKind = 'fail';
      title = 'DSH 回合出错'; body = '上一轮回合以错误结束，回来看看出了什么问题';
    } else if (kind === 'blocked') {
      // blocked = 消息/目标轮次被 preStep 拦下、**根本没跑起来**（见 dsh-agent-loop:941），
      // 不是"跑了但失败"，故维持蜂鸣而非 fail 池的"失败"台词（语义不同，别混）。
      // 实测：近 20 天 932 个会话中 "kind":"blocked" 命中 0 次，属极罕见路径。
      gate = cfg.notifyOnBlocked; psKind = 'chime';
      title = 'DSH 回合被阻塞'; body = '回合已阻塞，可能需要你介入处理';
    } else {
      // aborted / max-tokens / interrupted / forked：默认静默（notifyOnAborted）
      gate = cfg.notifyOnAborted; psKind = 'chime';
      title = 'DSH 回合提前结束'; body = '回合结束原因：' + (kind || 'unknown');
    }
    // ── Toast 标题改用会话标题（v0.4.62）─────────────────────────────────
    //
    // 用户指出：既然点 Toast 跳不到对应会话，那至少让标题告诉用户
    // "是哪个会话完成了"。DSH 的侧栏标题就是首句话摘要，比「DSH 任务完成」有用。
    // 只用「看起来像标题」的结果 —— 拿不到真标题时 sessionTitleOf 会退回
    // 会话 id 前缀（如 session-2cc3），那东西当 Toast 标题毫无意义，还不如通用文案。
    const sTitle = sessionTitleOf(session);
    if (sTitle && !/^session[-_]?/i.test(sTitle) && sTitle !== '未知会话') title = sTitle;

    // 事件类别开关关闭 → 不播
    if (!gate) {
      // 必须报**真实生效的配置键**，不能从 kind 名拼。
      // 独立审查 2026-10-17 指出：原先用 `notifyOn${kind首字母大写}`，
      // 对 max-tokens/interrupted/forked 会拼出 `notifyOnMax-tokens` 这类不存在的键。
      const gateKey = kind === 'completed' ? 'notifyOnComplete'
        : kind === 'error' ? 'notifyOnError'
          : kind === 'blocked' ? 'notifyOnBlocked'
            : 'notifyOnAborted';
      skipLog('switch-off', kind, session, `${gateKey}=false`);
      return;
    }
    // 空闲门只对「完成」生效：error/blocked 是**当下就需要人介入**的信号，
    // 等子代理结束再报会延误处理；它们立即播报（error 走 fail 语句池，不进空闲门）。
    if (cfg.idleGate && kind === 'completed' && agent) {
      scheduleOrNotify(session, agent, psKind, title, body);
      return;
    }
    emitDone(session, psKind, title, body);
  }

  /** 审批提醒正文。 */
  function approvalBody(toolName, reason) {
    return '待批准：' + (toolName || '未知') + (reason ? '，' + reason : '');
  }

  /**
   * approval/asked（SessionEventMap 审计事件，带稳定 id）：主提醒路径。
   * 幂等：同 id 只提醒一次；同会话同工具在去抖窗内只响一次（连串审批）。
   */
  function handleApprovalAsked(session, data) {
    // 审批提醒：开关关闭、或该会话被过滤（子代理）→ 不播
    if (!cfg.notifyOnApproval || !shouldNotifySession(session)) {
      skipLog(cfg.notifyOnApproval ? 'subagent-filtered' : 'switch-off', 'approval', session,
        cfg.notifyOnApproval ? 'subagents=false' : 'notifyOnApproval=false');
      return;
    }
    const id = data && data.id ? 'id:' + String(data.id) : '';
    const toolName = (data && data.toolName) || '未知';
    const reason = data && data.reason ? String(data.reason) : '';
    const now = Date.now();
    const stKey = 'session:' + sessionKey(session) + '|' + toolName;
    if (isRecent(approvalSeen, stKey, now, cfg.approvalDebounceMs)) {
      skipLog('debounce', 'approval', session, `same tool within ${Math.round(cfg.approvalDebounceMs / 1000)}s`);
      return;
    }
    if (id && approvalSeen.has(id)) {
      skipLog('dedupe', 'approval', session, `already-notified id=${id}`);
      return;
    }
    rememberAt(approvalSeen, stKey, now);
    if (id) rememberAt(approvalSeen, id, now);
    notify('approval', 'DSH 需要你确认', approvalBody(toolName, reason), session);
  }

  /** approval/decided：清除该请求的幂等标记，之后的同类新审批可再次提醒。 */
  function handleApprovalDecided(data) {
    const id = data && data.id ? 'id:' + String(data.id) : '';
    if (id) approvalSeen.delete(id);
  }

  /**
   * 会话标题（正文线索 + v0.4.62 起兼作 Toast 标题）。
   *
   * 三级来源（前一级拿不到就试下一级）：
   *   ① `sessionTitle` 服务 —— 宿主自己维护的标题（支持 rename），最权威；
   *   ② `sessionProjections` 的 `title` 投影 —— 2026-10-19 实测 436 个会话全部有，
   *      内容通常就是用户首句摘要（「优化Deepseek Harness配置与插件」）；
   *   ③ 会话 id 前 12 位 —— 丑陋但至少能区分（旧插件 :433-439 同构）。
   *
   * ⚠️ 为什么要有 ②：① 在某些宿主版本/时机下取不到（服务缺失或尚未生成），
   * 而投影缓存里已经有标题了。两者都拿不到才退回 id。
   */
  function sessionTitleOf(session) {
    try {
      const svcTitle = svc('sessionTitle');
      const snap = svcTitle && typeof svcTitle.get === 'function' ? svcTitle.get(session) : undefined;
      if (snap && snap.title) return String(snap.title);
    } catch { /* 服务不可用 → 试下一级 */ }
    try {
      const proj = svc('sessionProjections');
      if (proj && typeof proj.stateOf === 'function') {
        const v = proj.stateOf(session, 'title');
        // 防御两种形状：直接字符串，或 { ver, seq, val } 行。
        const s = typeof v === 'string' ? v : (v && typeof v.val === 'string' ? v.val : '');
        const t = String(s || '').trim();
        if (t) return t;
      }
    } catch { /* 投影不可用 → 退回 id */ }
    const k = sessionKey(session);
    return k === '__unknown__' ? '未知会话' : k.slice(0, 12);
  }

  /** 提问提醒（方案C）：tool/call 命中提问工具 → kind=question（question 语句池语音）。 */
  function handleQuestionCall(session, d) {
    if (!QUESTION_TOOLS.has(d.name)) return;
    if (!cfg.notifyOnQuestion || !shouldNotifySession(session)) {
      skipLog(cfg.notifyOnQuestion ? 'subagent-filtered' : 'switch-off', 'question', session,
        cfg.notifyOnQuestion ? 'subagents=false' : 'notifyOnQuestion=false');
      return;
    }
    const callId = String(d.callId || '');
    const key = sessionKey(session) + ':' + callId;
    const now = Date.now();
    if (isRecent(questionSeen, key, now, QUESTION_TTL_MS)) {
      skipLog('dedupe', 'question', session, `same callId=${callId} already notified`);
      return;
    }
    rememberAt(questionSeen, key, now);
    const q = questionSummary(d.name, d.arguments);
    notify('question', 'DSH 在等你回答', '[' + sessionTitleOf(session) + '] ' + q.text + q.hint, session);
  }

  /** tool/result 配对（content[0].toolCallId ↔ tool/call.callId）→ 清理标记（回答已产生）。 */
  function handleQuestionResult(session, d) {
    const cid = d && d.message && d.message.content && d.message.content[0] && d.message.content[0].toolCallId;
    if (cid) questionSeen.delete(sessionKey(session) + ':' + String(cid));
  }

  console.log(`[dsh-notify-say] active (complete=${cfg.notifyOnComplete} error=${cfg.notifyOnError} `
    + `blocked=${cfg.notifyOnBlocked} aborted=${cfg.notifyOnAborted} approval=${cfg.notifyOnApproval} `
    + `question=${cfg.notifyOnQuestion} voice=${cfg.voice}/${cfg.voiceMode} debounce=${Math.round(cfg.debounceMs / 1000)}s `
    + `idleGate=${cfg.idleGate} idleGateTimeout=${Math.round(cfg.idleGateTimeoutMs / 1000)}s)`);

  // ── 会话事件流：turn/end 记 reason + approval/asked、approval/decided 审计对 + 提问 ──
  ctx.on('session/event', (session, event) => {
    // v0.4.36：记一次"事件到达"。
    //
    // 用途只在排查：热重载窗口内如果有事件到达但没播报，
    // 重载完成后会打印差值，让"漏播"可被区分出来。
    // 不影响任何播报行为。
    bumpEventCount()
    try {
      const type = event && event.type;
      if (type === 'turn/end') {
        // 只记账不播报：播报由 agent/status 的 running→idle 边沿触发（更接近"真空闲"，
        // 且能在用户连发多轮时自然合并为一次）。
        rememberBounded(lastTurnEnd, sessionKey(session), { kind: reasonKindOf(event.data), at: Date.now() }, Date.now(), (v) => v && v.at);
      } else if (type === 'approval/asked') handleApprovalAsked(session, event.data);
      else if (type === 'approval/decided') handleApprovalDecided(event.data);
      else if (type === 'tool/call') handleQuestionCall(session, event.data);
      else if (type === 'tool/result') handleQuestionResult(session, event.data);
    } catch (e) {
      // 只读旁路：观测/提醒失败绝不影响会话
      console.warn('[dsh-notify-say] session/event handler failed: ' + String((e && e.message) || e));
    }
  }, { global: true });

  // ── agent 状态边沿：running→idle 判完成；任何变化都重估挂起项 ────────────
  // 依据：agent/status 文档「idle means no driver remains scheduled or active」
  // （dsh-agent/lib/types/runtime-types.d.ts:247）。子代理的 idle 正是唤醒信号。
  ctx.on('agent/status', (payload) => {
    try {
      const agent = payload && payload.agent;
      if (!agent) return;
      const status = payload.status;
      const id = String(agent.id);
      const prev = prevStatus.get(id);
      // 有界记账（值带时间戳，供 TTL 清理用；读边沿时取 .status）
      rememberBounded(prevStatus, id, { status, at: Date.now() }, Date.now(), (v) => v && v.at);
      // 子代理结束 / 主会话状态变化 → 重估挂起项
      reevaluatePending('agent/status');
      if (status !== 'idle' || !prev || prev.status !== 'running') return;
      if (!shouldNotifySession(agent.session)) {
        // 这是**最常见**的一类"不播"：子代理会话完成、而 subagents=false。
        // 独立审查 2026-10-17 指出这里原先漏了留痕，恰是用户最想在日志里看到的。
        const rec0 = lastTurnEnd.get(id);
        skipLog('subagent-filtered', rec0 && rec0.kind ? rec0.kind : 'completed',
          agent.session, 'subagents=false');
        return;
      }
      const rec = lastTurnEnd.get(id);
      // 取不到 reason 时按 completed 处理（fail-visible：宁可多播，不静默用户的任务）
      handleDone(agent.session, agent, rec && rec.kind ? rec.kind : 'completed');
    } catch (e) {
      console.warn('[dsh-notify-say] agent/status handler failed: ' + String((e && e.message) || e));
    }
  }, { global: true });

  // ── 后台任务可见集变化 → 重估挂起项（"最后一个任务结束"的唤醒路径）────────
  try {
    const js = svc('jobs');
    if (js && typeof js.onJobsChanged === 'function') {
      ctx.effect(() => js.onJobsChanged(() => {
        try { reevaluatePending('jobs-changed'); } catch (e) {
          console.warn('[dsh-notify-say] jobs-changed reevaluate failed: ' + String((e && e.message) || e));
        }
      }), 'dsh-notify-say: jobs-changed');
    }
  } catch (e) {
    console.warn('[dsh-notify-say] jobs.onJobsChanged unavailable: ' + String((e && e.message) || e));
  }

  // ── 卸载清理：挂起计时器与状态（监听器由插件 fiber 自动回收）──────────────
  ctx.effect(() => () => {
    for (const p of pendingDone.values()) clearTimeout(p.timer);
    pendingDone.clear();
    prevStatus.clear();
    lastTurnEnd.clear();
    // v0.4.63：长轮询的挂起响应也要结束掉。不做的后果是热重载后
    // 旧连接永远等不到响应，客户端不会再发新的 /wait（它以为还在等）。
    try { bridge.disposeAllWaiters(); } catch { /* 卸载期失败不影响退出 */ }
  }, 'dsh-notify-say: pending timers');

  // ── 审批 waterfall：必须 next() 放行并透传返回值，绝不阻断、不改写 ──────
  // 接缝证据：dsh-user-approval/lib/index.js:176（fail-closed 默认保持官方语义）。
  // 主要提醒路径是 approval/asked；本 listener 是放行同刻的兜底提醒（asked 先于
  // waterfall 入账，正常情况下会被上面的去抖去重，只在 asked 不可观测时兜底）。
  ctx.on('approval/request', (req, next) => {
    try {
      const session = req && req.agent && req.agent.session;
      if (cfg.notifyOnApproval && shouldNotifySession(session)) {
        const toolName = req && req.toolName;
        const reason = req && req.reason ? String(req.reason) : '';
        const now = Date.now();
        const stKey = 'session:' + sessionKey(session) + '|' + (toolName || '未知');
        if (!isRecent(approvalSeen, stKey, now, cfg.approvalDebounceMs)) {
          rememberAt(approvalSeen, stKey, now);
          notify('approval', 'DSH 需要你确认', approvalBody(toolName, reason), session);
        }
      }
    } catch {
      // 通知侧任何失败都不影响审批链；next() 在 try 外调用
    }
    return next();
  }, { global: true });

  // ── host → client 桥（两条 route，同一前缀）────────────────────────────────
  //
  // client 跑在 sandbox 渲染进程里（无 process、无 fs），既拿不到"刚才是哪个会话
  // 通知的"，也改不了配置。官方正路：host 注册 /api/… route，client 用 fetch
  // （本机先例 dsh-our-free-model）。
  //
  //   1. session bridge：点 Toast 后跳到对应会话
  //   2. config route ：设置卡片里直接读写音量/音色/开关（改完立即生效）
  //
  // 稳定性：`webServer` 是**可选依赖**，拿不到就整体跳过；
  // Toast 与语音完全不受影响 —— 这两条都是增强，不是主功能。
  try {
    if (ctx && typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (scoped) => {
        try {
          const server = scoped && scoped.webServer;
          if (!server || typeof server.register !== 'function') return;
          const reg = () => server.register(
            { kind: 'prefix', path: ROUTE_PREFIX, handler: (req, res) => {
              // 同一前缀下按路径分流：`/config…` 走配置读写，其余走会话桥。
              //
              // ⚠️ 必须按**路径段**判断，不能用 `url.indexOf('/config') >= 0`：
              // 子串匹配会被查询串里的内容骗到（例如 `/consume?next=/config`）。
              // 这里取 pathname 再去掉前缀，只比较第一段。
              try {
                const raw = String((req && (req.url || req.path)) || '');
                const pathname = raw.split('?')[0].split('#')[0];
                const rest = pathname.startsWith(ROUTE_PREFIX)
                  ? pathname.slice(ROUTE_PREFIX.length)
                  : pathname;
                const head = rest.replace(/^\/+/, '').split('/')[0];
                // ── 本地来源防护（v0.4.24）─────────────────────────────────
                //
                // ⚠️ 实测 2026-10-18：宿主 /api 网关有鉴权（无凭据 401），
                // 但插件 webServer.register 的路由**不在保护范围内** ——
                // 不带凭据 POST config/set 返回 200 且真的改了配置。
                // 恶意网页可用 <img>/<form> 触发本机回环请求（不触发 CORS 预检）。
                //
                // 防护逻辑见 lib/http-guard.js。这里做"分流前的总闸"，
                // 各端点内部的限流用 throttle()。

                // ── 写操作判定（v0.4.39 扩展）──────────────────────────────
              //
              // ⚠️ 原来只认 config/set 与 consume，而 v0.4.32+ 新增的三个接口
              // **都会写本机文件**却没被标成写操作：
              //   · voicepacks/install    下载并解压到用户目录
              //   · voicepacks/uninstall  删除用户目录下的音色
              //   · diagnostics           把日志脱敏后写入磁盘
              //
              // 后果：这些请求按「只读」放行 —— 不做 Origin/跨站检查，
              // 也不强制 JSON content-type，与模块自己的安全契约不符。
              // （外部审阅 2026-10-18 指出。）
              const isWriteRoute =
                (head === 'config' && /\/set\b/.test(pathname))
                || head === 'consume'
                // v0.4.63：/ack 只摘一条（前台跳转后确认），同样是写操作
                || head === 'ack'
                || head === 'diagnostics'
                || (head === 'voicepacks' && (/\/install\b/.test(pathname) || /\/uninstall\b/.test(pathname)))
                // v0.4.57：一次性自重载会 dispose 当前实例并重新求值模块，
                // 是不可逆副作用，按写操作处理。
                || head === 'reload';
                const guard = checkLocalOrigin(req, { write: isWriteRoute });
                if (!guard.ok) {
                try {
                res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                res.end(JSON.stringify({ ok: false, reason: guard.reason }));
                } catch { /* 响应已发出 */ }
                return;
                }

                // ── 检查更新（v0.4.48）──────────────────────────────────
        //
        // **只读**：不下载、不覆盖文件、不执行命令。
        // 也刻意不放进 isWriteRoute —— 它没有任何副作用。
        //
        // 为什么不接受客户端传 URL：那等于让本机访问任意地址（SSRF）。
        // 查询地址固定在 update-check.js 里。
        // ── 一次性自重载（v0.4.57）──────────────────────────────────
        //
        // 用户 2026-10-18 明确要求：「点一下重载一下」，不要"开了就一直重载"。
        // 所以这里是**纯显式动作**：没有任何自动触发（watcher 已删除）。
        //
        // 只接受 POST —— 它不可逆。
        if (head === 'reload') {
          if (String((req && req.method) || 'GET').toUpperCase() !== 'POST') {
            try {
              res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', allow: 'POST' });
              res.end(JSON.stringify({ ok: false, reason: 'method-not-allowed' }));
            } catch { /* 响应已发出 */ }
            return;
          }
          if (!reloadOnce) {
            try {
              res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
              res.end(JSON.stringify({ ok: false, reason: 'reload-unavailable' }));
            } catch { /* 响应已发出 */ }
            return;
          }
          // 限流：5 秒内只允许一次（防连点、也防脚本反复触发 dispose）
          const rlGate = throttle('reload', 5000);
          if (!rlGate.ok) {
            try {
              res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'retry-after': String(Math.ceil((rlGate.retryAfterMs || 1000) / 1000)) });
              res.end(JSON.stringify({ ok: false, reason: 'throttled', retryAfterMs: rlGate.retryAfterMs }));
            } catch { /* 响应已发出 */ }
            return;
          }
          // ⚠️ 成功后当前实例已被 dispose、新实例接管 ——
          // 这个响应**可能发不出去**。客户端必须把"请求失败"也当作
          // "可能已重载"，提示用户刷新页面。
          Promise.resolve()
            .then(() => reloadOnce())
            .then((r) => {
              try {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                res.end(JSON.stringify(r));
              } catch { /* 响应已发出 */ }
            })
            .catch((e) => {
              try {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                res.end(JSON.stringify({ ok: false, reason: 'exception', error: String((e && e.message) || e) }));
              } catch { /* 响应已发出 */ }
            });
          return;
        }

        if (head === 'version') {
          // ?force=1 表示用户手动点了「检查更新」，绕过 24 小时缓存
          const force = /[?&]force=1\b/.test(String((req && req.url) || ''));
          //
          // ⚠️ 必须包一层 catch：检查更新永远不该把设置页弄崩。
          // 网络不通是常态（用户可能在离线环境），此时只报错误，
          // 通知与语音完全不受影响。
          Promise.resolve()
            .then(() => checkForUpdate({
              pluginRoot: PLUGIN_ROOT,
              // ⚠️ 传「正在运行的代码版本」（PLUGIN_VERSION 在模块加载时读一次）。
              // 与磁盘 package.json 分开：用户可在 DSH 运行期间升级插件，
              // 那时磁盘是新的、跑的还是旧的 —— 界面该提示「重启生效」而非「已是最新」。
              runningVersion: PLUGIN_VERSION,
              force,
              cache: UPDATE_CACHE,
            }))
            .then((r) => {
              try {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                res.end(JSON.stringify(r));
              } catch { /* 响应已发出 */ }
            })
            .catch((e) => {
              try {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
              } catch { /* 响应已发出 */ }
            });
          return;
        }

        if (head === 'config') return configRoute.handler(req, res);

                // ── 自测端点（v0.4.11）────────────────────────────────────
                //
                // 从 HTTP 直接触发一次真实 notify()，**绕开会话事件**。
                //
                // 为什么需要：2026-10-17 遇到"完成任务完全没反应、连弹窗都没有"。
                // 此时无法区分是
                //   ① 会话事件没进插件（事件处理器丢了）
                //   ② 事件进来了但 notify() 坏了
                // 有了这个端点就能二分：/selftest 能弹窗出声 → notify 好、问题在事件；
                // 否则 → notify 链路坏了。
                // ── 诊断导出（v0.4.35）────────────────────────────────────
        //
        // 读日志 → 脱敏（用户名/路径/长 token）→ 写到日志同目录，
        // 返回路径给界面显示。
        //
        // 为什么必须 POST：它会**写文件**。用 GET 的话，
        // 任意网页放个 <img src=".../diagnostics"> 就能让本机反复生成文件。
        if (head === 'diagnostics') {
          if (String((req && req.method) || 'GET').toUpperCase() !== 'POST') {
            try {
              res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'POST' });
              res.end(JSON.stringify({ ok: false, reason: 'method-not-allowed' }));
            } catch { /* 响应已发出 */ }
            return;
          }
          try {
            const r = exportDiagnostics({
              version: PLUGIN_VERSION,
              logLevel: (cfg && cfg.logLevel) || 'info',
            });
            res.writeHead(r.ok ? 200 : 500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify(r));
          } catch (e) {
            try {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
            } catch { /* 响应已发出 */ }
          }
          return;
        }

        // 语音包管理（异步：会下载与写盘）
        if (head === 'voicepacks') {
          Promise.resolve(voicePackRoute.handle(req, res, head, pathname))
            .catch((e) => {
              try {
                res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, reason: 'internal', error: String((e && e.message) || e) }));
              } catch { /* 响应已发出 */ }
            });
          return;
        }

        if (head === 'selftest') {
                  // ── 限流（v0.4.24）──────────────────────────────────────────
                  // preview / selftest 会真的出声、真的起子进程。恶意网页可以用
                  // <img src=".../preview"> 反复触发 —— 既骚扰又是资源放大。
                  // 3 秒一次：够用户手点试听，又不足以被刷。
                  const gate = throttle(head === 'selftest' ? 'selftest' : 'preview', 3000)
                  if (!gate.ok) {
                  try {
                  res.writeHead(429, {
                  'content-type': 'application/json; charset=utf-8',
                  'cache-control': 'no-store',
                  'retry-after': String(Math.ceil((gate.retryAfterMs || 1000) / 1000)),
                  })
                  res.end(JSON.stringify({ ok: false, reason: 'throttled', retryAfterMs: gate.retryAfterMs }))
                  } catch { /* 响应已发出 */ }
                  return
                  }
                  try {
                    const q = raw.split('?')[1] || '';
                    const km = /kind=([a-z]+)/.exec(q);
                    const tk = km ? km[1] : 'done';
                    notify(tk, '插件自测', '看到这个弹窗说明 notify 通路正常', null);
                    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: true, kind: tk }));
                  } catch (e) {
                    try {
                      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
                      res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
                    } catch { /* ignore */ }
                  }
                  return;
                }

                // ── 试听端点（v0.4.17）──────────────────────────────────────
                //
                // **只出声，不弹窗**（ps1 的 -Preview）。用途：
                //   · 调「语音包增益」时听效果 —— 不然只能盲调
                //   · 换发音人/音色后确认是想要的
                //   · 换自定义音频后确认选对了文件
                //
                // 与 /selftest 的区别：selftest 走完整 notify()（含 Toast），
                // 用来验证"通知通路"；这里只验证"声音对不对"。
                //
                // 支持 ?kind=done|fail|question|approval|blocked|chime，
                // 默认 done。参数按**当前生效配置**组装，所以听到的就是
                // 真实播报的效果（含增益、发音人、按事件覆盖）。
                if (head === 'preview') {
                  // ── 限流（v0.4.24）──────────────────────────────────────────
                  // preview / selftest 会真的出声、真的起子进程。恶意网页可以用
                  // <img src=".../preview"> 反复触发 —— 既骚扰又是资源放大。
                  // 3 秒一次：够用户手点试听，又不足以被刷。
                  const gate = throttle(head === 'selftest' ? 'selftest' : 'preview', 3000)
                  if (!gate.ok) {
                  try {
                  res.writeHead(429, {
                  'content-type': 'application/json; charset=utf-8',
                  'cache-control': 'no-store',
                  'retry-after': String(Math.ceil((gate.retryAfterMs || 1000) / 1000)),
                  })
                  res.end(JSON.stringify({ ok: false, reason: 'throttled', retryAfterMs: gate.retryAfterMs }))
                  } catch { /* 响应已发出 */ }
                  return
                  }
                  try {
                    const q = raw.split('?')[1] || '';
                    const km = /kind=([a-z]+)/.exec(q);
                    const pk = km ? km[1] : 'done';
                    refreshConfig();
                    const aKind = audioKindOf(pk) || 'done';
                    // 试听统一走 bundled 语义（选曲 + 增益），
                    // 这样"调增益听效果"这件事对语音包最直接。
                    // 若用户当前音源是 tts/custom，则按各自参数试听。
                    const src = resolveSource(aKind, cfg);
                    if (src === 'tts') {
                      const line = ttsTextFor(pk);
                      const vVoice = kindOr(cfg.kindTtsVoice, aKind, cfg.ttsVoice);
                      const vRate = kindOr(cfg.kindTtsRate, aKind, cfg.ttsRate || 0);
                      const ttsArgs = [
                        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File',
                        TTS_PATH, '-Text', line, '-Volume', String(cfg.volume), '-Rate', String(vRate),
                      ];
                      if (vVoice) ttsArgs.push('-VoiceName', vVoice);
                      spawnTts(ttsArgs);
                    } else if (src === 'custom') {
                      const file = resolveCustomFile(aKind, cfg);
                      const a = baseNotifyArgs(pk, '试听', '', false);
                      a.push('-Preview');
                      if (file) {
                        a.push('-CustomFile', file);
                        if (cfg.normalizeCustomAudio === true) {
                          a.push('-Gain', String(Number(cfg.voiceGain) > 1 ? Number(cfg.voiceGain) : 2.0));
                        }
                      } else {
                        a.push('-SystemSound', 'auto');
                      }
                      spawnNotify(a);
                    } else if (src === 'system') {
                      const a = baseNotifyArgs(pk, '试听', '', false);
                      a.push('-Preview', '-SystemSound', 'auto');
                      spawnNotify(a);
                    } else if (src === 'none') {
                      // 静音模式：不折腾，直接告知
                      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                      res.end(JSON.stringify({ ok: true, kind: pk, source: 'none', note: '当前设为不出声' }));
                      return;
                    } else if (src === 'bundled') {
                      // 语音包：选曲 + 按峰值限幅的增益
                      const a = baseNotifyArgs(pk, '试听', '', false);
                      a.push('-Preview');
                      const g = Number(cfg.voiceGain);
                      if (Number.isFinite(g) && g > 1) a.push('-Gain', String(g));
                      spawnNotify(a);
                    } else {
                      // 未知音源：退回系统提示音，绝不静默（试听没声音最让人困惑）
                      const a = baseNotifyArgs(pk, '试听', '', false);
                      a.push('-Preview', '-SystemSound', 'auto');
                      spawnNotify(a);
                    }
                    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: true, kind: pk, source: src, gain: cfg.voiceGain }));
                  } catch (e) {
                    try {
                      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
                      res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
                    } catch { /* ignore */ }
                  }
                  return;
                }
              } catch { /* 分流失败就落到默认分支 */ }
              return bridge.handler(req, res);
            } },
            'dsh-notify-say: api',
          );
          if (scoped && typeof scoped.effect === 'function') scoped.effect(reg, 'dsh-notify-say: api');
          else reg();
        } catch (e) {
          console.warn('[dsh-notify-say] api route 注册失败（跳会话/设置卡片不可用，其余功能正常）：'
            + String((e && e.message) || e));
        }
      });
    }
  } catch {
    // webServer 不存在 / inject 不支持：静默降级
  }

  // ── 开发期自热重载（默认关闭）────────────────────────────────────────────
  //
  // 背景（2026-10-17 实测教训）：宿主只在启动时加载一次本文件，之后改磁盘上的
  // 代码**不会**生效 —— 我改了 audioSource 默认值，磁盘是新的，宿主仍按旧逻辑
  // 走 bundled→system，导致每次完成都静默。那时唯一解是重启 DSH。
  //
  // 机制移植自本机 dsh-our-free-model 的 src/reload.js（详见 lib/dev-reload.js
  // 的模块注释，含"必须用 Map.prototype.delete"这个关键点）。
  //
  // **默认关闭**：
  //   - 生产安装不会重写自己的文件，开着只是多一条可能出错的路径；
  //   - 它依赖 ctx.loader.internal / ctx.registry / ctx.fiber 三个非公开对象，
  //     DSH 升级可能变；关着就不会受影响。
  //
  // 开启方式：cordis.patch.yml 或 config.json 里设 `devReload: true`。
  //
  // ⚠️ 防无限循环：重载后新实例的 apply 会**再次**读到 devReload=true，
  // 若不做标记就会重载→重载→…。故用 globalThis 上的时间戳做冷却：
  // 30 秒内已重载过就跳过。key 带插件名，避免与其它插件冲突。
  // ── 一次性自重载的实现（v0.4.57）──────────────────────────────────────
  //
  // 用户要求：点一下重载一次；不点就不动。这里只是**把能力准备好**，
  // 不做任何自动触发 —— 触发点只有 `POST /reload`（设置页的按钮）。
  //
  // ## 为什么删掉 watcher
  //
  // 2026-10-18 实测它把宿主拖崩，崩溃日志两条硬证据：
  //   ① 45 条「fingerprint unchanged（旧代码仍在运行）」
  //      —— 那天为调 UI 改了 40 多次文件，每次保存触发一次注定失败的尝试；
  //   ② 同一时刻反复「Session reference "..." is released」
  //      —— 每次重载都 dispose 旧实例，而 dispose 会释放渲染进程仍在用的
  //         会话引用；反复几十次后渲染进程拿到损坏的 client 包，
  //         抛 SyntaxError，宿主退出。
  //
  // 结论：危险的不是"失败"，是"**反复**"。一次点击一次尝试，不再累积。
  reloadOnce = async function () {
    // ① 前置：磁盘内容与当前实例相同 → 什么都不做
    //
    // 同一件事的"没变"判断放在最前面，因为它最省钱也最安全：
    // 代码没变就不该 dispose 任何东西。
    let diskFingerprint = '';
    try { diskFingerprint = computeFingerprint(PLUGIN_ROOT); } catch { /* 读不到就继续 */ }
    // ② 决策抽在 dev-reload.js 的 planReload() —— 纯函数，可完整测试。
    //
    //    代码没变            → noop（一次 dispose 都不做）
    //    插件根真实路径变了  → 拒绝，告知必须重启
    //    确实变了            → reload（一次）
    let nowReal = '';
    try { nowReal = realpathSync(PLUGIN_ROOT); } catch { /* 解不开就不比 */ }
    const plan = planReload({
      diskFingerprint,
      runningFingerprint: fingerprint,
      resolvedRootAtLoad: RESOLVED_PLUGIN_ROOT,
      resolvedRootNow: nowReal,
    });
    if (plan.action === 'noop') {
      return { ok: true, noop: true, reason: plan.reason, fingerprint };
    }
    if (plan.action === 'refuse-path-changed') {
      return { ok: false, reason: plan.reason, hint: plan.hint };
    }

    // ③ 一次尝试。失败**不重试**，直接如实返回让用户去重启。
    const eventsBefore = readEventCount();
    let r;
    try {
      r = await selfReload(ctx, {
        logger: console,
        expectedFingerprint: undefined,
        differFrom: fingerprint,
        diskFingerprint,
      });
    } catch (e) {
      return { ok: false, reason: 'exception', error: String((e && e.message) || e) };
    }

    if (r && r.ok) {
      // 重载窗口内是否观察过事件（只作排查参考，不是漏报数 ——
      // 口径见 EVENT_COUNTER_KEY 的注释）。
      let observed = 0;
      try { observed = readEventCount() - eventsBefore; } catch { /* ignore */ }
      appendNotifyLog('[reload] OK by-user' + (observed > 0 ? ' observed=' + observed : ''));
      return {
        ok: true,
        reason: 'reloaded',
        fibers: r.fibers,
        busted: !!r.busted,
        verified: !!r.verified,
        observed,
      };
    }

    const err = String((r && r.error) || 'unknown');
    appendNotifyLog('[reload] FAILED ' + err);
    return {
      ok: false,
      reason: 'reload-failed',
      error: err,
      restored: !!(r && r.restored),
      hint: '自重载没有成功，旧代码仍在运行 —— 请重启 DSH。',
    };
  };

}

// ── 官方 Config schema 导出（v0.4.0）─────────────────────────────────────────
//
// 这是「设置页 GUI」的官方入口：DSH 0.1.7+ 的 Loader 自动接管插件导出的 `Config`，
// 在设置页生成表单，无需自建 client 半侧、无需 `slots`（未文档化、历史上被无声改过）。
//
// 源码侧契约（本机 app.asar 实证）：
//   - `volatileForm(schema)` 为 undefined 时抛 `Plugin entry "<ns>" has no volatile fields`
//   - 写入非 volatile 路径时抛 `Config field "<path>" is not volatile`
//   → 故 lib/config-schema.js 里**每个字段**都调了 `.volatile()`。
//
// 关键：**schema 加载失败时不能导出坏对象**，否则插件可能整体加载失败。
// 拿不到 schemastery 时导出 `undefined`（等价于「本插件不提供表单」），
// 插件功能完全不受影响，只是设置页不出现。宁可少一个页面，不可少一个插件。
const _schema = (() => {
  try {
    const z = loadSchema(process.env, { log: (m) => console.warn('[dsh-notify-say] ' + m) });
    if (!z) return undefined;
    return buildConfig(z);
  } catch (e) {
    try {
      console.warn('[dsh-notify-say] Config schema 构建失败，设置页将不出现（插件功能不受影响）：'
        + String((e && e.message) || e));
    } catch { /* 连日志都失败就算了 */ }
    return undefined;
  }
})();

export const Config = _schema;

/**
 * 本模块所在代码的"代际指纹"（v0.4.20）。
 *
 * ## 为什么需要
 *
 * 热重载要能回答一个问题：**刚才那次重载，真的把新代码换上了吗？**
 *
 * 只检查"re-import 返回了新对象"是不够的 —— 那只证明**入口**被重新求值了，
 * 不证明它 import 的依赖也换了。2026-10-17 实测就出现过
 * "config-store.js 换了、index.js 没换"（或反之）的半新半旧状态，
 * 而重载照样报 ok:true，排查时被误导了好几轮。
 *
 * ## 它是什么
 *
 * 一个**在模块求值时就固定下来**的标记：
 *   · 由本模块的 import.meta.url 派生（含代际查询串）
 *   · 加上加载时间戳
 *
 * 关键在于：它是**模块顶层的 const**，一旦求值就冻结。
 * 所以：
 *   · 如果重载真的重新求值了本模块 → 得到**新的** fingerprint
 *   · 如果还是旧模块（缓存没清掉）→ 读到**旧的** fingerprint
 *
 * 重载流程拿它和"磁盘期望值"比对，两者一致才算真生效。
 *
 * 注意：它**不是**文件内容哈希（那要读盘，太重）。
 * 它只证伪"没换"，不证明"内容对" —— 内容对不对由文件系统负责。
 */
/**
 * 本模块**代码内容**的指纹（v0.4.20）。
 *
 * ## 为什么需要
 *
 * 热重载要能回答：**刚才那次重载，真的把新代码换上了吗？**
 *
 * 只检查"re-import 返回了新对象"是不够的 —— 那只证明**入口**被重新求值了，
 * 不证明它 import 的依赖也换了。2026-10-17 实测就出现过
 * "config-store.js 换了、index.js 没换"（或反之）的半新半旧状态，
 * 而重载照样报 ok:true，排查时被误导了好几轮。
 *
 * ## 为什么是"源码哈希"而不是"代际标记"
 *
 * 第一版用的是 `import.meta.url`（含代际查询串），结果**判断力反了**：
 * 代际一变 URL 就变、指纹就变，于是"代码没改但重新求值了"也被判成
 * "新代码已生效" —— 校验形同虚设（S2 测试当场抓到）。
 *
 * 现在改为对**本模块文件自身的字节**做哈希：
 *   · 代码没改 → 无论如何重新求值，指纹都一样 → 拒绝了假成功 ✅
 *   · 代码改了 → 指纹不同 → 认可生效 ✅
 *
 * 读盘成本可接受：只在模块求值那一刻做一次（几 KB~几十 KB）。
 *
 * ## 依赖了什么
 *
 * `import.meta.url`（去掉查询串）+ `node:fs`。若沙箱读不到文件，
 * 退化为空串，`verifyReload` 会据此判失败（宁可报错也不假成功）。
 */
export const fingerprint = (() => {
  try {
    // ⚠️ 必须覆盖**整个 lib/ 目录**，不能只算 index.js。
    //
    // 2026-10-18 实测踩到：只算 index.js 时，改 http-guard.js /
    // client.js / config-store.js 都不会改变指纹 —— 而 verifyReload 的
    // differFrom 规则要求「新指纹必须不同于旧实例」，于是热重载每次报
    // `fingerprint unchanged`，而代码其实已经改了。
    //
    // 当时没暴露，是因为那几次改的都是 index.js 本身。
    //
    // 复用 dev-reload.js 的 computeFingerprint：
    // 它覆盖 package.json + lib/*.js，用大小与 mtime 混合哈希，
    // 足够灵敏又不必每次读几百 KB 全文。
    const pkgDir = fileURLToPath(new URL('..', import.meta.url));
    return computeFingerprint(pkgDir);
  } catch {
    return '';
  }
})();



