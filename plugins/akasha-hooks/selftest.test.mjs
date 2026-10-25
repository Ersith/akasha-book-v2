// akasha-hooks 自测（v1.2：记录层 + 输出审计；夹具＝宿主真值：revision 逐帧递增）。
// 桩 ctx 收集监听；临时 akashaDir（拷贝核心 lib.mjs + 假 data/canon.jsonl）验证 usage / output-audit 线。
// 运行：node selftest.mjs（退出码 0 = 全过）
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { apply, findPlaceholders, assertNoPlaceholders } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
// 兼容双布局（2026-10-15 DS 合入修）：oss 仓库 = <repo>/plugins/<pkg> ⇒ <repo>/core；工作源 = <LOCAL_PATH> ⇒ <LOCAL_PATH>
const CORE = existsSync(join(here, '..', '..', 'core', 'lib.mjs')) ? join(here, '..', '..', 'core') : join(here, '..', 'akasha');
const scratchRoot = join(tmpdir(), 'akasha-hooks-selftest');
mkdirSync(scratchRoot, { recursive: true });
const cleanupDirs = [];
process.on('exit', () => {
  for (const d of cleanupDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 兜底失败不遮错误 */ } }
});

const dir = mkdtempSync(join(scratchRoot, 'akasha-hooks-'));
cleanupDirs.push(dir);
copyFileSync(join(CORE, 'lib.mjs'), join(dir, 'lib.mjs'));
copyFileSync(join(CORE, 'json-redaction.mjs'), join(dir, 'json-redaction.mjs'));
mkdirSync(join(dir, 'data'), { recursive: true });
writeFileSync(join(dir, 'data', 'canon.jsonl'), JSON.stringify({
  id: 'canon-test-item-xyz', claim: '测试条目', source: { type: '复现', ref: 'selftest' }, last_reviewed: '2026-10-07'
}) + '\n', 'utf8');

const logPath = join(dir, 'hooks.jsonl');
const handlers = {};
const ctx = { on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); return () => {}; } };
apply(ctx, { log: logPath, akashaDir: dir, idleDebounceMs: 1 });

// —— 1. 激活线 + 监听面 ——
let text = readFileSync(logPath, 'utf8');
assert.ok(text.includes('"kind":"activated"'), '激活线');
for (const ev of ['session/event', 'tools/result', 'agent/error', 'agent/status', 'agent/assistant-stream']) {
  assert.ok((handlers[ev] || []).length >= 1, '已监听 ' + ev);
}

// —— 2. 流累积 + 审计（committed 的 assistant/message）——
//    宿主真值＝每帧 revision 递增；id 可能被切分在不同 chunk。累积必须跨 revision 连续。
const stream = handlers['agent/assistant-stream'][0];
stream({ agent: { id: 'sess-1' }, frame: { type: 'start', attemptId: 'a1', revision: 1, turn: 1, step: 1 } });
stream({ agent: { id: 'sess-1' }, frame: { type: 'chunk', attemptId: 'a1', revision: 2, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text: '见 canon-test-' } } });
stream({ agent: { id: 'sess-1' }, frame: { type: 'chunk', attemptId: 'a1', revision: 3, index: 1, time: 0, chunk: { type: 'text-delta', index: 1, text: 'item-xyz 与 canon-nope-abcdef' } } });
stream({ agent: { id: 'sess-1' }, frame: { type: 'end', attemptId: 'a1', revision: 4, index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 9 } } });
text = readFileSync(logPath, 'utf8');
assert.ok(text.includes('"kind":"usage"') && text.includes('canon-test-item-xyz'), 'usage 线（真 id，跨帧切分也必须还原）');
assert.ok(text.includes('"kind":"output-audit"') && text.includes('canon-nope-abcdef'), 'output-audit 线（假 id）');

// —— 3. abandoned 流不落线 ——
const before = readFileSync(logPath, 'utf8').length;
stream({ agent: { id: 's' }, frame: { type: 'start', attemptId: 'a2', revision: 1, turn: 2, step: 1 } });
stream({ agent: { id: 's' }, frame: { type: 'chunk', attemptId: 'a2', revision: 1, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text: 'canon-ghost-xxxxxx' } } });
stream({ agent: { id: 's' }, frame: { type: 'end', attemptId: 'a2', revision: 1, index: 1, outcome: { kind: 'abandoned' } } });
assert.equal(readFileSync(logPath, 'utf8').length, before, 'abandoned 流不落线');

