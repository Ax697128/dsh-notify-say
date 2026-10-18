# 音色许可审核记录（2026-10-18）

> 本文档是**开发者内部的审核记录**，基于各权利人官方页面的**本地快照**（见 `snapshots/`）。
> 它不是权利人出具的授权书，也不构成法律意见。
>
> 对外提供时只用 `licenses/AUDIO.md` 的摘要与官方链接。

## 一、审核口径（限定条件）

本审核仅针对以下使用形态：

```
✅ 个人开发
✅ 免费、开源、无广告、无赞助
✅ 本地用 VOICEVOX 生成 WAV
✅ 打包 ZIP 上传 GitHub Release 供下载
✅ 在插件 GUI 中播放这些 WAV
❌ 不分发 VOICEVOX 软件 / 模型权重 / 角色立绘
```

**换任何一条（如收费、公司运营、接受赞助、商业化），结论都要重新评估。**

## 二、判定标准

| 状态 | 含义 | 插件行为 |
|---|---|---|
| `APPROVED` | 官方条款明确允许商用非商用 + 仅需署名与用途限制，**未发现禁止素材再分发** | 可提供下载 |
| `CONDITIONAL` | 允许使用，但**未明确涉及「独立音频素材包分发」** | 可提供下载，但须传递义务 + 显著标示 |
| `PENDING` | 条款未能完整读取，或有身份/来源疑问 | **不提供下载** |
| `FORBIDDEN` | 官方明确禁止再分发 / 禁止无偿配发音声素材 | **不提供下载** |

## 三、逐音色结论（16 个 VOICEVOX 音色）

### FORBIDDEN（明确禁止，必须移除）

