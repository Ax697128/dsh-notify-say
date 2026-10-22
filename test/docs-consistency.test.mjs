/**
 * 文档一致性测试（v0.4.29）。
 *
 * ## 为什么需要
 *
 * 2026-10-18 外部审阅指出两处文档漂移：
 *   · `docs/待做清单.md` 还停在 v0.4.24，里面列着已经修完的事项
 *   · 审核记录里有个 `ankokon`，实际音色 key 是 `ankomon`
 *
 * 这类错误不影响功能，但会误导读者 —— 而且**只要没人看就永远发现不了**。
 * 审阅者建议「用测试或校验脚本预防」，这个文件就是那个脚本。
 *
 * ## 检查什么
 *
 * 1. 文档里提到的音色 key 必须真实存在（拼写漂移）
 * 2. 待做清单的"最后更新"版本不能落后太多（进度漂移）
 * 3. 内部文档不得含本机绝对路径（发布物卫生）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** 磁盘上真实存在的音色 key（从 sounds/voice-lines 推）。 */
function realVoiceKeys() {
  const base = join(ROOT, 'sounds', 'voice-lines');
  const keys = new Set();
  if (!existsSync(base)) return keys;

  const scan = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { scan(join(dir, e.name)); continue; }
      if (!e.name.toLowerCase().endsWith('.wav')) continue;
      const k = e.name
        .replace(/\.wav$/i, '')
        .replace(/~\d+$/, '')
        .replace(/-(?:extra|kansai)-\d+$/, '');
      if (k) keys.add(k);
    }
  };
  scan(base);
  return keys;
}

// ── D1: 审核记录里的音色 key 必须真实存在 ───────────────────────────────
test('D1: docs/audio-audit/README.md 提到的音色 key 都真实存在', () => {
  const f = join(ROOT, 'docs', 'audio-audit', 'README.md');
  if (!existsSync(f)) return;

  const real = realVoiceKeys();
  if (real.size === 0) return;   // 发布包里只有 1 个音色也可能，跳过

  const md = readFileSync(f, 'utf8');

  // 抓「反引号包裹的、形如音色 key 的标识」
  // 音色 key 的特征：小写字母开头，含 - 或纯字母，长度 >= 4
  const candidates = new Set();
  for (const m of md.matchAll(/`([a-z][a-z0-9-]{3,})`/g)) {
    const k = m[1];
    // 排除明显不是音色 key 的（文件名、命令、配置键）
    if (/\.(md|js|mjs|ps1|json|wav|txt|yml)$/.test(k)) continue;
    if (k.startsWith('my-')) continue;          // 个人声音不参与公开清单
    if (['node-test', 'test-all', 'test-route'].includes(k)) continue;
    candidates.add(k);
  }

  // 只校验"看起来像音色 key"的：全部小写 + 含连字符
  const suspect = [...candidates].filter((k) => {
    if (real.has(k)) return false;
    return /^[a-z]+(?:-[a-z0-9]+)+$/.test(k);
  });

  // 允许一些通用词
  const allowed = new Set(['third-party', 'audio-audit', 'not-recorded']);
  const bad = suspect.filter((k) => !allowed.has(k));

  // ⚠️ 发布包只带 1 个音色（10 个 wav），而审核文档列了 13 个。
  // 直接断言"文档里每个 key 都必须在磁盘上"会在发布包里必然失败 ——
  // 那是"测试假设了开发环境"，不是文档真的拼错了。
  //
  // 正确判据：**只校验发布包实际拥有音色的那个子集**。
  // 没有的音色无法在此环境验证，跳过（不算通过，只是不阻塞）。
  //
  // 但拼写漂移仍能被抓到：如果某个 key 在文档里写错，
  // 而正确拼写在磁盘上存在，那个错的就不在任何子集里 —— 无法区分。
  // 所以这里加一条补充：磁盘上有的音色，文档里若出现"近似拼写"
  // （只差一个后缀段）就报出来。
  const installed = real.size;
  if (installed >= 10) {
    // 开发环境：全部校验
    assert.deepEqual(bad, [],
      '这些 key 在文档里出现但磁盘上没有对应音色（可能是拼写漂移）：\n  '
      + bad.join('\n  '));
    return;
  }

  // 发布环境（音色很少）：只检查"磁盘上有、但文档里写成近似但不同"的
  const nearMiss = [];
  for (const key of real) {
    for (const s of bad) {
      // 一个是另一个的前缀（如 manbetsu-hanamaru vs -genki）
      if (key.startsWith(s) || s.startsWith(key)) {
        if (key !== s) nearMiss.push(`${s} vs ${key}`);
      }
    }
  }
  assert.deepEqual(nearMiss, [],
    '文档里的写法与磁盘上的音色 key 近似但不一致（疑似漏写后缀）：\n  '
    + nearMiss.join('\n  '));
});