// —— 4. 逐帧递增 revision 为宿主真值：累积不得重置（修复回归哨兵） ——
stream({ agent: { id: 's' }, frame: { type: 'start', attemptId: 'a3', revision: 1, turn: 3, step: 1 } });
stream({ agent: { id: 's' }, frame: { type: 'chunk', attemptId: 'a3', revision: 2, index: 0, time: 0, chunk: { type: 'text-delta', index: 0, text: 'canon-ghost-yyyyy' } } });
stream({ agent: { id: 's' }, frame: { type: 'chunk', attemptId: 'a3', revision: 3, index: 1, time: 0, chunk: { type: 'text-delta', index: 1, text: ' 收尾' } } });
stream({ agent: { id: 's' }, frame: { type: 'end', attemptId: 'a3', revision: 4, index: 2, outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 10 } } });
text = readFileSync(logPath, 'utf8');
assert.ok(text.includes('"eventType":"assistant/attempt"'), 'attempt 线带 eventType');
assert.ok(text.includes('canon-ghost-yyyyy'), '早帧内容必须保留到 end（跨 revision 累积）');

// —— 5. 无核心降级：akashaDir 指向空目录 → apply 不炸、审计静默跳过、激活线仍在 ——
const dirC = mkdtempSync(join(scratchRoot, 'akasha-hooks-c-'));
cleanupDirs.push(dirC);
const logC = join(dirC, 'hooks.jsonl');
const ctxC = { on() { return () => {}; } };
let threw = null;
try { apply(ctxC, { log: logC, akashaDir: dirC }); } catch (e) { threw = e; }
assert.equal(threw, null, '无核心时 apply 不得抛：' + (threw && threw.message));
assert.ok(readFileSync(logC, 'utf8').includes('"kind":"activated"'), '降级时激活线仍在');

// —— 5b. B2（wave1）：shell 里的 akasha CLI 查库子命令标 akashaCli（只记子命令名，不记命令原文）——
{
  const { akashaCliOf } = await import('./index.js');
  assert.equal(akashaCliOf('bash', { command: 'node core/akasha.mjs lookup 某词' }), 'lookup');
  assert.equal(akashaCliOf('pwsh', { command: 'node "C:/x/akasha.mjs" mirror match 某段文本' }), 'mirror-match', '带引号的脚本路径（Windows 常见）也认');
  assert.equal(akashaCliOf('pwsh', { command: 'node akasha.mjs mirror  match 文本' }), 'mirror-match');
  assert.equal(akashaCliOf('bash', { command: 'node akasha.mjs session lookup 词 --limit 3' }), 'session-lookup');
  assert.equal(akashaCliOf('bash', { command: 'node akasha.mjs add --store canon --data {}' }), null, '写入子命令不算召回');
  assert.equal(akashaCliOf('read', { command: 'node akasha.mjs lookup x' }), null, '非 shell 工具不看');
  // 2026-10-10 人读复查：工具目录长了（dsh_wsl 在跑），分类集合没跟上 → 漏计召回。此处钉住。
  assert.equal(akashaCliOf('dsh_wsl', { command: 'node core/akasha.mjs brief 某主题' }), 'brief', 'dsh_wsl 里的查库也须计入召回');
  assert.equal(akashaCliOf('dsh_wsl', { command: 'node akasha.mjs add --store canon --data {}' }), null, 'dsh_wsl 写子命令不算召回');
  // 2026-10-13 举一反三（审计 P1 同族）：工具/子命令表漏项 = 召回静默漏计。
  assert.equal(akashaCliOf('ops_bash', { command: 'node akasha/akasha.mjs lookup 词' }), 'lookup', 'ops_bash 是主用 shell 入口，必须计入召回');
  assert.equal(akashaCliOf('bash', { command: 'node akasha.mjs check' }), 'check', 'check（只读自查）算召回');
  assert.equal(akashaCliOf('bash', { command: 'node akasha.mjs stats' }), 'stats', 'stats 算召回');
  assert.equal(akashaCliOf('bash', { command: 'node akasha.mjs audit --today 2026-10-13' }), 'audit', 'audit 算召回');
  assert.equal(akashaCliOf('bash', { command: 'node akasha.mjs frontier list' }), 'frontier-list', 'frontier list 算召回');
  assert.equal(akashaCliOf('bash', { command: 'node akasha.mjs session tree --session abc' }), 'session-tree', 'session 只读子命令算召回');
  assert.equal(akashaCliOf('bash', { command: 'node akasha.mjs sleep --plan --today 2026-10-13' }), 'sleep---plan', 'sleep --plan（只读计划）算召回');
  assert.equal(akashaCliOf('bash', { command: 'node akasha.mjs revise canon x --data {}' }), null, 'revise（写入）不算召回');
  assert.equal(akashaCliOf('bash', { command: 'node akasha.mjs retire canon x' }), null, 'retire（写入）不算召回');
  const hB = {};
  const logB = join(dir, 'hooks-b2.jsonl');
  apply({ on(name, fn) { (hB[name] = hB[name] || []).push(fn); return () => {}; } }, { log: logB, akashaDir: dir });
  for (const fn of hB['tools/result']) fn({ name: 'bash', arguments: { command: 'node akasha.mjs brief 某主题 # secret-ish' } }, { isError: false });
  const toolLine = readFileSync(logB, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.kind === 'tool');
  assert.equal(toolLine.akashaCli, 'brief', JSON.stringify(toolLine));
  assert.ok(!JSON.stringify(toolLine).includes('secret-ish'), '不记命令原文');
}

