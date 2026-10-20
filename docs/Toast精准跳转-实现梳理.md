# Toast 精准跳转 —— 实现梳理与外部审查材料

> 生成时间：2026-10-20
> 版本：v0.4.78（已真机验证通过）
> 用途：供外部独立审查；记录完整实现、失败历史、已知取舍

---

## 一、需求

用户原话（2026-10-19 提出，2026-10-20 强化）：

> 「点这个 Toast 比在左边找会话切换来的方便，而且既然它播报了的话，无脑点 Toast 它可以立马过去看结果」

具体两条硬要求：

1. **播报与跳转必须分离** —— 播报时不跳，**只有点了 Toast 才跳**
2. **点哪个 Toast 就跳哪个会话** —— 多会话同时有通知时不能跳错

以及一条兼容性要求：

> 「做成开关式……兼容性也会好一点」

---

## 二、为什么不能简单实现

### 2.1 官方协议 `dsh://open` 无法携带参数（已验证）

DSH 本体在 `app.asar` 里的实现是**精确匹配**：

```js
if (url === "dsh://open" || url === "dsh://open/") focusPrimaryWindow();
```

`dsh://open?session=xxx` **连窗口都不会拉起来**（不是"忽略参数"，是"完全不匹配"）。

因此必须注册自有协议才能识别"点的是哪个 Toast"。

### 2.2 Toast 点击与前端 JS 是**两个世界**

这是整个设计的关键约束：

| 时机 | 代码在哪 | 能否直接调 `ui.openSession()` |
|---|---|---|
| 播报时 | DSH 前端（渲染进程 JS）| ✅ 能 |
| 点 Toast | **Windows 调起的独立进程** | ❌ 不能，碰不到前端 |

所以点 Toast 必须有**中转**：

```
Toast 点击
  → Windows 调起协议处理器（独立进程）
  → 处理器把 sessionId 写进 HTTP 端点（pending-jump）
  → DSH 前端轮询/事件触发时读到
  → 前端调 ui.openSession()
```

**这条中转链上任何一环断了，表现都是"点了没反应"** —— 今天排查 8 小时，就是因为 9 个环节里坏了 9 个。

---

## 三、完整链路（当前实现）

```
┌──────────────────────────────────────────────────────────────────┐
│ 1. 播报时：插件构造 Toast                                        │
│    lib/index.js → notifyArgs()                                   │
│      if (jumpSid) args.push('-SessionId', jumpSid)               │
│      jumpSid = cfg.toastJumpSession && jumpProtoState==='ok'     │
│                && sessionIdForArgs ? sessionIdForArgs : ''       │
└──────────────────────────┬───────────────────────────────────────┘
                           ↓
┌──────────────────────────────────────────────────────────────────┐
│ 2. dsh-notify.ps1 生成 Toast                                     │
│    $toastLaunch = 'dshnotify://jump?session=' + $SessionId       │
│    （SessionId 不合法或为空则退回 'dsh://open'）                 │
│    写进 Toast 的 XML <toast launch="...">                        │
└──────────────────────────┬───────────────────────────────────────┘
                           ↓ 用户点击
┌──────────────────────────────────────────────────────────────────┐
│ 3. Windows 按注册表调起协议处理器                                 │
│    HKCU\Software\Classes\dshnotify\shell\open\command =          │
│      "wscript.exe" "jump-handler.vbs" "%1"                       │
│                                                                  │
│    ⚠️ 必须用 wscript（GUI 子系统），不能用 powershell.exe        │
│       后者在协议调起场景下必弹可见控制台窗口                     │
└──────────────────────────┬───────────────────────────────────────┘
                           ↓
┌──────────────────────────────────────────────────────────────────┐
│ 4. jump-handler.vbs                                              │
│    · 解析 dshnotify://jump?session=<id>                          │
│    · 白名单校验 ^[A-Za-z0-9_-]{4,128}$                            │
│    · 从 %LOCALAPPDATA%\dsh-notify-say\port.txt 读端口            │
│    · POST http://127.0.0.1:<port>/api/dsh-notify-say/pending-jump │
│      （带 Origin 头，过 http-guard）                             │
│    · sh.Run "cmd /c start """" dsh://open", 0, False （唤窗）    │
└──────────────────────────┬───────────────────────────────────────┘
                           ↓
┌──────────────────────────────────────────────────────────────────┐
│ 5. lib/index.js 的 /pending-jump 端点                            │
│    POST → pendingJump = { sessionId, at }                        │
│            日志 [jump-click] session=xxx from=...                │
│    GET  → 返回并**消费**（一次性），120 秒过期                    │
└──────────────────────────┬───────────────────────────────────────┘
                           ↓
┌──────────────────────────────────────────────────────────────────┐
│ 6. lib/client.js 前端读取（三条触发路径）                        │
│    ① onVisibility：窗口变可见 + 有 pending → 读                 │
│    ② tryTopJump：window.focus / document.mousedown → 读         │
│    ③ **5 秒探活兜底**：轮询循环每 5 秒也调一次 tryTopJump()     │
│        （③ 是必需的 —— 见 §5.4）                                 │
│    读到后 → openSession(ctx, sessionId)                          │
└──────────────────────────┬───────────────────────────────────────┘
                           ↓
┌──────────────────────────────────────────────────────────────────┐
│ 7. openSession() → ctx.get('uiWorkspace').openSession(sid)       │
│    日志 [ui] openSession CALL sid=xxx via=<调用栈>               │
└──────────────────────────────────────────────────────────────────┘
```

