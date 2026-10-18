/**
 * 检查更新（v0.4.48）。
 *
 * ## 这个功能最需要测什么
 *
 * 不是"能不能查到版本"——那是网络问题，测不出什么。
 * 真正要锁的是**它不会做危险的事**：
 *   · 不能自己下载/覆盖文件/执行命令
 *   · 不能走 /releases/latest（实测那指向 voice-packs，不是插件版本）
 *   · 不能因为检查失败影响通知与语音
 *   · 开发模式（Junction）绝对不能给出会覆盖源码的命令
 *   · 不能接受客户端传的 URL（SSRF）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8');
const CLIENT = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
const UC = readFileSync(join(ROOT, 'lib', 'update-check.js'), 'utf8');

// ── U1: 版本解析与比较 ──────────────────────────────────────────────────
test('U1: 版本比较正确处理 v 前缀与非法输入', async () => {
  const { parseVersion, compareVersions } = await import('../lib/update-check.js');

  assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3]);
  assert.equal(parseVersion('abc'), null);
  assert.equal(parseVersion(''), null);

  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('1.2.3', '1.2.4'), -1);
  assert.equal(compareVersions('1.3.0', '1.2.9'), 1);
  assert.equal(compareVersions('v0.4.47', '0.4.46'), 1);
  // 解析不出就返回 null —— 调用方据此**不下"有新版"的结论**
  assert.equal(compareVersions('abc', '1.0.0'), null);
});

// ── U2: 不解析的版本不能误报"有新版" ────────────────────────────────────
test('U2: 版本格式异常时 hasUpdate 为 null（不误报）', async () => {
  const { checkForUpdate } = await import('../lib/update-check.js');

  const tmp = join(ROOT, '.tmp-u2-' + Math.random().toString(36).slice(2, 8));
  try {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ version: 'weird' }));

    const fake = async () => ({ ok: true, json: async () => ({ 'dist-tags': { latest: '9.9.9' } }) });
    const r = await checkForUpdate({ pluginRoot: tmp, force: true, fetchImpl: fake });
    assert.equal(r.ok, true);
    assert.equal(r.hasUpdate, null,
      '本地版本解析不出时不能判定"有新版"，否则用户会去升级一个根本没装的东西');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── U3: 开发模式（Junction / 源码）不给升级命令 ─────────────────────────
test('U3: 开发模式不给出会覆盖源码的命令', async () => {
  const { upgradeHint, detectInstallMode } = await import('../lib/update-check.js');

  const dev = upgradeHint('dev');
  assert.equal(dev.command, '',
    '开发模式必须**没有**命令 —— 本机是 Junction 指向开发源码，'
    + '用 dsh plugin update 会直接覆盖掉源码');
  assert.match(dev.note, /不要/,
    '必须明确劝阻用插件升级命令');

  const npm = upgradeHint('npm');
  assert.match(npm.command, /dsh plugin .*update dsh-notify-say/,
    'npm 安装才给 dsh 的升级命令');
  assert.match(npm.command, /<.*profile.*>/,
    'profile 名无法可靠得知，必须用占位符而不是假装知道');
  assert.match(npm.note, /重启/,
    '要提示更新后需重启 profile');
});

// ── U4: 源失败要回退，两个都失败要如实报错 ──────────────────────────────
test('U4: npm 失败回退 GitHub；都失败时如实报错', async () => {
  const { checkForUpdate, NPM_REGISTRY_URL, GITHUB_RAW_PKG_URL } =
    await import('../lib/update-check.js');

  // ① npm 挂、GitHub 通
  const seen = [];
  const f1 = async (url) => {
    seen.push(url);
    if (url === NPM_REGISTRY_URL) return { ok: false, status: 500 };
    return { ok: true, json: async () => ({ version: '0.4.99' }) };
  };
  const r1 = await checkForUpdate({ pluginRoot: ROOT, force: true, fetchImpl: f1 });
  assert.equal(r1.ok, true);
  assert.equal(r1.source, 'github', 'npm 挂了应标明用的是 GitHub');
  assert.ok(seen.includes(GITHUB_RAW_PKG_URL));

  // ② 两个都挂
  const f2 = async () => ({ ok: false, status: 503 });
  const r2 = await checkForUpdate({ pluginRoot: ROOT, force: true, fetchImpl: f2 });
  assert.equal(r2.ok, false);
  assert.match(String(r2.error), /npm|github/, '应把两个源的失败都说出来');
});

// ── U5: 检查更新永不抛异常（不能把设置页弄崩）───────────────────────────
test('U5: fetch 抛异常时返回结构化错误，不抛出', async () => {
  const { checkForUpdate } = await import('../lib/update-check.js');
  const boom = async () => { throw new Error('network down'); };

  const r = await checkForUpdate({ pluginRoot: ROOT, force: true, fetchImpl: boom });
  assert.equal(r.ok, false);
  assert.ok(r.error, '应给出错误原因');
  // 关键：仍然带出当前版本 —— 界面要能显示"你装的是哪个版本"
  assert.ok(r.current, '失败时也要报告当前版本');
});

// ── U6: 缓存 24 小时，force 可绕过 ──────────────────────────────────────
test('U6: 宿主侧缓存 24 小时，force 绕过', async () => {
  const { checkForUpdate, AUTO_CHECK_TTL_MS } = await import('../lib/update-check.js');
  const cache = { at: 0, result: null };

  let calls = 0;
  const fake = async () => {
    calls++;
    return { ok: true, json: async () => ({ 'dist-tags': { latest: '0.4.99' } }) };
  };

  const t0 = 1_700_000_000_000;
  await checkForUpdate({ pluginRoot: ROOT, fetchImpl: fake, cache, now: t0 });
  assert.equal(calls, 1);

  // TTL 内再来一次：用缓存，不再联网
  const r2 = await checkForUpdate({ pluginRoot: ROOT, fetchImpl: fake, cache, now: t0 + 1000 });
  assert.equal(calls, 1, 'TTL 内不应重复联网');
  assert.equal(r2.cached, true);

  // force 强制联网
  await checkForUpdate({ pluginRoot: ROOT, fetchImpl: fake, cache, now: t0 + 2000, force: true });
  assert.equal(calls, 2, 'force 应绕过缓存');

  // 过期后重新联网
  // ⚠️ 注意基准：上面 force 那次把 cache.at 刷新到 t0+2000，
  // 所以要相对**它**算过期，而不是相对 t0（第一版算错，误判成"未过期"）。
  await checkForUpdate({
    pluginRoot: ROOT, fetchImpl: fake, cache,
    now: t0 + 2000 + AUTO_CHECK_TTL_MS + 1,
  });
  assert.equal(calls, 3, '超过 TTL 应重新联网');
});

// ── U7: 不用 /releases/latest（实测那指向 voice-packs）──────────────────
test('U7: 权威源不是 GitHub Releases 的 latest', () => {
  // ⚠️ 实测（2026-10-18）：本仓库 /releases/latest 返回 tag `voice-packs`,
  // 那是语音包索引，跟插件版本毫无关系。
  // 用它会得出"最新版是 voice-packs"这种荒谬结论。
  // ⚠️ 只查代码，不查注释 —— 注释里正是在解释"为什么不能用它"。
  const code = UC
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /releases\/latest/,
    '不得使用 /releases/latest 作为插件版本来源（它指向 voice-packs）');

  assert.match(UC, /registry\.npmjs\.org/,
    '应查 npm registry');
  assert.match(UC, /raw\.githubusercontent\.com/,
    '应查 GitHub main 的 package.json');
});

// ── U8: 只读，不做任何危险动作 ──────────────────────────────────────────
test('U8: update-check 不下载、不写盘、不执行命令', () => {
  // 这是这个功能的**核心安全边界**：它只报告，不行动。
  for (const danger of [
    /writeFileSync/,
    /mkdirSync/,
    /unlinkSync/,
    /rmSync/,
    /child_process/,
    /execSync/,
    /spawn/,
  ]) {
    assert.doesNotMatch(UC, danger,
      `update-check 不应包含 ${danger} —— 它只检查，不安装`);
  }
});

// ── U9: /version 路由是只读的 ───────────────────────────────────────────
test('U9: /version 不在写操作白名单里，且不接受客户端 URL', () => {
  // isWriteRoute 里不应出现 version
  const at = INDEX.indexOf('const isWriteRoute');
  assert.ok(at > 0);
  const seg = INDEX.slice(at, at + 700);
  assert.doesNotMatch(seg, /'version'/,
    '/version 没有任何副作用，不该算写操作（否则会被强制要求 JSON 与 Origin）');

  // 路由内部不能从请求里读 URL —— 那等于让本机访问任意地址（SSRF）
  const vAt = INDEX.indexOf("if (head === 'version') {");
  assert.ok(vAt > 0, '应有 /version 路由');
  const vSeg = INDEX.slice(vAt, vAt + 1200);
  assert.doesNotMatch(vSeg, /searchParams\.get\(['"]url/,
    '不得接受客户端传入的查询地址');
  assert.doesNotMatch(vSeg, /req\.url.*https?:/,
    '不得把请求里的 URL 直接当抓取目标');
});

// ── U10: 前端只读结果，不执行任何安装动作 ───────────────────────────────
test('U10: GUI 只显示版本与命令，绝不自动安装', () => {
  // 界面上有版本卡片
  assert.match(CLIENT, /版本与更新/);
  assert.match(CLIENT, /检查更新/);

  // 但**不能**有任何"自动更新"的调用
  for (const danger of [
    /updatePlugin\s*\(/,
    /installUpdate\s*\(/,
    /applyUpdate\s*\(/,
  ]) {
    assert.doesNotMatch(CLIENT, danger,
      'GUI 不得有自动安装/自动更新的入口');
  }

  // 升级命令只能是"显示"和"复制"，不能被执行
  const at = CLIENT.indexOf('copyUpgradeCommand');
  assert.ok(at > 0, '应有复制命令的动作');
  const seg = CLIENT.slice(at, at + 800);
  assert.doesNotMatch(seg, /exec|spawn|shell/i,
    '复制命令只能写剪贴板，不能执行');
});

// ── U11: 版本状态用独立 state，不掺进主 state ───────────────────────────
test('U11: 版本信息用独立 useState（避开 25 处 set 的字段遗漏坑）', () => {
  // 主 state 有 25 处 set() 逐字段重建，加字段要改 25 处 ——
  // 已因此出过 4 次 bug。版本信息走独立 state 就一劳永逸。
  assert.match(CLIENT, /var vst = React\.useState\(/,
    '版本信息应有独立的 useState');
  assert.match(CLIENT, /var vset = vst\[1\]/);

  // 主 state 里不应出现 version 字段（那会要求 25 处都带上它）
  const stAt = CLIENT.indexOf('var st = React.useState({');
  const stEnd = CLIENT.indexOf('})', stAt);
  const mainState = CLIENT.slice(stAt, stEnd);
  assert.doesNotMatch(mainState, /^\s*version:/m,
    '版本字段不该塞进主 state');
});
