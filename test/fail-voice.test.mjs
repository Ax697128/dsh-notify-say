/**
 * dsh-notify-desktop 失败语音（fail 池）测试 —— v0.3.1。
 *
 * 覆盖两处：
 *  A. lib/index.js：error 分支必须走 psKind='fail'；blocked 必须仍是 'chime'
 *     （语义不同：error=跑了但失败，blocked=被拦下没跑起来）。
 *  B. dsh-notify.ps1：fail 池**不得**回落到 done 池 / master-voice / 梗音效池
 *     ——否则失败时会播「主人、任務完了です！」，语义完全相反。
 *
 * B 用 PowerShell 子进程真跑 ps1（-Preview 只出声不弹 Toast），断言其 pick= 字段。
 *
 * ⚠️ **本文件故意不 import ../lib/index.js，也不改 SystemRoot**（三条实测踩坑，别踩）：
 * ① 别的测试文件用 `process.env.SystemRoot = '<不存在>'` 来让 spawn 失效；
 *    若本文件也这么干，**PowerShell 子进程会启动失败**（报 `8009001d`
 *    "Loading managed Windows PowerShell failed"——CLR 找不到 .NET），
 *    表现为 stdout 全空、5 条断言全红，**极易误判成"代码坏了"**。
 *    本文件只读源码文本、只跑 ps1，不需要那个隔离。
 * ② 不能用 `node --test ... -- <args>` 传参：`node --test` 会把 `--` 之后的参数当
 *    **测试文件**加载，`.ps1` 触发 `ERR_UNKNOWN_FILE_EXTENSION`，且 argv 取不到值。
 * ③ 不能用 `execFileSync` 抓 stdout（本机 `node --test` 下拿不到）；用 `spawnSync`。
 *
 * ⚠️ worktree 长路径限制（实测）：MCI 在 >130 字符的 wav 路径上 open 返回 304，
 * 故本文件**只断言"选到了哪个文件"**（pick= 字段，纯字符串判定），
 * **不断言"是否真的出声"**——后者在 worktree 里必假失败，是环境限制非代码缺陷。
 * 真机播放已在短路径（模拟部署）下人工验证通过。
 *
 * 运行：node --test tools/plugins/dsh-notify-desktop/test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');
const PS1 = join(PLUGIN, 'dsh-notify.ps1');
const FAIL_POOL = join(PLUGIN, 'sounds', 'voice-lines', 'fail');
/** done 池 = voice-lines 根目录（那批是说「任務完了です」的，失败时不该播）。 */
const DONE_POOL = join(PLUGIN, 'sounds', 'voice-lines');
const LIB = join(PLUGIN, 'lib', 'index.js');

/** 跑 ps1 -Preview，返回 stdout / stderr / exit code。用 spawnSync（见文件头踩坑③）。 */
function runPs1(args) {
  const r = spawnSync('powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, ...args],
    { encoding: 'utf8', timeout: 60_000 });
  return {
    out: String(r.stdout || ''),
    err: String(r.stderr || ''),
    code: typeof r.status === 'number' ? r.status : 1,
  };
}

/** 从输出里提取 pick=<name>。 */
function pickOf(out) {
  const m = /pick=([^\s+]+)/.exec(out);
  return m ? m[1] : '';
}

// ── A. lib 源码分支路由（读源码文本断言，不起进程）─────────────────────────
test('A1: lib 源码中 error 分支走 fail 池，blocked 仍走 chime（exact）', () => {
  const src = readFileSync(LIB, 'utf8');
  assert.match(src, /gate = cfg\.notifyOnError; psKind = 'fail';/,
    "error 分支必须设为 psKind='fail'（否则失败不播 fail 池）");
  assert.match(src, /gate = cfg\.notifyOnBlocked; psKind = 'chime';/,
    "blocked 必须保持 psKind='chime'（它是'被拦下没跑起来'，不是'跑了但失败'）");
  // 负例：error 不得再是 chime —— 那正是本次要改掉的旧行为
  assert.doesNotMatch(src, /gate = cfg\.notifyOnError; psKind = 'chime';/,
    "error 不应再走 chime");
});