// ── D2: 待做清单的更新版本不能落后于 package.json ───────────────────────
test('D2: docs/待做清单.md 的版本不落后于 package.json', () => {
  const f = join(ROOT, 'docs', '待做清单.md');
  if (!existsSync(f)) return;

  const md = readFileSync(f, 'utf8');
  const m = /最后更新[：:]\s*\d{4}-\d{2}-\d{2}[（(]v?([\d.]+)[）)]/.exec(md);
  if (!m) {
    // 没写版本号也算不漂移（只是格式不同）
    return;
  }
  const docVer = m[1];
  const pkgVer = PKG.version;

  const cmp = (a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    }
    return 0;
  };

  // 允许文档比包版本落后 1 个补丁号（写文档有滞后是合理的）；
  // 落后 2 个以上说明"改完没回头更新"，那才是漂移。
  const behind = cmp(pkgVer, docVer);
  assert.ok(behind <= 1,
    `待做清单停在 v${docVer}，而包已经是 v${pkgVer} —— `
    + '落后超过 1 个补丁号说明改完没回头更新（外部审阅已指出过一次）');
});

// ── D3: 公开文档不得含本机绝对路径 ──────────────────────────────────────
test('D3: docs/ 下的文档不含本机绝对路径', () => {
  const docsDir = join(ROOT, 'docs');
  if (!existsSync(docsDir)) return;

  const offenders = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(md|ps1|mjs|js|json|txt)$/i.test(e.name)) continue;
      const text = readFileSync(full, 'utf8');
      // 本机路径特征：盘符 + 已知开发目录
      if (/[A-Z]:\\+(?:0Deepseek|Codex|Users\\+audio)/i.test(text)) {
        offenders.push(full.replace(ROOT, '.'));
      }
    }
  };
  walk(docsDir);

  assert.deepEqual(offenders, [],
    '文档里出现本机绝对路径 —— 发布物是公开的，别人拿去跑不通：\n  '
    + offenders.join('\n  '));
});

// ── D4: THIRD-PARTY-NOTICES 必须给出可点的官方链接 ──────────────────────
test('D4: 第三方声明含官方条款链接（不能只有口头说明）', () => {
  const f = join(ROOT, 'THIRD-PARTY-NOTICES.md');
  if (!existsSync(f)) return;
  const md = readFileSync(f, 'utf8');

  assert.match(md, /https:\/\/voicevox\.hiroshiba\.jp\/term/,
    '必须给出 VOICEVOX 官方条款链接 —— 用户需要能自己核对');
  assert.match(md, /https:\/\/zunko\.jp\//,
    '必须给出ずんずんプロジェクト条款链接');
  // 绝不能把第三方音频说成 MIT/CC0
  assert.doesNotMatch(md, /语音.{0,8}(?:MIT|CC0).{0,8}(?:发布|许可)/,
    '不得声称语音文件以 MIT/CC0 发布 —— 我们无权变更第三方素材的许可');
});

