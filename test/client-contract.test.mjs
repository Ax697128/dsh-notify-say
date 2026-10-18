/**
 * 客户端代码的静态契约测试（v0.4.23）。
 *
 * ## 为什么需要这一类测试
 *
 * 2026-10-18 外部代码审阅发现：`consumeLastSession()` 返回**字符串**，
 * 调用方却按 `doc.sessionId` 访问 —— 类型不匹配，导致**会话跳转功能
 * 从未生效过**，而且服务端信号已被 consume 清除，连重试机会都没有。
 *
 * 这类 bug 的特点：
 *   · 两端各自"看起来都对"
 *   · 跑起来不报错（只是静默不生效）
 *   · 没有端到端测试就发现不了
 *
 * 所以这里用**源码静态断言**锁住契约。不是替代运行时测试，
 * 而是防止"改一处忘另一处"的回归。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = join(ROOT, 'lib', 'client.js');
const NOTIFY_CONFIG = join(ROOT, 'tools', 'notify-config.ps1');

const client = readFileSync(CLIENT, 'utf8');

// ── C27: consumeLastSession 必须返回对象（不是裸字符串）──────────────────
test('C27: consumeLastSession 返回 {sessionId, at} 对象而非裸字符串', () => {
  const fn = client.match(/function consumeLastSession\(\)[\s\S]*?\n    \}/);
  assert.ok(fn, '应能找到 consumeLastSession 定义');
  const body = fn[0];

  // 必须返回对象字面量
  assert.match(body, /return\s*\{[\s\S]*sessionId:/,
    'consumeLastSession 必须返回含 sessionId 的对象；'
    + '返回裸字符串会让调用方的 doc.sessionId 恒为 undefined（2026-10-18 实际 bug）');

  // 不得再有 `return doc.sessionId`（裸字符串返回）
  assert.doesNotMatch(body, /return\s+doc\.sessionId\s*$/m,
    '不得返回裸字符串 doc.sessionId');
});

// ── C28: 调用方与返回形状必须一致（防单边修改）──────────────────────────
test('C28: 调用方按对象访问 sessionId（与 C27 形状一致）', () => {
  const call = client.match(/consumeLastSession\(\)\.then\(function \(doc\) \{[\s\S]{0,400}/);
  assert.ok(call, '应能找到调用点');
  assert.match(call[0], /doc\.sessionId/,
    '调用方应访问 doc.sessionId —— 每边都应跟着另一边改');
  assert.match(call[0], /!doc \|\| !doc\.sessionId/,
    '应保留空值短路判断');
});

// ── C29: jumpEnabled 必须"读不到配置就不跳" ─────────────────────────────
test('C29: jumpEnabled 读不到配置时两个开关都为 false', () => {
  // 用「从函数名到下一个 function/】」的宽松切片，避免依赖缩进宽度
  const start = client.indexOf('function jumpEnabled()');
  assert.ok(start >= 0, '应能找到 jumpEnabled 定义');
  const rest = client.slice(start);
  const endRel = rest.search(/\n\s*var onVisibility/);
  const body = endRel > 0 ? rest.slice(0, endRel) : rest.slice(0, 2000);

  // 原 bug：cfg.jumpWhenBackground !== false 在 {} 上求值为 true
  //
  // 注意：必须**剥掉注释行**再判断 —— 我们的修复注释里就写了
  // `{}.jumpWhenBackground !== false` 来解释这个 bug，
  // 直接搜全文会误报（第一次跑就是这么挂的）。
  const codeOnly = body
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  assert.doesNotMatch(codeOnly, /jumpWhenBackground\s*!==\s*false/,
    '不得用 `!== false` 判定 —— {} 会得到 true，与"拿不到就不跳"相反');

  // 必须是严格等于 true
  assert.match(body, /jumpWhenBackground:\s*v\.jumpWhenBackground === true/,
    '必须严格判断 === true，缺失/undefined 都不跳');

  // 必须显式处理空配置
  assert.match(body, /Object\.keys\(v\)\.length === 0/,
    '必须显式识别空配置（loadConfig 失败返回 {}）');
});

// ── C30: VOICE_KEYS 不得含许可被禁的音色 ────────────────────────────────
test('C30: GUI 音色列表不含 kasukabe-tsumugi / mochiko', () => {
  const m = client.match(/var VOICE_KEYS = \[[\s\S]*?\]/);
  assert.ok(m, '应能找到 VOICE_KEYS');
  const list = m[0];

  for (const banned of ['kasukabe-tsumugi', 'mochiko']) {
    // 只检查列表本体，注释里提到是可以的（那是解释为什么移除）
    const inList = new RegExp(`'${banned}'`).test(list);
    assert.equal(inList, false,
      `${banned} 不得出现在 GUI 音色列表里 —— `
      + '官方规约禁止再分发（见 docs/audio-audit/README.md）');
  }
});

// ── C31: 安装提示不得指向不存在的脚本 ───────────────────────────────────
test('C31: notify-config.ps1 不指向仓库里不存在的脚本', async () => {
  const { existsSync } = await import('node:fs');
  const src = readFileSync(NOTIFY_CONFIG, 'utf8');

  // 找出所有 "powershell ... -File <某 .ps1>" 的提示
  const refs = [...src.matchAll(/-File\s+\S*?([\w-]+\.ps1)/g)].map((m) => m[1]);
  for (const script of new Set(refs)) {
    const candidates = [
      join(ROOT, 'tools', script),
      join(ROOT, script),
    ];
    const found = candidates.some((p) => existsSync(p));
    assert.ok(found,
      `notify-config.ps1 提示用户运行 ${script}，但仓库里找不到它 —— `
      + '这是"照着做就失败"的文档 bug');
  }
});

// ── C32: 语音包清单不得在挂载时自动加载（防死循环）────────────────────────
test('C32: loadPacks 不在 useEffect 里自动触发', () => {
  const src = client;

  // 找所有 useEffect 块
  const effects = [...src.matchAll(/React\.useEffect\(function[\s\S]*?\n {6}\}, \[[^\]]*\]\)/g)];
  assert.ok(effects.length > 0, '应能找到 useEffect');

  for (const m of effects) {
    assert.doesNotMatch(m[0], /loadPacks\s*\(\s*\)/,
      'useEffect 里不得调用 loadPacks —— set 会触发重渲染，'
      + '同步执行的 effect 会形成「加载→set→重渲染→加载」死循环'
      + '（2026-10-18 实测把 4GB 堆打满，client-bundle 测试直接 OOM）');
  }

  // 反面：loadPacks 必须存在（供按钮调用）
  assert.match(src, /function loadPacks\s*\(/, '应保留 loadPacks 供按钮调用');
  assert.match(src, /onClick: function \(\) \{ loadPacks\(\) \}/,
    '应有按钮显式触发 loadPacks');
});

// ── C33: 语音包 UI 必须给出授权提示 ────────────────────────────────────
test('C33: 语音包区域含 VOICEVOX 授权提示（不能默默装）', () => {
  const src = client;
  assert.match(src, /voicepacks\/index/, '应有列清单的调用');
  assert.match(src, /voicepacks\/install/, '应有安装调用');
  assert.match(src, /voicepacks\/uninstall/, '应有卸载调用');
  assert.match(src, /VOICEVOX 生成/, 'UI 必须说明这些语音由 VOICEVOX 生成');
  assert.match(src, /TERMS\.md/, '必须提示下载后会附条款文件');
});

// ── C34: 前端不得自己拼下载 URL（SSRF 防护）────────────────────────────
test('C34: 前端只传 key，不构造下载地址', () => {
  const src = client;
  const at = src.indexOf("apiUrl('voicepacks/install')");
  assert.ok(at >= 0, '应能找到安装调用');
  const seg = src.slice(at, at + 400);
  assert.match(seg, /JSON\.stringify\(\{ key: key \}\)/,
    '安装请求体应只含 key');
  assert.doesNotMatch(seg, /https?:\/\//,
    '前端不得出现下载 URL —— 地址必须由 host 从固定源算（否则就是 SSRF）');
});
// ── C35: 所有 set 返回必须带 packs（防状态字段被清掉）────────────────────
test('C35: 每个 set 的状态重建都保留 packs（否则语音包区会失效）', () => {
  const lines = client.split(/\r?\n/);
  const bad = [];

  for (let i = 0; i < lines.length; i++) {
    if (/return \{/.test(lines[i])) {
      const block = lines.slice(i, i + 6).join(' ');
      // 只检查"状态重建"形态（含 loaded:），不是普通数据对象
      if (/loaded:/.test(block) && !/packs:/.test(block)) {
        bad.push(i + 1);
      }
    }
  }

  assert.deepEqual(bad, [],
    '这些 set 返回没带 packs —— 组件状态是整体对象，漏字段等于把它重置成 undefined。\n'
    + '表现：拖一下音量滑杆，语音包区就白了/显示"加载失败"。\n'
    + '行号：' + bad.join(', '));
});

// ── C36: apply 的 success 分支也要带 packs ──────────────────────────────
test('C36: apply 成功后重新套用 values 时不能丢 packs', () => {
  const at = client.indexOf('function apply(patch, label) {');
  assert.ok(at > 0, '应能找到 apply');
  const seg = client.slice(at, at + 1400);

  // success 分支里同时出现 values 与 packs 才算对
  assert.match(seg, /values: r\.values \|\| p\.values/, '应套用服务端返回的生效值');
  assert.match(seg, /packs: p\.packs/, '同一分支必须保留 packs');
});
// ── C37: 所有 set 返回必须带 termsAck / termsPending ────────────────────
test('C37: termsAck/termsPending 必须在顶层，不能在 packs 内层', () => {
  // ⚠️ 2026-10-18 第三轮审阅指出：这条原来只检查"附近有没有 termsAck 字符串"，
  // 所以我用脚本批量补字段时把它插进了 `packs: { ... }` 内层，测试仍是绿的。
  //
  // 后果：刷新语音包列表后顶层确认状态被清掉 → 用户被反复要求确认同一音色。
  //
  // 现在改成**按缩进判断真实层级**：状态对象的属性缩进应该与 `packs:` 同级，
  // 而不是比它更深。
  const lines = client.split(/\r?\n/);
  const problems = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/termsAck:|termsPending:/.test(line)) continue;
    if (/^\s*\/\//.test(line)) continue;   // 注释不算

    const indent = line.length - line.trimStart().length;

    // 往上找最近的 `packs:` 行，看当前缩进是否比它大
    let packsIndent = -1;
    for (let j = i - 1; j >= Math.max(0, i - 12); j--) {
      if (/packs:\s*(\{|p\.packs|\{)/.test(lines[j])) {
        packsIndent = lines[j].length - lines[j].trimStart().length;
        break;
      }
      if (/^\s*\}\s*,?\s*$/.test(lines[j])) break;   // 遇到闭合就停
    }

    // 若在 packs 块里（缩进比 packs 深），就是错位
    if (packsIndent >= 0 && indent > packsIndent) {
      problems.push({ line: i + 1, indent, packsIndent });
    }
  }

  assert.deepEqual(problems, [],
    'termsAck/termsPending 被放进了 packs 子对象内层 —— '
    + '刷新列表后顶层状态会被清掉，用户会被反复要求确认条款。\n'
    + JSON.stringify(problems));
});

// ── C37b: 每个状态重建都必须真的带上这两个字段 ─────────────────────────
test('C37b: 每个 set 的状态重建都保留 termsAck 与 termsPending', () => {
  const lines = client.split(/\r?\n/);
  const bad = [];

  for (let i = 0; i < lines.length; i++) {
    if (/return \{/.test(lines[i])) {
      const block = lines.slice(i, i + 10).join(' ');
      if (/loaded:/.test(block)) {
        if (!/termsAck:/.test(block) || !/termsPending:/.test(block)) bad.push(i + 1);
      }
    }
  }

  assert.deepEqual(bad, [],
    '这些 set 没带 termsAck/termsPending —— 组件状态是整体对象，漏字段等于重置。\n'
    + '（这是同一个坑的第三次：advOpen、packs、termsAck 各一次）\n'
    + '行号：' + bad.join(', '));
});

// ── C38: 下载前必须有条款确认（不能直接开始下载）───────────────────────
test('C38: 未确认条款时点击下载要先问', () => {
  assert.match(client, /function askTerms/,
    '应有 askTerms 动作');
  assert.match(client, /function ackTerms/,
    '应有确认动作');
  assert.match(client, /if \(!\(s\.termsAck && s\.termsAck\[p\.key\]\)\) \{ askTerms\(p\); return \}/,
    '下载按钮必须先检查确认状态：未确认就弹面板，不能直接 addPack');
});

// ── C39: 条款确认面板必须展示署名与官方链接 ────────────────────────────
test('C39: 确认面板展示署名 + 官方条款链接', () => {
  assert.match(client, /下载前请先看条款/,
    '面板要有明确标题');
  assert.match(client, /署名要求/,
    '要显示署名要求（VOICEVOX 音色的核心义务）');
  assert.match(client, /官方条款：/,
    '要给出官方条款链接');
  assert.match(client, /下载后 zip 内也带 TERMS\.md/,
    '要说明包内也带条款文件');

  // 关键：不能只给"我已阅读"而没有链接
  const at = client.indexOf('下载前请先看条款');
  const seg = client.slice(at, at + 1200);
  assert.match(seg, /termsUrl/,
    '面板必须真的用到 termsUrl —— 否则用户没处读条款就要点确认');
});
// ── C40: 条款确认必须是居中覆盖弹窗，不能是列表下方的内联面板 ──────────
test('C40: 条款确认是覆盖式弹窗（固定在视口中心，不随滚动）', () => {
  // 2026-10-18 用户实测反馈：v0.4.40 把确认面板放在语音包列表**下面**，
  // 点列表上面几个音色时面板在屏幕外看不见 ——
  // 用户以为已经在下载，实际在等一个他没看见的确认。
  //
  // 这不只是"位置靠下"，而是**不阻断**：后面所有按钮照常可点。
  assert.match(client, /function renderTermsModal/,
    '应有独立的弹窗渲染函数');

  const at = client.indexOf('function renderTermsModal');
  const seg = client.slice(at, at + 1200);

  assert.match(seg, /position:\s*'fixed'/,
    '弹窗必须用 position:fixed 才能固定在视口中心 —— '
    + '相对定位会跟着设置卡片滚动，重演"看不见"的问题');
  assert.match(seg, /justifyContent:\s*'center'/,
    '应水平居中');
  assert.match(seg, /alignItems:\s*'center'/,
    '应垂直居中');
  assert.match(seg, /zIndex/,
    '需要 zIndex 才能盖在其他内容之上');

  // 遮罩要能吃掉点击（阻断背后交互）
  assert.match(seg, /background:\s*'rgba\(0,0,0/,
    '应有半透明遮罩');
});

// ── C41: 弹窗作为根的兄弟节点，不能塞进 rows ────────────────────────────
test('C41: 弹窗挂在根上而不是 rows 里', () => {
  // 塞进 rows 会跟着滚动（位置不固定），这是设计上的硬要求。
  const at = client.indexOf("h('div', { key: 'root-box', style: S.box }, rows)");
  assert.ok(at > 0, '根渲染应把 rows 包进 root-box');

  // 弹窗应在根层 push，而不是 rows.push
  assert.match(client, /rootKids\.push\(renderTermsModal/,
    '弹窗应 push 到 rootKids（根的兄弟层），而不是 rows');

  assert.doesNotMatch(client, /rows\.push\(renderTermsModal/,
    '不能把弹窗塞进 rows —— 那会跟着滚动');
});

// ── C42: 点遮罩可关闭（不能把用户困住）──────────────────────────────────
test('C42: 点遮罩外部可取消，点卡片内部不取消', () => {
  const at = client.indexOf('function renderTermsModal');
  const seg = client.slice(at, at + 1200);

  assert.match(seg, /e\.target === e\.currentTarget/,
    '应区分"点遮罩"与"点卡片内部" —— 否则点卡片任意位置都会关掉弹窗');
  assert.match(seg, /cancelTerms\(\)/,
    '点外部应取消');
});
// ── C43: set() 里的状态字段必须来自它自己的参数 ─────────────────────────
test('C43: 状态字段引用必须用 set() 自己的参数，不得用外层变量', () => {
  // ⚠️ 2026-10-18 真实 bug（外部审阅发现）：
  //
  //   pickCustomFile().then(function (p) {      // p 是文件路径字符串
  //     set(function (prev) {                   // 状态参数叫 prev
  //       return { ..., packs: p.packs, ... }   // ← 用错的变量！
  //     })
  //   })
  //
  // `p` 是路径字符串（取消时是空串），`p.packs` 恒为 undefined →
  // 用户取消选择自定义音频后，**已加载的语音包状态被清掉**。
  //
  // 这类"状态字段遗漏/用错变量"已经出现 4 次（advOpen / packs /
  // termsAck / 这次的 p.packs）。所以用静态扫描固定住，而不是靠人记得。
  const lines = client.split(/\r?\n/);
  const FIELDS = ['loaded', 'values', 'advOpen', 'packs', 'termsAck', 'termsPending', 'busy', 'msg', 'err'];

  // 允许引用非状态参数的对象：它们是**接口响应**，恰好也有同名字段。
  //   r    —— saveConfig 的返回值（含 values）
  //   doc  —— fetchVoicePacks 的返回值（含 packs）
  const ALLOW = new Set(['r', 'doc']);

  const bad = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/set\(function \((\w+)\) \{/);
    if (!m) continue;
    const param = m[1];

    // 取该 set 的块
    let depth = 0, started = false, end = i;
    for (let j = i; j < Math.min(i + 30, lines.length); j++) {
      for (const ch of lines[j]) {
        if (ch === '{') { depth++; started = true; }
        else if (ch === '}') { depth--; }
      }
      if (started && depth === 0) { end = j; break; }
    }
    const block = lines.slice(i, end + 1).join('\n');

    for (const f of FIELDS) {
      const re = new RegExp(`([A-Za-z_$][\\w$]*)\\.${f}\\b`, 'g');
      let mm;
      while ((mm = re.exec(block)) !== null) {
        const ident = mm[1];
        if (ident === param || ALLOW.has(ident)) continue;
        bad.push(`L${i + 1}: 参数=${param} 但用了 ${mm[0]}`);
      }
    }
  }

  assert.deepEqual(bad, [],
    '这些 set() 引用了不属于它自己状态参数的字段 —— '
    + '典型后果是把已加载的状态清成 undefined（语音包列表消失等）。\n'
    + bad.join('\n'));
});