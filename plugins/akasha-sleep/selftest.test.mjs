// akasha-sleep 自测（v1.5：调度插件 + 核心库 sleep.mjs 双层）。
// 纯函数直接测 ../../core/sleep.mjs；端到端用桩 ctx + 系统临时目录（不碰真实库水位线）。
// 运行：node selftest.mjs（退出码 0 = 全过）
import assert from 'node:assert/strict';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { apply, buildWakeNote, isWakeNoteworthy, findPlaceholders, assertNoPlaceholders } from './lib/index.js';
// 静态 import 会被提升到 CORE 计算之前（oss 布局可，工作源布局不可）——改 CORE 之后动态 import（2026-10-15 DS 合入修）。

// 活树布局：插件在 <LOCAL_PATH> <AKASHA_DIR>/（仓布局则是 ../../core）
const here = dirname(fileURLToPath(import.meta.url));
// 兼容双布局（2026-10-15 DS 合入修）：oss 仓库 = <repo>/plugins/<pkg> ⇒ <repo>/core；工作源 = <LOCAL_PATH>/dsh-* ⇒ <AKASHA_DIR>。
const CORE = existsSync(join(here, '..', '..', 'core', 'lib.mjs')) ? join(here, '..', '..', 'core') : join(here, '..', 'akasha');
const { buildTodos, distillHooks, renderContextLine, renderPulseLine, renderRecallLine, shouldSleep } = await import(pathToFileURL(join(CORE, 'sleep.mjs')).href);
/** 把核心（sleep.mjs + lib.mjs）拷进桩目录——插件通过 akashaDir 动态加载它们。 */
const seedCore = (dir) => {
  copyFileSync(join(CORE, 'sleep.mjs'), join(dir, 'sleep.mjs'));
  copyFileSync(join(CORE, 'lib.mjs'), join(dir, 'lib.mjs'));
  copyFileSync(join(CORE, 'json-redaction.mjs'), join(dir, 'json-redaction.mjs'));
};

// —— 1. distillHooks 纯函数 ——
const lines = [
  JSON.stringify({ kind: 'tool', tool: 'pwsh', ok: true }),
  JSON.stringify({ kind: 'tool', tool: 'pwsh', ok: false, message: 'boom' }),
  JSON.stringify({ kind: 'turn-end', turn: 1 }),
  JSON.stringify({ kind: 'gate-denied', tool: 'edit' }),
  JSON.stringify({ kind: 'agent-error', message: 'x' }),
  'not json'
];
const { counters, notes } = distillHooks(lines);
assert.equal(counters.lines, 5, 'lines 只数可解析记录');
assert.equal(counters.tools, 2);
assert.equal(counters.toolErrors, 1);
assert.equal(counters.turns, 1);
assert.equal(counters.denials, 1);
assert.equal(counters.agentErrors, 1);
assert.equal(counters.byTool.pwsh, 2);
assert.equal(notes.length, 1);

// —— 2. buildTodos 纯函数 ——
const todos = buildTodos(
  { toolErrors: 1, denials: 1, agentErrors: 0 },
  ['工具失败 edit: x'],
  { ok: false, findings: [{ level: 'warn', code: 'frontier-due', count: 68 }] }
);
assert.equal(todos.length, 3, JSON.stringify(todos));
assert.equal(todos[0].kind, 'review');
assert.equal(todos[0].code, 'frontier-due');
assert.equal(todos[1].code, 'tool-error');
assert.equal(todos[2].code, 'gate-denied');
assert.deepEqual(buildTodos({ toolErrors: 0, denials: 0, agentErrors: 0 }, [], { ok: true, findings: [] }), []);
// wave1.1：召回漏进待办（review / recall-miss；排在最后，不改变前面各项的位置）
const withRecall = buildTodos({ toolErrors: 1, denials: 0, agentErrors: 0, failureTurns: 2, recallMisses: 1, lateRecall: 1 }, ['x'],
  { ok: true, findings: [] }, { samples: [{ what: 'bash', session: 'sess-aaaa', ts: '2026-01-01T00:00:00Z' }] });