// ── D5: 重载漏报诊断必须存在（排查"没听到播报"的第一手信号）────────────
test('D5: index.js 有重载漏报诊断', () => {
  const INDEX = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8');

  assert.match(INDEX, /EVENT_COUNTER_KEY/,
    '应有跨实例的事件计数器（重载后新模块读不到旧变量，必须用 globalThis）');
  assert.match(INDEX, /function bumpEventCount/,
    '应有计数入口');
  assert.match(INDEX, /bumpEventCount\(\)/,
    'session/event 处理器里应真的调用它');
  assert.match(INDEX, /重载窗口内/,
    '重载后应打印漏报提示，否则排查时无法区分"事件没进来"和"进来了没播"');

  // 计数器必须挂在 globalThis：模块级变量在重载后会重置，就失去意义
  assert.match(INDEX, /Symbol\.for\('dsh-notify-say\.eventCount'\)/,
    'key 应带插件名（避免与其它插件冲突）');
});
// ══ 打包与变更记录（v0.4.45）════════════════════════════════════════════
//
// ⚠️ 一个重要区别：`tools/release-build.ps1` 是**维护者工具**，
// 不随发布包分发（发布包的 tools\ 里只有 notify-config.ps1）。
// 所以检查它的那些断言在发布包里必须 skip，否则 CI 必然红。
//（v0.4.45 首跑 CI 就是这么红的：D6/D7/D8 去读一个不存在的文件。）
const RELEASE_BUILD = join(ROOT, 'tools', 'release-build.ps1');
const hasReleaseBuild = existsSync(RELEASE_BUILD);
const SKIP_DEVONLY = hasReleaseBuild ? false : 'release-build.ps1 是维护者工具，不在发布包内';

// ── D6: 打包不得带临时/备份文件（fail-closed）──────────────────────────
test('D6: release-build 有垃圾文件闸（.bak/.tmp 不得进发布包）', { skip: SKIP_DEVONLY }, () => {
  // ⚠️ 2026-10-18 真实事故：我把 mutation 测试用的
  // `lib/dev-reload.js.bak` 忘在源码目录里，release-build 把它一起
  // 复制进发布包 —— **而且已经推到 GitHub 与 npm**。
  //
  // 内容无害，但发布物里出现 .bak 是明显疏漏：用户疑惑、包体积白涨、
  // 而且说明打包流程没检查「目录里有没有残留」。
  const rb = readFileSync(RELEASE_BUILD, 'utf8');

  assert.match(rb, /junkPattern/, '应有垃圾文件模式定义');
  assert.match(rb, /\.\(bak\|tmp\|orig\|rej\|swp\)/,
    '应覆盖常见编辑器/工具残留（.bak/.tmp/.orig/.rej/.swp）');
  assert.match(rb, /exit 1/, '发现垃圾文件必须中止构建（fail-closed），不能只警告');

  const guardAt = rb.indexOf('$junkPattern');
  const clAt = rb.indexOf('生成 CHANGELOG');
  assert.ok(guardAt > 0 && clAt > 0 && guardAt < clAt,
    '垃圾闸应在复制完成后、写 CHANGELOG 之前');
});

// ── D7: CHANGELOG 过滤器必须挡住内部内容 ──────────────────────────────
test('D7: CHANGELOG 生成器过滤内部标记与 hash', { skip: SKIP_DEVONLY }, () => {
  // 公开仓库只有 release: vX.Y.Z 快照，外部看不到每次改了什么。
  // 但**也不能原样输出开发提交标题** —— 实测早期标题是内部笔记风格：
  //   · CARD：#7849 跟进评论回写
  //   · RECOVERY.md 救援说明（三级回滚…）
  //   · deploy-snapshots/desktop-profile-pre-...
  //   · a306b8d / b9d83e1（私有仓库 hash）
  const rb = readFileSync(RELEASE_BUILD, 'utf8');

  assert.match(rb, /publicTypes/, '应只保留面向使用者的提交类型');
  for (const t of ['feat', 'fix', 'perf', 'refactor']) {
    assert.match(rb, new RegExp(`'${t}'`), `publicTypes 应含 ${t}`);
  }
  assert.doesNotMatch(rb, /publicTypes = @\([^)]*'(docs|test|chore|ci)'/,
    'docs/test/chore/ci 不应算面向使用者的类型');

  assert.match(rb, /internalMarkers/, '应有内部标记黑名单');
  for (const m of ['CARD', 'RECOVERY', '交接备忘', 'deploy-snapshots']) {
    assert.ok(rb.includes(m),
      `internalMarkers 应含 ${m} —— 实测这些标记会带出内部资料引用`);
  }

  assert.match(rb, /0-9a-f\]\{7,40\}/,
    '应剥掉 7~40 位十六进制串（私有仓库 hash 在公开仓库里指不到东西）');
});

