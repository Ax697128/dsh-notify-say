// dsh-notify-say browser half。
//
// ## 职责（只有两件）
//
//   1. 在 DSH 设置页注册「通知」分区（slots.inject('settings.section')）
//      —— Config schema 只生成「插件配置编辑器」里的表单，**不会**在设置侧栏加分区；
//         侧栏分区必须由 client 注册。本机先例：dsh-opencode-go / dsh-save-money /
//         dsh-cost-meter / dsh-our-free-model 全都这么做。
//   2. 点 Toast 后跳到「那条通知对应的会话」。
//
// ## 为什么必须是这种形态
//
// 宿主契约要求 client 产物自行注册 `window.__ModuleLoader__.load({id, factory})`
// （实测：dsh-sidebar-footer-stack 的 3KB 手写 client.js 也是这个包裹）。
// 直接放 ESM 源码会被当经典脚本执行 → SyntaxError → client-modules 加载失败。
// 本文件**手写**这个包裹，不依赖 esbuild（本机没有 esbuild，也不需要）。
//
// ## 兼容性（本插件首要目标）
//
// client 跑在 sandbox 渲染进程里：sandbox:true / contextIsolation:true /
// nodeIntegration:false → **没有 process、读不了盘**。
// 所以一切数据都走 host 的 /api route（fetch），且**每一处都 try/catch**：
//
//   - 拿不到 slots         → 不注册设置分区，跳转仍工作
//   - 拿不到 uiWorkspace   → 不跳转，用户看到的是"窗口被唤到前台"（旧行为）
//   - route 不可达         → 不跳转，不报错
//
// 任何一环失败都只是"少一个增强"，绝不拖累页面。
window.__ModuleLoader__.load({
  id: 'dsh-notify-say',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var name = 'dsh-notify-say'
    // 声明对 slots 的**硬依赖**，而不是在 apply 里"试一次拿不到就算了"。
    //
    // 为什么（独立审查 2026-10-17 指出）：`slots` 由 dsh-client-ui-renderer 提供，
    // 若本插件激活早于该服务生效，`ctx.get('slots', false)` 会拿到 undefined，
    // 而原实现没有重试 → 设置页分区**永久不出现**，且不留任何日志。
    // 写成 inject 后，宿主会等依赖就绪再激活，从根上避免这个竞态。
    // 先例：dsh-our-free-model/client.js 的 `const inject = ['slots','locale']`。
    var inject = ['slots']

    /** host 注册的 route 前缀（与 lib/session-bridge.js 的 ROUTE_PREFIX 一致）。 */
    var API_PREFIX = 'dsh-notify-say'

    /**
     * 用页面 base 解析 route，而不是 origin-absolute 的 `/api/...`。
     * DSH 可能挂在反向代理的子路径下，写死 `/api/...` 会 404
     * （本机先例 dsh-our-free-model 的注释明确记载了这个坑）。
     */
    function apiUrl(path) {
      try {
        return new URL('api/' + API_PREFIX + '/' + path, document.baseURI).toString()
      } catch (e) {
        return '/api/' + API_PREFIX + '/' + path
      }
    }

    /**
     * 取「最近一条通知对应的会话」；消费即清，避免重复跳转。
     *
     * ⚠️ 返回的是**对象** `{ sessionId, at }`，不是裸字符串。
     *
     * 2026-10-18 外部审阅发现一个 P0 bug：这里原本 `return doc.sessionId`
     * （字符串），但调用方写的是 `if (!doc || !doc.sessionId) return`。
     * 字符串没有 `.sessionId` 属性 → 恒为 undefined → **直接 return**。
     * 结果是会话跳转功能**从未生效过**，而且服务端信号已被 consume 清除，
     * 连重试的机会都没有。
     *
     * 教训：这类"返回类型与调用方期望不符"的 bug，静态审阅一眼可见，
     * 但没有任何单元测试覆盖到（因为两端各自都"看起来对"）。
     * 已加 C27 测试锁住返回形状。
     */
    function consumeLastSession() {
      // ⚠️ 必须是 POST + JSON：服务端把它当写操作（会清除信号），
      // 而 http-guard 对写操作要求 JSON content-type —— 用 GET 会收到 403，
      // 会话跳转随之失效（2026-10-18 实测回归，v0.4.25 修）。
      return fetch(apiUrl('consume'), {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
        .then(function (res) {
          if (!res || !res.ok) return null
          if (res.status === 204) return null
          return res.json()
        })
        .then(function (doc) {
          if (!doc || typeof doc.sessionId !== 'string' || !doc.sessionId) return null
          return {
            sessionId: doc.sessionId,
            at: Number(doc.at) || 0,
          }
        })
        .catch(function () { return null })
    }

    /**
     * 跳到指定会话。**未文档化 API**，拿不到就静默不动（退回"只唤窗"）。
     */
    // ── 语音包管理 API（v0.4.32）──────────────────────────────────────
    //
    // **只传音色 key，不传 URL** —— 下载地址由 host 从固定源算，
    // 前端传 URL 就等于让本机访问任意地址（SSRF）。
    function fetchVoicePacks() {
      return fetch(apiUrl('voicepacks/index'), { cache: 'no-store', credentials: 'same-origin' })
        .then(function (r) { return r && r.ok ? r.json() : null })
        .catch(function () { return null })
    }

    function installVoicePack(key) {
      return fetch(apiUrl('voicepacks/install'), {
        method: 'POST', cache: 'no-store', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: key }),
      }).then(function (r) { return r ? r.json() : null }).catch(function () { return null })
    }

    function uninstallVoicePack(key) {
      return fetch(apiUrl('voicepacks/uninstall'), {
        method: 'POST', cache: 'no-store', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: key }),
      }).then(function (r) { return r ? r.json() : null }).catch(function () { return null })
    }

    function openSession(ctx, sessionId) {
      try {
        if (!sessionId) return false
        var ui = null
        try { ui = ctx.get('uiWorkspace', false) } catch (e) { ui = null }
        if (!ui || typeof ui.openSession !== 'function') return false
        ui.openSession(sessionId)
        return true
      } catch (e) {
        return false
      }
    }

    // ── 1) 设置页分区 ──────────────────────────────────────────────────────
    //
    // ⚠️ 必须返回 **React 元素**，不能返回原生 DOM。
    // v0.4.1 首版用 document.createElement 造节点，结果设置页点进去**一片空白**
    // —— React 不认识原生 DOM 节点，不会挂载它（实测现象）。
    // React 从 factory 的 require 取（本机先例 dsh-save-money:16 即 require('react')）。
    //
    // 内容：官方 Config 表单负责**编辑**；本卡片只做只读说明 + 常用命令提示。
    // 这样即使 slots 渲染接口变化，损失也仅是一张说明卡。
    var React = null
    try { React = require('react') } catch (e) { React = null }

    /** 极简样式（内联）：不依赖任何 CSS 模块（哈希会随构建漂）。 */
    var S = {
      box: { padding: '12px', fontSize: '13px', lineHeight: '1.8' },
      title: { fontWeight: 600, marginBottom: '8px' },
      dim: { opacity: 0.75 },
      gap: { opacity: 0.75, marginTop: '6px' },
      code: { fontFamily: 'ui-monospace,Menlo,Consolas,monospace', fontSize: '12px' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', margin: '6px 0' },
      label: { minWidth: '86px' },
      hint: { opacity: 0.6, fontSize: '12px', marginLeft: '6px' },
      err: { color: '#c0392b', fontSize: '12px', marginTop: '6px' },
      ok: { color: '#1e8449', fontSize: '12px', marginTop: '6px' },
      foot: { opacity: 0.6, marginTop: '10px', fontSize: '12px' },
      // 事件开关：勾选框 + 可换行的说明文字
      toggleRow: { display: 'flex', alignItems: 'flex-start', gap: '8px', margin: '8px 0' },
      toggleBox: { marginTop: '3px', flex: '0 0 auto' },
      toggleText: { flex: '1', lineHeight: '1.5' },
      toggleLabel: { fontWeight: 500 },
      toggleDesc: { opacity: 0.62, fontSize: '12px' },
      // 音源说明（弱化、单独一行）
      subHint: { opacity: 0.62, fontSize: '12px', margin: '2px 0 8px' },
      btn: {
        padding: '4px 10px', fontSize: '12px', cursor: 'pointer',
        border: '1px solid rgba(128,128,128,.45)', borderRadius: '4px',
        background: 'transparent', color: 'inherit',
      },
      // 高级折叠区
      advHead: { margin: '14px 0 4px' },
      advBtn: {
        padding: '2px 0', fontSize: '13px', cursor: 'pointer',
        border: 'none', background: 'transparent', color: 'inherit', fontWeight: 600,
      },
      // 台词输入框：与下拉同样的边框风格，占满剩余宽度
      textInput: {
        flex: '1', minWidth: '120px', padding: '3px 8px', fontSize: '13px',
        border: '1px solid rgba(128,128,128,.45)', borderRadius: '4px',
        background: 'transparent', color: 'inherit',
      },
      // 高级区里每行的「子设置」容器：左侧留出缩进，表明从属于上一行
      subBox: {
        margin: '0 0 8px 94px', padding: '6px 10px',
        borderLeft: '2px solid rgba(128,128,128,.28)',
      },
      subRow: { display: 'flex', alignItems: 'center', gap: '8px', margin: '4px 0' },
      subLabel: { minWidth: '64px', fontSize: '12px', opacity: 0.82 },
    }

    /** 音源 id → 显示名（"跟随默认（xxx）"里要用）。 */
    var SRC_NAME = {
      tts: '系统语音合成',
      bundled: '语音包',
      system: '系统提示音',
      custom: '我的音频',
      none: '不出声',
    }

    // ── 配置读写（走 host route）───────────────────────────────────────────
    //
    // 为什么不走官方 Config 表单：本插件以 bundle 形态挂载时，
    // `volatileForm` 生成的表单出现在「插件配置编辑器」里，而不是设置页分区
    // （实测：分区里只有我们自己画的卡）。所以卡里自带控件，经 host route 落盘到
    // `$DSH_HOME/storages/dsh-notify-say/config.json`，插件每轮播报前重读 →
    // **改完立即生效，不用重启**。
    function cfgUrl(path) {
      try { return new URL('api/' + API_PREFIX + '/' + path, document.baseURI).toString() }
      catch (e) { return '/api/' + API_PREFIX + '/' + path }
    }

    /**
     * 弹出系统文件选择器，拿到**真实绝对路径**。
     *
     * ## 为什么不能只用 `<input type=file>`
     *
     * 浏览器安全限制下，`<input type=file>` 的 File 对象**拿不到绝对路径**
     * （只有 name/size/内容）。而我们的播放进程是按路径读文件的，必须拿真路径。
     *
     * ## 官方给的解法
     *
     * 宿主通过 contextBridge 暴露了 `__DSH_HOST_PATHS__.pathFor(file)`，
     * 底层是 Electron 的 `webUtils.getPathForFile`（app.asar 实证）。
     * 这是**正路**，本机桌面壳就是 `dsh-app://app`，能访问到。
     *
     * ## 降级
     *
     * 拿不到 `__DSH_HOST_PATHS__` 时（例如非桌面壳环境），退回只显示文件名并提示
     * 手动填路径 —— 绝不让按钮"点了没反应"。
     *
     * @returns {Promise<string>} 绝对路径；取消或失败返回空串
     */
    function pickCustomFile() {
      return new Promise(function (resolve) {
        try {
          var input = document.createElement('input')
          input.type = 'file'
          input.accept = 'audio/*,.wav,.mp3,.m4a,.flac,.ogg'
          input.style.display = 'none'
          document.body.appendChild(input)

          var done = function (val) {
            try { input.remove() } catch (e) { /* ignore */ }
            resolve(val || '')
          }

          input.addEventListener('change', function () {
            try {
              var f = input.files && input.files[0]
              if (!f) return done('')
              var host = globalThis.__DSH_HOST_PATHS__
              if (host && typeof host.pathFor === 'function') {
                var p = host.pathFor(f)
                if (typeof p === 'string' && p) return done(p)
              }
              // 拿不到真路径：不静默失败，明确告诉用户
              try {
                console.warn('[dsh-notify-say] 无法取得文件绝对路径，请手动在配置里填 customFile')
              } catch (e) { /* ignore */ }
              return done('')
            } catch (e) { return done('') }
          })
          input.click()
        } catch (e) {
          resolve('')
        }
      })
    }

    function loadConfig() {
      return fetch(cfgUrl('config'), { cache: 'no-store', credentials: 'same-origin' })
        .then(function (r) { return r && r.ok ? r.json() : null })
        .then(function (d) { return d && d.values ? d.values : {} })
        .catch(function () { return {} })
    }

    function saveConfig(patch) {
      return fetch(cfgUrl('config/set'), {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values: patch }),
      })
        .then(function (r) { return r ? r.json().catch(function () { return null }) : null })
        .catch(function () { return null })
    }

    /**
     * 试听：**只出声，不弹窗**（v0.4.17）。
     *
     * 为什么需要：音量增益 / 发音人 / 音色 / 自定义音频这些设置，
     * 光看数字没法判断效果，只能盲调。有了试听就能边调边听。
     *
     * 与「测试通知」的区别：
     *   · 试听     → 只听声音（ps1 的 -Preview，无 Toast）
     *   · 测试通知 → 完整走一遍 notify()，含 Toast 弹窗
     *
     * @param {string} kind done|fail|question|approval|blocked|chime
     * @returns {Promise<object|null>} host 返回 { ok, kind, source, gain }
     */
    function previewSound(kind) {
      var k = kind || 'done'
      return fetch(cfgUrl('preview?kind=' + encodeURIComponent(k)), {
        cache: 'no-store',
        credentials: 'same-origin',
      })
        .then(function (r) { return r ? r.json().catch(function () { return null }) : null })
        .catch(function () { return null })
    }

    /** 音色候选（与 sounds/voice-lines 下的基础音色一致；可手输其他 key）。 */
    // 可下载/可选的音色清单（**只列审核通过的**）。
    //
    // ⚠️ 2026-10-18：移除 kasukabe-tsumugi 与 mochiko ——
    //   · 春日部つむぎ：官方规约第 6 条禁止「二次配布」
    //   · もち子さん：官方规约禁止「音声素材を無償配布」
    // 审核结论见 docs/audio-audit/README.md。
    //
    // 注意：这个列表只影响 GUI 下拉里的候选项。真正的分发拦截在
    // release-build.ps1 的 $NeverShipVoicePrefixes（构建期硬阻断），
    // 两处都要维护，但**构建期那道是安全网**。
    var VOICE_KEYS = [
      'zundamon-normal', 'zundamon-amama', 'ankomon', 'goki-nuigurumi',
      'kyushu-sora', 'manbetsu-hanamaru-genki', 'meimei-meria',
      'shikoku-metang', 'ameharu-hau', 'namiine-ritsu', 'shirakami-kotaro',
    ]

    /** 事件开关定义（键 → 中文名）。 */
    // 事件开关：[键, 名称, 一句话说明]。
    //
    // 说明文案是给**不了解内部术语**的人看的：
    //   - "空闲门" 是内部叫法，必须在界面上解释清楚它在防什么；
    //   - 其余各项也用"什么时候会响"的口语描述，而不是复述配置键的含义。
    var TOGGLES = [
      ['notifyOnComplete', '回合完成',
        '这一轮正常跑完时提醒你'],
      ['notifyOnError', '回合出错',
        '这一轮以错误结束时提醒（会播日语道歉语音）'],
      ['notifyOnBlocked', '被拦截',
        '这一轮还没开始就被拦下时提醒（例如钩子拒绝了指令）'],
      ['notifyOnAborted', '已中止',
        '你手动按停止、或超出长度限制时提醒'],
      ['notifyOnApproval', '待批准',
        'AI 要做敏感操作、等你点同意时提醒'],
      ['notifyOnQuestion', '要提问',
        'AI 有问题要问你、停下来等你回答时提醒'],
      ['subagents', '子代理也提醒',
        '连子代理自己的每一轮结束也提醒；默认只提醒你直接对话的那个会话'],
      ['idleGate', '等真正干完再提醒',
        '别被半路打断的"完成"骗了：AI 派出去的子任务还在跑时先不响，'
        + '等全部结束再响一次。关掉的话，一结束就响（即使还有子任务在跑）'],
    ]

    /**
     * 设置卡片：**真控件**。
     *
     * 状态全部来自 host route；每次改动立刻 POST，成功后用返回的合并值刷新本地态。
     * 任何一步失败只显示一行错误，不让整卡崩掉。
     */
    function SettingsCard() {
      if (!React) return null
      var h = React.createElement
      // 初值只是"占位"，让控件首屏就有内容、可交互（避免闪一屏"读取中"）。
      // ⚠️ 真实值必须以 host 返回的**生效值**为准（见下方 useEffect 的 merge）。
      // 这些占位数字**不代表实际配置**：例如 patch 里 volume 可能是 100，
      // 这里写 80 只是防 undefined；生效值到达后会被覆盖。
      var st = React.useState({
        loaded: false,
        values: {
          voice: true, voiceMode: 'fixed', voiceName: 'zundamon-normal', volume: 80,
          notifyOnComplete: true, notifyOnError: true, notifyOnBlocked: true,
          notifyOnAborted: false, notifyOnApproval: true, notifyOnQuestion: true,
          subagents: false, idleGate: true,
        },
        busy: false, msg: '', err: '',
      // 语音包清单：null = 还没加载过（用户点按钮才加载）
      packs: { loading: false, list: null, error: null },
        // 高级折叠区默认收起：多数人不需要，铺开只会劝退
        advOpen: false,
      })
      var s = st[0]
      var set = st[1]

      React.useEffect(function () {
        var alive = true
        loadConfig().then(function (v) {
          if (!alive) return
          set(function (p) {
            // 生效值覆盖占位值。注意这里**整体覆盖**而非只填缺失键：
            // host 返回的 values 已经是四层合并后的完整配置，
            // 它才是真的；本地占位值一律作废。
            var merged = {}
            var k
            for (k in p.values) merged[k] = p.values[k]
            if (v) for (k in v) merged[k] = v[k]
            return { loaded: true, values: merged, busy: false, msg: '', err: '' }
          })
        })
        return function () { alive = false }
      }, [])

      /**
       * 保存一个配置变更。
       *
       * ⚠️ 每次 set 都**必须带上 advOpen**：状态是一个整体对象，
       * 漏掉某个字段就等于把它重置成 undefined。第一版漏了 advOpen，
       * 表现是"点一下任意控件，高级折叠区就自己收起来"——很恼人且难查。
       */
      function apply(patch, label) {
        set(function (p) {
          return {
            loaded: p.loaded, values: p.values, packs: p.packs, advOpen: p.advOpen,
            busy: true, msg: '', err: '',
          }
        })
        saveConfig(patch).then(function (r) {
          if (r && r.ok) {
            set(function (p) {
              return {
                loaded: true,
                values: r.values || p.values,
                advOpen: p.advOpen,
                busy: false,
                msg: (label || '已保存') + '（立即生效）',
                err: '',
              }
            })
          } else {
            set(function (p) {
              return {
                loaded: p.loaded, values: p.values, packs: p.packs, advOpen: p.advOpen,
                busy: false, msg: '',
                err: '保存失败：' + ((r && r.reason) || '未知原因'),
              }
            })
          }
        })
      }
      // ── 语音包动作（v0.4.32）──────────────────────────────────────
      //
      // 下载要几秒（1~3 MB），所以：进 busy 挡重复点击；
      // 完成后重拉清单，让"已安装"标记更新。
      function loadPacks() {
        set(function (p) {
          return {
            loaded: p.loaded, values: p.values, packs: p.packs, advOpen: p.advOpen, busy: p.busy, msg: p.msg, err: p.err,
            packs: { loading: true, list: null, error: null },
          }
        })
        fetchVoicePacks().then(function (doc) {
          var ok = doc && doc.ok && Array.isArray(doc.packs)
          set(function (p) {
            return {
              loaded: p.loaded, values: p.values, packs: p.packs, advOpen: p.advOpen, busy: p.busy, msg: p.msg, err: p.err,
              packs: {
                loading: false,
                list: ok ? doc.packs : null,
                error: ok ? null : ((doc && (doc.indexError || doc.reason)) || "无法获取"),
              },
            }
          })
        })
      }

      function addPack(key, label) {
        set(function (p) {
          return {
            loaded: p.loaded, values: p.values, advOpen: p.advOpen, packs: p.packs, busy: true,
            msg: "正在下载 " + label + "…", err: "",
          }
        })
        installVoicePack(key).then(function (r) {
          var ok = r && r.ok
          set(function (p) {
            return {
              loaded: p.loaded, values: p.values, advOpen: p.advOpen, packs: p.packs, busy: false,
              msg: ok ? ("已安装 " + label + "（" + (r.files || 0) + " 个文件）") : "",
              err: ok ? "" : ("安装失败：" + ((r && (r.error || r.reason)) || "未知原因")),
            }
          })
          if (ok) loadPacks()
        })
      }

      function removePack(key, label) {
        set(function (p) {
          return {
            loaded: p.loaded, values: p.values, advOpen: p.advOpen, packs: p.packs, busy: true,
            msg: "正在卸载 " + label + "…", err: "",
          }
        })
        uninstallVoicePack(key).then(function (r) {
          var ok = r && r.ok
          set(function (p) {
            return {
              loaded: p.loaded, values: p.values, advOpen: p.advOpen, packs: p.packs, busy: false,
              msg: ok ? ("已卸载 " + label) : "",
              err: ok ? "" : ("卸载失败：" + ((r && (r.error || r.reason)) || "未知原因")),
            }
          })
          if (ok) loadPacks()
        })
      }

      var v = s.values || {}
      var rows = []

      rows.push(h('div', { key: 't', style: S.title }, '桌面通知'))
      // 注意：**不因"未加载完"就提前 return**。初值已按默认配置填好，
      // 控件立即可用；真实值到达后自动覆盖（见 useEffect 的 merge）。
      // 早期版本在这里 return 了一行"读取配置中…"，导致首屏只有文字没有控件。

      // ── 音源选择（v0.4.4）─────────────────────────────────────────────────
      //
      // 这是本插件最核心的可配置项：用户想听系统语音、想听语音包、想要系统音效、
      // 还是干脆不出声 —— 四种人都存在，所以必须能选。
      // 「none」单独作为一项，比"关掉语音开关"更明确（后者语义是"不要声音但可能还有别的"）。
      var SOURCES = [
        ['tts', '系统语音合成（不用下载）'],
        ['bundled', '语音包（二次元音色）'],
        ['system', '系统提示音（短促音效）'],
        ['custom', '我自己的音频文件'],
        ['none', '不出声，只显示通知'],
      ]
      var curSource = v.audioSource || 'tts'
      rows.push(h('div', { key: 'src', style: S.row },
        h('span', { style: S.label }, '声音来源'),
        h('select', {
          value: curSource,
          disabled: s.busy,
          onChange: function (e) { apply({ audioSource: e.target.value }, '声音来源已更新') },
        }, SOURCES.map(function (p) { return h('option', { key: p[0], value: p[0] }, p[1]) })),
      ))
      // 说明：让用户知道当前选项意味着什么，不用去猜
      var SRC_HINT = {
        tts: '用 Windows 自带语音念一句中文，不占空间、装了就能用',
        bundled: '播放下载的 VOICEVOX 语音包；没下载过音色时会退回系统提示音',
        system: '播放 Windows 的系统提示音，完成/失败/提问各用不同的音',
        custom: '播放你自己指定的音频文件（在下方设置）',
        none: '完全不发声，只弹通知',
      }
      rows.push(h('div', { key: 'srchint', style: S.subHint }, SRC_HINT[curSource] || ''))

      // ── 弹窗开关（v0.4.4）────────────────────────────────────────────────
      // 有人只想听声音、嫌弹窗打断；也有人只要弹窗、不要声音。两者都要能关。
      rows.push(h('div', { key: 'toast', style: S.row },
        h('span', { style: S.label }, '显示通知弹窗'),
        h('input', {
          type: 'checkbox',
          checked: v.showToast !== false,
          disabled: s.busy,
          onChange: function (e) { apply({ showToast: !!e.target.checked }, '弹窗开关已更新') },
        }),
        h('span', { style: S.hint }, v.showToast === false ? '关闭后只有声音' : '关掉后只听声音、不弹窗'),
      ))

      // 语音开关
      rows.push(h('div', { key: 'voice', style: S.row },
        h('span', { style: S.label }, '语音播报'),
        h('input', {
          type: 'checkbox',
          checked: v.voice !== false,
          disabled: s.busy,
          onChange: function (e) { apply({ voice: !!e.target.checked }, '语音开关已更新') },
        }),
        h('span', { style: S.hint }, '关掉只弹 Toast'),
      ))

      // 音量
      rows.push(h('div', { key: 'vol', style: S.row },
        h('span', { style: S.label }, '音量'),
        h('input', {
          type: 'range', min: 0, max: 100, step: 1,
          value: typeof v.volume === 'number' ? v.volume : 80,
          disabled: s.busy,
          style: { flex: '1' },
          // onChange 必须有：React 对「有 value 无 onChange」的受控表单元素会
          // 降级成只读并告警（本机是 React 19，受控组件语义更严格）。
          // 拖拽过程只改本地显示，不写盘 —— 避免每像素一次请求。
          onChange: function (e) {
            var n = Number(e.target.value)
            set(function (p) {
              var nv = {}; for (var k in p.values) nv[k] = p.values[k]
              nv.volume = n
              return {
                loaded: p.loaded, values: nv, advOpen: p.advOpen,
                busy: p.busy, msg: '', err: p.err,
              }
            })
          },
          // 松手才写盘。用 pointerup 覆盖鼠标/触摸/触控笔；
          // 再补 onBlur 兜底（指针在元素外抬起时元素收不到 pointerup）。
          onPointerUp: function (e) { apply({ volume: Number(e.currentTarget.value) }, '音量已更新') },
          onBlur: function (e) { apply({ volume: Number(e.currentTarget.value) }, '音量已更新') },
          onKeyUp: function (e) { apply({ volume: Number(e.currentTarget.value) }, '音量已更新') },
        }),
        h('span', { style: S.hint }, String(typeof v.volume === 'number' ? v.volume : 80)),
      ))

      // ── 语音包增益（v0.4.16）─────────────────────────────────────────────
      //
      // 为什么单独一个滑杆：Windows 的播放音量上限是"原始幅度 1.0 倍"，
      // 而本包语音包峰值中位只有 40.4%（实测 247 个文件），
      // 所以上面「音量」拉满也只到原始电平的 35%~40%，听感偏轻。
      // 这个滑杆做**数字增益**：把样本乘一个系数，绕开 1.0 倍上限。
      //
      // ps1 侧会按峰值自动限幅（不超过 95%），所以不用担心调大破音。
      rows.push(h('div', { key: 'vogain', style: S.row },
        h('span', { style: S.label }, '语音包增益'),
        h('input', {
          type: 'range', min: 1.0, max: 4.0, step: 0.1,
          value: typeof v.voiceGain === 'number' ? v.voiceGain : 2.0,
          disabled: s.busy,
          style: { flex: '1' },
          onChange: function (e) {
            var n = Number(e.target.value)
            set(function (p) {
              var nv = {}; for (var k in p.values) nv[k] = p.values[k]
              nv.voiceGain = n
              return {
                loaded: p.loaded, values: nv, advOpen: p.advOpen,
                busy: p.busy, msg: '', err: p.err,
              }
            })
          },
          onPointerUp: function (e) { apply({ voiceGain: Number(e.currentTarget.value) }, '增益已更新') },
          onBlur: function (e) { apply({ voiceGain: Number(e.currentTarget.value) }, '增益已更新') },
          onKeyUp: function (e) { apply({ voiceGain: Number(e.currentTarget.value) }, '增益已更新') },
        }),
        h('span', { style: S.hint }, 'x' + (typeof v.voiceGain === 'number' ? v.voiceGain.toFixed(1) : '2.0')),
        // 试听：只听声音、不弹窗。调增益/换音色这类"要听才知道"的设置，
        // 没有试听就只能盲调（用户 2026-10-18 指出）。
        h('button', {
          type: 'button',
          key: 'pv-gain',
          disabled: s.busy,
          style: S.btn,
          onClick: function () {
            previewSound('done').then(function (r) {
              set(function (p) {
                return {
                  loaded: p.loaded, values: p.values, packs: p.packs, advOpen: p.advOpen,
                  busy: false,
                  msg: r && r.ok ? ('试听中（' + (r.source || 'bundled') + '）') : '试听失败',
                  err: p.err,
                }
              })
            })
          },
        }, '试听'),
      ))
      rows.push(h('div', { key: 'vogainhint', style: S.subHint },
        '语音包素材本身录得偏轻，这里补上。自动限幅，调大不会破音。'))

      // ── 自定义音频标准化（v0.4.16）──────────────────────────────────────
      //
      // 默认关：那是用户自己的素材，可能特意做得轻或响，不该擅自改。
      // 打开后才按统一响度处理（只对 16-bit PCM wav 生效）。
      rows.push(h('div', { key: 'normcust', style: S.row },
        h('span', { style: S.label }, '自定义音频标准化'),
        h('input', {
          type: 'checkbox',
          checked: v.normalizeCustomAudio === true,
          disabled: s.busy,
          onChange: function (e) {
            apply({ normalizeCustomAudio: !!e.target.checked }, '已更新')
          },
        }),
        h('span', { style: S.hint }, v.normalizeCustomAudio === true
          ? '开：统一响度（仅 wav 有效）'
          : '关：尊重你原文件的响度'),
      ))

      // ── 试听（v0.4.17）──────────────────────────────────────────────────
      //
      // 为什么单独一行放五种事件：用户常给不同事件配不同音源
      // （例如"完成听日语、失败听系统音"），必须能分别试听确认。
      //
      // 试听**只出声、不弹窗**（ps1 的 -Preview）——
      // 它的用途是"听效果"，不是验证通知通路（那是「测试通知」的事）。
      rows.push(h('div', { key: 'pv-row', style: S.row },
        h('span', { style: S.label }, '试听'),
        (function () {
          var KINDS = [
            ['done', '完成'], ['fail', '失败'], ['question', '提问'],
            ['approval', '批准'], ['blocked', '拦截'],
          ]
          return h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', flex: '1' } },
            KINDS.map(function (pair) {
              return h('button', {
                type: 'button',
                key: 'pv-' + pair[0],
                disabled: s.busy,
                style: S.btn,
                onClick: function () {
                  // 先写盘再试听：让试听用的就是刚才调的值
                  previewSound(pair[0]).then(function (r) {
                    set(function (p) {
                      return {
                        loaded: p.loaded, values: p.values, packs: p.packs, advOpen: p.advOpen,
                        busy: false,
                        msg: r && r.ok
                          ? ('试听「' + pair[1] + '」（' + (r.source || 'bundled') + '）')
                          : '试听失败',
                        err: p.err,
                      }
                    })
                  })
                },
              }, pair[1])
            }),
          )
        })(),
      ))
      rows.push(h('div', { key: 'pv-hint', style: S.subHint },
        '试听只出声、不弹窗。调完增益或换了音色，点一下就能听效果。'))

      // ── 语音包管理（v0.4.32）──────────────────────────────────────
      //
      // 核心包只带 1 个音色，其余按需下载。
      //
      // ⚠️ 刻意**不在挂载时自动加载**：set 会触发重渲染，
      // 而任何同步执行的 useEffect 都会让「加载 → set → 重渲染 → 加载」
      // 变成死循环（实测把 4GB 堆打满）。改为用户点按钮触发。
      if (curSource === 'bundled') {
        var vp = s.packs || { loading: false, list: null, error: null }
        rows.push(h('div', { key: 'vp-title', style: S.label }, '语音包'))

        if (vp.loading) {
          rows.push(h('div', { key: 'vp-loading', style: S.subHint }, '正在获取可下载音色…'))
        } else if (!vp.list) {
          rows.push(h('div', { key: 'vp-idle', style: S.subHint },
            vp.error
              ? '未能获取可下载列表：' + vp.error + '。已装的音色仍可正常使用。'
              : '核心包只带 1 个音色。点右边按钮看看还有哪些可以下载。'))
          rows.push(h('div', { key: 'vp-load-row', style: S.row },
            h('button', {
              type: 'button',
              disabled: s.busy,
              style: S.btn,
              onClick: function () { loadPacks() },
            }, vp.error ? '重试' : '加载列表'),
          ))
        } else {
          var items = vp.list.filter(function (p) { return p.downloadable || p.installed })
          rows.push(h('div', { key: 'vp-list', style: { display: 'flex', flexDirection: 'column', gap: '4px', flex: '1' } },
            items.map(function (p) {
              var mb = p.bytes ? (p.bytes / 1048576).toFixed(1) + ' MB' : ''
              return h('div', { key: 'vp-item-' + p.key, style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                h('span', { style: { flex: '1' } }, (p.name || p.key) + (mb ? '（' + mb + '）' : '')),
                p.installed ? h('span', { style: { color: '#2a7' } }, '已安装') : null,
                h('button', {
                  type: 'button',
                  disabled: s.busy || !p.downloadable,
                  style: S.btn,
                  onClick: function () {
                    if (p.installed) removePack(p.key, p.name || p.key)
                    else addPack(p.key, p.name || p.key)
                  },
                }, p.installed ? '卸载' : (p.downloadable ? '下载' : '不可用')),
              )
            }),
          ))
          rows.push(h('div', { key: 'vp-hint', style: S.subHint },
            '这些语音由 VOICEVOX 生成，各有各的署名与用途限制；下载后会附 TERMS.md。'))
        }
      }
      // ── 语音包专属设置（仅 bundled 时显示）──────────────────────────────
      if (curSource === 'bundled') {
        // 音色模式
        rows.push(h('div', { key: 'mode', style: S.row },
          h('span', { style: S.label }, '音色模式'),
          h('select', {
            value: v.voiceMode || 'fixed',
            disabled: s.busy,
            onChange: function (e) { apply({ voiceMode: e.target.value }, '音色模式已更新') },
          },
            h('option', { value: 'fixed' }, '固定音色'),
            h('option', { value: 'random' }, '每次随机'),
          ),
        ))

        // 音色名（随机模式下置灰，避免误以为它仍生效）
        var fixedMode = (v.voiceMode || 'fixed') === 'fixed'
        var keyOpts = VOICE_KEYS.slice()
        if (v.voiceName && keyOpts.indexOf(v.voiceName) < 0) keyOpts.unshift(v.voiceName)
        rows.push(h('div', { key: 'name', style: S.row },
          h('span', { style: S.label }, '固定音色'),
          h('select', {
            value: v.voiceName || 'zundamon-normal',
            disabled: s.busy || !fixedMode,
            onChange: function (e) { apply({ voiceName: e.target.value }, '音色已更新') },
          }, keyOpts.map(function (k) { return h('option', { key: k, value: k }, k) })),
          fixedMode ? null : h('span', { style: S.hint }, '随机模式下不生效'),
        ))
      }

      // ── TTS 专属设置（仅 tts 时显示）─────────────────────────────────────
      if (curSource === 'tts') {
        var TTS_VOICES = [['', '系统默认'], ['Microsoft Huihui Desktop', 'Huihui（中文女声）'],
          ['Microsoft Zira Desktop', 'Zira（英文女声）']]
        rows.push(h('div', { key: 'ttsv', style: S.row },
          h('span', { style: S.label }, '朗读声音'),
          h('select', {
            value: v.ttsVoice || '',
            disabled: s.busy,
            onChange: function (e) { apply({ ttsVoice: e.target.value }, '朗读声音已更新') },
          }, TTS_VOICES.map(function (p) { return h('option', { key: p[0], value: p[0] }, p[1]) })),
        ))
        rows.push(h('div', { key: 'ttsr', style: S.row },
          h('span', { style: S.label }, '语速'),
          h('input', {
            type: 'range', min: -10, max: 10, step: 1,
            value: typeof v.ttsRate === 'number' ? v.ttsRate : 0,
            disabled: s.busy,
            style: { flex: '1' },
            onChange: function (e) {
              var n = Number(e.target.value)
              set(function (p) {
                var nv = {}; for (var k in p.values) nv[k] = p.values[k]
                nv.ttsRate = n
                return {
                loaded: p.loaded, values: nv, advOpen: p.advOpen,
                busy: p.busy, msg: '', err: p.err,
              }
              })
            },
            onPointerUp: function (e) { apply({ ttsRate: Number(e.currentTarget.value) }, '语速已更新') },
            onBlur: function (e) { apply({ ttsRate: Number(e.currentTarget.value) }, '语速已更新') },
            onKeyUp: function (e) { apply({ ttsRate: Number(e.currentTarget.value) }, '语速已更新') },
          }),
          h('span', { style: S.hint }, (function () {
            var n = typeof v.ttsRate === 'number' ? v.ttsRate : 0
            return n === 0 ? '正常' : (n < 0 ? '慢 ' + Math.abs(n) : '快 ' + n)
          })()),
        ))

        // ── 自定义台词（v0.4.8）─────────────────────────────────────────────
        //
        // 用户 2026-10-17 要求："既然是这个 TTS 台词，是不是可以用户去输一段话呀？"
        // 留空 = 用内置台词库（每种事件 2~4 句随机，避免听腻）。
        //
        // 用受控 input + onBlur 保存（不是每次按键都写盘）：
        // 打字过程频繁 POST 没有意义，还会让光标位置闪。
        rows.push(h('div', { key: 'ttsTextHint', style: S.subHint },
          '想让它说别的话就填在这里（最多 60 字）。留空则每次从内置的几句里随机。'))
        var TTS_TEXT_ROWS = [
          ['Done', '任务完成'],
          ['Fail', '任务失败'],
          ['Question', '向你提问'],
          ['Approval', '待你批准'],
          ['Blocked', '被拦截'],
        ]
        TTS_TEXT_ROWS.forEach(function (pair) {
          var suffix = pair[0]
          var label = pair[1]
          var key = 'ttsText' + suffix
          rows.push(h('div', { key: 'tt-' + suffix, style: S.row },
            h('span', { style: S.label }, label),
            h('input', {
              type: 'text',
              maxLength: 60,
              placeholder: '留空 = 内置随机',
              value: typeof v[key] === 'string' ? v[key] : '',
              disabled: s.busy,
              style: S.textInput,
              // 打字时只更新本地显示，不发请求
              onChange: (function (k) {
                return function (e) {
                  var val = e.target.value
                  set(function (p) {
                    var nv = {}; for (var kk in p.values) nv[kk] = p.values[kk]
                    nv[k] = val
                    return {
                      loaded: p.loaded, values: nv, advOpen: p.advOpen,
                      busy: p.busy, msg: '', err: p.err,
                    }
                  })
                }
              })(key),
              // 失去焦点 / 回车才写盘
              onBlur: (function (k) {
                return function (e) {
                  var o = {}
                  o[k] = e.target.value
                  apply(o, '台词已更新')
                }
              })(key),
              onKeyDown: function (e) {
                if (e.key === 'Enter') { try { e.target.blur() } catch (x) { /* ignore */ } }
              },
            }),
          ))
        })
      }

      // ── 自定义音频（仅 custom 时显示）────────────────────────────────────
      //
      // 按事件分别选文件：用户可能想让"完成"放自己的音乐、"失败"放另一段。
      // 保存的是扁平键（customFileDone / customFileFail …），因为 config-store
      // 的白名单只认标量；host 侧会拼成 audio-source 需要的 customFiles 字典。
      //
      // ⚠️ 只记录**路径**，不复制文件：用户改文件立即生效，也不占额外空间。
      if (curSource === 'custom') {
        rows.push(h('div', { key: 'custhint', style: S.subHint },
          '给每种提醒各挑一个 wav / mp3。文件不会被复制，插件只记住位置。'))
        var CUSTOM_KINDS = [
          ['Done', '任务完成'],
          ['Fail', '任务失败'],
          ['Question', '向你提问'],
          ['Approval', '待你批准'],
        ]
        CUSTOM_KINDS.forEach(function (pair) {
          var suffix = pair[0]
          var label = pair[1]
          var key = 'customFile' + suffix
          var cur = v[key] || ''
          rows.push(h('div', { key: 'cf-' + suffix, style: S.row },
            h('span', { style: S.label }, label),
            h('button', {
              type: 'button',
              disabled: s.busy,
              style: S.btn,
              onClick: (function (k) {
                return function () {
                  pickCustomFile().then(function (p) {
                    if (p) {
                      var patch = {}
                      patch[k] = p
                      patch.audioSource = 'custom'
                      apply(patch, '已选择音频文件')
                    } else {
                      set(function (prev) {
                        return {
                          loaded: prev.loaded, values: prev.values, advOpen: prev.advOpen,
                          busy: false, msg: '',
                          err: '没有取到文件路径。若点了没反应，可手动在配置里填该事件的 customFile。',
                        }
                      })
                    }
                  }).catch(function () { /* pickCustomFile 内部已兜底 */ })
                }
              })(key),
            }, cur ? '更换…' : '选择文件…'),
            h('span', { style: S.hint }, cur || '（未选择，将用系统提示音）'),
            cur ? h('button', {
              type: 'button',
              disabled: s.busy,
              style: S.btn,
              onClick: (function (k) {
                return function () {
                  var patch = {}
                  patch[k] = ''
                  apply(patch, '已清除')
                }
              })(key),
            }, '清除') : null,
          ))
        })
      }

      // 事件开关（未设置时用默认：aborted / subagents 默认关，其余默认开）
      var DEFAULTS = {
        notifyOnComplete: true, notifyOnError: true, notifyOnBlocked: true,
        notifyOnAborted: false, notifyOnApproval: true, notifyOnQuestion: true,
        subagents: false, idleGate: true,
      }
      rows.push(h('div', { key: 'sep', style: { margin: '10px 0 4px', fontWeight: 600 } }, '提醒哪些事件'))
      TOGGLES.forEach(function (pair) {
        var key = pair[0]
        var label = pair[1]
        var desc = pair[2] || ''
        var cur = (typeof v[key] === 'boolean') ? v[key] : DEFAULTS[key]
        // 一行 = [勾选框] [名称] [说明]。说明用弱化色、允许换行，
        // 这样"等真正干完再提醒"这种较长的解释也能完整读到。
        rows.push(h('div', { key: 'tg-' + key, style: S.toggleRow },
          h('input', {
            type: 'checkbox',
            checked: cur === true,
            disabled: s.busy,
            style: S.toggleBox,
            onChange: (function (k) {
              return function (e) {
                var o = {}
                o[k] = !!e.target.checked
                apply(o, '已更新')
              }
            })(key),
          }),
          h('div', { style: S.toggleText },
            h('span', { style: S.toggleLabel }, label),
            desc ? h('span', { style: S.toggleDesc }, ' — ' + desc) : null,
          ),
        ))
      })

      // ── 会话跳转（v0.4.6）──────────────────────────────────────────────
      //
      // 为什么这里是**两个**开关而不是一个：
      // 切回窗口有两种情形，用户诉求正好相反 ——
      //   · 后台完成 → 回来自动带到那条会话（省得自己翻侧栏）
      //   · 前台完成 → 有人想跳过去看一眼，有人**故意不想跳**
      //     （想自己按绿点逐个确认哪些完成了）
      // 所以不替用户选，两两组合出四种行为。
      //
      // 实测限制（写进说明，别让用户以为是 bug）：
      // Toast 的点击只能唤起窗口、带不了会话 id，所以"点通知才跳"做不到；
      // 只能用「窗口从后台回来」作为信号。因此直接点任务栏图标也会跳。
      rows.push(h('div', { key: 'sepHr2', style: { margin: '10px 0 4px', borderTop: '1px solid rgba(128,128,128,.25)' } }))
      rows.push(h('div', { key: 'jumpTitle', style: { fontWeight: 600, margin: '6px 0 2px' } }, '跳回对应会话'))
      rows.push(h('div', { key: 'jumpHint', style: S.subHint },
        '收到完成提醒后，自动带你回到那条会话。')) 

      rows.push(h('div', { key: 'jumpBg', style: S.toggleRow },
        h('input', {
          type: 'checkbox',
          checked: v.jumpWhenBackground !== false,
          disabled: s.busy,
          style: S.toggleBox,
          onChange: function (e) { apply({ jumpWhenBackground: !!e.target.checked }, '跳转设置已更新') },
        }),
        h('div', { style: S.toggleText },
          h('span', { style: S.toggleLabel }, '在后台完成时跳转'),
          h('span', { style: S.toggleDesc },
            ' — 你在别的窗口忙、任务完成了，回来时直接落到那条会话。'),
        ),
      ))

      rows.push(h('div', { key: 'jumpFg', style: S.toggleRow },
        h('input', {
          type: 'checkbox',
          checked: v.jumpWhenForeground === true,
          disabled: s.busy,
          style: S.toggleBox,
          onChange: function (e) { apply({ jumpWhenForeground: !!e.target.checked }, '跳转设置已更新') },
        }),
        h('div', { style: S.toggleText },
          h('span', { style: S.toggleLabel }, '窗口就在眼前时也跳转'),
          h('span', { style: S.toggleDesc },
            ' — 默认关。关掉时你正看着屏幕，它不会动你的位置；'
            + '打开则每次完成都带你过去看一眼。'),
        ),
      ))

      // 两个都关 = 完全关闭。明确说出来，免得用户以为坏了。
      if (v.jumpWhenBackground === false && v.jumpWhenForeground !== true) {
        rows.push(h('div', { key: 'jumpOff', style: S.subHint }, '当前：两个都关，不会自动跳转。'))
      }

      // ── 冷却（v0.4.7）─────────────────────────────────────────────────────
      //
      // 用户 2026-10-17 明确要求："同一会话的冷却我们可以给它关了，
      // 甚至可以把不同会话的冷却给它加上。"
      //
      // 两类人诉求相反，所以两级都做成可调：
      //   同一会话：连续完成多次只提醒最后一次（防噪音）
      //   所有会话：任意会话响过之后，一段时间内其余会话都不出声
      //            （"我已经听到一个、过来了，别再叫"）
      //
      // 跨会话默认 0（关闭），保持"不同会话都会响" —— 想每个结果都听见的人不会漏。
      rows.push(h('div', { key: 'sepHr3', style: { margin: '10px 0 4px', borderTop: '1px solid rgba(128,128,128,.25)' } }))
      rows.push(h('div', { key: 'coolTitle', style: { fontWeight: 600, margin: '6px 0 2px' } }, '提醒频率'))
      rows.push(h('div', { key: 'coolHint', style: S.subHint },
        '嫌吵就拉开间隔；想每个结果都听见就把「同一会话」调成关闭。'))

      var COOLDOWN_CHOICES = [
        [0, '关闭（每次都提醒）'],
        [15, '15 秒'],
        [30, '30 秒'],
        [60, '1 分钟'],
        [120, '2 分钟'],
        [300, '5 分钟'],
      ]
      var curDeb = Math.round(typeof v.debounceSeconds === 'number' ? v.debounceSeconds : 60)
      var curGlb = Math.round(typeof v.globalCooldownSeconds === 'number' ? v.globalCooldownSeconds : 0)

      /** 造一个秒数下拉（当前值不在预设里时补一项，避免显示错乱）。 */
      var mkCooldownSelect = function (cur, key) {
        var opts = COOLDOWN_CHOICES.map(function (p) {
          return h('option', { key: String(p[0]), value: String(p[0]) }, p[1])
        })
        if (!COOLDOWN_CHOICES.some(function (p) { return p[0] === cur })) {
          opts = opts.concat([h('option', { key: 'custom', value: String(cur) }, cur + ' 秒')])
        }
        return h('select', {
          value: String(cur),
          disabled: s.busy,
          onChange: (function (k) {
            return function (e) {
              var patch = {}
              patch[k] = Number(e.target.value)
              apply(patch, '提醒频率已更新')
            }
          })(key),
        }, opts)
      }

      rows.push(h('div', { key: 'deb', style: S.row },
        h('span', { style: S.label }, '同一会话'),
        mkCooldownSelect(curDeb, 'debounceSeconds'),
        h('span', { style: S.hint }, curDeb === 0 ? '每次都响' : '这段时间内不重复'),
      ))

      rows.push(h('div', { key: 'glb', style: S.row },
        h('span', { style: S.label }, '所有会话'),
        mkCooldownSelect(curGlb, 'globalCooldownSeconds'),
        h('span', { style: S.hint }, curGlb === 0 ? '每个会话都会响' : '响一次后安静一会儿'),
      ))

      // ── 高级（折叠，v0.4.5）──────────────────────────────────────────────
      //
      // 放在折叠区而不是主界面，理由：
      //   - 大多数人永远不需要"给某一种提醒单独换音源"，铺开只会劝退；
      //   - 但真正需要的人（比如"完成听日语、失败听系统警告音"）又必须能用。
      //
      // 用法：每一行的下拉默认「跟随上面的声音来源」，改过才覆盖。
      // 只把**偏离默认的项**存进配置（kindSourceFail='system'），
      // 所以以后改全局默认，没单独改过的事件会跟着变 —— 符合直觉。
      var advOpen = st[0].advOpen === true
      rows.push(h('div', { key: 'adv', style: S.advHead },
        h('button', {
          type: 'button',
          style: S.advBtn,
          onClick: function () {
            set(function (p) {
              return {
                loaded: p.loaded, values: p.values, packs: p.packs, busy: p.busy, msg: p.msg, err: p.err,
                advOpen: p.advOpen !== true,
              }
            })
          },
        }, (advOpen ? '▾ ' : '▸ ') + '高级：给每种提醒单独设置'),
      ))

      if (advOpen) {
        var KIND_ROWS = [['Done', '任务完成'], ['Fail', '任务失败'],
          ['Question', '向你提问'], ['Approval', '待你批准'], ['Blocked', '被拦截']]
        var FOLLOW = '__follow__'
        rows.push(h('div', { key: 'advhint', style: S.subHint },
          '默认跟随上面的「声音来源」。只有你改过的那几行才会单独生效。'))
        KIND_ROWS.forEach(function (pair) {
          var suffix = pair[0]
          var label = pair[1]
          // ⚠️ 读与写**用的字段名不同**，这是 v0.4.10 修的一个真 bug：
          //
          //   写入：扁平键 kindSourceFail = 'system'（config-store 白名单只认标量）
          //   读回：backend 的 normalizeConfig 会把它聚合成
          //         audioSourceByKind = { fail: 'system' }
          //         —— 生效值里**没有** kindSourceFail 这个键
          //
          // 原先前端读写都用扁平键，于是 GET 回来的 v 里取不到值，
          // 每行永远显示「跟随默认」，用户以为设置没生效（实际存进去了）。
          var writeKey = 'kindSource' + suffix
          var kindLower = suffix.toLowerCase()
          var byKind = (v.audioSourceByKind && typeof v.audioSourceByKind === 'object')
            ? v.audioSourceByKind : {}
          var cur = byKind[kindLower] || FOLLOW
          rows.push(h('div', { key: 'ks-' + suffix, style: S.row },
            h('span', { style: S.label }, label),
            h('select', {
              value: cur,
              disabled: s.busy,
              onChange: (function (k) {
                return function (e) {
                  var patch = {}
                  // 选「跟随默认」就把键清空，让配置回到最小状态
                  patch[k] = e.target.value === FOLLOW ? '' : e.target.value
                  apply(patch, '已更新')
                }
              })(writeKey),
            }, [
              h('option', { key: FOLLOW, value: FOLLOW }, '跟随默认（' + (SRC_NAME[curSource] || curSource) + '）'),
              h('option', { key: 'tts', value: 'tts' }, '系统语音合成'),
              h('option', { key: 'bundled', value: 'bundled' }, '语音包'),
              h('option', { key: 'system', value: 'system' }, '系统提示音'),
              h('option', { key: 'custom', value: 'custom' }, '我的音频文件'),
              h('option', { key: 'none', value: 'none' }, '不出声'),
            ]),
            cur === FOLLOW ? null : h('span', { style: S.hint }, '（已单独设置）'),
          ))

          // ── 该事件的**子设置**（v0.4.9）──────────────────────────────────
          //
          // 用户 2026-10-17 指出：只选了音源类型，但"念什么话、什么声音、
          // 什么音效"还得回上面用全局的，不合逻辑。所以每行在**覆盖了音源**时
          // 展开该音源自己的参数；「跟随默认」时不展开（避免界面爆炸）。
          //
          // 参数矩阵：
          //   tts     → 发音人 + 语速 + 台词
          //   bundled → 音色模式 + 音色名
          //   system  → 系统音效名
          //   custom  → 选择文件
          var effSrc = (cur === FOLLOW) ? curSource : cur
          if (cur === FOLLOW) return   // 跟随默认 → 不展开

          var sub = []
          var kKey = function (base) { return base + suffix }

          /**
           * 读按事件覆盖的值。
           *
           * ⚠️ 写入用**扁平键**（kindTtsVoiceDone），读回用**字典**
           * （values.kindTtsVoice.done）—— 因为 backend 的 normalizeConfig
           * 会把扁平键聚合成字典，生效值里没有扁平键。
           * 第一版读写都用扁平键，导致界面永远显示"跟随默认"（实际已存）。
           *
           * @param {string} dictName 字典名（如 'kindTtsVoice'）
           * @param {*} dflt 取不到时的默认值
           */
          var readKind = function (dictName, dflt) {
            var m = v[dictName]
            if (m && typeof m === 'object') {
              var got = m[kindLower]
              if (got !== undefined && got !== null && got !== '') return got
            }
            return dflt
          }

          if (effSrc === 'tts') {
            // 发音人
            var vNameKey = kKey('kindTtsVoice')
            var vNameCur = readKind('kindTtsVoice', '')
            sub.push(h('div', { key: 'ttsv-' + suffix, style: S.subRow },
              h('span', { style: S.subLabel }, '朗读声音'),
              h('select', {
                value: vNameCur,
                disabled: s.busy,
                onChange: (function (k) {
                  return function (e) {
                    var o = {}; o[k] = e.target.value; apply(o, '已更新')
                  }
                })(vNameKey),
              }, [
                h('option', { key: '', value: '' }, '跟随全局'),
                h('option', { key: 'hui', value: 'Microsoft Huihui Desktop' }, 'Huihui（中文女声）'),
                h('option', { key: 'zira', value: 'Microsoft Zira Desktop' }, 'Zira（英文女声）'),
              ]),
            ))
            // 语速
            var vRateKey = kKey('kindTtsRate')
            var vRateCur = Number(readKind('kindTtsRate', 0)) || 0
            sub.push(h('div', { key: 'ttsr-' + suffix, style: S.subRow },
              h('span', { style: S.subLabel }, '语速'),
              h('input', {
                type: 'range', min: -10, max: 10, step: 1,
                value: vRateCur,
                disabled: s.busy,
                style: { flex: '1' },
                onChange: (function (k) {
                  return function (e) {
                    var n = Number(e.target.value)
                    set(function (p) {
                      var nv = {}; for (var kk in p.values) nv[kk] = p.values[kk]
                      nv[k] = n
                      return {
                        loaded: p.loaded, values: nv, advOpen: p.advOpen,
                        busy: p.busy, msg: '', err: p.err,
                      }
                    })
                  }
                })(vRateKey),
                onPointerUp: (function (k) {
                  return function (e) {
                    var o = {}; o[k] = Number(e.currentTarget.value); apply(o, '已更新')
                  }
                })(vRateKey),
                onBlur: (function (k) {
                  return function (e) {
                    var o = {}; o[k] = Number(e.currentTarget.value); apply(o, '已更新')
                  }
                })(vRateKey),
              }),
              h('span', { style: S.hint }, vRateCur === 0 ? '跟随全局' : (vRateCur < 0 ? '慢' : '快')),
            ))
            // 台词（这个字段本来就按事件，直接复用）
            var txtKey = 'ttsText' + suffix
            var txtCur = String(readKind('ttsTexts', '') || '')
            sub.push(h('div', { key: 'ttst-' + suffix, style: S.subRow },
              h('span', { style: S.subLabel }, '台词'),
              h('input', {
                type: 'text',
                maxLength: 60,
                placeholder: '留空 = 内置随机',
                value: txtCur,
                disabled: s.busy,
                style: S.textInput,
                onChange: (function (k) {
                  return function (e) {
                    var val = e.target.value
                    set(function (p) {
                      var nv = {}; for (var kk in p.values) nv[kk] = p.values[kk]
                      nv[k] = val
                      return {
                        loaded: p.loaded, values: nv, advOpen: p.advOpen,
                        busy: p.busy, msg: '', err: p.err,
                      }
                    })
                  }
                })(txtKey),
                onBlur: (function (k) {
                  return function (e) {
                    var o = {}; o[k] = e.target.value; apply(o, '已更新')
                  }
                })(txtKey),
                onKeyDown: function (e) { if (e.key === 'Enter') { try { e.target.blur() } catch (x) { /* ignore */ } } },
              }),
            ))
          } else if (effSrc === 'bundled') {
            // 音色模式
            var mKey = kKey('kindVoiceMode')
            var mCur = readKind('kindVoiceMode', '')
            sub.push(h('div', { key: 'km-' + suffix, style: S.subRow },
              h('span', { style: S.subLabel }, '音色模式'),
              h('select', {
                value: mCur,
                disabled: s.busy,
                onChange: (function (k) {
                  return function (e) { var o = {}; o[k] = e.target.value; apply(o, '已更新') }
                })(mKey),
              }, [
                h('option', { key: '', value: '' }, '跟随全局'),
                h('option', { key: 'fixed', value: 'fixed' }, '固定音色'),
                h('option', { key: 'random', value: 'random' }, '每次随机'),
              ]),
            ))
            // 音色名
            var nKey = kKey('kindVoiceName')
            var nCur = readKind('kindVoiceName', '')
            var kOpts2 = VOICE_KEYS.slice()
            if (nCur && kOpts2.indexOf(nCur) < 0) kOpts2.unshift(nCur)
            sub.push(h('div', { key: 'kn-' + suffix, style: S.subRow },
              h('span', { style: S.subLabel }, '音色'),
              h('select', {
                value: nCur,
                disabled: s.busy || mCur === 'random',
                onChange: (function (k) {
                  return function (e) { var o = {}; o[k] = e.target.value; apply(o, '已更新') }
                })(nKey),
              }, [h('option', { key: '', value: '' }, '跟随全局')].concat(
                kOpts2.map(function (x) { return h('option', { key: x, value: x }, x) }),
              )),
              mCur === 'random' ? h('span', { style: S.hint }, '随机模式下不生效') : null,
            ))
          } else if (effSrc === 'system') {
            // 系统音效名
            var sKey = kKey('kindSystemSound')
            var sCur = readKind('kindSystemSound', '')
            sub.push(h('div', { key: 'kss-' + suffix, style: S.subRow },
              h('span', { style: S.subLabel }, '音效'),
              h('select', {
                value: sCur,
                disabled: s.busy,
                onChange: (function (k) {
                  return function (e) { var o = {}; o[k] = e.target.value; apply(o, '已更新') }
                })(sKey),
              }, [
                h('option', { key: '', value: '' }, '按事件自动选'),
                h('option', { key: 'Asterisk', value: 'Asterisk' }, '提示音（轻快）'),
                h('option', { key: 'Question', value: 'Question' }, '询问音'),
                h('option', { key: 'Exclamation', value: 'Exclamation' }, '感叹音'),
                h('option', { key: 'Hand', value: 'Hand' }, '警告音（低沉）'),
                h('option', { key: 'Beep', value: 'Beep' }, '哔声'),
              ]),
            ))
          } else if (effSrc === 'custom') {
            // 选择文件（复用已有的 customFile* 键）
            var cKey = 'customFile' + suffix
            var cCur = readKind('customFiles', '')
            sub.push(h('div', { key: 'kc-' + suffix, style: S.subRow },
              h('span', { style: S.subLabel }, '音频'),
              h('button', {
                type: 'button',
                disabled: s.busy,
                style: S.btn,
                onClick: (function (k) {
                  return function () {
                    pickCustomFile().then(function (p) {
                      if (p) { var o = {}; o[k] = p; apply(o, '已选择音频') }
                    }).catch(function () { /* 内部已兜底 */ })
                  }
                })(cKey),
              }, cCur ? '更换…' : '选择文件…'),
              h('span', { style: S.hint }, cCur || '（未选择，将用系统提示音）'),
            ))
          }

          if (sub.length) {
            rows.push(h('div', { key: 'sub-' + suffix, style: S.subBox }, sub))
          }
        })


        // ── 开发选项：热重载 ────────────────────────────────────────────────
        //
        // 让用户自己选，而不是我替他决定。默认关（生产安装不需要）。
        // 开启后：改插件源码保存 → 自动换成新代码，不用重启 DSH。
        rows.push(h('div', { key: 'sepHr', style: { margin: '10px 0 4px', borderTop: '1px solid rgba(128,128,128,.25)' } }))
        rows.push(h('div', { key: 'dr', style: S.toggleRow },
          h('input', {
            type: 'checkbox',
            checked: v.devReload === true,
            disabled: s.busy,
            style: S.toggleBox,
            onChange: function (e) { apply({ devReload: !!e.target.checked }, '热重载设置已更新') },
          }),
          h('div', { style: S.toggleText },
            h('span', { style: S.toggleLabel }, '开发：改代码后自动热重载'),
            h('span', { style: S.toggleDesc },
              ' — 保存插件源码后自动生效，不必重启 DSH。默认关：'
              + '它依赖宿主内部结构，升级后可能失效；失效时只报错，不影响正常播报。'),
          ),
        ))

        // ── 日志级别（v0.4.34）──────────────────────────────────────────────
        //
        // 默认 info：只记元数据（事件、音源、成败、数量）。
        // debug：额外记台词正文与 Toast 标题正文 —— **可能含敏感信息**。
        //
        // 为什么放在高级区：多数人不需要改，但排查问题时要能开。
        rows.push(h('div', { key: 'll-row', style: S.row },
          h('span', { style: S.label }, '日志详细度'),
          h('select', {
            value: v.logLevel || 'info',
            disabled: s.busy,
            onChange: function (e) { apply({ logLevel: e.target.value }, '日志级别已更新') },
          },
            h('option', { value: 'info' }, '只记元数据（默认）'),
            h('option', { value: 'debug' }, '含台词正文（可能敏感）'),
          ),
        ))
        rows.push(h('div', { key: 'll-hint', style: S.subHint },
          v.logLevel === 'debug'
            ? '⚠️ debug 档会把台词和通知正文写进日志。日志在 %TEMP%\\dsh-notify-say\\notify.log，'
              + '提 Issue 前请先切回「只记元数据」或自行删改。'
            : '日志只记事件类型、音源、成败与数量，不含台词正文。排查问题时可切到 debug。'))
      }

      if (s.msg) rows.push(h('div', { key: 'msg', style: S.ok }, s.msg))
      if (s.err) rows.push(h('div', { key: 'err', style: S.err }, s.err))
      rows.push(h('div', { key: 'foot', style: S.foot },
        '改动立即生效，无需重启。以上为运行时覆盖，优先级高于 cordis.patch.yml。'))

      return h('div', { style: S.box }, rows)
    }

    /**
     * 注册设置页分区。
     *
     * 已通过 `inject = ['slots']` 声明硬依赖，理论上此刻 slots 一定就绪；
     * 但仍保留软判断：**宁可少一个分区，也不要让整个 client 激活失败**
     * （激活失败会连跳转一起丢掉）。
     *
     * @returns {Function|null} 清理函数（解除注册），没有注册则 null
     */
    function registerSettingsSection(ctx) {
      try {
        var slots = ctx.get('slots', false)
        if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          try {
            console.warn('[dsh-notify-say] slots 不可用，设置页分区未注册（跳转仍可用）')
          } catch (e) { /* ignore */ }
          return null
        }
        var dispose = null
        slots.inject('settings.section', function () {
          try {
            // register 会返回一个 disposer —— 收好它，否则热重载会重复注册
            // （独立审查 2026-10-17 指出：原实现丢弃了返回值）
            var d = slots.register({
              name: 'settings.section',
              id: 'dsh-notify-say',
              order: 60,
              label: '通知',
            }, SettingsCard)
            if (typeof d === 'function') dispose = d
          } catch (e) { /* 注册失败不影响跳转 */ }
        })
        return function () { try { if (typeof dispose === 'function') dispose() } catch (e) { /* ignore */ } }
      } catch (e) { return null }
    }

    // ── 2) 完成播报后跳回对应会话 ──────────────────────────────────────────
    //
    // ## 为什么不是"点 Toast 才跳"
    //
    // Windows Toast 的 `launch` 是固定串 `dsh://open`（ps1 里 activationType="protocol"），
    // 官方只支持唤窗，且 main.ts 是整串精确匹配 —— **拿不到"点的是哪条通知"**。
    // 所以只能折中：用「窗口从不可见变为可见」作为信号。
    //
    // ## 判定规则
    //
    //   通知到达时窗口**不可见** → 用户回来时**跳**   （结果还没看，带他过去）
    //   通知到达时窗口**可见**   → **不跳**            （他正看着，别动他的位置，让他自己看绿点）
    //
    // 判定的实现形式：记录"用户最后一次离开的时刻"，
    // 若通知时间 >= 离开时刻，说明通知是在用户离开期间到达的。
    //
    // **不设时效**：10 分钟后才回来看，结果仍然没看过，跳过去依然合理。
    //
    // ## 已知边界（已写进 GUI 的折叠说明）
    //
    // 用户直接点任务栏图标而非点 Toast 时，信号完全相同，无法区分 —— 也会跳。
    // 不接受就关掉这个开关。
    //
    // ⚠️ client 是**经典脚本**（__ModuleLoader__ 包裹），不能 import ESM。
    // 所以这里内联了 lib/session-jump.js 的两个纯函数。**两处必须保持一致**，
    // session-jump.test.mjs 测的是 lib 那份，client 这份由 client-bundle.test.mjs 校验一致性。

    /** 与 lib/session-jump.js 的 isHidden 等价。 */
    function isHiddenDoc(doc) {
      try {
        if (!doc) return true
        if (typeof doc.visibilityState === 'string') return doc.visibilityState === 'hidden'
        if (typeof doc.hidden === 'boolean') return doc.hidden
        return false
      } catch (e) { return true }
    }

    /**
     * 与 lib/session-jump.js 的 decideJump 等价（只保留判定，不带决策常量）。
     *
     * 两个独立开关组合出四种行为（用户 2026-10-17 要求的）：
     *   bg=true,  fg=false → 后台跳、前台不跳（默认）
     *   bg=true,  fg=true  → 都跳
     *   bg=false, fg=true  → 只前台跳
     *   bg=false, fg=false → 都不跳（自己按绿点确认）
     *
     * ⚠️ 判定用**区间** [leftAt, returnedAt)，不能只比 leftAt ——
     * 只比 leftAt 会导致"用户离开过一次之后，前台判定永久失效"
     * （独立审查 2026-10-17 抓到的严重缺陷）。
     */
    function shouldJump(inp) {
      var i = inp || {}
      var bg = i.jumpWhenBackground === undefined ? true : i.jumpWhenBackground !== false
      var fg = i.jumpWhenForeground === true
      if (!bg && !fg) return false                          // 两个都关 = 功能关闭
      if (!i.sessionId) return false
      if (i.consumed === true) return false
      var left = Number(i.leftAt)
      var at = Number(i.notifiedAt)
      // Number(undefined) 是 NaN，而 `NaN <= 0` 为 false —— 必须显式归一成 0
      var retRaw = Number(i.returnedAt)
      var ret = isFinite(retRaw) ? retRaw : 0
      if (!isFinite(left) || left <= 0) return false         // 不知何时离开 → 保守不跳
      if (!isFinite(at) || at <= 0) return false
      // 通知落在「用户不在的那段时间」内 → 后台完成
      var inAway = at >= left && (ret <= 0 || at < ret)
      if (inAway) return bg
      return fg                                              // 前台完成
    }

    /** 与 lib/session-jump.js 的 createLeaveTracker 等价。 */
    /**
     * 与 lib/session-jump.js 的 createLeaveTracker 等价。
     *
     * 同时记 `leftAt`（离开）与 `returnedAt`（回来）—— 只记离开会让
     * "前台不跳"永久失效（见 shouldJump 的注释）。
     */
    function makeLeaveTracker() {
      var leftAt = 0
      var returnedAt = 0
      var wasHidden = false
      var seen = false
      return {
        onVisibility: function (doc, now) {
          var hidden = isHiddenDoc(doc)
          var t = isFinite(now) ? now : Date.now()
          if (!seen) {
            seen = true
            wasHidden = hidden
            if (hidden) leftAt = t
            return
          }
          if (hidden && !wasHidden) {
            leftAt = t
            returnedAt = 0        // 新一轮离开，旧的回来说明作废
          } else if (!hidden && wasHidden) {
            returnedAt = t        // 用户回来了
          }
          wasHidden = hidden
        },
        leftAt: function () { return leftAt },
        returnedAt: function () { return returnedAt },
        reset: function () { leftAt = 0; returnedAt = 0 },
      }
    }

    function armSessionJump(ctx) {
      var leave = makeLeaveTracker()
      var busy = false

      /** 从 host 取配置里的开关（拿不到就当关闭，绝不擅自跳）。 */
      /**
       * 从 host 取两个跳转开关。
       *
       * 拿不到配置时：**两个都返回 false**（不跳）。
       * 宁可少跳一次，也不要在用户没同意的情况下动他的界面。
       */
      function jumpEnabled() {
        return loadConfig().then(function (v) {
          // ⚠️ 2026-10-18 外部审阅指出逻辑矛盾：loadConfig 失败返回 {}，
          // 而 {}.jumpWhenBackground !== false 求值为 true —— 与"拿不到就不跳"正好相反。
          // 现在显式区分"读到了"与"没读到"。
          if (!v || typeof v !== "object" || Object.keys(v).length === 0) {
            return { jumpWhenBackground: false, jumpWhenForeground: false }
          }
          return {
            // 只有明确读到 true 才跳；缺失或 null 都不跳
            jumpWhenBackground: v.jumpWhenBackground === true,
            jumpWhenForeground: v.jumpWhenForeground === true,
          }
        }).catch(function () {
          return { jumpWhenBackground: false, jumpWhenForeground: false }
        })
      }

      var onVisibility = function () {
        try {
          var now = Date.now()
          leave.onVisibility(typeof document !== 'undefined' ? document : null, now)

          // 只在"变为可见"时才考虑跳转
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        } catch (e) { return }
        if (busy) return
        busy = true

        jumpEnabled().then(function (en) {
          if (!en) { busy = false; return null }
          return consumeLastSession().then(function (doc) {
            busy = false
            if (!doc || !doc.sessionId) return
            if (shouldJump({
              jumpWhenBackground: en.jumpWhenBackground,
              jumpWhenForeground: en.jumpWhenForeground,
              consumed: false,
              sessionId: doc.sessionId,
              notifiedAt: Number(doc.at),
              leftAt: leave.leftAt(),
              returnedAt: leave.returnedAt(),
            })) {
              leave.reset()
              openSession(ctx, doc.sessionId)
            }
          })
        }).catch(function () { busy = false })
      }

      try {
        if (typeof document !== 'undefined' && document.addEventListener) {
          document.addEventListener('visibilitychange', onVisibility)
        }
      } catch (e) { /* 拿不到 document 就算了 */ }

      return function () {
        try {
          if (typeof document !== 'undefined' && document.removeEventListener) {
            document.removeEventListener('visibilitychange', onVisibility)
          }
        } catch (e) { /* ignore */ }
      }
    }

    function apply(ctx) {
      // 两件事分别 try/catch：任一失败都不该拖累另一件。
      var disposeSection = null
      try { disposeSection = registerSettingsSection(ctx) } catch (e) { disposeSection = null }

      var disposeJump = null
      try { disposeJump = armSessionJump(ctx) } catch (e) { disposeJump = null }

      return function () {
        try { if (typeof disposeJump === 'function') disposeJump() } catch (e) { /* ignore */ }
        try { if (typeof disposeSection === 'function') disposeSection() } catch (e) { /* ignore */ }
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = name
    return module.exports
  },
})
