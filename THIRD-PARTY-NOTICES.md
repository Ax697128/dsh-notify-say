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

**官方条款原文**（用户应能自行核对，不要只信本文件的转述）：

- VOICEVOX 软件利用规约：<https://voicevox.hiroshiba.jp/term/>
- ずんずんプロジェクト音源利用规约（ずんだもん等）：
  <https://zunko.jp/con_ongen_kiyaku.html>
- 完整音色列表与各自条款：<https://voicevox.hiroshiba.jp/>
- 官方音源总条款（含各角色摘要）：
  <https://github.com/VOICEVOX/voicevox_vvm/blob/main/TERMS.txt>

> **如果你要再分发本项目的语音文件**（例如打包自己的语音包），
> 请自行确认所涉音色的最新利用规约。本项目的 `LICENSE`（MIT）
> **不覆盖**这些音频素材。

---

## 一之二、中文语音合成 — EmotiVoice

`sounds/voice-lines/` 下以 `zh-` 开头的 WAV（共 4 个音色 × 12 条 = 48 个）
由 **EmotiVoice** 在本地离线合成，**不是** VOICEVOX。

- 项目主页：<https://github.com/netease-youdao/EmotiVoice>
- 开发方：网易有道（NetEase Youdao）
- 本插件**不包含** EmotiVoice 的模型与代码，只包含用它输出的音频文件

### 许可链（逐层说明，因为这里有三层）

| 层 | 内容 | 许可 |
|---|---|---|
| 1 | EmotiVoice 的**代码与模型权重** | **Apache License 2.0** |
| 2 | 模型训练语料 **LibriTTS** / **HiFiTTS** | **CC BY 4.0**（允许商用，需署名） |
| 3 | 底层录音来源 LibriVox | **公有领域**（朗读者已明示捐入） |

关于第 1 层：EmotiVoice 仓库根目录的 `LICENSE` 是标准 Apache License 2.0；
随仓库分发的《EmotiVoice 用户协议》PDF 第 4.1 条也明确写着
「有道基于 Apache2.0 开源协议向您授权使用」。**但该 PDF 同时约束官方交互页面**，
我们不使用那个页面，只使用本地推理输出。

关于第 2 层：LibriTTS（<https://www.openslr.org/60/>）与
HiFiTTS（<https://www.openslr.org/109/>）在 OpenSLR 上都标注为 CC BY 4.0。

关于第 3 层：LibriVox 官方说明「all our recordings are public domain …
anyone can use all our recordings however they wish (even to sell them)」
（<https://librivox.org/pages/public-domain>）。

### 音色署名与命名

音色在界面上**只按声学特征命名**（低沉男声 / 平稳男声 / 清亮女声 / 温柔女声），
不使用任何真名。

原因：EmotiVoice 的说话人索引背后是 LibriTTS / HiFiTTS 语料里的 LibriVox
志愿录音者，那些名字是**真人姓名**。拿真人姓名当我们产品的音色标签，
既会误导用户以为得到了该人的授权，也不合适。所以只描述声音。

如果需要按 CC BY 4.0 署名，可用 `sounds/voice-lines/../MANIFEST.json` 里记录的
`EmotiVoice:speaker-<index>` 形式，并在需要时引用上述两个数据集页面。

### 与 VOICEVOX 音色的关系

两套音色在**分发机制上完全相同**：同样的 zip 结构、同样的 `packs.json` 索引、
同样的设置页下载与卸载流程、同样的条款确认弹窗。区别只有两处：

1. 生成引擎不同（EmotiVoice vs VOICEVOX）
2. 台词语言不同（中文 vs 日语）

打包时 `tools/build-voice-packs.ps1` 会按 `Engine` 字段分别生成 TERMS.md，
**中文包不会冒充 VOICEVOX 生成**。

---


**2026-10-18：移除了此前随包分发的 10 个 Mixkit mp3 音效。**

### 移除原因

[Mixkit Sound Effects Free License](https://mixkit.co/license/modal/sfxFree/) 明确禁止：

> You can't **redistribute the Item on its own, as stock, in a tool or
> template, or with source files**.

本插件通过 npm / GitHub 公开分发包含这些 mp3 的安装包，属于该条款禁止的
「再分发素材本身 / 随源文件分发」情形。

### 影响

这些文件是**兜底池**成员：正常流程走「语音包 → master-voice.wav → mp3 池」，
前两者都存在，所以移除**对实际体验没有影响**。

### 如果你想要音效

`sounds/` 目录支持直接放入 `.mp3` / `.wav`，插件会自动作为兜底音效使用。
请自行确保所用素材的许可允许你的使用方式。

---

## 二之二、未随包分发的音色（合规说明）

以下音色的 WAV 由开发者本地生成，但**不进入发布包**：

| 音色 | 原因 |
|---|---|
| **もち子さん**（mochiko） | [官方利用规约](https://vtubermochio.wixsite.com/mochizora/)明确禁止
  「無償配布、有償販売」利用其输出合成音频制作的音声素材。本插件免费分发，正落在该禁令内。 |
| 个人声音样本 | 作者本人的声音，仅本地使用，不对外分发。 |

其余音色的发布状态见仓库 `docs/语音包分发方案-待审阅.md`。

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
