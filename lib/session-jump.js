/**
 * 会话跳转决策（纯函数，无 IO、无 DOM 依赖）。
 *
 * ## 要解决的问题
 *
 * Windows Toast 的 `launch` 是**固定字符串** `dsh://open`
 * （ps1 里 `<toast activationType="protocol" launch="dsh://open">`；官方只支持唤窗，
 * 且 `main.ts:1238` 是整串精确匹配，加参数就失效），所以**拿不到"点的是哪条通知"**。
 * 无法做到"精确地只在点通知时跳转"。
 *
 * ## 折中方案：把选择权交给用户（两个独立开关）
 *
 * 不再替用户决定"哪种情况该跳"，而是暴露两个开关，组合出四种行为：
 *
 * | jumpWhenBackground | jumpWhenForeground | 行为 | 适合谁 |
 * |---|---|---|---|
 * | ✅ | ❌ | 只在后台完成时跳 | 回来看结果的人（默认） |
 * | ✅ | ✅ | 都跳 | 想一眼看到刚完成内容的人 |
 * | ❌ | ✅ | 只在前台跳 | 少见，但允许 |
 * | ❌ | ❌ | 都不跳 | 想自己按绿点确认的人 |
 *
 * **关键洞察**：用户 2026-10-17 指出——有人**故意不跳**，因为想自己回来按绿点
 * 逐个确认哪些完成了；也有人希望前台完成时也跳过去看一眼。这两种诉求都合理，
 * 所以不该由实现者替他们选。
 *
 * ## "前台/后台"如何判定
 *
 * 用事件时序，不依赖 host（client 不会在通知那一刻收到消息）：
 *
 *   - `visibilitychange → hidden`：记 `leftAt = now`（用户离开了）
 *   - `visibilitychange → visible`：若有未消费通知，比较 `notify.at` 与 `leftAt`
 *
 *     - `notify.at >= leftAt` ⇒ 通知是在用户离开期间到达的 ⇒ **后台完成**
 *     - `notify.at <  leftAt` ⇒ 通知到达时用户还在看 ⇒ **前台完成**
 *
 * **不设时效**：任务结果哪怕 10 分钟后才回来看也仍未看过，跳转依然合理
 * （用户明确指正过：加时效是多余限制）。
 *
 * ## 已知边界（无法消除，写进 GUI 折叠说明）
 *
 * 用户**直接点任务栏图标**而非点 Toast 时，信号与"点 Toast 唤窗"完全相同，无法区分。
 * 这是 `dsh://open` 只能唤窗、不带参数导致的，不是本实现的疏忽。
 */

/** 跳转判定结果（字符串便于日志与测试断言）。 */
export const JUMP_DECISIONS = Object.freeze({
  /** 跳 */
  JUMP: 'jump',
  /** 前台完成，但用户关了"前台也跳" */
  SKIP_FOREGROUND: 'skip-foreground',
  /** 后台完成，但用户关了"后台也跳" */
  SKIP_BACKGROUND: 'skip-background',
  /** 没有待跳转的通知 */
  SKIP_NO_PENDING: 'skip-no-pending',
  /** 已消费过，防重复跳转 */
  SKIP_CONSUMED: 'skip-consumed',
  /** 不知道用户何时离开（首次加载等）→ 保守不跳 */
  SKIP_UNKNOWN_LEFT: 'skip-unknown-left',
  /** 两个开关都关了 */
  SKIP_DISABLED: 'skip-disabled',
});

/** 默认：只在后台完成时跳（最常见诉求：回来看结果）。 */
export const DEFAULT_JUMP = Object.freeze({
  jumpWhenBackground: true,
  jumpWhenForeground: false,
});

/**
 * 判定是否应该跳转。
 *
 * @param {object} input
 * @param {boolean} [input.jumpWhenBackground] 后台完成时是否跳（默认 true）
 * @param {boolean} [input.jumpWhenForeground] 前台完成时是否跳（默认 false）
 * @param {boolean} [input.consumed]   该通知是否已被消费
 * @param {string}  [input.sessionId]  待跳转会话 id（空表示无）
 * @param {number}  [input.notifiedAt] host 记录的通知时间戳（ms）
 * @param {number}  [input.leftAt]     client 观测到"窗口变为隐藏"的时间戳（ms），0/未定义表示未知
 * @param {number}  [input.returnedAt] client 观测到"窗口变回可见"的时间戳（ms）；
 *                                     0/未定义表示"离开后还没回来过"
 * @returns {{ decision: string, jump: boolean, phase: string }}
 *   `phase` = 'background' | 'foreground' | 'unknown'，便于日志排查
 */