assert.equal(withRecall.length, 2, JSON.stringify(withRecall));
assert.equal(withRecall[1].kind, 'review');
assert.equal(withRecall[1].code, 'recall-miss');
assert.equal(withRecall[1].count, 1);
assert.ok(withRecall[1].note.includes('1/2 回合') && withRecall[1].note.includes('事后才查 1'), withRecall[1].note);
assert.deepEqual(withRecall[1].samples, ['bash @sess-aaaa 2026-01-01T00:00']);
assert.equal(buildTodos({ recallMisses: 0, failureTurns: 3 }, [], { ok: true, findings: [] }).length, 0, '没有漏召 → 不出待办');

// —— 3. renderContextLine / renderPulseLine / shouldSleep 纯函数 ——
assert.ok(renderContextLine({}).includes('尚未运行'));
const line = renderContextLine({
  lastRunAt: '2026-10-06T23:00:00.000Z', lastTrigger: 'activate', lastReport: 'sleep-2026-10-06.json',
  lastCounters: { lines: 9, tools: 3, toolErrors: 1, denials: 0 }, lastAudit: 'ok'
});
assert.ok(line.includes('2026-10-06T23:00:00.000Z') && line.includes('审计 OK'), line);
assert.ok(renderContextLine({ lastRunAt: 'x', lastAudit: 2, lastCounters: {} }).includes('审计警告 2 条'));
assert.ok(!renderContextLine({ lastRunAt: 'x', lastAudit: 'ok', lastCounters: {}, lastTodo: 0 }).includes('待办'));
assert.ok(renderContextLine({ lastRunAt: 'x', lastAudit: 'ok', lastCounters: {}, lastTodo: 3 }).includes('待办 3 条'));
assert.equal(shouldSleep({}, Date.now(), 6).due, true, '无记录 → 该睡');
assert.equal(shouldSleep({ lastRunAt: new Date().toISOString() }, Date.now(), 6).due, false, '<6h → 不睡');
assert.equal(shouldSleep({ lastRunAt: new Date(Date.now() - 7 * 3600000).toISOString() }, Date.now(), 6).due, true, '>6h → 该睡');

// —— 4. apply 桩 ctx 端到端（临时目录 + 核心拷贝：审计空库 ok + 有待办 → inbox 落行）——
// 注意：本机 C: 可能满（系统 TEMP 也在 C:）——测试落工作区磁盘（H:），成功后在结尾清理。
const scratchRoot = join(tmpdir(), 'akasha-sleep-selftest');
mkdirSync(scratchRoot, { recursive: true });
// 兜底清理：断言失败中断也清掉临时目录（2026-10-07 复查捕获「失败留残渣」）
// F-14-S6-2（2026-10-17 batch15）：`scratchRoot` 是 mkdirSync 建的**父容器**，此前只清子目录 ⇒ 空容器常驻
//   （实测 `<TEMP_DIR>\akasha-sleep-selftest` 永不消失）。子目录清完后补一步**非空则留**的 rmdir：
//   `<TEMP_DIR>` 名称固定，若另一进程正在跑同一套件，其子目录还在 ⇒ rmdir 失败即保留，不误删他进程夹具。
const cleanupDirs = [];
process.on('exit', () => {
  for (const d of cleanupDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 兜底失败不遮错误 */ } }
  try { rmdirSync(scratchRoot); } catch { /* 非空（他进程在用）或已不存在 ⇒ 保留 */ }
});
const dir = mkdtempSync(join(scratchRoot, 'akasha-sleep-'));
cleanupDirs.push(dir);
seedCore(dir);
const logPath = join(dir, 'hooks.jsonl');
const statePath = join(dir, 'sleep-state.json');
const inboxPath = join(dir, 'inbox.jsonl');
appendFileSync(logPath, [
  JSON.stringify({ kind: 'tool', tool: 'read', ok: true }),
  JSON.stringify({ kind: 'tool', tool: 'read', ok: false, message: 'cannot read "<LOCAL_PATH>/x.mjs": ENOENT' }),
  JSON.stringify({ kind: 'gate-denied', tool: 'edit', target: '<AKASHA_DIR>/data/canon.jsonl', message: '拒绝直写 akasha/data/canon.jsonl' })
].join('\n') + '\n');