---

## 四、关键设计决策与理由

### 4.1 为什么用「HTTP 端点中转」而不是写文件/IPC

| 方案 | 问题 |
|---|---|
| 写临时文件 + 前端轮询文件 | 前端在 sandbox 渲染进程，**没有 fs 权限**（`sandbox:true` / `nodeIntegration:false`）|
| 命名管道 / 本地 socket | 同上，前端拿不到 |
| **HTTP 回环（当前）** | 前端本来就用 fetch 调宿主 API，零新增权限 |

### 4.2 为什么用 VBS 而不是 PowerShell

**用户实测三次报告"点 Toast 打开一个命令行窗口"。**

根因：`powershell.exe -WindowStyle Hidden -File xxx.ps1` 在协议调起场景下**仍会显示控制台**。`-WindowStyle` 只影响 PowerShell 自己的宿主窗口，**不改父进程已经传下来的 console**（协议启动时那个 console 已存在）。

`wscript.exe` 是 **GUI 子系统**程序，**根本不创建控制台** —— 这是根治。

附带好处：VBS 启动几毫秒，PowerShell 冷启动 300–800ms。

### 4.3 为什么端口要写进 port.txt

DSH 每次启动**端口都变**（实测见过 `53523` / `50061` / `59525` / `58163` / `55510`）。

处理器是独立进程，不知道当前端口。早期实现硬编码几个候选端口，**必然漏**。

现在：插件在注册路由时把 `server.address().port` 写进 `%LOCALAPPDATA%\dsh-notify-say\port.txt`，VBS 优先读它。

### 4.4 为什么 5 秒探活是必需的（不是冗余）

`tryTopJump` 原本只挂在 `window.focus` 和 `document.mousedown` 上。但：

> 用户原话：「我就是 DSH 在前台的，我点的跳转」

**DSH 在前台时点系统 Toast**：
- 窗口本来就聚焦 → `window.focus` **不会触发**（没有焦点变化）
- 点的是系统 Toast，不是页面 → `document.mousedown` **不会触发**

→ 两个监听都不会来。**必须有定时兜底。**

代价：最多 5 秒延迟。对"点完看一眼结果"这个场景可接受。

### 4.5 为什么 `toastJumpSession=true` 时要禁用旧的自动跳

v0.4.62 起有个旧行为：**窗口变可见 + 队列里有未读完成记录 → 立刻跳过去**。

用户开了精准跳转后，这个旧行为和"点了才跳"冲突：

> 用户原话：「还没点就跳回来了」

一从别的窗口切回来就被旧路径带走，根本没机会点 Toast。

现在语义清晰：
- `toastJumpSession = true` → **只认点了 Toast**
- `toastJumpSession = false` → 保留旧自动跳（不想开协议的用户）

---

## 五、失败历史（9 个 bug，供审查者理解脆弱点）