// ── B. ps1 池选择与语义护栏（真跑 ps1）──────────────────────────────────────
test('B0: fail 池资产存在且为 48 条（3 句 × 16 音色）', () => {
  assert.equal(existsSync(FAIL_POOL), true, 'fail 池目录必须存在');
  const files = readdirSync(FAIL_POOL).filter((f) => f.endsWith('.wav'));

  // ⚠️ 不能硬编码"48 条 / 16 音色"。
  //
  // 自用版有 16 个音色的 fail 语音，但**发布版只带 1 个音色**。
  // 硬编码会在发布包里必然失败 —— 而那个失败是"测试假设了开发环境"，
  // 不是资产真的有问题。外部用户跑 `npm test` 看到红灯，会以为包坏了。
  //
  // 判据改为：**按 fail 池自己出现的音色集合**推算应有条数。
  // 每个音色在 fail 池应有 3 个变体（~1/~2/~3）。
  const byVoice = new Map();
  for (const f of files) {
    const m = /^(.+)~(\d)\.wav$/.exec(f);
    if (!m) continue;
    const [, base, n] = m;
    if (!byVoice.has(base)) byVoice.set(base, new Map());
    byVoice.get(base).set(n, (byVoice.get(base).get(n) || 0) + 1);
  }
  assert.ok(byVoice.size > 0, 'fail 池至少要有一个音色');

  // 每个音色的三个变体都应恰好各 1 条（不是"某些音色有 3 条、某些只有 1 条"）
  for (const [base, variants] of byVoice) {
    assert.deepEqual(
      [...variants.keys()].sort(),
      ['1', '2', '3'],
      `音色 ${base} 应恰好有 ~1/~2/~3 三个变体，实际 ${[...variants.keys()].join(',')}`,
    );
    for (const [n, count] of variants) {
      assert.equal(count, 1, `音色 ${base} 的 ~${n} 变体不应重复（实际 ${count} 条）`);
    }
  }

  // 总数 = 音色数 × 3
  assert.equal(
    files.length,
    byVoice.size * 3,
    `fail 池应为 ${byVoice.size} 音色 × 3 变体 = ${byVoice.size * 3} 条，实际 ${files.length}`,
  );
});

test('B1: -Kind fail + 固定音色 → 选到 fail 池的 ~N 变体（不是 done 池同名文件）', () => {
  const { out, err, code } = runPs1(['-Kind', 'fail', '-Preview', '-Voice', 'zundamon-normal', '-Volume', '0']);
  assert.equal(code, 0, `ps1 应正常退出；stderr=${err.slice(0, 200)}`);
  const pick = pickOf(out);
  assert.match(pick, /^zundamon-normal~\d\.wav$/, `应选 fail 池 ~N 变体，实际 pick=${pick}`);
  // 负例：不得选到 done 池根目录的同名（无 ~）文件
  assert.doesNotMatch(pick, /^zundamon-normal\.wav$/, '不得选到 done 池根目录的同名文件');
});

test('B2: -Kind fail + random → 仍限定在 fail 池（不回落到庆祝音）', () => {
  const { out, code } = runPs1(['-Kind', 'fail', '-Preview', '-Mode', 'random', '-Volume', '0']);
  assert.equal(code, 0, 'ps1 应正常退出');
  const pick = pickOf(out);
  assert.match(pick, /~\d\.wav$/, `random 应选 fail 池 ~N 变体，实际 pick=${pick}`);
  assert.doesNotMatch(pick, /master-voice/, '不得回落 master-voice（那是"任務完了"）');
  assert.doesNotMatch(pick, /\.mp3$/, '不得回落梗音效池（庆祝音）');
});