const contexts = [];
const onHandlers = {};
let intervalArgs = null;
let timerOwnerCleanup = null;
const ctx = {
  on(name, fn) { (onHandlers[name] = onHandlers[name] || []).push(fn); return () => {}; },
  effect(cb) { timerOwnerCleanup = cb(); return () => {}; },
  interval(fn, ms) { intervalArgs = [fn, ms]; return () => {}; },
  systemPrompt: { context(c) { contexts.push(c); return () => {}; } }
};
apply(ctx, { log: logPath, stateFile: statePath, inboxFile: inboxPath, akashaDir: dir, minIntervalHours: 6, timerCheckMs: 3600000, contextOrder: 130, pulseOrder: 132 });

const sleepCtx = contexts.find((c) => c.name === 'akasha:sleep');
const pulseCtx = contexts.find((c) => c.name === 'akasha:pulse');
assert.ok(sleepCtx, 'systemPrompt.context（akasha:sleep）已注册');
assert.equal(sleepCtx.order, 130);
assert.ok(pulseCtx, 'systemPrompt.context（akasha:pulse）已注册');
assert.equal(pulseCtx.order, 132);
const emptyPulse = pulseCtx.text();
assert.ok(emptyPulse !== null && emptyPulse.includes('canon 0'), '桩空库 → 脉搏渲染全 0 行且不抛：' + emptyPulse);
// v1.5：模拟一次工具失败 → 脉搏条追一行回查提示（错误钩子的注入级动作）
assert.ok((onHandlers['tools/result'] || []).length >= 1, '已监听 tools/result');
assert.ok((onHandlers['agent/error'] || []).length >= 1, '已监听 agent/error');
onHandlers['tools/result'][0]({ name: 'pwsh' }, { isError: true });
const pulseWithRecall = pulseCtx.text();
assert.ok(pulseWithRecall.includes('回查提示') && pulseWithRecall.includes('pwsh'), '失败后脉搏条应追一行回查提示：' + pulseWithRecall);
assert.ok(intervalArgs && intervalArgs[1] === 3600000 && typeof intervalArgs[0] === 'function', '定时兜底已注册（ctx.interval，随 inject:["timer"] 合法）');
assert.equal(typeof timerOwnerCleanup, 'function', 'timer 清理已交给 ctx.effect（插件卸载即停）');

// 防御回归：ctx 上没有 interval 时 apply 也不得抛（v1.1.0 事故的性质是「属性访问本身抛」）
const ctx2 = { on() { return () => {}; }, effect() { return () => {}; }, systemPrompt: { context() { return () => {}; } } };
let threw = null;
try { apply(ctx2, { log: logPath, stateFile: statePath, inboxFile: inboxPath, akashaDir: dir, minIntervalHours: 6, timerCheckMs: 3600000, contextOrder: 130 }); }
catch (e) { threw = e; }
assert.equal(threw, null, 'interval 缺失时 apply 不得抛：' + (threw && threw.message));

const reportPath = join(dir, 'logs', `sleep-${new Date().toISOString().slice(0, 10)}.json`);
assert.ok(existsSync(reportPath), '激活首跑生成报告');
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
// 夹具：edit 失败前没有查库 → 除 tool-error / gate-denied 外，再出一条 recall-miss 复盘待办（wave1.1）
assert.equal(report.todo.length, 3, JSON.stringify(report.todo));
assert.deepEqual(report.todo.map((x) => x.code), ['tool-error', 'gate-denied', 'recall-miss']);
assert.equal(report.counters.recallMisses, 1);
assert.equal(report.counters.toolErrors, 1);

assert.ok(existsSync(inboxPath), '有待办时写 inbox');
const inboxLine = JSON.parse(readFileSync(inboxPath, 'utf8').trim().split(/\r?\n/).pop());
assert.equal(inboxLine.kind, 'todo');
assert.equal(inboxLine.items.length, 3);
assert.ok(inboxLine.items.some((x) => x.kind === 'review' && x.code === 'recall-miss'), '召回漏写进 inbox');

const state = JSON.parse(readFileSync(statePath, 'utf8'));
assert.equal(state.processedLines, 3, '水位线=已处理行数');
assert.equal(state.lastTrigger, 'activate');
assert.equal(state.lastAudit, 'ok', '桩空库上 audit 通过（审计降级路径见第 8 节无核心用例）');
assert.equal(state.lastTodo, 3);

const text = sleepCtx.text();
assert.ok(text.includes('审计 OK') && text.includes('待办 3 条') && text.includes('失败前未查库 1/1 回合'), text);

