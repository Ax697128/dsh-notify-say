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

// ── U3: 三种安装方式各自给正确指引 ──────────────────────────────────────
test('U3: development 不给命令；managed 给命令；unknown 只给查证指引', async () => {
  const { upgradeHint } = await import('../lib/update-check.js');

  const dev = upgradeHint('development', {});
  assert.equal(dev.command, '',
    'development（源码/Junction）必须**没有**命令 —— 用插件升级命令会覆盖源码');
  assert.match(dev.note, /不要/, '必须明确劝阻');

  const managed = upgradeHint('managed', { npmLatest: '0.4.50', githubLatest: '0.4.50' });
  assert.match(managed.command, /dsh plugin .*update dsh-notify-say/,
    'managed（包管理器安装）才给 dsh 的升级命令');
  assert.match(managed.command, /<.*profile.*>/,
    'profile 名无法可靠得知，必须用占位符而不是假装知道');
  assert.match(managed.note, /重启/, '要提示更新后需重启 profile');

  const unknown = upgradeHint('unknown', {});
  assert.equal(unknown.command, '',
    'unknown 时宁可不给命令 —— 给错了会让用户覆盖掉自己的安装');
  assert.match(unknown.note, /无法确定|查证|安装来源/, '应说明无法确定并给出查证方向');
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
  const { checkForUpdate, AUTO_CHECK_TTL_MS, NPM_REGISTRY_URL } = await import('../lib/update-check.js');
  const cache = { at: 0, result: null };

  // ⚠️ 现在一次检查会**并行查两个源**（npm + GitHub），所以不能用总请求数
  // 衡量"查了几次"。只数 npm 那个请求 —— 每次检查恰好发一次。
  let calls = 0;
  const fake = async (url) => {
    if (url === NPM_REGISTRY_URL) calls++;
    if (url === NPM_REGISTRY_URL) {
      return { ok: true, json: async () => ({ 'dist-tags': { latest: '0.4.99' } }) };
    }
    return { ok: true, json: async () => ({ version: '0.4.99' }) };
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

// ── U12: hasUpdate 的方向必须正确（本地旧→true，本地新→false）──────────
test('U12: hasUpdate 方向 —— 只在远端更新时为 true', async () => {
  // ⚠️ 2026-10-18 实测抓到的真 bug：第一版写成 `cmp < 0`，**方向反了**。
  //
  // 表现：本地 0.4.48、npm 还在暂存队列里是 0.4.47 ——
  // 界面却显示"有新版"。也就是 npm 落后时装作有新版本，
  // npm 超前时反而不提示。
  //
  // 这个 bug 能溜过去，是因为 U1 只测了 compareVersions 本身，
  // 没有任何用例断言 hasUpdate 的**方向**。所以补上。
  const { checkForUpdate } = await import('../lib/update-check.js');

  const tmp = join(ROOT, '.tmp-u12-' + Math.random().toString(36).slice(2, 8));
  try {
    mkdirSync(tmp, { recursive: true });

    // ① 远端更新（0.9.9 > 0.4.48）→ 有新版
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ version: '0.4.48' }));
    const newer = async () => ({ ok: true, json: async () => ({ 'dist-tags': { latest: '0.9.9' } }) });
    const r1 = await checkForUpdate({ pluginRoot: tmp, force: true, fetchImpl: newer });
    assert.equal(r1.hasUpdate, true,
      '远端 0.9.9 > 本地 0.4.48，必须提示有新版');

    // ② 远端落后（npm 暂存队列期间会这样）→ 不能提示有新版
    const older = async () => ({ ok: true, json: async () => ({ 'dist-tags': { latest: '0.4.40' } }) });
    const r2 = await checkForUpdate({ pluginRoot: tmp, force: true, fetchImpl: older });
    assert.equal(r2.hasUpdate, false,
      '远端 0.4.40 < 本地 0.4.48，**不能**提示有新版 —— '
      + 'npm 暂存队列期间就会出现这种"远端落后"，提示更新会让用户困惑');

    // ③ 相同版本 → 无新版
    const same = async () => ({ ok: true, json: async () => ({ 'dist-tags': { latest: '0.4.48' } }) });
    const r3 = await checkForUpdate({ pluginRoot: tmp, force: true, fetchImpl: same });
    assert.equal(r3.hasUpdate, false, '版本相同不应提示更新');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
// ── U13: 两个源都查，取较高版本（npm 暂存队列期间不能漏更新）────────────
test('U13: 并行查两个源，取较高版本', async () => {
  // 实测场景（2026-10-18）：npm 有暂存队列，发布后 latest 会落后一阵。
  //   npm latest   = 0.4.47
  //   GitHub main  = 0.4.48
  // 若"先 npm、失败才回退 GitHub"，这期间**所有人都看不到 0.4.48 可用**，
  // 而 GitHub 安装的用户本来就是以 main 为准的。
  //
  // 所以并行查两个源、取较高版本。两个源都是同一套发布流程的正式产物。
  const { checkForUpdate, NPM_REGISTRY_URL, GITHUB_RAW_PKG_URL } =
    await import('../lib/update-check.js');

  const tmp = join(ROOT, '.tmp-u13-' + Math.random().toString(36).slice(2, 8));
  try {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ version: '0.4.47' }));

    const seen = [];
    // npm 落后、GitHub 较新
    const fake = async (url) => {
      seen.push(url);
      if (url === NPM_REGISTRY_URL) {
        return { ok: true, json: async () => ({ 'dist-tags': { latest: '0.4.47' } }) };
      }
      if (url === GITHUB_RAW_PKG_URL) {
        return { ok: true, json: async () => ({ version: '0.4.48' }) };
      }
      return { ok: false, status: 404 };
    };

    const r = await checkForUpdate({ pluginRoot: tmp, force: true, fetchImpl: fake });

    assert.equal(r.ok, true);
    assert.equal(r.latest, '0.4.48',
      'npm 落后时应采信 GitHub 的更高版本 —— 否则用户永远等不到更新提示');
    assert.equal(r.hasUpdate, true, '0.4.48 > 0.4.47，应有新版');
    assert.match(r.source, /github/,
      'source 应标明采用了 GitHub 的版本');

    // 两个源都要真的查过（不是串行等待）
    assert.ok(seen.includes(NPM_REGISTRY_URL), '应查 npm');
    assert.ok(seen.includes(GITHUB_RAW_PKG_URL), '应查 GitHub');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── U14: 反向 —— 本地较新时不提示（npm 超前也不会误报）──────────────────
test('U14: 两个源都落后于本地时不提示更新', async () => {
  const { checkForUpdate, NPM_REGISTRY_URL, GITHUB_RAW_PKG_URL } =
    await import('../lib/update-check.js');

  const tmp = join(ROOT, '.tmp-u14-' + Math.random().toString(36).slice(2, 8));
  try {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ version: '0.5.0' }));

    const fake = async (url) => {
      if (url === NPM_REGISTRY_URL) {
        return { ok: true, json: async () => ({ 'dist-tags': { latest: '0.4.40' } }) };
      }
      return { ok: true, json: async () => ({ version: '0.4.48' }) };
    };

    const r = await checkForUpdate({ pluginRoot: tmp, force: true, fetchImpl: fake });
    assert.equal(r.latest, '0.4.48', '取较高的那个（0.4.48 > 0.4.40）');
    assert.equal(r.hasUpdate, false, '两个源都低于本地 0.5.0，不该提示更新');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
// ══ 第四轮审阅（v0.4.51）══════════════════════════════════════════════════

// ── U15: pnpm 安装不能被误判成开发模式 ─────────────────────────────────
test('U15: 路径在 node_modules 下 → managed（即使项目根有 .git）', async () => {
  // ⚠️ 这是核实出来的**真 bug**：
  //
  //   原实现先往上找 .git、再比对 realpath。而 pnpm 安装的真实路径是
  //   `<项目>/node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>` ——
  //   项目根本身通常就有 .git，于是判成"开发模式"，提示用户
  //   「检测到源码安装，请不要用插件升级命令」。
  //
  // 而 DSH 就是用 pnpm 管插件的 —— 也就是**绝大多数用户都会看到反的提示**。
  const { detectInstallMode } = await import('../lib/update-check.js');
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');

  const tmp = join(ROOT, '.tmp-u15-' + Math.random().toString(36).slice(2, 8));
  try {
    // 造 pnpm 结构：node_modules/.pnpm/<pkg>@1/node_modules/<pkg>
    const real = join(tmp, 'node_modules', '.pnpm', 'pkg@1', 'node_modules', 'pkg');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'package.json'), JSON.stringify({ name: 'pkg', version: '1.0.0' }));
    // 项目根放 .git（真实项目都有）
    mkdirSync(join(tmp, '.git'), { recursive: true });
    writeFileSync(join(tmp, '.git', 'HEAD'), 'ref: refs/heads/main');

    assert.equal(detectInstallMode(real), 'managed',
      'node_modules 下的路径必须判为 managed —— 它是包管理器装的，不是开发模式');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── U16: 运行版本 vs 磁盘版本 → 提示重启 ────────────────────────────────
test('U16: 磁盘已升级但没重启时，提示重启而不是「已是最新」', async () => {
  // 用户可以在 DSH 运行期间升级插件：磁盘 package.json 已是新版，
  // 但进程里跑的还是旧 JS 模块。只看磁盘会显示"已是最新"，其实要重启。
  const { checkForUpdate } = await import('../lib/update-check.js');
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');

  const tmp = join(ROOT, '.tmp-u16-' + Math.random().toString(36).slice(2, 8));
  try {
    mkdirSync(tmp, { recursive: true });
    // 磁盘上是 0.5.0
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({ version: '0.5.0' }));

    const fake = async () => ({ ok: true, json: async () => ({ 'dist-tags': { latest: '0.5.0' } }) });

    // 但运行中的代码还是 0.4.0
    const r = await checkForUpdate({
      pluginRoot: tmp, runningVersion: '0.4.0', force: true, fetchImpl: fake,
    });

    assert.equal(r.running, '0.4.0', 'running 应是正在跑的版本');
    assert.equal(r.installed, '0.5.0', 'installed 应是磁盘上的版本');
    assert.equal(r.needsRestart, true, '两者不同 → 需要重启');
    assert.equal(r.hasUpdate, false,
      '磁盘已经是最新 → 不该再提示"有新版本可升级"（用户已经装了）');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── U17: npm 落后时升级指引要如实说明 ──────────────────────────────────
test('U17: npm 落后于 GitHub 时，提示可能装不到那个版本', async () => {
  // 第四轮审阅指出：只报一个合并后的 latest，会出现
  //   「提示 0.4.50，但 npm 安装的用户执行升级命令只拿到 0.4.48」。
  const { checkForUpdate } = await import('../lib/update-check.js');
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');

  const tmp = join(ROOT, '.tmp-u17-' + Math.random().toString(36).slice(2, 8));
  try {
    // 必须让 pluginRoot 真的在 node_modules 下，才会被判成 managed
    const pkgDir = join(tmp, 'node_modules', 'dsh-notify-say');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ version: '0.4.40' }));

    const fake = async (url) => {
      if (String(url).includes('registry.npmjs.org')) {
        return { ok: true, json: async () => ({ 'dist-tags': { latest: '0.4.48' } }) };
      }
      return { ok: true, json: async () => ({ version: '0.4.50' }) };
    };

    const r = await checkForUpdate({ pluginRoot: pkgDir, force: true, fetchImpl: fake });

    assert.equal(r.npmLatest, '0.4.48', '要单独保留 npm 的版本');
    assert.equal(r.githubLatest, '0.4.50', '要单独保留 GitHub 的版本');
    assert.equal(r.latest, '0.4.50', 'latest 取较高的');
    assert.match(r.note, /npm.*还没有|可能只能升到/,
      'npm 落后时必须如实说明，否则用户照提示操作会装不到那个版本');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});