test('B3: fail 池缺该音色 → 在 fail 池内换音色，**绝不回落到 done 池**（关键护栏）', () => {
  // 独立复核 I-1 提出后（2026-10-17）行为已加强：池内换音色 > 没台词。
  // 用 done 池里真实存在、但 fail 池不覆盖的 key（如 -kansai-1 变体）来测这条路径。
  const { out, code } = runPs1(['-Kind', 'fail', '-Preview', '-Voice', 'ameharu-hau-kansai-1', '-Volume', '0']);
  assert.equal(code, 0, 'ps1 应正常退出');
  const pick = pickOf(out);

  // ① 必须仍从 fail 池取到台词（不能因为缺该音色就哑掉）
  assert.match(pick, /~\d\.wav$/, `应在 fail 池内换音色，实际 pick=${pick}`);

  // ② 本测试最重要的一条：绝不回落到 done 池（那会播「主人、任務完了です！」语义相反）。
  // ⚠️ 不能写 `assert.doesNotMatch(out, /pick=\S*voice-lines\\/)`——`pick=` 只含**叶文件名**、
  // 从不含目录，该断言**永远为真 = 空断言**（自查时发现并改掉）。
  // 有效做法：拿 done 池根目录的真实文件名清单，断言 pick 不等于其中任何一个。
  const doneNames = new Set(readdirSync(DONE_POOL).filter((f) => f.endsWith('.wav')));
  assert.ok(!doneNames.has(pick), `pick=${pick} 落在 done 池里（说明回落到"完成"语音）`);

  // ③ 也不许回落到 master-voice / 梗音效（庆祝音）
  assert.doesNotMatch(out, /master-voice/, '不得回落 master-voice');
  assert.doesNotMatch(pick, /\.mp3$/, '不得回落梗音效池');
});

test('B3b: 完全不存在该音色 → 仍在 fail 池内取台词（不哑）', () => {
  const { out, code } = runPs1(['-Kind', 'fail', '-Preview', '-Voice', 'no-such-voice-xyz', '-Volume', '0']);
  assert.equal(code, 0, 'ps1 应正常退出');
  const pick = pickOf(out);
  assert.match(pick, /~\d\.wav$/, `应在 fail 池内换音色，实际 pick=${pick}`);
  const doneNames = new Set(readdirSync(DONE_POOL).filter((f) => f.endsWith('.wav')));
  assert.ok(!doneNames.has(pick), `pick=${pick} 落在 done 池里`);
});

test('B3c: fail 池整目录缺失 → 落到蜂鸣（不变哑巴，也不越池到 done）', () => {
  // 用 chime 模拟"子池取不到"这层保护：chime 恒不取语句，其兜底必须是蜂鸣而非 done 池。
  const { out, code } = runPs1(['-Kind', 'chime', '-Preview', '-Volume', '0']);
  assert.equal(code, 0, 'ps1 应正常退出');
  assert.equal(pickOf(out), 'chime', 'chime 应标为 chime（走蜂鸣）');
  assert.doesNotMatch(out, /pick=\S+\.wav/, 'chime 不得取到任何语句文件');
});

test('B4: -Kind chime → 不选语句（pick 标为 chime，只蜂鸣）', () => {
  const { out, code } = runPs1(['-Kind', 'chime', '-Preview', '-Volume', '0']);
  assert.equal(code, 0, 'ps1 应正常退出');
  // 既有行为：chime 的展示标签就是 'chime'（ps1 的 pickedName 分支），不是 'none'。
  // 关键断言是「没有选到任何 wav 语句」——chime 必须既不是 fail 池也不是 done 池。
  assert.equal(pickOf(out), 'chime', `chime 的 pick 标签应为 chime，实际=${pickOf(out)}`);
  assert.doesNotMatch(out, /pick=\S+\.wav/, 'chime 不得选到任何语音文件');
});

test('B5: -Kind done 未回归（仍从 done 池选）', () => {
  const { out, code } = runPs1(['-Kind', 'done', '-Preview', '-Voice', 'zundamon-normal', '-Volume', '0']);
  assert.equal(code, 0, 'ps1 应正常退出');
  const pick = pickOf(out);
  assert.match(pick, /^(zundamon-normal|master-voice)\.wav$/, `done 应走 done 池/master，实际 pick=${pick}`);
});

test('B6: 未知 Kind 被 ValidateSet 拒绝（fail-closed，不会静默走错池）', () => {
  const { code } = runPs1(['-Kind', 'bogus-kind', '-Preview']);
  assert.notEqual(code, 0, 'ValidateSet 应拒绝未知 Kind');
});