// 定时回调触发 → 去抖挡住并留痕
intervalArgs[0]();
const logText = readFileSync(logPath, 'utf8');
assert.ok(logText.includes('"kind":"sleep-skip"') && logText.includes('"trigger":"timer"'), '定时回调走去抖留痕');
assert.ok(logText.includes('"kind":"sleep-done"'), 'sleep-done 落观测线');
assert.ok(logText.includes('"kind":"sleep-armed"'), 'sleep-armed 落观测线');
assert.ok(!logText.includes('"kind":"wake-note-llm-skip"'), '默认（wakeNote 开、消息本地构造）不应出现跳过留痕');
assert.ok(logText.includes('"todo":3'), 'sleep-done 带待办数（含 recall-miss）');

// 注意：不在此处删 dir——§6 的 ctxLive 要读到本目录的桩 state（桩 state 缺失会让它 boot 触发
// activate、把空报告写进真库 logs——2026-10-07 复查捕获）；统一由终末清理 + exit 兜底。

// —— 5. 唤醒条纯函数（M6b）——
const kLib = { canon: 1, mirror: 2, orphan: 3, pricing: 4, lexicon: 5, frontier: 6 };
const kQuiet = { sleep: { lastRunAt: 'x', trigger: 'activate', todo: 0 }, inbox: { totalItems: 0 }, review: { findings: [], ok: true }, library: kLib };
assert.equal(isWakeNoteworthy({ ...kQuiet, sleep: null }), true, '未跑过睡眠 → 值得提醒');
assert.equal(isWakeNoteworthy(kQuiet), false, '一切平静 → 不打扰');
assert.equal(isWakeNoteworthy({ ...kQuiet, inbox: { totalItems: 2 } }), true, '有待办 → 提醒');
assert.equal(isWakeNoteworthy({ ...kQuiet, review: { findings: [{ level: 'warn', code: 'frontier-due', count: 3 }], ok: false } }), true, '审计警告 → 提醒');
const note = buildWakeNote({ ...kQuiet, inbox: { totalItems: 2 } });
assert.ok(note.includes('起床包') && note.includes('canon 1') && note.includes('待办 inbox：2 条') && note.includes('akasha_kit'), note);
const noteWarn = buildWakeNote({ ...kQuiet, review: { findings: [{ level: 'warn', code: 'frontier-due', count: 3 }], ok: false } });
// 2026-10-19：压缩后重投补「近期 2 条结论」（卡片 e3c10a7a 第三项）
const noteWithConcl = buildWakeNote({ ...kQuiet, inbox: { totalItems: 2 } }, ['结论甲：先查库', '结论乙：再动手']);
assert.ok(noteWithConcl.includes('近期结论（压缩前）：'), '压缩后唤醒条带结论标题');
assert.ok(noteWithConcl.includes('结论甲：先查库') && noteWithConcl.includes('结论乙：再动手'), '两条结论都在');
assert.ok(!buildWakeNote({ ...kQuiet, inbox: { totalItems: 2 } }).includes('近期结论'), '普通唤醒条不塞结论（仅压缩后）');
assert.ok(noteWarn.includes('审计：frontier-due×3'), noteWarn);

// —— 6. 库脉搏（v1.3）：纯函数两路 + 真库渲染一路 ——
assert.equal(renderPulseLine(null), null);
assert.equal(renderPulseLine({}), null);
const stubPulse = renderPulseLine({
  stores: { canon: { count: 26, current: 24 }, frontier: { count: 92, current: 89 } },
  newest: { store: 'canon', id: 'canon-akasha-usage-r2', ageText: '5 分钟前' }
});
assert.ok(stubPulse.includes('库脉搏') && stubPulse.includes('canon 24') && stubPulse.includes('frontier 89')
  && stubPulse.includes('canon-akasha-usage-r2') && stubPulse.includes('5 分钟前'), stubPulse);
// C3（2026-10-14 用户裁定 A）：近场纪律半句——缺省在、可关
assert.ok(stubPulse.includes('· 相关主题先 brief'), '缺省须带近场半句：' + stubPulse);
assert.ok(!renderPulseLine({ ...({ stores: { canon: { count: 1, current: 1 } }, newest: null }) }, { hint: false }).includes('相关主题先 brief'), 'opts.hint=false 须关断');
process.env.AKASHA_PULSE_HINT = 'off';
assert.ok(!renderPulseLine({ stores: { canon: { count: 1, current: 1 } }, newest: null }).includes('相关主题先 brief'), 'AKASHA_PULSE_HINT=off 须关断');
delete process.env.AKASHA_PULSE_HINT;

