/**
 * 第二阶段 UI 行为回归（v0.4.54）。
 *
 * ## 为什么这些测试必须存在
 *
 * 这一阶段引入了「按声音来源动态显示」——它是**最容易写坏**的一类改动：
 * 条件写错就会把某个音源的必要控件藏掉；实现方式不当还会顺手清掉别的音源的配置。
 *
 * 用户明确要求：**切换声音来源只能影响可见性，不能删除/重置/修改其他音源的已保存配置。**
 * 这条不能靠"我看着没问题"保证，必须用测试钉住。
 *
 * ## 测试策略
 *
 * 用与 client-bundle 相同的假 React 跑同一份 client.js：
 *   · 渲染不同 audioSource，断言**出现/不出现**哪些控件
 *   · 切换一圈后，断言主 state 的 `values` **逐字段没变**
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');

// ── 假 React（与 client-bundle 同款）─────────────────────────────────────
function fakeReact() {
  const createElement = (type, props, ...children) => ({
    $$typeof: Symbol.for('react.element'),
    type,
    props: { ...(props || {}), children },
  });
  const hooks = { slots: [], index: 0, eff: 0, ranEff: new Set(), rerender: null };
  const useState = (init) => {
    const i = hooks.index++;
    if (hooks.slots[i] === undefined) {
      hooks.slots[i] = { value: typeof init === 'function' ? init() : init };
    }
    const slot = hooks.slots[i];
    const set = (updater) => {
      slot.value = typeof updater === 'function' ? updater(slot.value) : updater;
      if (typeof hooks.rerender === 'function') hooks.rerender();
    };
    return [slot.value, set];
  };
  /**
   * effect 只跑一次 —— 模拟组件里 `useEffect(fn, [])` 的语义。
   *
   * ⚠️⚠️ 这里踩了两次坑，两个都必须处理：
   *
   *  ① **不能立即调 cleanup**：真实 React 只在卸载时调。若立刻调，
   *     组件的 `alive = false` 会让 `loadConfig().then(...)` 直接 return，
   *     values 永远停在占位默认值 —— "配置没被改动"的断言就变成假绿。
   *
   *  ② **不能每次渲染都跑**：effect 里 `loadConfig().then(set)`，
   *     而 set 会触发 rerender → 再跑 effect → 再 loadConfig …
   *     这是**无限递归**，实测直接把 4GB 堆打满（v0.4.33 踩过同一个坑）。
   *     真实 React 靠 `[]` 依赖只跑一次，假 React 必须自己模拟。
   */
  const useEffect = (fn) => {
    const i = hooks.eff++;
    if (hooks.ranEff.has(i)) return;      // 已经跑过，跳过（= [] 依赖）
    hooks.ranEff.add(i);
    try { fn(); } catch { /* ignore */ }
  };
  const resetIndex = () => { hooks.index = 0; hooks.eff = 0; };
  return { createElement, useState, useEffect, __hooks: hooks, __resetIndex: resetIndex };
}

/** 完整配置：每个字段都给个非默认值，便于发现"被重置"。 */
const FULL = {
  voice: true, voiceMode: 'random', voiceName: 'ameharu-hau', volume: 37,
  notifyOnComplete: false, notifyOnError: true, notifyOnBlocked: true,
  notifyOnAborted: true, notifyOnApproval: false, notifyOnQuestion: true,
  subagents: true, idleGate: false,
  audioSource: 'tts', showToast: false, ttsVoice: 'Huihui', ttsRate: 4, devReload: false,
  logLevel: 'debug', voiceGain: 3.1, normalizeCustomAudio: true,
  jumpWhenBackground: false, jumpWhenForeground: true,
  debounceSeconds: 5, globalCooldownSeconds: 120,
  audioSourceByKind: { fail: 'system' }, ttsTexts: { done: '测试台词' },
  kindSystemSound: {}, kindVoiceName: {}, customFiles: {},
};

/** 加载 client.js 并拿到设置组件。 */
async function loadCard() {
  let captured = null;
  const fakeWindow = {
    __ModuleLoader__: { load(def) { captured = def; } },
    addEventListener() {}, removeEventListener() {},
  };
  new Function('window', 'document', CLIENT)(fakeWindow, undefined);
  if (!captured) throw new Error('client.js 没有注册');

  const r = fakeReact();
  const mod = captured.factory((id) => {
    if (id === 'react') return r;
    throw new Error('client 不应 require: ' + id);
  });

  let component = null;
  mod.apply({
    get(id) {
      if (id === 'slots') return { inject(_n, fn) { fn(); }, register(_m, c) { component = c; } };
      return undefined;
    },
  });
  if (!component) throw new Error('没有注册设置卡');

  globalThis.fetch = (url) => Promise.resolve({
    ok: true, status: 200,
    json: () => Promise.resolve(
      String(url).includes('version')
        ? { ok: true, running: '0.4.54', installed: '0.4.54', latest: '0.4.54', hasUpdate: false, npmLatest: '0.4.54', githubLatest: '0.4.54', installMode: 'managed', changelogUrl: 'x' }
        : { ok: true, values: FULL, packs: [] },
    ),
  });

  const render = () => { r.__resetIndex(); return component({}); };

  // ⚠️ 必须先渲染一次：hook 槽是渲染时才建立的，
  // 不渲染就拿不到主 state 槽（第一版就是这样，报「找不到主 state 槽」）。
  render();
  r.__hooks.rerender = render;

  // 等 loadConfig / fetchVersion 的 Promise 链跑完，让 values 变成 host 的真实值。
  // 不等的话 values 还是占位默认值，"配置没被改动"的断言就没有意义。
  for (let i = 0; i < 8; i++) await Promise.resolve();
  render();

  return { r, component, render };
}