// —— 5c. wave1.1：tool 线带会话 id（exec.agent.id）；无 agent 时不写 ——
{
  const hS = {};
  const logS = join(dir, 'hooks-sid.jsonl');
  apply({ on(name, fn) { (hS[name] = hS[name] || []).push(fn); return () => {}; } }, { log: logS, akashaDir: dir });
  for (const fn of hS['tools/result']) fn({ name: 'read', callId: 'c1', agent: { id: 'sess-alpha' }, arguments: {} }, { isError: false });
  for (const fn of hS['tools/result']) fn({ name: 'read', callId: 'c2', arguments: {} }, { isError: true, error: { message: 'x' } });
  const tl = readFileSync(logS, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.kind === 'tool');
  assert.equal(tl[0].session, 'sess-alpha', 'tool 线应带 exec.agent.id：' + JSON.stringify(tl[0]));
  assert.ok(!('session' in tl[1]), '无 agent 时不写 session（不编造）：' + JSON.stringify(tl[1]));
}

// —— 5d. wave1.1：两个会话交错 → hooks 落盘 → 核心 recallSignals 按会话分区，互不混窗（端到端，中性夹具）——
{
  const hI = {};
  const logI = join(dir, 'hooks-interleave.jsonl');
  apply({ on(name, fn) { (hI[name] = hI[name] || []).push(fn); return () => {}; } }, { log: logI, akashaDir: dir });
  const A = { id: 'sess-aaaa' }; const B = { id: 'sess-bbbb' };
  const tool = (agent, name, isError = false) => { for (const fn of hI['tools/result']) fn({ name, callId: name + Math.random(), agent, arguments: {} }, isError ? { isError: true, error: { message: 'boom' } } : { isError: false }); };
  const turnEnd = (session, turn) => { for (const fn of hI['session/event']) fn(session, { type: 'turn/end', data: { turn } }); };
  const agentErr = (agent) => { for (const fn of hI['agent/error']) fn({ agent, turn: 1, step: 1, error: new Error('x') }); };
  tool(A, 'mcp__akasha__akasha_lookup');  // A 先查库
  tool(B, 'bash', true);                  // B 没查库就失败
  tool(A, 'bash', true);                  // A 查过库后失败
  turnEnd(B, 1);                          // B 回合先结束（不得关掉 A 的窗口）
  tool(B, 'mcp__akasha__akasha_brief');   // B 下一回合查库……
  agentErr(A);                            // ……A 同回合再出错（不得被 B 的查库「救」）
  turnEnd(A, 1);
  turnEnd(B, 2);
  const recs = readFileSync(logI, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(recs.filter((r) => r.kind === 'tool').every((r) => r.session === 'sess-aaaa' || r.session === 'sess-bbbb'), '每条 tool 线都带会话 id');
  const { recallSignals } = await import(pathToFileURL(join(dir, 'lib.mjs')).href);
  const r = recallSignals(recs);
  assert.equal(r.sessions, 2, JSON.stringify(r));
  assert.equal(r.unattributed, 0);
  assert.equal(r.failureTurns, 2, '两个失败回合（A1 / B1）：' + JSON.stringify(r));
  assert.equal(r.recalledBefore, 1, 'A1：自己先查过库（A 的 agent-error 与 bash 同回合，只算一次）：' + JSON.stringify(r));
  assert.equal(r.misses, 1, 'B1 是漏召（A 的查库救不了 B）：' + JSON.stringify(r));
  assert.deepEqual(r.samples.map((x) => x.session), ['sess-bbbb']);
  // 对照：抹掉 session（＝旧日志的全局口径）→ 窗口混了，B1 的漏召被 A 的查库「掩盖」
  const mixed = recallSignals(recs.map(({ session, ...rest }) => rest));
  assert.equal(mixed.misses, 0, '全局口径下 B1 被 A 的查库掩盖、A 的出错被 B 的查库「救」——混窗确实发生：' + JSON.stringify(mixed));
  assert.equal(mixed.recalledBefore, 2, JSON.stringify(mixed));
}

// —— 6. 2026-10 wave1：默认路径回归——默认日志必须落在 $HOME/.akasha/logs，不得在 cwd 下建出字面量 `~` 目录 ——
{
  const fakeHome = mkdtempSync(join(scratchRoot, 'akasha-hooks-home-'));
  const cwdD = mkdtempSync(join(scratchRoot, 'akasha-hooks-cwd-'));
  cleanupDirs.push(fakeHome, cwdD);
  const indexUrl = new URL('./index.js', import.meta.url).href;
  const script = `const m = await import(${JSON.stringify(indexUrl)}); m.apply({ on() { return () => {}; } }, {});`;
  // D4（2026-10-19 发布面 P2）：本用例测的是**默认值**，必须把外部注入的路径环境变量清掉——
  //   设了 AKASHA_DIR 时默认日志按契约就是 <AKASHA_DIR>/logs/hooks.jsonl（不是缺陷），
  //   带着它跑这条断言只会把「设计如此」报成红。用空串（模块侧判 trim!=='' ⇒ 视为未设）：显式、跨平台一致。
  const childEnv = { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome, AKASHA_DIR: '', AKASHA_LOGS: '' };
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: cwdD, env: childEnv, stdio: 'pipe'
  });
  assert.ok(existsSync(join(fakeHome, '.akasha', 'logs', 'hooks.jsonl')),
    '默认日志落在 homedir()/.akasha/logs/hooks.jsonl（子进程已清 AKASHA_DIR/AKASHA_LOGS）');
  assert.ok(!existsSync(join(cwdD, '~')), 'cwd 下不得出现字面量 `~` 目录');
}