**这一节是全文档最重要的部分。** 功能"看起来实现了"很久，但每次都有新故障，因为链路上每一环都错得很隐蔽。

| # | Bug | 表现 | 为什么难发现 |
|---|---|---|---|
| ① | `-WindowStyle Hidden` 配 `-Command` | 注册总是失败 | powershell 直接 `exit=-1`、无输出 |
| ② | `HKCU:` 驱动器在 Node spawn 下返回空 | probe 永远 `missing` | `status=0`、`stderr` 空，只是没输出 |
| ③ | `jump-handler.ps1` 用了 JS 的 `/** */` 注释 | 处理器从不执行 | PowerShell 整文件语法错误，但协议"调起成功"、注册表也正常 |
| ④ | `-SessionId` 插在 `ValidateSet` 与 `-LogLevel` 之间 | 播报全挂（只剩蜂鸣）| ValidateSet 被错套到 SessionId 上，报"不属于集合 info,debug" |
| ⑤ | 处理器硬编码候选端口 | 端口一变就失效 | DSH 每次启动端口都不同 |
| ⑥ | `/log` 端点被 `git checkout` 冲掉 | 前端日志全丢 | 前端静默失败，看起来像"前端没加载新代码" |
| ⑦ | **`baseUrl()` 从未定义** | **前端永远读不到 pending-jump** | 抛 `ReferenceError` 被 `.catch` 吞成 `null` |
| ⑧ | `powershell.exe` 协议调起必弹窗 | 用户看到命令行窗口 | `-WindowStyle` 不改协议继承的 console |
| ⑨ | probe 只认 `jump-handler.ps1` | 换成 vbs 后误判 `foreign` | 自己的注册被当成"别人的" |

### 5.1 最致命的是 ⑦

```js
// v0.4.70 ~ v0.4.77 的真实代码
function fetchPendingJump() {
  return fetch(baseUrl() + '/pending-jump', {...})   // ← baseUrl 不存在！
    .catch(function () { return null })               // ← 异常被吞
}
```

**前端从 v0.4.70 到 v0.4.77 从来没有成功读取过 pending-jump。** 每次调用都抛 `ReferenceError`，被 catch 吞成 `null`，然后当成"没有待跳转"。

这就是为什么 `[jump-click]` 一直有记录、但 `openSession CALL` 一直是 0。

### 5.2 ③ 和 ⑦ 的共同教训

**"静默失败"是本功能最大的敌人。** 两个 bug 都是：
- 代码路径确实执行了
- 但抛的异常被 `catch` 吞掉
- 外部表现是"什么都没发生"

现在所有关键节点都写日志（含调用栈），`/log` 端点让前端也能上报。

### 5.3 为什么改了这么多轮才通

因为**链路上 9 个环节串行**，每个坏了表现都一样（点了没反应）。修好第 1 个才能暴露第 2 个。唯一的办法是**逐层加可观测性**。

---

## 六、安全性

### 6.1 协议处理器（VBS）

- 只接受 `dshnotify://jump?session=<id>` 形态，其它静默退出
- `session` 白名单：`^[A-Za-z0-9_-]{4,128}$`
- **不执行任何传入内容**（不 eval、不拼命令行）

**风险（如实说明）**：任何本机程序都能调起本协议并伪造 sessionId。后果是"DSH 跳到一个会话" —— 无害。恶意网页理论上可触发，但要先让浏览器认 `dshnotify://` 协议，且最多造成误跳。

### 6.2 `/pending-jump` 端点

- 写操作必须 JSON content-type（`<form>` 发不出）
- Origin/Referer 必须是本机回环（`lib/http-guard.js`）
- 读操作一次性消费，120 秒过期
- sessionId 白名单校验

### 6.3 已知取舍

- **不防本机进程**：本机进程能伪造 Origin，但它在 Windows 上本来就能读你的文件，不是这个模块该解决的层
- **注册表写在 HKCU**：不需要管理员，卸载时删自己那个键，不碰别人的

---

## 七、卸载与降级

### 7.1 完整闭环（用户明确要求）

> 「既然注册了，以后的删除就要考虑，然后以及它不生效要考虑」

