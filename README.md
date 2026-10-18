# dsh-notify-desktop

给 [DeepSeek Harness](https://github.com/deepseek-ai) Desktop 用的通知插件：**任务跑完会说话**。

> 别的通知插件"叮"一声；这个会喊你"主人、任务完成了"。
> 而且**子代理还在跑的时候，它不会骗你说完成了**。

---

## 它解决什么问题

你让 AI 跑一个较长任务，然后切去干别的。常见两种通知插件的毛病：

1. **该响的时候不响** —— 主会话一轮结束就报"完成"，但其实它派出的子代理还在跑，你回来发现没干完。
2. **不该响的时候一直响** —— 每个子代理结束都弹一次，连环轰炸。

本插件的做法：

- **空闲门（idle gate）**：主会话这轮结束、但仍有子代理或后台任务在跑时，**先不播**；等全部结束再播**一次**。超时（默认 10 分钟）兜底，防子任务卡死导致永不播报。
- **按会话去抖**：同一会话 60 秒内只响一次。
- **失败单独提醒**：回合出错时播**日语道歉语音**（可选），比"任务完成"更该让你立刻知道。

---

## 特性

| 特性 | 说明 |
|---|---|
| **语音播报** | 本地 wav，不联网、不调用云端 TTS。发布版附 1 个音色，其余可按需下载 |
| **空闲门** | 有在飞工作时不误报"完成"，全部结束才播一次 |
| **五类事件** | 完成 / 出错 / 被拦截 / 待批准 / 要提问，各自独立开关 |
| **设置页 GUI** | 走官方 `Config` schema，DSH 设置页自动生成表单 |
| **命令行** | `tools/notify-config.ps1`，改完**立即生效、不用重启** |
| **点通知跳会话** | 点击 Toast 可直接回到对应会话（拿不到导航服务时自动降级为"唤出窗口"） |
| **不装语音也能用** | 没有语音包 = Toast + 系统提示音，这是正常配置 |
| **全离线** | 不联网、不发送任何会话内容 |

---

## 安装

### 前置

- DSH Desktop **0.1.7-rc.2 或更高**
- Windows（Toast 用 WinRT，播放用 MCI；暂不支持 macOS/Linux）

### 方式一：插件页（推荐）

在 DSH 的 **设置 → 插件** 里搜索 `dsh-notify-desktop` 安装。

### 方式二：手工 link（本地开发）

把本仓库目录链接进 profile：

```
D:\Program Files (x86)\DSH\profiles\desktop\package.json
  dependencies 里加:  "dsh-notify-desktop": "link:<本仓库路径>"
  dsh.profile.bundles 里加:  "dsh-notify-desktop"
```

然后在该 profile 目录执行 `pnpm install`，重启 DSH。

---

## 配置

三种方式，优先级由低到高（后者覆盖前者）：

```
1. schema 默认值
2. cordis.patch.yml 的 config
3. DSH 设置页里改的值
4. tools/notify-config.ps1 写的 storages/config.json
```

> ⚠️ **注意语义**：一旦你在设置页改过某项，再改 `cordis.patch.yml` 里同一项**不再生效**。
> 这是 DSH 官方设计（用户层优先级更高），不是本插件的 bug。

### 设置页

DSH **设置 → 通知**（由官方 Loader 从本插件的 `Config` schema 自动生成），共 12 项：

语音开关、音色模式（固定/随机）、音色名、音量，
以及完成/出错/被拦截/已中止/待批准/要提问/子代理/空闲门 八个开关。

### 命令行

```powershell
cd <插件目录>\tools

.\notify-config.ps1 -Show              # 看当前生效值
.\notify-config.ps1 -Voice off         # 静音（Toast 仍弹）
.\notify-config.ps1 -Volume 40
.\notify-config.ps1 -VoiceMode random
.\notify-config.ps1 -VoiceName ankomon
.\notify-config.ps1 -Disable aborted -Enable subagents
.\notify-config.ps1 -Clear             # 交还控制权给设置页
```

改完**立即生效**，不需要重启 DSH。

### 语音包管理

核心包只带**一个日语音色**（ずんだもん），体积约 2.8 MB。
完整多音色包体积较大（十余个音色约 40 MB），故不随包发布 —— 计划通过单独下载提供（尚未实现）。

```powershell
.\notify-config.ps1 -ListPacks         # 看已装哪些音色、各占多少
.\notify-config.ps1 -PurgeVoice <key>  # 删掉不用的音色
.\notify-config.ps1 -InstallHint       # 看怎么获取更多音色
```

**不装任何语音包也完全可用**：通知会退回 Windows Toast + 系统提示音。

想要更多音色，两条路：

1. **自己合成**：装 [VOICEVOX](https://voicevox.hiroshiba.jp/)（本地免费 TTS），启动引擎（默认 `http://127.0.0.1:50021`），
   然后按下面的命名规则把合成好的 wav 放进对应目录即可。
   （合成脚本不随本包发布——它依赖本地 VOICEVOX 引擎与特定音色表，放在发布包里只会误导。）
2. **手工放入**：把 wav 按下面的命名放进对应目录

```
sounds/voice-lines/<key>~1.wav            完成
sounds/voice-lines/question/<key>~1.wav   提问
sounds/voice-lines/approval/<key>~1.wav   审批
sounds/voice-lines/fail/<key>~1.wav       出错
```

---

## 兼容性与降级

本插件的首要目标是**稳定**，所以每个依赖外部能力的地方都有降级路径：

| 能力 | 拿不到时怎么办 |
|---|---|
| `@deepseek-ai/schemastery`（生成设置页） | 不导出 `Config` → **设置页不出现，插件照常工作** |
| `uiWorkspace.openSession`（点通知跳会话） | 不跳转，Toast 仍能唤出窗口（**退回旧行为**） |
| 语音包 | 回退系统提示音 |
| `$DSH_HOME` 未设置 | 配置走 patch 默认值；不写任何状态文件 |

**不会出现"静默失效"**：每个降级都有明确行为，并有测试锁定。

> 对比：某些插件写 `if (typeof sessions?.open === 'function') sessions.open(id)`，
> 而 `sessions.open` 在 0.1.7+ 已被移除 —— 该功能**静默失效，用户点通知没反应却无从察觉**。
> 详见 `CARD.md` 的 §零之二。

---

## 已知限制

- **仅 Windows**（Toast = WinRT，播放 = MCI，调用 Windows PowerShell 5.1）
- **设置页真实渲染尚未验证**（代码已就绪、schema 结构已测，但未在宿主里看过界面）
- **点通知跳会话依赖未文档化 API**（`uiWorkspace`），官方随时可能改；坏了会自动降级
- `blocked`（回合被拦截）只用系统蜂鸣，不播失败语音 —— 因为语义是"被拦下"而非"失败"
- **`fail` 语音包只覆盖 16 个基础音色**（103 个音色里的其余 87 个只有完成语音）。选到未覆盖的音色时，失败会在同池内换一个音色，不会哑掉、也不会播错语义

---

## 开发

```powershell
npm run test:all      # 101 条测试
npm test              # 主套件（route 测试会 skip）
npm run test:route    # 需要 --import loader 的 6 条接线测试
```

测试分九组：空闲门判定（20）、事件接线（12）、会话跳转降级（11）、配置持久化（11）、
语音包（10）、失败语音（10）、Config schema（8）、失败路由（6）、真实 Cordis（5）。

全部通过才算提交就绪；关键断言做过**变异测试**（故意改坏代码确认测试变红）。

---

## 许可

代码以 MIT 发布。
**语音文件不适用 MIT**，由 VOICEVOX 生成，各音色有其自身使用条款，
详见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。