/**
 * 按形状定位主 state 槽。
 *
 * ⚠️ 不要写死索引：组件有多个 useState（版本 / 试听 / 高级分区 / 主 state），
 * 以后再加一个就会让 slots[N] 指错 —— 这个错误我刚刚踩过：
 * renderWith 里写死 slots[1]，取到的是「试听 state」，改 audioSource 完全没效果。
 */
function findMainSlot(card) {
  const slot = card.r.__hooks.slots.find(
    (s) => s && s.value && typeof s.value === 'object'
      && 'values' in s.value && 'loaded' in s.value,
  );
  if (!slot) throw new Error('找不到主 state 槽（形状不符）');
  return slot;
}

/** 收集树里的所有文本。 */
function texts(node, out) {
  const acc = out || [];
  if (node === null || node === undefined || node === false) return acc;
  if (typeof node === 'string' || typeof node === 'number') { acc.push(String(node)); return acc; }
  if (Array.isArray(node)) { node.forEach((n) => texts(n, acc)); return acc; }
  texts(node.props && node.props.children, acc);
  return acc;
}

/** 收集树里所有元素。 */
function elements(node, out) {
  const acc = out || [];
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) { node.forEach((n) => elements(n, acc)); return acc; }
  if (node.type) acc.push(node);
  elements(node.props && node.props.children, acc);
  return acc;
}

/** 把 audioSource 设成指定值后渲染，返回 { text, els }。 */
function renderWith(card, source, extra) {
  // ⚠️ 不要写死索引：这个组件有多个 useState（版本 / 试听 / 高级分区 / 主 state），
  // 以后再加一个就会让硬编码的 slots[N] 指错。按形状找：主 state 一定同时有
  // `values` 和 `loaded`。
  const mainSlot = findMainSlot(card);
  assert.ok(mainSlot, '应能按形状定位主 state 槽');
  mainSlot.value = {
    ...mainSlot.value,
    ...(extra || {}),
    values: { ...mainSlot.value.values, audioSource: source },
  };
  const tree = card.render();
  return { text: texts(tree).join(' '), els: elements(tree) };
}

const has = (text, s) => text.includes(s);

// ── N1: 每种音源显示它需要的控件，隐藏无关的 ────────────────────────────
test('N1: 按声音来源显示对应控件', async () => {
  const card = await loadCard();

  // tts：朗读声音 / 语速 / 自定义台词
  {
    const { text } = renderWith(card, 'tts');
    assert.ok(has(text, '朗读声音'), 'tts 应显示「朗读声音」');
    assert.ok(has(text, '语速'), 'tts 应显示「语速」');
    assert.ok(!has(text, '语音包增益'), 'tts 不应显示语音包增益');
    assert.ok(!has(text, '自定义音频标准化'), 'tts 不应显示标准化');
  }

  // bundled：音色模式 / 音色 / 增益 / 语音包
  {
    const { text } = renderWith(card, 'bundled');
    assert.ok(has(text, '语音包增益'), 'bundled 应显示语音包增益');
    assert.ok(has(text, '音色模式'), 'bundled 应显示音色模式');
    assert.ok(has(text, '语音包'), 'bundled 应显示语音包管理');
    assert.ok(!has(text, '朗读声音'), 'bundled 不应显示 TTS 朗读声音');
  }

  // system：只有音量 + 试听
  {
    const { text } = renderWith(card, 'system');
    assert.ok(has(text, '音量'), 'system 应显示音量');
    assert.ok(has(text, '试听'), 'system 应显示试听');
    assert.ok(!has(text, '语音包增益'), 'system 不应显示增益');
    assert.ok(!has(text, '朗读声音'), 'system 不应显示 TTS');
  }

  // custom：文件选择 / 标准化
  {
    const { text } = renderWith(card, 'custom');
    assert.ok(has(text, '自定义音频标准化'), 'custom 应显示标准化');
    assert.ok(!has(text, '语音包增益'), 'custom 不应显示增益');
    assert.ok(!has(text, '朗读声音'), 'custom 不应显示 TTS');
  }

  // none：隐藏音频设置，但保留弹窗开关与提醒规则
  {
    const { text, els } = renderWith(card, 'none');
    assert.ok(has(text, '不出声'), 'none 应有说明');
    assert.ok(has(text, '显示通知弹窗'), 'none 仍应保留弹窗开关');
    assert.ok(has(text, '提醒规则'), 'none 仍应保留提醒规则');
    const sliders = els.filter((e) => e.type === 'input' && e.props.type === 'range');
    assert.equal(sliders.length, 0, 'none 时不应有音量滑杆');
  }
});