| 场景 | 行为 |
|---|---|
| 用户关掉 `toastJumpSession` | 主动注销协议（删 HKCU 那个键） |
| 协议注册失败 | 降级为 `dsh://open` —— "点了没反应"比"跳不到会话"更糟 |
| `uiWorkspace` 不可用 | 不跳转，只唤窗（旧行为） |
| 任何一环异常 | 只影响跳转，**不影响播报** |

### 7.2 为什么卸载 hook 里**不**注销协议

```js
// lib/index.js 的 dispose
// ⚠️ 这里**不能**调 unregisterJumpProtocol()
```

因为 **DSH 热重载时也会执行 dispose**（旧实例销毁），会把用户刚注册好的协议注销掉。实测日志：

```
00:21:06 [jump-proto] unregistered dshnotify://
```

之后所有 Toast 的 launch 又变回 `dsh://open`。

正确注销时机只有：① 用户关开关；② 插件真的被卸载（重装动作）。

---

## 八、验证方法（可复现）

### 8.1 单元测试

```powershell
cd <插件目录>
npm run test:all     # 506 + 26 通过
```

### 8.2 端到端验证（不依赖用户操作）

```powershell
# 模拟点击 Toast（等价于 Windows 调起协议）
Start-Process "dshnotify://jump?session=<真实会话id>"

# 等 ≤5 秒（探活间隔），然后看日志
Get-Content "$env:TEMP\dsh-notify-say\notify.log" -Tail 20 |
  Select-String 'jump-click|openSession'

# 期望：
#   [jump-click] session=xxx from=http://127.0.0.1:<port>
#   [ui] openSession CALL sid=xxx via=...
```

### 8.3 处理器独立验证

```powershell
# VBS 有自己的诊断日志
cscript //nologo <插件目录>\jump-handler.vbs "dshnotify://jump?session=session-test1234"
Get-Content "$env:TEMP\dsh-notify-say\jump-handler.log"
```

期望输出：
```
[recv]   "dshnotify://jump?session=session-test1234"
[parse]  sid=session-test1234
[port]   from port.txt=55510
[posted] port=55510 status=200
[open]   dsh://open
```

---

## 九、已知遗留问题

| 项 | 说明 | 优先级 |
|---|---|---|
| 5 秒延迟 | 探活兜底导致最多 5 秒才跳 | 低（可接受）|
| 旧 `jump-handler.ps1` 保留 | 作为 VBS 不可用时的回退，但已无必要 | 低（可清理）|
| 恶意网页可致误跳 | 见 §6.1，影响有限 | 低 |
| `port.txt` 可能过期 | DSH 崩溃后残留旧端口 → VBS 会逐个试候选 | 低（有兜底）|
| 多显示器/DPI | 未测试 | 待验证 |

---

## 十、给审查者的具体问题

请重点看这几处：

1. **§三 第 6 步的三条读取路径**（`onVisibility` / `tryTopJump` / 5 秒探活）会不会**重复跳转**？会不会有竞态？
2. **`pending-jump` 一次性消费**在多窗口/多标签场景下是否安全？（消费即清，但前端可能有多个读取者）
3. **VBS 的毫秒时间戳计算**：`DateDiff("s", #1/1/1970#, Now()) * 1000` —— 精度只到秒，够用吗？（前端判断 120 秒过期）
4. **`port.txt` 的信任边界**：本机任何程序都能改写它，导致 VBS 把 sessionId POST 到恶意端口。这个风险可接受吗？
5. **卸载清理**：§7.2 说热重载时不能注销协议，那"用户真的卸载插件"时靠什么清理？现在的实现是否有残留？

---

## 附：相关文件

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 协议注册/注销/probe、`/pending-jump` 端点、`/log` 端点、参数构造 |
| `lib/client.js` | 前端：读 pending-jump、调 `ui.openSession`、三条触发路径 |
| `jump-handler.vbs` | **协议处理器（当前）**，wscript 调起，无控制台窗口 |
| `jump-handler.ps1` | 旧版处理器（回退用），有弹窗问题 |
| `dsh-notify.ps1` | 生成 Toast，把 sessionId 写进 `launch` |
| `lib/http-guard.js` | 本地来源防护 |
| `lib/config-schema.js` | `toastJumpSession` / `jumpWhenBackground` / `jumpWhenForeground` / `multiJumpRule` |