// ── D8: 已发布的 CHANGELOG 本身要干净（这条在两种环境都跑）────────────
test('D8: 随包发布的 CHANGELOG 不含内部标记 / hash / 本机路径', () => {
  // 这条查的是**产物**而不是生成器，所以在发布包里也能跑 ——
  // 而且它比"检查生成器源码"更接近真实：用户拿到的就是这份文件。
  const cl = join(ROOT, 'CHANGELOG.md');
  if (!existsSync(cl)) return;   // 开发目录没有（它是构建产物），跳过

  const c = readFileSync(cl, 'utf8');

  // 内部资料标记：提到这些说明过滤失效了
  for (const m of ['CARD', 'RECOVERY', '交接备忘', 'deploy-snapshots', 'app.asar', '待做清单']) {
    assert.ok(!c.includes(m),
      `CHANGELOG 里出现了内部标记「${m}」—— 过滤失效，会带出内部资料引用`);
  }

  // 私有仓库的提交 hash 在公开仓库里指不到任何东西，反而误导
  const hex = c.match(/\b[0-9a-f]{7,40}\b/g) || [];
  assert.deepEqual(hex, [],
    `CHANGELOG 里出现了疑似提交 hash：${hex.slice(0, 5).join(', ')}`);

  // 本机绝对路径
  assert.doesNotMatch(c, /[A-Za-z]:\\\\/, '不得含本机绝对路径');

  // 得有实际内容（防"生成器坏了、产出一个空文件"）
  assert.match(c, /^## v\d+\.\d+\.\d+/m, 'CHANGELOG 应含至少一个版本节');
});

// ── D8b: 生成器配置（仅开发目录）───────────────────────────────────────
test('D8b: CHANGELOG 由构建脚本生成，且内部资料不进发布包', { skip: SKIP_DEVONLY }, () => {
  // 注意：**源 package.json 与发布包 package.json 是两份不同的东西**。
  // 源的 files 服务于本地 link 安装（甚至列了 CARD.md / RECOVERY.md）；
  // 发布包那份由 release-build.ps1 重写 —— 那才是 npm 用户拿到的。
  const rb = readFileSync(RELEASE_BUILD, 'utf8');

  assert.match(rb, /'CHANGELOG\.md',/,
    'CHANGELOG.md 必须出现在 release-build 写出的 files 数组里 —— '
    + '同类事故：THIRD-PARTY-NOTICES.md 曾漏了 files，导致 npm 包没有任何第三方声明');

  const filesBlock = rb.slice(rb.indexOf('files'), rb.indexOf('keywords'));
  for (const internal of ['CARD.md', 'RECOVERY.md']) {
    assert.ok(!filesBlock.includes(internal),
      `${internal} 是内部资料，不得出现在发布包的 files 里`);
  }

  assert.match(rb, /WriteAllText\(\(Join-Path \$Destination 'CHANGELOG\.md'\)/,
    'CHANGELOG.md 应由构建脚本生成到目标目录（不是从源码目录复制）');
});

// ── D9: 发版流程必须在**发布包里**跑一次测试 ────────────────────────────
test('D9: release.ps1 在构建后、推送前，于发布包内跑测试', { skip: SKIP_DEVONLY }, () => {
  // ⚠️ 2026-10-18 真实代价：D6/D7/D8 去读 `tools/release-build.ps1`，
  // 而那是**维护者工具、不在发布包里** ——
  // 于是开发目录全绿、推上去 CI 三平台全红。
  //
  // 根因不是那三条测试写错，而是**发版流程只在开发目录跑测试**，
  // 而 CI 跑的是发布包（公开仓库本身就是发布包）。两者文件集不同。
  //
  // 修法：步骤 3 重建发布包之后、步骤 4 推送之前，再跑一次测试。
  // 这样"本地绿、线上红"在推之前就会暴露。
  const rp = readFileSync(join(ROOT, 'tools', 'release.ps1'), 'utf8');

  const step35 = rp.indexOf('3.5 在发布包里跑测试');
  const step3 = rp.indexOf("Write-Step '3. 重建发布包'");
  const step4 = rp.indexOf("Write-Step '4. 提交并推送 GitHub'");

  assert.ok(step3 > 0 && step35 > 0 && step4 > 0,
    'release.ps1 应有步骤 3 / 3.5 / 4');
  assert.ok(step35 > step3 && step35 < step4,
    '3.5 必须在「重建发布包」之后、「推送 GitHub」之前 —— '
    + '顺序错了就起不到拦截作用');

  // 必须在发布包目录里跑，且失败要中止
  assert.match(rp, /Push-Location \$ReleaseDir/,
    '应在发布包目录里执行');
  assert.match(rp, /throw 'release-package tests failed'/,
    '发布包内测试失败必须中止发版（fail-closed）');
});
// ══ README 与实现一致性（v0.4.47）════════════════════════════════════════
//
// 2026-10-18 外部审阅指出 README 落后于功能：
//   · 说语音包下载"尚未实现"（其实 13 个 zip 早发布了，GUI 也能下）
//   · 说"全离线"（下载语音包要访问 GitHub）
//   · 说"点 Toast 可跳回会话"（Toast 点击带不了会话 id，跳转是另一套机制）
//   · 说"设置页 12 项"（实际 schema 字段多得多）
//
// README 是用户判断"这插件能干什么"的第一入口。写错不是文字瑕疵 ——
// 别人可能因此根本不知道有下载功能。

const README = readFileSync(join(ROOT, 'README.md'), 'utf8');

// ── D10: README 不得再声称语音包下载"未实现" ────────────────────────────
test('D10: README 不得说语音包下载尚未实现', () => {
  assert.doesNotMatch(README, /下载提供（尚未实现）/,
    '语音包下载已实现并发布 13 个 zip，README 不得再说"尚未实现"');
  assert.doesNotMatch(README, /尚未实现/,
    'README 里不应残留"尚未实现"这类过时表态');

  // 反而应该真的介绍怎么下载
  assert.match(README, /语音包/,
    'README 应有语音包章节');
  assert.match(README, /下载/,
    'README 应说明可以下载');
});

// ── D11: README 不得无条件下声称"全离线" ────────────────────────────────
test('D11: README 的联网表述必须区分"播放离线"与"下载要联网"', () => {
  // 只写"全离线"会让用户以为下载语音包也不需要网络，
  // 一旦断网失败就以为插件坏了。
  const hasOfflineClaim = /全离线/.test(README);
  if (hasOfflineClaim) {
    assert.match(README, /下载.*联网|联网.*下载/,
      '若说"全离线"，必须同时说明下载语音包需要联网');
  }
  // 明确写清楚是更好的做法
  assert.match(README, /不调用云端 TTS|不联网/,
    '应说明播放/通知是离线的');
});

// ── D12: README 对「点 Toast 跳会话」的描述必须与实现一致 ───────────────
//
// ⚠️ 这条测试原先断言的是**旧结论**：「Toast 点击带不了会话 id」。
// 2026-10-20 我们通过注册自有协议 dshnotify-say:// 做出了可靠实现，
// 旧结论被推翻 —— 继续断言旧说法就会逼着文档写错的东西。
//
// 现在断言语义反过来：README 必须承认这个功能**存在**，
// 且必须说清它是**可选开关**（不能让用户以为装了就默认具备）。
test('D12: README 必须正确描述「点 Toast 跳会话」（可选开关，非默认）', () => {
  // 不得再出现"做不到"的旧结论
  assert.doesNotMatch(README, /做不到：点哪条 Toast/,
    '旧结论已推翻 —— README 不能再说点 Toast 跳会话做不到');

  // 必须承认这个功能存在，并给出协议名（让用户能自己核实注册表）
  assert.match(README, /dshnotify-say:\/\//,
    '应写明用的自有协议 dshnotify-say://，否则用户无法排查协议注册问题');

  // 必须是**显式开关**，不能说成默认行为
  assert.match(README, /点击通知跳转到对应会话/,
    '应给出开关的实际名称，用户要能在设置页找到它');
  assert.match(README, /不开启时|显式开关/,
    '必须说明不开启时的行为 —— 否则用户会以为装了就自动具备');

  // 保留真实限制：DSH 官方协议确实带不了参数（这条事实没变）
  assert.match(README, /dsh:\/\/open/,
    '应保留 DSH 官方协议限制的说明，这是选择自有协议的原因');
});

// ── D13: README 里的数字必须与实现一致 ──────────────────────────────────
test('D13: README 的测试条数与实际一致', () => {
  const pkgScripts = PKG.scripts || {};
  assert.ok(pkgScripts['test:all'], '应有 test:all 脚本');

  // README 写了几条就直接比对；写错了会误导贡献者
  const m = README.match(/\*\*(\d+) 条测试通过/);
  if (!m) {
    assert.match(README, /条测试/, 'README 应说明测试规模');
    return;
  }
  const claimed = Number(m[1]);
  // 只做「量级」校验，不比对精确值 —— 精确比对会让每次加测试都要改 README，
  // 而真正该防的是「写着 3000 条但其实早就不止/远不到」这种失真。
  // 区间随套件增长上调过：v0.5.0 时 test:all = 568（主套件 542 + route 26）。
  assert.ok(claimed > 300 && claimed < 900,
    `README 声称 ${claimed} 条测试，超出合理范围 —— 数字可能过时`);
});

// ── D14: README 必须提到音色下载的许可告知 ──────────────────────────────
test('D14: README 说明下载前会展示署名与条款', () => {
  // 这是合规要求：用户得知道"用这些语音做的内容要署名"。
  // README 是下载前的最后一道说明。
  assert.match(README, /署名/,
    'README 应说明音色的署名要求');
  assert.match(README, /条款/,
    'README 应说明条款');
  assert.match(README, /TERMS\.md/,
    '应说明包内带 TERMS.md');
});
// ── D15: MANIFEST 不得留 (unknown)，要留可回溯的线索 ────────────────────
test('D15: MANIFEST 的版本回溯栏可用（不是 unknown）', { skip: SKIP_DEVONLY }, () => {
  // 2026-10-18 外部审阅指出：公开仓库的 MANIFEST 长期显示
  // `Git 提交: (unknown)` —— 这一栏从来没提供过信息。
  //
  // 原因是它在**构建时**生成，而发布包首次 commit 在构建**之后**。
  // 现在改为如实说明 + 给出真正能查的线索。
  const rb = readFileSync(RELEASE_BUILD, 'utf8');

  assert.doesNotMatch(rb, /'\(unknown\)'/,
    '不得再写 (unknown) —— 那等于这一栏没信息');

  assert.match(rb, /源码日期/,
    '应记录源提交日期（判断构建用的是哪天源码）');
  assert.match(rb, /版本回溯/,
    '应指向可查的公开提交 / CHANGELOG');
});
// ── D16: .ps1 必须是 LF ─────────────────────────────────────────────────
test('D16: PowerShell 脚本用 LF（与 .gitattributes 一致）', () => {
  // ⚠️ 2026-10-18 核实时发现真实分歧：
  //
  //   本地工作树  CRLF
  //   发布包      CRLF   ← release-build 从工作树复制
  //   GitHub      纯LF   ← .gitattributes 的 `*.ps1 text eol=lf` 归一化
  //
  // 于是"同版本"的两个产物字节不同：npm 用户拿到 CRLF，GitHub 用户拿到 LF。
  // 两者都能跑（实测通过），但**测的东西和用户拿的东西不是一个**，
  // 任何按字节校验/哈希对比都会对不上。
  //
  // 修法：工作树也归一成 LF（对 git 是 no-op，因为索引本来就是 LF）。
  // 这条测试防止以后有人用会写 CRLF 的工具改 ps1。
  const bad = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.tmp')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.toLowerCase().endsWith('.ps1')) continue;
      try {
        const buf = readFileSync(p);
        if (buf.includes(13)) bad.push(p.slice(ROOT.length + 1));
      } catch { /* 读不到就跳过 */ }
    }
  };
  walk(ROOT);

  assert.deepEqual(bad, [],
    '.ps1 里出现了 CR (CRLF 行尾) —— 与 .gitattributes 的 eol=lf 不一致，'
    + '会导致发布包与 GitHub 版本字节不同：\n' + bad.join('\n'));
});
// ── D17: README 的联网说明必须涵盖"检查更新" ────────────────────────────
test('D17: README 如实说明检查更新也会联网', () => {
  // ⚠️ 2026-10-18 第四轮审阅指出：v0.4.48 加了"挂载时自动查版本"，
  // 但 README 仍写着"不下载语音包的话，这个插件不会联网" —— 文档与行为冲突。
  //
  // 用户对"全离线"是有期待的。加了自动联网就必须说清楚。
  assert.doesNotMatch(README, /不下载语音包的话，这个插件不会联网/,
    '这句已不成立：设置页挂载时会查版本（缓存过期时访问 npm/GitHub）');

  // 必须明确列出"检查更新"也会联网
  assert.match(README, /检查更新/,
    'README 应提到检查更新');
  assert.match(README, /npm registry|npm 与 GitHub|npm\/GitHub/,
    '应说明检查更新访问的是哪些地址');
  assert.match(README, /24 小时/,
    '应说明检查频率（用户有权知道多久联一次网）');

  // 也要说明失败不影响功能
  assert.match(README, /不影响通知|照常工作/,
    '应说明联网失败不影响通知与语音');
});
// ── D18: 所有 .ps1 必须带 UTF-8 BOM ─────────────────────────────────────
test('D18: PowerShell 脚本必须有 UTF-8 BOM（含维护者工具）', () => {
  // ⚠️ 2026-10-18 我自己踩的坑：
  //
  // 用 Node 或 .NET 编辑 .ps1 时，`writeFileSync(..., 'utf8')` /
  // `WriteAllText(..., UTF8Encoding($false))` 会**丢掉 BOM**。
  // 而 PowerShell 5.1 在没有 BOM 时按系统 ANSI（中文系统是 GBK）解码，
  // 于是文件里的中文变成乱码 → 语法错误 → 构建直接崩：
  //
  //   Missing closing ')' in expression.
  //   master-voice.wav锛坉one 鍏滃簳锛?
  //
  // CI 里有 BOM 检查，但它只看**发布包里的** ps1 ——
  // `tools/release-build.ps1` 与 `tools/release.ps1` 是维护者工具、不进发布包，
  // 所以它们的 BOM 一直没人查，这次才崩在本地。
  const bad = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.tmp')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.toLowerCase().endsWith('.ps1')) continue;
      try {
        const buf = readFileSync(p);
        const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
        if (!hasBom) bad.push(p.slice(ROOT.length + 1));
      } catch { /* 读不到就跳过 */ }
    }
  };
  walk(ROOT);

  assert.deepEqual(bad, [],
    '这些 .ps1 没有 UTF-8 BOM —— PowerShell 5.1 会把中文读成乱码然后语法报错：\n'
    + bad.join('\n'));
});