// —— 6b. 回查条（v1.5 纯函数）：窗口内失败 → 提示；窗口外 / 空 → null ——
assert.equal(renderRecallLine([], Date.now()), null);
assert.equal(renderRecallLine(null, Date.now()), null);
assert.equal(renderRecallLine([{ ts: Date.now() - 4000000, tool: 'pwsh' }], Date.now()), null, '窗口外（>30min）不提示');
const recall = renderRecallLine([{ ts: Date.now() - 60000, tool: 'pwsh' }, { ts: Date.now() - 30000, tool: 'edit' }], Date.now());
assert.ok(recall && recall.includes('2 次失败') && recall.includes('pwsh') && recall.includes('edit') && recall.includes('回查'), recall);

// 真库渲染：另起桩 ctx，akashaDir 指向真库 → 脉搏行必须带出当前计数与最近写入
const contexts2 = [];
const ctxLive = {
  on() { return () => {}; },
  effect() { return () => {}; },
  interval() { return () => {}; },
  systemPrompt: { context(c) { contexts2.push(c); return () => {}; } }
};
apply(ctxLive, { log: logPath, stateFile: statePath, inboxFile: inboxPath, akashaDir: CORE, minIntervalHours: 6, timerCheckMs: 3600000, contextOrder: 130, pulseOrder: 132 });
const livePulse = contexts2.find((c) => c.name === 'akasha:pulse').text();
// 空库：全零行（「含最近写入」的格式化断言由上方 stubPulse 覆盖）
assert.ok(livePulse === '' || (typeof livePulse === 'string' && livePulse.includes('阿卡夏·库脉搏')), String(livePulse));

// —— 7. 写路径静默失败 → 观测线（v1.3.1：静默失败类清剿；v1.4 后由核心 sleep.mjs 发线）——
const dirB = mkdtempSync(join(scratchRoot, 'akasha-sleep-b-'));
cleanupDirs.push(dirB);
seedCore(dirB);
const blocker = join(dirB, 'blocker');
writeFileSync(blocker, 'x', 'utf8'); // 用文件冒充目录 → state / inbox 写必失败
const logB = join(dirB, 'hooks.jsonl');
appendFileSync(logB, JSON.stringify({ kind: 'tool', tool: 'edit', ok: false, message: 'x' }) + '\n', 'utf8');
const ctxB = {
  on() { return () => {}; },
  effect() { return () => {}; },
  interval() { return () => {}; },
  systemPrompt: { context() { return () => {}; } }
};
apply(ctxB, { log: logB, stateFile: join(blocker, 'state.json'), inboxFile: join(blocker, 'inbox.jsonl'), akashaDir: dirB, minIntervalHours: 6, timerCheckMs: 3600000, contextOrder: 130, pulseOrder: 132 });
const logBText = readFileSync(logB, 'utf8');
assert.ok(logBText.includes('"kind":"sleep-state-error"'), '状态写失败 → sleep-state-error 落线');
assert.ok(logBText.includes('"kind":"sleep-inbox-error"'), 'inbox 写失败（待办不丢得无声无息）→ sleep-inbox-error 落线');
rmSync(dirB, { recursive: true, force: true });

// —— 8. 无核心降级（v1.4 切分）：apply 不炸 + sleep-error 留痕 + 条子提示 ——
const dirC = mkdtempSync(join(scratchRoot, 'akasha-sleep-c-'));
cleanupDirs.push(dirC);
const logC = join(dirC, 'hooks.jsonl');
const contextsC = [];
const ctxC = {
  on() { return () => {}; },
  effect() { return () => {}; },
  interval() { return () => {}; },
  systemPrompt: { context(c) { contextsC.push(c); return () => {}; } }
};
let threwC = null;
try { apply(ctxC, { log: logC, stateFile: join(dirC, 'state.json'), inboxFile: join(dirC, 'inbox.jsonl'), akashaDir: dirC, minIntervalHours: 6, timerCheckMs: 3600000, contextOrder: 130, pulseOrder: 132 }); }
catch (e) { threwC = e; }
assert.equal(threwC, null, '无核心时 apply 不得抛');
const logCText = existsSync(logC) ? readFileSync(logC, 'utf8') : '';
assert.ok(logCText.includes('"kind":"sleep-error"'), '无核心 → sleep-error 留痕');
const sleepLineC = contextsC.find((c) => c.name === 'akasha:sleep').text();
assert.ok(String(sleepLineC).includes('核心库不可用'), sleepLineC);
rmSync(dirC, { recursive: true, force: true });