// —— STORE 审计边界用例：malformed / fail closed / replay（纯函数，无副作用）——
{
  const { akashaCliOf } = await import('./index.js');
  assert.equal(akashaCliOf('pwsh', null), null, 'malformed：args=null 不得抛，返回 null（fail closed）');
  assert.equal(akashaCliOf(undefined, { command: 'node akasha.mjs lookup x' }), null, 'malformed：工具名缺失 → null');
  assert.equal(akashaCliOf('pwsh', { command: 'node akasha.mjs lookup x' }), 'lookup', '正常路径：识别 akasha 子命令');
  const twice = [akashaCliOf('pwsh', { command: 'node akasha.mjs brief y' }), akashaCliOf('pwsh', { command: 'node akasha.mjs brief y' })];
  assert.deepEqual(twice, ['brief', 'brief'], 'replay：同输入两次识别一致（纯函数、可重放）');
}

// —— 体量代理（2026-10-15；补 hooks 的 token/字符口径）——
{
  const { sizeOf, charsOf } = await import('./index.js');
  assert.equal(sizeOf('abcdef'), 6, '字符串取 length');
  assert.equal(sizeOf({ a: 1 }), 7, '对象走 JSON.stringify（{"a":1} = 7）');
  const cyc = {}; cyc.self = cyc;
  assert.equal(sizeOf(cyc), 0, '循环引用降级 0（记账不得把事件打挂）');
  assert.equal(sizeOf(undefined), 2, 'undefined ⇒ JSON.stringify(undefined ?? "") = "\\"\\"" ⇒ 2 字符（安全降级，非 0）');
  const r = charsOf({ arguments: { a: 1, b: 'x'.repeat(10) } }, { content: [{ type: 'text', text: 'y'.repeat(20) }] });
  assert.ok(r.chars === r.charsIn + r.charsOut && r.charsIn > 0 && r.charsOut > r.charsIn, 'chars = 入参 + 返回体：' + JSON.stringify(r));
  const r2 = charsOf({ arguments: 'abc' }, { isError: true, error: { message: 'boom' } });
  assert.ok(r2.chars > 0 && r2.charsOut > 0, '失败路径也要有体量（走 error 分支）：' + JSON.stringify(r2));
}

// —— 占位符守卫（2026-10-19 发布面 P0）：照抄 OSS 的 `<AKASHA_DIR>` 字面量必须**明确抛错**，不得静默降级 ——
assert.equal(findPlaceholders({ akashaDir: '<AKASHA_DIR>' }).length, 1, '占位符必须被识别');
assert.equal(findPlaceholders({ akashaDir: CORE }).length, 0, '正常路径不得误报');
assert.throws(() => assertNoPlaceholders({ log: '<AKASHA_DIR>/logs/hooks.jsonl' }), /未替换的占位符/, '占位符配置必须抛错');
assert.throws(() => apply({}, { akashaDir: '<AKASHA_DIR>' }), /占位符/, 'apply 阶段必须 fail closed');

console.log('selftest: all assertions passed');