// ── D19: .gitattributes 必须随包分发 ────────────────────────────────────
test('D19: 发布包带 .gitattributes（否则 Windows 上 checkout 会改成 CRLF）', () => {
  // 2026-10-18 实测：CI 跑在 windows-latest，公开仓库当时没有 .gitattributes，
  // `actions/checkout` 按 autocrlf=true 把 .ps1 转成 CRLF，
  // 而开发机是 LF → D16 在 CI 全红（同样的提交，字节不同）。
  assert.ok(existsSync(join(ROOT, '.gitattributes')),
    '插件目录应有自己的 .gitattributes，并随包分发');

  const ga = readFileSync(join(ROOT, '.gitattributes'), 'utf8');
  assert.match(ga, /\*\.ps1\s+text eol=lf/,
    '.gitattributes 应把 .ps1 定为 LF');
  assert.match(ga, /\*\.wav\s+binary/,
    '音频必须标 binary，否则换行转换会损坏文件');

  // 若这是开发目录，还要确认 release-build 把它列进白名单
  if (hasReleaseBuild) {
    const rb = readFileSync(RELEASE_BUILD, 'utf8');
    assert.match(rb, /'\.gitattributes'/,
      'release-build 的 includeFiles 必须含 .gitattributes，否则不会进发布包');
  }
});