// —— STORE 审计边界用例：malformed / 回滚（rollback）语义 / 并发节流 ——
{
  const { isWakeNoteworthy, buildWakeNote } = await import('./lib/index.js');
  assert.doesNotThrow(() => isWakeNoteworthy({}), 'malformed：空状态对象不得抛');
  assert.equal(typeof buildWakeNote({ library: { canon: 0, mirror: 0, orphan: 0, pricing: 0, lexicon: 0, frontier: 0 } }), 'string', 'malformed 输入仍产出字符串（不抛、不静默吞）');
  // 回滚（rollback）语义：核心库不可用（上面 dirC 场景）→ 不得落地任何状态，水位线不得推进
  assert.ok(!existsSync(join(dirC, 'logs', 'sleep-state.json')), '回滚：核心库不可用 → sleep-state.json 不得存在（失败不推进水位线）');
}

// —— 契约测试：本地构造的唤醒条消息 **与宿主逐字段比对**（守住"删掉动态加载"后的上游漂移）——
{
  const { createUserMessage, deepFreeze } = await import('./lib/index.js');
  const sample = { content: [{ type: 'text', text: 'x' }], source: { kind: 'akasha-wake' } };
  const mine = createUserMessage(structuredClone(sample));
  assert.equal(mine.role, 'user', '本地构造：role=user');
  assert.equal(typeof mine.id, 'string', '本地构造：id 为字符串');
  assert.ok(Object.isFrozen(mine), '本地构造：顶层冻结');
  assert.ok(Object.isFrozen(mine.content), '本地构造：嵌套冻结');
  assert.ok(deepFreeze({ a: { b: 1 } }).a && Object.isFrozen(deepFreeze({ a: { b: 1 } }).a), 'deepFreeze 递归');

  const hostModules = process.env.AKASHA_DSH_MODULES ?? '';
  const hostPath = join(hostModules, '@deepseek-ai', 'dsh-llm', 'lib', 'index.js');
  if (existsSync(hostPath)) {
    const { pathToFileURL } = await import('node:url');
    const { createUserMessage: hostCreateUserMessage } = await import(pathToFileURL(hostPath).href);
    const theirs = hostCreateUserMessage(structuredClone(sample));
    assert.deepEqual(Object.keys(mine).sort(), Object.keys(theirs).sort(), '键集合与宿主一致');
    assert.equal(mine.role, theirs.role, 'role 与宿主一致');
    assert.equal(typeof mine.id, typeof theirs.id, 'id 类型与宿主一致');
    assert.deepEqual(mine.content, theirs.content, '内容与宿主一致');
    assert.deepEqual(mine.source, theirs.source, 'source 与宿主一致');
    assert.equal(Object.isFrozen(mine), Object.isFrozen(theirs), '冻结语义与宿主一致');
  } else {
    console.log('SKIP 契约测试：未找到宿主 dsh-llm（可设 AKASHA_DSH_MODULES 指定应用模块目录）');
  }
}


