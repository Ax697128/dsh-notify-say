/**
 * 第 2 批 P0 的契约测试（2026-10-19 外部审查发现的错误漏播缺陷）。
 *
 * 三个 P0：
 *   ① 失败通知被完成的 60 秒去抖压制
 *   ② 后台 job failed 无独立播报路径
 *   ③ 缺 reason 默认 completed + 复用旧 reason
 *
 * 这些是**判定协议**（谁该播、谁不该播、播成什么等级），
 * 按纪律必须断言 exact state + exact reason code + negative path，
 * 不能用「多个可接受结果之一」的宽松断言。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = readFileSync(join(ROOT, 'lib/index.js'), 'utf8');

function fnBody(sig) {
  const lines = INDEX.split(/\r?\n/);
  const i = lines.findIndex((l) => l.includes(sig));
  assert.ok(i >= 0, '找不到函数: ' + sig);
  const indent = (lines[i].match(/^(\s*)/) || ['', ''])[1];
  let j = -1;
  for (let k = i + 1; k < lines.length; k++) {
    if (lines[k] === indent + '}') { j = k; break; }
  }
  assert.ok(j > i, '找不到函数终点: ' + sig);
  return lines.slice(i, j + 1).join('\n');
}

// ══ P0-① 去抖按等级分桶 ═════════════════════════════════════════════════
test('P1: 去抖必须按通知等级分桶（fail 不被 done 压制）', () => {
  const body = fnBody('function emitDone(');
  assert.match(body, /const tier = psKind === 'fail' \? 'fail' : 'done'/,
    '必须从 psKind 推导等级');
  assert.match(body, /const tierKey = key \+/,
    '必须有桶键');
  assert.match(body, /isRecent\(lastTurnNotify, tierKey,/,
    '去抖判定必须用桶键，不能用裸 key（裸 key 会让失败被完成吞掉）');
  // 负路径：不得再出现用裸 key 做判定
  assert.doesNotMatch(body, /isRecent\(lastTurnNotify, key, now/,
    '不能退回用裸 session key 去抖');
});

test('P2: 去抖记录也必须用桶键', () => {
  const body = fnBody('function emitDone(');
  assert.match(body, /rememberAt\(lastTurnNotify, tierKey, now\)/,
    '记录必须用桶键，否则分桶不生效');
});

// ══ P0-② 后台 job failed 独立提醒 ═══════════════════════════════════════
test('P3: 必须有 handleJobFailure 且只处理 status=failed', () => {
  const body = fnBody('function handleJobFailure(');
  assert.match(body, /!== 'failed'/, '只处理 failed');
  assert.match(body, /failedJobNotified/, '必须按 job 去重');
  assert.match(body, /jobfail:/, 'evKey 要用 job 粒度');
  // 必须是 fail 等级（走失败语音），不是 done
  assert.match(body, /'fail'/, '必须用 fail 等级播报');
});

test('P4: jobs 事件回调必须调用 handleJobFailure', () => {
  const idx = INDEX.indexOf("js.events.subscribe({ owners: 'all' }");
  assert.ok(idx > 0, '找不到 jobs 订阅');
  const seg = INDEX.slice(idx, idx + 1200);
  assert.match(seg, /handleJobFailure\(event\)/,
    '订阅回调必须检查 job 失败，否则后台失败没有声音');
});

test('P5: job 失败不受空闲门约束（直接 emitDone）', () => {
  const body = fnBody('function handleJobFailure(');
  assert.match(body, /emitDone\(/, 'job 失败要直接播报');
  assert.doesNotMatch(body, /scheduleOrNotify\(/,
    '不能走空闲门 —— 错误必须立刻提醒，不能等工作树空了');
});

// ══ P0-③ reason 完整性 ═════════════════════════════════════════════════
test('P6: 缺 reason 不得默认 completed', () => {
  assert.doesNotMatch(INDEX, /rec && rec\.kind \? rec\.kind : 'completed'/,
    '「取不到 reason 就当完成」会把错误播成成功，方向性错误');
  const idx = INDEX.indexOf('reason-missing');
  assert.ok(idx > 0, '缺 reason 时必须留痕');
});

test('P7: reason 消费后必须删除（防跨轮复用）', () => {
  const idx = INDEX.indexOf('lastTurnEnd.delete(');
  assert.ok(idx > 0, 'lastTurnEnd 必须消费即删除，否则下一轮会复用旧 reason');
});

test('P8: reason 的读写必须用同一个键', () => {
  // 2026-10-19 回归实测：写入用 sessionKey(session)，读取用 agent.id，
  // 两者不等时（测试环境 agent-1 / sess-1）rec 永远 undefined。
  const writeIdx = INDEX.indexOf('rememberBounded(lastTurnEnd');
  assert.ok(writeIdx > 0);
  const wseg = INDEX.slice(writeIdx, writeIdx + 300);
  assert.match(wseg, /sessionKey\(session\)/, '写入用 sessionKey(session)');

  // 按行检查：调用参数里必须出现 sessionKey(agent.session)
  const callLines = INDEX.split(/\r?\n/).filter((l) => /lastTurnEnd\.(get|delete)\(/.test(l));
  assert.ok(callLines.length >= 2, '至少有读取与删除');
  for (const ln of callLines) {
    assert.ok(ln.includes('sessionKey(agent.session)'),
      '读写键必须一致（写入侧用 sessionKey(session)，读取侧必须对应），实际: ' + ln.trim());
  }
});

test('P9: 轮次校验拿不到时按放行处理（不能丢通知）', () => {
  assert.match(INDEX, /canVerifyTurn/,
    '要区分「能校验」和「拿不到轮次」两种情况');
  // 必须有明确的「拿不到就放行」逻辑
  assert.match(INDEX, /turnOk === false/,
    '只有明确判定为过时才拒绝；undefined 要放行');
});

// ══ P1 播放层可观测（2.4 / 2.6）══════════════════════════════════════════
test('P10: spawn 必须记录退出码（不能把"启动了"当"播成了"）', () => {
  const body = fnBody('function spawnNotify(args, psKind) {');
  assert.match(body, /child\.once\('exit', \(code, signal\)/, '要接退出码与信号');
  assert.match(body, /play-ok/, '成功要留痕');
  assert.match(body, /play-fail/, '失败必须留痕');
  assert.match(body, /exit=/, '失败日志要含退出码');
});

test('P11: spawn 必须收 stderr（否则不知道为什么失败）', () => {
  const body = fnBody('function spawnNotify(args, psKind) {');
  assert.match(body, /'pipe'/, 'stderr 必须 pipe，不能全 ignore');
  assert.match(body, /stderrTail/, '要收集 stderr 尾部');
  assert.match(body, /stderr=/, '失败日志要带 stderr');
});

test('P12: 播放失败要有**一次**蜂鸣降级（且绝不重试）', () => {
  assert.match(INDEX, /beepFallbackUsed/, '要有防重入标志');
  const body = fnBody('function fallbackBeep(which) {');
  assert.match(body, /if \(beepFallbackUsed\) return;/, '只降级一次');
  assert.match(body, /beepFallbackUsed = true;/, '用了就置位');
  // 负路径：不得出现重试循环
  assert.doesNotMatch(body, /setTimeout|setInterval|for \(|while \(/, '不得重试（防通知风暴）');
});

test('P13: 并发丢弃必须能定位是哪条通知', () => {
  const body = fnBody('function spawnNotify(args, psKind) {');
  const idx = body.indexOf('spawn-drop');
  assert.ok(idx > 0, '要有 spawn-drop 留痕');
  const seg = body.slice(idx, idx + 300);
  assert.match(seg, /kind=/, 'spawn-drop 必须带 psKind，否则无法定位丢了什么');
});

test('P14: spawnTts 要透传 psKind（TTS 失败也要能定位）', () => {
  const body = fnBody('function spawnTts(args, psKind) {');
  assert.match(body, /spawnNotify\(args, psKind\)/, 'spawnTts 必须透传 psKind');
});
// ══ 第 3 批：error 当场播报（2026-10-19 真机排查的根因）══════════════════
test('P15: error / blocked 必须在 turn/end 当场播，不等 idle 边沿', () => {
  const idx = INDEX.indexOf("if (type === 'turn/end') {");
  assert.ok(idx > 0, '要有 turn/end 处理');
  const seg = INDEX.slice(idx, idx + 2200);
  // 必须有 error/blocked 的立即播报分支
  assert.match(seg, /endKind === 'error' \|\| endKind === 'blocked'/,
    '必须有 error/blocked 的当场播报分支');
  // 该分支必须 return（不能落下去写 lastTurnEnd，否则 idle 路径会再播一次）
  const branch = seg.slice(seg.indexOf("endKind === 'error'"));
  assert.match(branch, /return;/, '当场播后必须 return，避免走到 lastTurnEnd 记账');
});

test('P16: 数据依据 —— 不得因"怕重复"而把 error 也走记账路径', () => {
  // 2026-10-19 实测 2195 个会话 / 6262 条 turn/end：
  //   同一 turn 多条 turn/end = 0，同一 turn 多种 kind = 0
  // 所以不存在"提前播会重复"的问题。
  const idx = INDEX.indexOf("if (type === 'turn/end') {");
  const seg = INDEX.slice(idx, idx + 2200);
  assert.match(seg, /error .* 当场播报|当场播报，不等 idle|error \/ blocked → 当场播/,
    '代码里应保留这条判断的依据说明，防止后人又改回"等 idle"');
});

test('P17: 子代理错误要有独立开关（默认开）', () => {
  assert.match(INDEX, /notifyOnSubagentError/,
    '子代理错误要能单独控制：不打扰于子代理完成，但不能静默子代理错误');
  // 默认值定义在 config-schema.js（FIELD_DEFAULTS），不在 index.js
  const SCHEMA = readFileSync(join(ROOT, 'lib/config-schema.js'), 'utf8');
  const m = SCHEMA.match(/notifyOnSubagentError:\s*(true|false)/);
  assert.ok(m, 'config-schema.js 里要有默认值');
  assert.equal(m[1], 'true', '默认必须开 —— 错误不该被静默');
});