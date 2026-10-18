/**
 * 定稿前的收尾行为测试（v0.4.56）。
 *
 * 这两条来自用户评审：
 *   ① 静音时音频设置应收起，但**不能禁用试听**
 *   ② 「条款链接待补」不能虚报
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');

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
  // 只跑一次（模拟 [] 依赖）；不调 cleanup（否则 alive=false，配置永远不合并）
  const useEffect = (fn) => {
    const i = hooks.eff++;
    if (hooks.ranEff.has(i)) return;
    hooks.ranEff.add(i);
    try { fn(); } catch { /* ignore */ }
  };
  const resetIndex = () => { hooks.index = 0; hooks.eff = 0; };
  return { createElement, useState, useEffect, __hooks: hooks, __resetIndex: resetIndex };
}

const FULL = {
  voice: true, voiceMode: 'fixed', voiceName: 'zundamon-normal', volume: 80,
  notifyOnComplete: true, notifyOnError: true, notifyOnBlocked: true,
  notifyOnAborted: false, notifyOnApproval: true, notifyOnQuestion: true,
  subagents: false, idleGate: true,
  audioSource: 'tts', showToast: true, ttsVoice: '', ttsRate: 0, devReload: false,
  logLevel: 'info', voiceGain: 2.0, normalizeCustomAudio: false,
  jumpWhenBackground: true, jumpWhenForeground: false,
  debounceSeconds: 60, globalCooldownSeconds: 0,
  audioSourceByKind: {}, ttsTexts: {}, kindSystemSound: {}, kindVoiceName: {},
  customFiles: {},
};

function texts(node, out) {
  const acc = out || [];
  if (node === null || node === undefined || node === false) return acc;
  if (typeof node === 'string' || typeof node === 'number') { acc.push(String(node)); return acc; }
  if (Array.isArray(node)) { node.forEach((n) => texts(n, acc)); return acc; }
  texts(node.props && node.props.children, acc);
  return acc;
}

function elements(node, out) {
  const acc = out || [];
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) { node.forEach((n) => elements(n, acc)); return acc; }
  if (node.type) acc.push(node);
  elements(node.props && node.props.children, acc);
  return acc;
}

/** 按形状找主 state 槽（组件有多个 useState，不能写死索引）。 */
function findMainSlot(card) {
  const s = card.r.__hooks.slots.find(
    (x) => x && x.value && typeof x.value === 'object'
      && 'values' in x.value && 'loaded' in x.value,
  );
  if (!s) throw new Error('找不到主 state 槽');
  return s;
}

/** 按形状找「声音设置展开状态」槽（{ open: ... }）。 */
function findSoundSlot(card) {
  const s = card.r.__hooks.slots.find(
    (x) => x && x.value && typeof x.value === 'object'
      && 'open' in x.value && Object.keys(x.value).length === 1,
  );
  if (!s) throw new Error('找不到声音区 state 槽');
  return s;
}

async function loadCard() {
  let captured = null;
  new Function('window', 'document', CLIENT)(
    { __ModuleLoader__: { load(def) { captured = def; } }, addEventListener() {}, removeEventListener() {} },
    undefined,
  );
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
        ? {
          ok: true, running: '0.4.56', installed: '0.4.56', latest: '0.4.56',
          hasUpdate: false, needsRestart: false, npmLatest: '0.4.56',
          githubLatest: '0.4.56', installMode: 'managed', changelogUrl: 'x',
        }
        : { ok: true, values: FULL, packs: [] },
    ),
  });

  const render = () => { r.__resetIndex(); return component({}); };
  render();
  r.__hooks.rerender = render;
  for (let i = 0; i < 8; i++) await Promise.resolve();
  return { r, render };
}

const has = (text, s) => text.includes(s);

/** 设 state 后渲染。 */
function renderWith(card, main, sound) {
  findMainSlot(card).value = { ...findMainSlot(card).value, ...main };
  if (sound !== undefined) findSoundSlot(card).value = { open: sound };
  const tree = card.render();
  return { text: texts(tree).join(' '), els: elements(tree) };
}

// ── N6: 静音时收起声音设置，但不禁用试听 ────────────────────────────────
test('N6: 声音提醒关闭时收起音频设置，试听仍可用', async () => {
  const card = await loadCard();

  // 声音开着 → 正常展开；手动把 open 置 null（跟随默认）
  {
    const { text } = renderWith(card,
      { values: { ...FULL, audioSource: 'tts', voice: true } }, null);
    assert.ok(has(text, '朗读声音'), '声音开着时应正常显示音频控件');
    assert.ok(!has(text, '声音提醒已关闭'), '声音开着时不该出现收起提示');
  }

  // 声音关掉 → 收起，但说明"配置还在"
  {
    const { text } = renderWith(card,
      { values: { ...FULL, audioSource: 'tts', voice: false } }, null);
    assert.ok(has(text, '声音提醒已关闭，原有配置已保留'),
      '静音时应说明「配置还在」，否则用户以为被清掉了');
    assert.ok(!has(text, '朗读声音'), '静音时应收起音频控件');
  }

  // 用户手动展开 → 控件回来，且试听**没有**被禁用
  {
    const { text, els } = renderWith(card,
      { values: { ...FULL, audioSource: 'tts', voice: false } }, true);
    assert.ok(has(text, '朗读声音'), '手动展开后应能看到音频控件');

    const pvButtons = els.filter((e) => {
      if (e.type !== 'button') return false;
      const kids = e.props.children || [];
      return ['完成', '失败', '提问', '批准', '拦截'].includes(kids[0]);
    });
    assert.ok(pvButtons.length >= 5, `五个试听按钮都应存在（实际 ${pvButtons.length}）`);
    assert.ok(pvButtons.every((b) => !b.props.disabled),
      '静音**不得禁用试听** —— 试听是测试配置的行为，与通知开关无关');
  }
});

// ── N7: 条款占位不虚报 ──────────────────────────────────────────────────
test('N7: 条款占位只在「能下载却没条款」时出现', () => {
  // 用户评审时看到「条款链接待补」，要求核实是不是发布缺字段。
  //
  // 核实结论：真实 packs.json 的 13 个音色都有 terms，服务端也转成 termsUrl
  // （R7 用真实请求钉住）。但**离线**时索引取不到，已安装的包没有 termsUrl ——
  // 原来会显示占位，看起来像发布缺字段。
  //
  // 现在判据收窄为「能下载 && 没条款」。
  assert.match(
    CLIENT,
    /\(p\.downloadable && !p\.termsUrl\)/,
    '占位提示必须同时要求 downloadable —— 否则离线时会虚报',
  );
  // 反面断言：不能退回「没有 termsUrl 就报」
  assert.doesNotMatch(
    CLIENT,
    /\+ \(p\.termsUrl \? '' : '　（条款链接待补）'\)/,
    '不应退回旧的「没 termsUrl 就提示」判据',
  );
});

// ── N8: 高级区不再有重复标题 ────────────────────────────────────────────
test('N8: 高级区四个子组没有重复的内部标题', async () => {
  const card = await loadCard();
  const { text } = renderWith(card, { advOpen: true }, undefined);
  // 子组标题「按事件定制声音」只应出现一次（内部不再重复「按事件覆盖声音来源」）
  const occurrences = text.split('按事件定制声音').length - 1;
  assert.equal(occurrences, 1, `「按事件定制声音」应只出现一次（实际 ${occurrences}）`);
  assert.doesNotMatch(CLIENT, /'按事件覆盖声音来源'/,
    '内部标题应已删除 —— 与二级分组标题重复');
});