// ---- S4（2026-10-13）：状态条尾读 —— 用插件导出的两个纯函数做回归（真库 + 合成边界）----
await (async () => {
  const { tailReadText, latestIntentGist } = await import('./lib/index.js');
  const oldWay = (text) => latestIntentGist(text.split('\n').slice(-200).join('\n'));
  // ① 真库（若存在）：旧口径（整读+slice(-200)）与新口径（尾窗）必须给出同一 gist
  const real = join(dir, '..', '..', 'akasha', 'data', 'session.jsonl');
  if (existsSync(real)) {
    const text = readFileSync(real, 'utf8');
    assert.equal(latestIntentGist(tailReadText(real).text), oldWay(text), '真库：尾读与整读的 gist 必须一致');
  }
  assert.equal(latestIntentGist(''), null, '空文本 → null（不抛）');
  // ② 合成边界：单行无换行 / 注入段在尾 / 窗口起点切在行中 / 很小文件
  const s4dir = mkdtempSync(join(tmpdir(), 'sleep-s4-'));
  const J = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  try {
    const f1 = join(s4dir, 'a.jsonl');
    writeFileSync(f1, J([{ kind: 'intent', gist: '<sys>注入' }, { kind: 'intent', gist: 'a'.repeat(900) }, { kind: 'intent', gist: '真 gist' }, { kind: 'process', id: 't' }]));
    assert.equal(latestIntentGist(tailReadText(f1).text), '真 gist', '注入段必须跳过');
    const f2 = join(s4dir, 'b.jsonl');
    writeFileSync(f2, JSON.stringify({ kind: 'intent', gist: '单行' }));
    assert.equal(latestIntentGist(tailReadText(f2).text), '单行', '无尾换行的单行文件');
    const big = [];
    for (let i = 0; i < 400; i += 1) big.push({ kind: 'process', id: 'x' + i, pad: '字'.repeat(400) });
    big.push({ kind: 'intent', gist: '半行边界后的 gist' });
    const f3 = join(s4dir, 'c.jsonl');
    writeFileSync(f3, J(big));
    assert.equal(latestIntentGist(tailReadText(f3).text), '半行边界后的 gist', '窗口起点切在行中也要正确');
  } finally { rmSync(s4dir, { recursive: true, force: true }); }
})();
// —— 终末清理 ——
rmSync(dir, { recursive: true, force: true });