export function decideJump(input) {
  const i = input || {};

  // 两个开关都关 → 功能关闭。缺省按默认值（后台开、前台关）。
  const bg = i.jumpWhenBackground === undefined ? DEFAULT_JUMP.jumpWhenBackground : i.jumpWhenBackground !== false;
  const fg = i.jumpWhenForeground === undefined ? DEFAULT_JUMP.jumpWhenForeground : i.jumpWhenForeground === true;
  if (!bg && !fg) return { decision: JUMP_DECISIONS.SKIP_DISABLED, jump: false, phase: 'unknown' };

  if (!i.sessionId) return { decision: JUMP_DECISIONS.SKIP_NO_PENDING, jump: false, phase: 'unknown' };
  if (i.consumed === true) return { decision: JUMP_DECISIONS.SKIP_CONSUMED, jump: false, phase: 'unknown' };

  const left = Number(i.leftAt);
  const at = Number(i.notifiedAt);
  // ⚠️ returnedAt 可能是 undefined/NaN —— 必须显式归一为 0 表示"还没回来"。
  // 直接用 Number(undefined) 会得到 NaN，而 `NaN <= 0` 是 false，
  // 会让"还没回来"被误判成"已经回来了"，进而把后台通知判成前台（实测踩到）。
  const retRaw = Number(i.returnedAt);
  const ret = Number.isFinite(retRaw) ? retRaw : 0;
  if (!Number.isFinite(left) || left <= 0) {
    // 不知道用户何时离开 → 无法判断前台/后台 → 保守不跳
    return { decision: JUMP_DECISIONS.SKIP_UNKNOWN_LEFT, jump: false, phase: 'unknown' };
  }
  if (!Number.isFinite(at) || at <= 0) {
    return { decision: JUMP_DECISIONS.SKIP_NO_PENDING, jump: false, phase: 'unknown' };
  }

  // 通知是否落在「用户不在的那段时间」内？
  //
  // 区间判定（第一版只比 leftAt，导致"离开过一次之后前台判定永久失效"）：
  //   at >= left                    → 在离开之后到达（必要条件）
  //   returnedAt == 0               → 还没回来过，所以仍在离开期间
  //   at <  returnedAt              → 在回来之前到达 → 确实不在
  // 三条同时成立才算「后台完成」。
  const inAwayWindow = at >= left && (ret <= 0 || at < ret);

  if (inAwayWindow) {
    return bg
      ? { decision: JUMP_DECISIONS.JUMP, jump: true, phase: 'background' }
      : { decision: JUMP_DECISIONS.SKIP_BACKGROUND, jump: false, phase: 'background' };
  }

  // 通知到达时用户还在看 ⇒ 前台完成
  return fg
    ? { decision: JUMP_DECISIONS.JUMP, jump: true, phase: 'foreground' }
    : { decision: JUMP_DECISIONS.SKIP_FOREGROUND, jump: false, phase: 'foreground' };
}

/**
 * 把 `visibilityState` 归一成布尔：窗口是否"不在前台"。
 *
 * @param {object} doc 形如 `document`
 * @returns {boolean} true = 不可见/最小化/被遮挡
 */
export function isHidden(doc) {
  try {
    if (!doc) return true;
    if (typeof doc.visibilityState === 'string') return doc.visibilityState === 'hidden';
    if (typeof doc.hidden === 'boolean') return doc.hidden;
    return false;
  } catch {
    return true;
  }
}

/**
 * 跟踪「用户离开 / 回来的时刻」。
 *
 * ## 为什么必须同时记录"回来"
 *
 * 第一版只记 `leftAt`（visible → hidden）。**这是一个逻辑缺陷**（独立审查 2026-10-17 指出）：
 *
 *   用户离开过一次之后，`leftAt` 就永远停在那个旧值；
 *   此后哪怕他一直坐在窗口前，任何新通知的 `notifiedAt >= leftAt` 都成立
 *   → 被判成「后台完成」→ 在他眼前强行跳转。
 *
 * 也就是说，"前台不跳"这条规则会**永久失效**。修法是把判定改成区间：
 *
 *   通知落在 [leftAt, returnedAt) 内 ⇒ 用户当时确实不在 ⇒ 后台完成
 *   通知 >= returnedAt           ⇒ 用户已经在看     ⇒ 前台完成
 *
 * ## 语义
 *
 * - `leftAt`：最后一次 visible → hidden 的时刻
 * - `returnedAt`：最后一次 hidden → visible 的时刻（离开过才有值）
 * - 两者都为 0 表示"从未观测到切换"（页面一直可见，或刚加载）
 *
 * @returns {{
 *   onVisibility: (doc: object, now: number) => void,
 *   leftAt: () => number,
 *   returnedAt: () => number,
 *   reset: () => void,
 * }}
 */
export function createLeaveTracker() {
  let leftAt = 0;
  let returnedAt = 0;
  let wasHidden = false;
  let seen = false;

  return {
    /** 每次 visibilitychange 调用；只在状态边沿记录时间。 */
    onVisibility(doc, now) {
      const hidden = isHidden(doc);
      const t = Number.isFinite(now) ? now : Date.now();
      if (!seen) {
        // 首次运行：一进来就隐藏的（页面在后台被加载），记为"离开中"
        seen = true;
        wasHidden = hidden;
        if (hidden) leftAt = t;
        return;
      }
      if (hidden && !wasHidden) {
        leftAt = t;       // 可见 → 隐藏：用户离开了
        returnedAt = 0;   // 新一轮离开，旧的回来说明作废
      } else if (!hidden && wasHidden) {
        returnedAt = t;   // 隐藏 → 可见：用户回来了
      }
      wasHidden = hidden;
    },
    /** 最后一次"离开"的时间戳；0 表示未知。 */
    leftAt() {
      return leftAt;
    },
    /** 最后一次"回来"的时间戳；0 表示离开后还没回来过。 */
    returnedAt() {
      return returnedAt;
    },
    /** 跳转成功后调用，避免下次回来重复跳。 */
    reset() {
      leftAt = 0;
      returnedAt = 0;
    },
  };
}

