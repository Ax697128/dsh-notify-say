# 第三方素材与致谢

本项目**没有运行时依赖**（`package.json` 中 `dependencies` 为空，不含 `node_modules`）。
但随包分发的语音与音效素材来自以下项目，特此说明并致谢。

---

## 一、语音合成 — VOICEVOX

`sounds/voice-lines/` 下的全部 WAV 语音，以及 `sounds/master-voice.wav`，
均由 **VOICEVOX** 在本地合成。

- 项目主页：<https://voicevox.hiroshiba.jp/>
- 引擎仓库：<https://github.com/VOICEVOX/voicevox_engine>
- 本插件**不包含** VOICEVOX 引擎本身，只包含用它输出的音频文件

### 音色署名

核心包（`sounds/voice-lines/`）附带的音色为 **ずんだもん**（Zundamon）：

> VOICEVOX:ずんだもん

### 使用条款要点

VOICEVOX 软件本体免费（含商用）。用它合成的音频可以自由使用、发布、商用，
但**每个角色音色有各自的利用规约**，需遵守对应条款。主要包括：

- 建议标注音色来源（本项目已在 README 与本文件中标注）
- 不得用于诽谤中伤、政治宣传、宗教活动等用途
- 各音色的具体条款以其官方发布为准

完整音色列表与各自条款：<https://voicevox.hiroshiba.jp/>

> **如果你要再分发本项目的语音文件**（例如打包自己的语音包），
> 请自行确认所涉音色的最新利用规约。本项目的 `LICENSE`（MIT）
> **不覆盖**这些音频素材。

---

## 二、音效素材 — Mixkit

`sounds/` 目录下的 10 个梗音效（`.mp3`）来自 **Mixkit** 的免费音效库：

- 来源：<https://mixkit.co/free-sound-effects/funny/>、
  <https://mixkit.co/free-sound-effects/alarm/>
- 许可：**Mixkit License**

### 条款要点

- ✅ 免费使用，**含商业用途**
- ✅ **无需署名**
- ❌ 不可将音频文件本身作为独立商品转卖或再分发

完整条款：<https://mixkit.co/license/>

具体文件与原始标题对应关系见 `sounds/README.md`。

---

## 三、代码参考

本项目的热重载机制（`lib/dev-reload.js`）参考了本机另一插件的实现思路。
那是作者本人的代码，不属于第三方；相关差异与取舍已在模块头注释中说明。

其余代码为原创。

---

## 四、运行环境

本项目运行在 **DeepSeek Harness (DSH) Desktop** 之上，依赖其插件 API。
DSH 本身的许可与本项目无关，请参见其官方发布。

---

## 致谢

感谢 **VOICEVOX** 项目与各音色作者，让本地、免费、离线的人声合成成为可能；
感谢 **Mixkit** 提供可自由使用的音效素材。

没有这些开源与免费资源，这个插件只能发出单调的系统提示音。