// —— 行为层重挂（2026-10-13 深夜）：形态 B 判定 + 续行开关（**默认关**；旧测试组按裁定删除的继任者）——
{
  const { judgeIdleTurn, IDLE_RESUME_TEXT } = await import('./lib/index.js');
  // ① 纯函数：三形态 + 两信号
  assert.deepEqual(judgeIdleTurn({ hasText: false, toolCalls: 0, tail: '想完了。好。' }), { shape: 'B', signal: 'hao', stall: true });
  assert.equal(judgeIdleTurn({ hasText: false, toolCalls: 3, tail: '好。' }).shape, 'A', '无正文+有工具＝形态 A（正常中间步骤，绝不报）');
  assert.equal(judgeIdleTurn({ hasText: true, toolCalls: 0, tail: '好。' }).shape, 'normal');
  assert.equal(judgeIdleTurn({ hasText: false, toolCalls: 0, tail: '没想完' }).signal, null);
  assert.equal(judgeIdleTurn({ hasText: false, toolCalls: 0, tail: '先这样。' }).signal, 'o', '弱信号＝尾部句号');
  assert.ok(String(IDLE_RESUME_TEXT).includes('禁止列清单') && String(IDLE_RESUME_TEXT).includes('禁止打勾') && String(IDLE_RESUME_TEXT).includes('禁止以「。」收尾'), '注入文案须含 §⑥ 三禁：' + IDLE_RESUME_TEXT);

  const idleRoot = mkdtempSync(join(tmpdir(), 'sleep-idle-'));
  cleanupDirs.push(idleRoot);
  seedCore(idleRoot);
  const mkCtx = () => {
    const handlers = {};
    return {
      handlers,
      ctx: { on(n, f) { (handlers[n] = handlers[n] || []).push(f); return () => {}; }, effect() { return () => {}; }, interval() { return () => {}; }, systemPrompt: { context: () => () => {} } }
    };
  };
  const applyFor = (sid, extra) => {
    const { handlers, ctx } = mkCtx();
    const injected = [];
    const logPath2 = join(idleRoot, `hooks-${sid}.jsonl`);
    apply(ctx, { log: logPath2, stateFile: join(idleRoot, `s-${sid}.json`), inboxFile: join(idleRoot, `i-${sid}.jsonl`), akashaDir: idleRoot, minIntervalHours: 6, ...extra });
    return { handlers, logPath: logPath2, injected };
  };
  const mkAgent2 = (sid, header = {}, sink) => ({ id: sid, session: { id: sid, header }, inject: (m) => sink.push(m) });
  // 帧序列按旧包实证链路驱动：start（建状态）→ chunk（累积）→ end（判定 + 注入）
  const send = (handlers, agent, frames) => { for (const fr of frames) for (const h of handlers['agent/assistant-stream']) h({ agent, frame: fr }); };
  const attempt = (id, chunks, turn = 1) => [{ type: 'start', attemptId: id, turn }, ...chunks.map((c) => ({ type: 'chunk', attemptId: id, chunk: c })), { type: 'end', attemptId: id, turn }];
  const readLines2 = (f) => readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

  // ② 默认关：B + 好。 ⇒ 只落观测线、不注入
  const OFF = applyFor('sess-off', { idleResume: false });
  const agentOff = mkAgent2('sess-off', {}, OFF.injected);
  send(OFF.handlers, agentOff, attempt('a1', [{ type: 'reasoning-delta', text: '想完了。好。' }], 7));
  assert.equal(OFF.injected.length, 0, '默认关不得注入');
  assert.ok(readLines2(OFF.logPath).some((x) => x.kind === 'idle-shape' && x.shape === 'B' && x.signal === 'hao' && x.turn === 7), '默认关也须落观测线：' + JSON.stringify(readLines2(OFF.logPath).map((x) => x.kind)));

  // ③ 开闸：B + 好。 ⇒ 注入（带 source 标记；限次 3）
  const ON = applyFor('sess-on', { idleResume: true, idleResumeCooldownMs: 0, idleResumeMax: 3 });
  const agentOn = mkAgent2('sess-on', {}, ON.injected);
  for (let i = 0; i < 5; i += 1) send(ON.handlers, agentOn, attempt('b' + i, [{ type: 'reasoning-delta', text: '好。' }], 10 + i));
  assert.equal(ON.injected.length, 3, '单会话限次＝3（防扰动循环）：' + ON.injected.length);
  assert.equal(ON.injected[0].source.kind, 'akasha-idle-resume', '注入消息须带 source 标记');
  assert.equal(ON.injected[0].role, 'user', '注入消息为 user 角色');
  assert.equal(readLines2(ON.logPath).filter((x) => x.kind === 'idle-resume').length, 3, '每次续行留痕');

  // ④ 形态 A / 有正文 / 子代理 / 空流：绝不注入
  const SKIP = applyFor('sess-skip', { idleResume: true, idleResumeCooldownMs: 0 });
  const agentA = mkAgent2('sess-skip', {}, SKIP.injected);
  send(SKIP.handlers, agentA, attempt('c1', [{ type: 'tool-call-delta', name: 'read' }, { type: 'reasoning-delta', text: '好。' }]));   // A 形态
  send(SKIP.handlers, agentA, attempt('c2', [{ type: 'text-delta', text: '正文' }]));                                                   // 有正文
  send(SKIP.handlers, agentA, attempt('c3', []));                                                                                       // 空流（无信号）
  const agentSub = mkAgent2('sess-sub', { origin: 'subagent' }, SKIP.injected);
  send(SKIP.handlers, agentSub, attempt('c4', [{ type: 'reasoning-delta', text: '好。' }]));                                             // 子代理
  send(SKIP.handlers, agentA, [{ type: 'end', attemptId: 'ghost' }]);                                                                   // 无状态 end：不得抛
  assert.equal(SKIP.injected.length, 0, 'A 形态 / 有正文 / 空流 / 子代理均不得注入');
  const shapeLines = readLines2(SKIP.logPath).filter((x) => x.kind === 'idle-shape');
  assert.equal(shapeLines.length, 2, '只有 A 与 空B 两条观测线（有正文＝normal 不落线）：' + JSON.stringify(shapeLines.map((x) => x.shape + '/' + x.signal)));
  assert.ok(shapeLines.some((x) => x.shape === 'A'), 'A 形态须留痕但不动作');
  rmSync(idleRoot, { recursive: true, force: true });
}

// —— 占位符守卫（2026-10-19 发布面 P0）：照抄 OSS 的 `<AKASHA_DIR>` 字面量必须**明确抛错**，不得静默降级 ——
assert.equal(findPlaceholders({ akashaDir: '<AKASHA_DIR>' }).length, 1, '占位符必须被识别');
assert.equal(findPlaceholders({ akashaDir: CORE }).length, 0, '正常路径不得误报');
assert.throws(() => assertNoPlaceholders({ stateFile: '<AKASHA_DIR>/logs/sleep-state.json' }), /未替换的占位符/, '占位符配置必须抛错');
assert.throws(() => apply({}, { akashaDir: '<AKASHA_DIR>' }), /占位符/, 'apply 阶段必须 fail closed');

console.log('selftest: all assertions passed');