// ── N2: 切换音源不改变任何已保存配置（最重要的一条）────────────────────
test('N2: 切一圈音源后，values 逐字段不变', async () => {
  const card = await loadCard();
  const mainSlot = findMainSlot(card);

  const before = JSON.parse(JSON.stringify(mainSlot.value.values));
  assert.equal(before.audioSource, 'tts', '起始音源应为 tts');

  const seen = [];
  for (const src of ['bundled', 'system', 'custom', 'none', 'tts']) {
    const { text } = renderWith(card, src);
    seen.push(src);
    // 每次切换后，除了 audioSource，其它字段必须一字不差
    const now = mainSlot.value.values;
    const withoutSource = (o) => {
      const c = { ...o };
      delete c.audioSource;
      return c;
    };
    assert.deepEqual(
      withoutSource(now),
      withoutSource({ ...before, audioSource: src }),
      `切到 ${src} 后其它字段被改动了 —— 动态显示只能影响可见性`,
    );
    // 其它音源的配置也要还在
    assert.equal(now.ttsRate, 4, `切到 ${src} 后 ttsRate 不该变`);
    assert.equal(now.voiceGain, 3.1, `切到 ${src} 后 voiceGain 不该变`);
    assert.equal(now.normalizeCustomAudio, true, `切到 ${src} 后 normalizeCustomAudio 不该变`);
    assert.deepEqual(now.audioSourceByKind, { fail: 'system' }, `切到 ${src} 后按事件覆盖不该变`);
  }
  assert.deepEqual(seen, ['bundled', 'system', 'custom', 'none', 'tts']);
});

// ── N3: 高级设置四个二级分组，默认全部收起 ──────────────────────────────
test('N3: 高级设置默认折叠；展开后四个子组默认也收起', async () => {
  const card = await loadCard();

  // 未展开：四个子组标题都不出现
  {
    const { text } = renderWith(card, 'tts');
    assert.ok(has(text, '高级设置'), '应有高级设置标题');
    assert.ok(!has(text, '按事件定制声音'), '未展开时不应出现子组');
  }

  // 展开高级设置：四个子组标题出现，但内容仍收起
  {
    const { text } = renderWith(card, 'tts', { advOpen: true });
    for (const t of ['按事件定制声音', '诊断与日志', '版本与更新', '开发者选项']) {
      assert.ok(has(text, t), `展开后应出现子组「${t}」`);
    }
    // 内容仍收起：不该看到具体控件
    assert.ok(!has(text, '跟随默认'), '子组默认收起，不应显示按事件覆盖的下拉');
    // ⚠️ 不能断言 '日志详细度'：它出现在子组的**说明文字**里
    //（「日志详细度，以及导出脱敏后的诊断文件。」），不是控件 —— 会假红。
    // 断言控件独有文案：下拉的选项。
    assert.ok(!has(text, '只记元数据'), '子组默认收起，不应显示日志级别控件');
    assert.ok(!has(text, '改代码后自动热重载'), '子组默认收起，不应显示热重载');
  }
});

// ── N4: 试听有忙碌态（点击后按钮变「…」且禁用）──────────────────────────
test('N4: 试听按钮具备忙碌与失败状态', () => {
  // 静态断言：忙碌 state 参与 disabled 与按钮文案
  assert.match(CLIENT, /var pvst = React\.useState/,
    '应有独立的试听状态（不塞进主 state）');
  assert.match(CLIENT, /disabled: s\.busy \|\| \(pvState\.kind !== ""\)/,
    '试听期间所有试听按钮应禁用（防连点撞限流）');
  assert.match(CLIENT, /isBusy \? '…' : pair\[1\]/,
    '正在试听的那个按钮应显示「…」，让用户知道点到了');
  // 失败走 err（红色），成功走 msg（绿色）—— 不再只有一句中性文案
  assert.match(CLIENT, /err: ok[\s\S]{0,200}试听「[\s\S]{0,80}没有成功/,
    '试听失败应写进 err 并说明原因');
});

// ── N5: 切换声音来源只改 audioSource 一个字段 ───────────────────────────
test('N5: 声音来源的 onChange 只提交 audioSource', () => {
  // ⚠️ 为什么需要这条：N2 是直接改 state 来验证"渲染不污染 values"，
  // 它**绕过 onChange 处理器**。所以如果有人"顺手"在切换音源时清掉别的
  // 音源配置（`apply({ audioSource: x, ttsRate: 0 })`），N2 抓不到 ——
  // 我实测过这个变异，N2 全绿。这条专门盯住处理器提交的字段集。
  const m = CLIENT.match(
    /onChange: function \(e\) \{ apply\(\{ ([^}]+) \}, '声音来源已更新'\) \}/,
  );
  assert.ok(m, '应能定位「声音来源」下拉的 onChange');

  const keys = m[1]
    .split(',')
    .map((s) => s.split(':')[0].trim())
    .filter(Boolean);

  assert.deepEqual(keys, ['audioSource'],
    '切换声音来源只能提交 audioSource —— 带上别的键就会把那个音源的配置一起改掉');
});