// ── D20: engines.dsh 必须准确（市场用它决定"能不能装"）───────────────────
//
// ## 为什么这条重要（2026-10-20 发现插件已被市场收录）
//
// 本机 `profiles/desktop/.dsh-market/discovery-compatibility-v1.json`
// 里有 **3138 个条目**，其中包含 dsh-notify-say —— 市场是**全量扫描 npm**
// 上的 dsh 插件自动收录的，不是人工登记。
//
// 它抓的正是 `package.json` 的 `engines.dsh`：
//
//     "dsh-notify-say": {
//       "facts": { "version": "0.4.82", "enginesDsh": ">=0.1.7-rc.2" }
//     }
//
// DSH 的 plugin-manager 用这个字段做兼容校验（源码里有
// `requirements` / `incompatible` 结构）。**声明错了，市场就会
// 告诉不兼容的用户"能装"**，装完才发现坏。
//
// ## 原来错在哪
//
// 我们写的是 `>=0.1.7-rc.2`，但**从未在 0.1.7 上测过**（实测是 0.2.1-rc.2）。
// 而且没有上界 —— 0.3.0 若有破坏性改动，市场仍会说兼容。
//
// 生态惯例（本机市场缓存里实测）：主要插件都写 `>=X <0.3.0`，例如
//     dsh-plugin-resolver     >=0.2.0-rc.2 <0.3.0
//     dsh-dania-voice         >=0.1.7-rc.1 <0.3.0-0
//     dsh-gui-auth-url        >=0.2.1-rc.2 <0.3.0-0
test('D20: engines.dsh 必须有实测下界 + 上界，且与 README 一致', () => {
  const engines = PKG.engines || {};
  const dshRange = String(engines.dsh || '');

  assert.ok(dshRange, 'package.json 必须有 engines.dsh —— 市场靠它判断兼容性');

  // 必须有上界。没有上界 = 声称"未来所有版本都兼容"，这是不实声明
  assert.match(dshRange, /<\s*[\d.]+/,
    `engines.dsh 必须有上界（当前: ${dshRange}）—— 否则 DSH 大版本不兼容时，`
    + '市场仍会告诉用户"能装"');

  // 下界不能低于实测版本。实测环境是 0.2.1-rc.2
  const m = dshRange.match(/>=\s*([\d.]+(?:-[\w.]+)?)/);
  assert.ok(m, `engines.dsh 应有 >= 下界（当前: ${dshRange}）`);
  const lower = m[1];
  // 只做"不低于 0.2.1"的粗判（精确 semver 比较不必在这里实现）
  assert.ok(
    /^0\.[2-9]\./.test(lower) || /^[1-9]/.test(lower),
    `engines.dsh 的下界 ${lower} 低于实测版本 0.2.1-rc.2 —— ` +
    '声明支持未测过的版本等于让用户当小白鼠',
  );

  // README 必须与 engines 一致（不能一处说 0.2.1、另一处说 0.1.7）
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /0\.2\.1-rc\.2/,
    'README 必须写明实测的 DSH 版本');
  assert.doesNotMatch(readme, /0\.1\.7-rc\.2 或更高/,
    'README 不能再说"0.1.7-rc.2 或更高" —— 那个版本没测过');
});