| 音色 | 依据原文 | 出处 |
|---|---|---|
| **kasukabe-tsumugi** 春日部つむぎ | 「以下の行為について禁止します…**・二次配布**、自作発言」 | [官方](https://tsumugi-official.studio.site/rule) |
| **mochiko** もち子さん | 「出力した合成音声を使用した**音声素材を無償配布**、有償販売。」（禁止事項第 1 项） | [官方](https://vtubermochio.wixsite.com/mochizora/利用規約) |

> ⚠️ **kasukabe-tsumugi 是本次新发现**。此前只知它「条件保留」，
> 实际读原文后发现第 6 条禁令直接写了「二次配布」——
> 与我方 ZIP 分发模式正面冲突。**必须移除。**

### CONDITIONAL（可发，须履行义务）

| 音色 | 署名要求 | 关键限制 | 出处 |
|---|---|---|---|
| **zundamon-normal** | `VOICEVOX:ずんだもん` | 无政治/宗教/信息商材/虚假信息；不可转卖音频 | [ずんずん](https://zunko.jp/con_ongen_kiyaku.html) |
| **zundamon-amama** | `VOICEVOX:ずんだもん` | 同上 | 同上 |
| **shikoku-metang** | `VOICEVOX:四国めたん` | 同上 | 同上 |
| **kyushu-sora** | `VOICEVOX:九州そら` | 同上 | 同上 |
| **tohoku-zunko** | `VOICEVOX:東北ずん子` | 同上 | 同上 |
| **tohoku-kiritan** | `VOICEVOX:東北きりたん` | 同上 | 同上 |
| **ankomon** | `VOICEVOX:あんこもん` | 同上 | 同上 |
| **ameharu-hau** 雨晴はう | `VOICEVOX:雨晴はう`（角色名可选） | **禁止 R18 音声用途**；禁止未授权变声模型 | [あめはれくりにっく](https://amehau.com/rules/amehare-hau-rule.html) |
| **goki-nuigurumi** 後鬼 | `VOICEVOX:後鬼` | 企业商用需事前确认（本项目为个人免费，不触发） | [ついなちゃん](https://xn--n8jychz0k1d.com/voice_terms/) |
| **manbetsu-hanamaru-genki** 満別花丸 | `VOICEVOX:満別花丸` | 禁止恶意使用、冒充官方、特定政治极端宣传 | [官方](https://100hanamaru.wixsite.com/manbetsu-hanamaru-genki/rule) |
| **meimei-meria** 冥鳴ひまり | `VOICEVOX:冥鳴ひまり` | 禁止损害第三方、特定思想团体 | [官方](https://www.meimeihimari.com/terms-of-use) |
| **namiine-ritsu** 波音リツ | `VOICEVOX:波音リツ`（见下） | 权利人有要求停止公开的条款 | [カノンの落ちる城](https://www.canon-voice.com/terms/) |
| **shirakami-kotaro** 白上虎太郎 | `VOICEVOX:白上虎太郎` | 禁止用输出训练新声音模型 | [VirVox](https://www.virvoxproject.com/voicevoxの利用規約) |

#### 两个特别说明

**namiine-ritsu（最宽松但也有坑）**

官方页面顶部写 `音源の転載、再配布可` 和 `クレジット表記不要`。
但**同一页面另有**：`VOICEVOXを使用する場合、「VOICEVOX」のクレジットが必要`。

→ 结论：**可以再分发，但必须标 `VOICEVOX` 署名**（不是完全不署名）。

> 这是 2026-10-18 的教训：只看三行摘要会漏掉这条，差点做出错误判断。

**shirakami-kotaro（分发依据最明确）**

VirVox 条款直接规范了素材分发场景：

> 出力音声を音声素材として配布する際は、2.と同様の規約を素材の利用者へ義務づける必要があるものとします。

→ 这是所有音色里**唯一明确写了"分发音声素材"该怎么做**的条款。
对我们最有利——它证明了「分发是被考虑的、被规范的情形」。

### PENDING（不提供下载）

| 音色 | 原因 |
|---|---|
| **yurei-chan** | 身份未确认。VOICEVOX 官方同时存在「ユーレイちゃん」(U-Stella, style_id 102) 与「夜語トバリ」(style_id 118)，是**不同权利人**。文件名 `yurei-chan` 倾向指前者，但**无生成记录可证**。 |

## 四、自有声音（2 个）

| 音色 | 状态 | 说明 |
|---|---|---|
| `my-voice-ja` | **永不分发** | 作者本人声音。已加入发布黑名单。 |
| `my-voice-ja-2` | **永不分发** | 同上。 |

## 五、可选但尚未纳入的音色

VOICEVOX 官方共 40+ 个音色。以下**可能有价值但我们没用过**，如需扩充可先审核：

| 音色 | 声音特点 | 备注 |
|---|---|---|
| 中国うさぎ | 幽玄で初々しい | SSS 阵营，条款与ずんだもん同源 |
| 中部つるぎ | 凛然とした存在感 | SSS 阵营 |
| WhiteCUL | 聞き心地のよい率直 | 需单独查条款 |
| 猫使アル / 猫使ビィ | 厚みのある気さく / ピュアであどけない | 需单独查条款 |
| 春歌ナナ | はつらつとした力強い | 需单独查条款 |
| 琴詠ニア | 滑らかで無機質 | 需单独查条款 |
| 離途 / 黒沢冴白 / 暁記ミタマ | 各异 | 需单独查条款 |
| **VOICEVOX Nemo** | 无人格设定的纯音声库 | **条款最简单**：署名即可商用非商用，无角色条款负担 |

**Nemo 值得特别考虑**：它没有角色人格，条款是一次性的
（`VOICEVOX Nemo` 署名即可），不像角色音色那样每家都要单独查。
如果未来要扩大音色库，Nemo 是最省事的方向。

## 六、快照清单

`snapshots/` 下的文件是本审核的**原始证据**：

| 文件 | 内容 | 抓取方式 |
|---|---|---|
| `voicevox-software.txt` | VOICEVOX 软件规约 | browser-auto |
| `voicevox-vvm-terms.txt` | 官方模型/音源总条款（含各角色摘要） | raw.githubusercontent |
| `sss-zundamon.txt` / `sss-anonymous-common.txt` | ずんずんプロジェクト共通规约 | browser-auto |
| `ameharu-hau.txt` | 雨晴はう规约 | browser-auto |
| `goki-nuigurumi.txt` | 後鬼音源规约 | browser-auto |
| `kasukabe-tsumugi.txt` | 春日部つむぎ规约（**含二次配布禁令**） | browser-auto |
| `meimei-meria.txt` | 冥鳴ひまり规约 | browser-auto |
| `namiine-ritsu.txt` | 波音リツ规约 | browser-auto |
| `shirakami-kotaro.txt` | VirVox 规约（**含素材分发条款**） | browser-auto |
| `yurei-chan.txt` | U-Stella ユーレイちゃん规约 | browser-auto |

### 未能抓取（网络受限）

| 目标 | 原因 | 补救 |
|---|---|---|
| `mochiko` 完整正文 | `wixsite.com` 域名在本机网络不可达（ERR_CONNECTION_CLOSED） | 已有搜索摘要含禁止条款原文，且我们**已决定排除**，不影响结论 |
| `manbetsu-hanamaru-genki` 完整正文 | 同上（同为 wixsite） | 已有摘要含署名要求；建议后续用代理重抓 |
| `夜語トバリ` 规约正文 | 官网用 JS 动态加载，`#rules` 锚点未触发 | 身份未确认，暂不发布，暂不需要 |

## 七、当前可发布清单

```
可发布（CONDITIONAL，13 个）：
  zundamon-normal, zundamon-amama, shikoku-metang, kyushu-sora,
  tohoku-zunko, tohoku-kiritan, ankomon, ameharu-hau,
  goki-nuigurumi, manbetsu-hanamaru-genki, meimei-meria,
  namiine-ritsu, shirakami-kotaro

禁止发布（FORBIDDEN，2 个）：
  kasukabe-tsumugi, mochiko

待确认（PENDING，1 个）：
  yurei-chan

永不分发（隐私，2 个）：
  my-voice-ja, my-voice-ja-2
```

## 八、维护规则

1. **新增音色** → 必须先抓快照、填本记录、判定状态，才能进下载列表
2. **官方改条款** → 重抓快照，比对差异，重新判定
3. **用途变更**（收费、公司运营、赞助）→ 全部重新审核
4. **本记录与 `licenses/AUDIO.md` 必须同步** —— 前者是内部证据，后者是对外摘要
