// @akasha-book/session 自检 —— 桩 ctx 端到端（临时目录，不碰真库）。运行：node selftest.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CORE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'core');   // 2026-10-11 修：原为 '../..', 'core' ⇒ 解析成 H:\core（不存在）⇒ 12 条用例全挂的下游根因
const SCRATCH = join(tmpdir(), 'akasha-session-selftest');
mkdirSync(SCRATCH, { recursive: true });
// 清残：失败路径可能留下的临时目录（成功路径自清）
try { for (const d of readdirSync(SCRATCH)) if (d.startsWith('akasha-sesplug-')) rmSync(join(SCRATCH, d), { recursive: true, force: true }); } catch { /* 静默 */ }

let passed = 0; const failures = []; const skipped = [];
// 2026-10-17：这个 `t()` 原来是**同步包装**——async 用例体不被 await ⇒ 断言还没跑就先记 PASS
//   （和核心 test.mjs 以前那个假绿同一类；是写 N4 异步用例时当场撞见的）。
//   改为：async 体压进 pending，落定后才 PASS/FAIL，收尾统一 await。
const pendingT = [];
function t(name, fn) {
  let r;
  try { r = fn(); }
  catch (e) { failures.push([name, e]); console.log('FAIL', name, '—', e && e.message); return; }
  if (r && typeof r.then === 'function') {
    pendingT.push(Promise.resolve(r).then(
      () => { passed++; console.log('PASS', name); },
      (e) => { failures.push([name, e]); console.log('FAIL', name, '—', e && e.message); }
    ));
    return;
  }
  passed++; console.log('PASS', name);
}
// zstd 自 Node v23.8.0 / v22.15.0 起可用；旧 Node 上依赖 zstd 的用例记 SKIP（显式留痕，不伪装成通过）。
// （2026-10 wave1：合并批丢了这层，Node 20 上 4 项 FAIL；与核心 test.mjs 的 tz 口径对齐。）
const zlibNs = await import('node:zlib');
const HAS_ZSTD = typeof zlibNs.zstdCompressSync === 'function';
function tz(name, fn) {
  if (HAS_ZSTD) return t(name, fn);
  skipped.push(name); console.log('SKIP', name, `— Node ${process.version} 无 zstd`);
}

// v0.4：worker 路径是异步的——给用例提供 async + 轮询等待能力。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function ta(name, fn) {
  await loadFresh();   // 每个用例前重载模块（清掉跨用例状态）
  try { await fn(); passed++; console.log('PASS', name); }
  catch (e) { failures.push([name, e]); console.log('FAIL', name, '—', e.message); }
}
/** 依赖 zstd 的异步用例：Node 20 等无 zstd 时 SKIP（与 tz 同口径；4ab8856 worker 用例曾漏掉）。 */
async function tza(name, fn) {
  // 注：走 ta ⇒ 自带 loadFresh 重载
  if (HAS_ZSTD) return ta(name, fn);
  skipped.push(name); console.log('SKIP', name, `— Node ${process.version} 无 zstd`);
}
async function waitFor(pred, { timeoutMs = 20000, stepMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = pred();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('waitFor 超时：' + timeoutMs + 'ms');
    await sleep(stepMs);
  }
}

let mod = null;
// 2026-10-11 修：模块级状态会跨用例污染（worker 模式 / 节流时间戳 / workerFails）⇒ 每个用例前**重载模块**。
//   证据：同一 fixture 单独跑（probe-session-index.mjs）完全正常 ⇒ 缺陷在测试隔离，不在插件。
let __loadN = 0;
const loadFresh = async () => { mod = await import('./lib/index.js?fresh=' + (++__loadN)); return mod; };
try { await loadFresh(); }
catch (e) { failures.push(['import lib/index.js', e]); console.log('FAIL import lib/index.js —', e.message); }

function makeCtx() {
  const handlers = {}; const contexts = []; const disposers = [];
  return {
    handlers, contexts, disposers,
    ctx: {
      on: (name, fn) => { (handlers[name] ??= []).push(fn); },
      systemPrompt: { context: (o) => { contexts.push(o); } },
      effect: (fn) => { try { const d = fn(); if (typeof d === 'function') disposers.push(d); } catch { /* stub */ } },
      interval: undefined
    }
  };
}
const readLines = (log) => readFileSync(log, 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));

if (mod) {
  t('骨架：apply 落 session-armed 线（pid + 节流配置）', () => {
    const dir = mkdtempSync(join(SCRATCH, 'akasha-sesplug-'));
    const { ctx } = makeCtx();
    mod.apply(ctx, { akashaDir: CORE, log: join(dir, 'hooks.jsonl'), sessionsRoot: join(dir, 'sessions'), metaFile: join(dir, 'meta.json'), minIndexIntervalMs: 30000 });
    const lines = readLines(join(dir, 'hooks.jsonl'));
    const armed = lines.find((l) => l.kind === 'session-armed');
    assert.ok(armed, 'apply 应落 session-armed 线：' + JSON.stringify(lines.map((l) => l.kind)));
    assert.equal(armed.pid, process.pid);
    assert.equal(armed.minIndexIntervalMs, 30000);
    assert.ok(armed.timerCheckMs > 0);
    assert.ok(lines.some((l) => l.kind === 'session-worker' && l.event === 'spawn'), 'v0.4 默认应预热 worker（spawn 线）');
    rmSync(dir, { recursive: true, force: true });
  });
  t('骨架：挂 1 条 context 行（akasha:session，order 134）；无数据静默 null', () => {
    const dir = mkdtempSync(join(SCRATCH, 'akasha-sesplug-'));
    const { ctx, contexts } = makeCtx();
    mod.apply(ctx, { akashaDir: CORE, log: join(dir, 'hooks.jsonl'), sessionsRoot: join(dir, 'sessions'), metaFile: join(dir, 'meta.json') });
    assert.equal(contexts.length, 1);
    assert.equal(contexts[0].name, 'akasha:session');
    assert.equal(contexts[0].order, 134);
    assert.equal(contexts[0].text(), '', '空库应静默');
    rmSync(dir, { recursive: true, force: true });
  });
  t('配置：占位符 <AKASHA_DIR> 必须 fail closed（照抄 OSS 配置不得静默降级）', () => {
    assert.equal(mod.findPlaceholders({ akashaDir: '<AKASHA_DIR>' }).length, 1, '占位符必须被识别');
    assert.equal(mod.findPlaceholders({ akashaDir: CORE }).length, 0, '正常路径不得误报');
    assert.throws(() => mod.assertNoPlaceholders({ storeFile: '<AKASHA_DIR>/data/session.jsonl' }), /未替换的占位符/, '占位符配置必须抛错');
    const { ctx } = makeCtx();
    assert.throws(() => mod.apply(ctx, { akashaDir: '<AKASHA_DIR>' }), /占位符/, 'apply 阶段必须 fail closed');
  });
  t('纯函数：shouldIndex 去抖', () => {
    assert.equal(mod.shouldIndex(0, 1000, 30000), true);
    assert.equal(mod.shouldIndex(1000, 2000, 30000), false);
    assert.equal(mod.shouldIndex(1000, 31001, 30000), true);
  });
  const { zstdCompressSync } = zlibNs;
  const { appendFileSync, writeFileSync } = await import('node:fs');
  tz('索引：turn/end → 增量索引（fixture）；去抖 skip；幂等 0 增', () => {
    const dir = mkdtempSync(join(SCRATCH, 'akasha-sesplug-'));
    const log = join(dir, 'hooks.jsonl');
    const sessionsRoot = join(dir, 'sessions');
    const sDir = join(sessionsRoot, '--W--', 'session-abc12345');
    mkdirSync(sDir, { recursive: true });
    const mk = (seqs) => Buffer.from(seqs.map((seq) => JSON.stringify({ seq, time: 1791312000000 + seq * 1000, type: 'user/message', data: { content: [{ type: 'text', text: '第' + seq + '条' }] } })).join('\n') + '\n');
    const fx = join(sDir, 'session.v4.jsonl.zstd');
    writeFileSync(fx, zstdCompressSync(mk([1, 2])));
    const { ctx, handlers } = makeCtx();
    mod.apply(ctx, { akashaDir: CORE, log, sessionsRoot, metaFile: join(dir, 'meta.json'), storeFile: join(dir, 'store.jsonl'), minIndexIntervalMs: 30000, indexMode: 'inline' });
    const fire = (h) => (h['session/event'] ?? []).forEach((fn) => fn({ id: 'abc12345' }, { type: 'turn/end', data: { turn: 1 } }));
    fire(handlers);
    let idx = readLines(log).filter((l) => l.kind === 'session-index');
    assert.equal(idx.length, 1, JSON.stringify(readLines(log)));
    assert.ok(typeof idx[0].lagMs === 'number', '索引线应含事件循环延迟采样 lagMs：' + JSON.stringify(idx[0]));
    assert.equal(idx[0].added, 2);
    assert.equal(idx[0].session, 'abc12345');
    assert.equal(idx[0].frameFails, 0, '观测线应带 frameFails');
    assert.equal(idx[0].turn, 1, '观测线应带 turn');
    const metaObj = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
    assert.ok(Number.isInteger(metaObj.sessions.abc12345.conclusions), 'meta 应记结论数：' + JSON.stringify(metaObj.sessions.abc12345));
    fire(handlers);
    assert.equal(readLines(log).filter((l) => l.kind === 'session-index-skip').length, 1, '去抖应 skip');
    appendFileSync(fx, zstdCompressSync(mk([3])));
    const { ctx: ctx2, handlers: h2 } = makeCtx();
    const log2 = join(dir, 'hooks2.jsonl');
    mod.apply(ctx2, { akashaDir: CORE, log: log2, sessionsRoot, metaFile: join(dir, 'meta.json'), storeFile: join(dir, 'store.jsonl'), minIndexIntervalMs: 0, indexMode: 'inline' });
    fire(h2);
    appendFileSync(fx, zstdCompressSync(mk([3]))); // 同内容再落一帧：档案变了（过 stat 快路）但无新 seq
    fire(h2);
    const idx2 = readLines(log2).filter((l) => l.kind === 'session-index');
    assert.equal(idx2[0].added, 1, '增量只收新帧：' + JSON.stringify(idx2));
    assert.equal(idx2[1].added, 0, '重复内容再触发幂等（水位 + 去重）');
    rmSync(dir, { recursive: true, force: true });
  });
  t('索引：档案缺失（resolveSessionFile 未命中）→ session-index-error + 背压（窗口内不重报）', () => {
    const dir = mkdtempSync(join(SCRATCH, 'akasha-sesplug-'));
    const { ctx, handlers } = makeCtx();
    mod.apply(ctx, { akashaDir: CORE, log: join(dir, 'hooks.jsonl'), sessionsRoot: join(dir, 'sessions'), metaFile: join(dir, 'meta.json'), storeFile: join(dir, 'store.jsonl'), minIndexIntervalMs: 0 });
    const fire = () => (handlers['session/event'] ?? []).forEach((fn) => fn({ id: 'missing1' }, { type: 'turn/end', data: { turn: 1 } }));
    fire();
    fire();
    const lines = readLines(join(dir, 'hooks.jsonl'));
    assert.ok(lines.some((l) => l.kind === 'session-index-error' && String(l.message).includes('未找到')), JSON.stringify(lines));
    assert.equal(lines.filter((l) => l.kind === 'session-index-error').length, 1, '未命中应走背压（窗口内不重复报错）：' + JSON.stringify(lines));
    rmSync(dir, { recursive: true, force: true });
  });
  t('降级：核心库缺失 → session-index-error + 统一失败背压（窗口内不重报）', () => {
    const dir = mkdtempSync(join(SCRATCH, 'akasha-sesplug-'));
    const { ctx, handlers } = makeCtx();
    mod.apply(ctx, { akashaDir: CORE, log: join(dir, 'hooks.jsonl'), akashaDir: join(dir, 'empty'), sessionsRoot: join(dir, 'sessions'), metaFile: join(dir, 'meta.json'), storeFile: join(dir, 'store.jsonl'), minIndexIntervalMs: 0 });
    const fire = () => (handlers['session/event'] ?? []).forEach((fn) => fn({ id: 'x1' }, { type: 'turn/end', data: { turn: 1 } }));
    fire();
    fire();
    const lines = readLines(join(dir, 'hooks.jsonl'));
    assert.ok(lines.some((l) => l.kind === 'session-index-error'), JSON.stringify(lines));
    assert.equal(lines.filter((l) => l.kind === 'session-index-error').length, 1, '统一背压（失败窗口内静默）：' + JSON.stringify(lines));
    rmSync(dir, { recursive: true, force: true });
  });
  t('注入：压缩事件（compaction/end 真值）→ session-compact 线 + 节奏条点名；失败压缩不记', () => {
    const dir = mkdtempSync(join(SCRATCH, 'akasha-sesplug-'));
    const log = join(dir, 'hooks.jsonl');
    const meta = join(dir, 'meta.json');
    writeFileSync(meta, JSON.stringify({ version: 1, sessions: { abc12345: { lastSeq: 5, segments: 3, indexedAt: '2026-10-07T00:00:00.000Z', source: 'x' }, def67890: { lastSeq: 9, segments: 7, indexedAt: '2026-10-07T01:00:00.000Z', source: 'y' } } }));
    const { ctx, handlers, contexts } = makeCtx();
    mod.apply(ctx, { akashaDir: CORE, log, sessionsRoot: join(dir, 'sessions'), metaFile: meta, storeFile: join(dir, 'store.jsonl') });
    let line = contexts[0].text();
    assert.ok(line && line.includes('10 段') && line.includes('2 会话'), String(line));
    assert.ok(line.includes('session lookup'), String(line));
    assert.ok(!line.includes('压缩'), '无压缩窗口不应点名：' + line);
    const fire = (session, event) => (handlers['session/event'] ?? []).forEach((fn) => fn(session, event));
    // 2026-10-07 复查：压缩真信号＝session 事件 compaction/end（agent/created 的 source 只有 startup/resume，没有 compact）
    fire({ id: 'abc12345' }, { type: 'compaction/end', data: { turn: 9 } });
    // 本夹具无会话档案 → 压缩后补索引必失败：观测线如实记 indexed:false，且先尝试索引再记压缩（顺序断言）
    const after = readLines(log);
    const ci = after.findIndex((l) => l.kind === 'session-compact' && l.session === 'abc12345');
    const ei = after.findIndex((l) => l.kind === 'session-index-error' && l.session === 'abc12345' && l.trigger === 'compaction');
    assert.ok(ci >= 0 && after[ci].indexedFirst === true, JSON.stringify(after));
    assert.equal(after[ci].indexed, false, '档案缺失 → indexed:false：' + JSON.stringify(after[ci]));
    assert.equal(after[ci].reason, 'not-found');
    assert.ok(ei >= 0 && ei < ci, '先补索引、后记压缩：' + JSON.stringify(after));
    fire({ id: 'def67890' }, { type: 'compaction/end', data: { turn: 9, error: 'boom' } });
    assert.equal(readLines(log).filter((l) => l.kind === 'session-compact').length, 1, '失败压缩不记：' + JSON.stringify(readLines(log).filter((l) => l.kind === 'session-compact')));
    line = contexts[0].text();
    assert.ok(line.includes('压缩'), String(line));
    assert.ok(line.includes('session lookup'), String(line));
    // B1：补索引失败 → 节奏条绝不能说「已收入」，要给回退路径
    assert.ok(!line.includes('已收入'), 'B1：补索引失败不得宣称已收入：' + line);
    assert.ok(line.includes('可能未进会话层') && line.includes('未找到会话档案') && line.includes('session index'), line);
    rmSync(dir, { recursive: true, force: true });
  });
  t('注入：无数据 / 坏 meta 两态都静默（null）', () => {
    const dir = mkdtempSync(join(SCRATCH, 'akasha-sesplug-'));
    const { ctx, contexts } = makeCtx();
    mod.apply(ctx, { akashaDir: CORE, log: join(dir, 'hooks.jsonl'), sessionsRoot: join(dir, 'sessions'), metaFile: join(dir, 'missing.json'), storeFile: join(dir, 'store.jsonl') });
    assert.equal(contexts[0].text(), '');
    writeFileSync(join(dir, 'meta2.json'), '{bad json');
    const { ctx: c2, contexts: k2 } = makeCtx();
    mod.apply(c2, { log: join(dir, 'h2.jsonl'), sessionsRoot: join(dir, 'sessions'), metaFile: join(dir, 'meta2.json'), storeFile: join(dir, 'store.jsonl') });
    assert.equal(k2[0].text(), '');
    rmSync(dir, { recursive: true, force: true });
  });
  t('接缝：inject 声明覆盖 apply 触碰的服务（systemPrompt / timer）', () => {
    assert.ok(Array.isArray(mod.inject), '应导出 inject 数组');
    assert.ok(mod.inject.includes('systemPrompt'), '缺 systemPrompt → 真宿主激活必抛：' + JSON.stringify(mod.inject));
    assert.ok(mod.inject.includes('timer'), JSON.stringify(mod.inject));
  });
  t('注入：压缩点名含「已收入 + 段/结论数 + 工具名」；renderSessionLine 边界', () => {
    const line = mod.renderSessionLine({ meta: { sessions: { a: { segments: 3, conclusions: 2 } } }, compacts: [{ session: 'a', ts: Date.now(), indexed: true }] }, Date.now());
    assert.ok(line.includes('已收入'), line);
    assert.ok(line.includes('3 段') && line.includes('结论 2 条'), line);
    assert.ok(line.includes('akasha_session_lookup'), line);
    assert.equal(mod.renderSessionLine({ meta: { sessions: { a: { segments: 0 } } }, compacts: [] }, 0), null, '全零段静默');
    const line2 = mod.renderSessionLine({ meta: { sessions: { a: { segments: 1 } } }, compacts: [{ ts: 'bad' }, null] }, Date.now());
    assert.ok(line2 && !line2.includes('压缩'), '坏 compacts 条目不进窗口：' + line2);
  });
  t('B1：renderSessionLine 只在 indexed===true 时说「已收入」（失败 / 未确认 / 旧格式都不说）', () => {
    const meta = { sessions: { a: { segments: 3, conclusions: 2 } } };
    const now = Date.now();
    const fail = mod.renderSessionLine({ meta, compacts: [{ session: 'a', ts: now, indexed: false, reason: 'error' }] }, now);
    assert.ok(!fail.includes('已收入') && fail.includes('索引出错') && fail.includes('可能未进会话层'), fail);
    const legacy = mod.renderSessionLine({ meta, compacts: [{ session: 'a', ts: now }] }, now);
    assert.ok(!legacy.includes('已收入') && legacy.includes('补索引未确认'), '无 indexed 字段＝未确认：' + legacy);
    const mixed = mod.renderSessionLine({ meta, compacts: [{ session: 'a', ts: now - 1000, indexed: true }, { session: 'a', ts: now, indexed: false, reason: 'not-found' }] }, now);
    assert.ok(!mixed.includes('已收入'), '以最近一次压缩为准：' + mixed);
  });
  tz('B1：压缩后补索引成功 → indexed:true + 已收入；失败后被下一次索引追平 → 改口已收入', () => {
    const dir = mkdtempSync(join(SCRATCH, 'akasha-sesplug-'));
    const log = join(dir, 'hooks.jsonl');
    const sessionsRoot = join(dir, 'sessions');
    const mk = (seqs) => Buffer.from(seqs.map((seq) => JSON.stringify({ seq, time: 1791312000000 + seq * 1000, type: 'user/message', data: { content: [{ type: 'text', text: '中性夹具第' + seq + '条' }] } })).join('\n') + '\n');
    const sDir = join(sessionsRoot, '--W--', 'session-cmp00001');
    mkdirSync(sDir, { recursive: true });
    writeFileSync(join(sDir, 'session.v4.jsonl.zstd'), zstdCompressSync(mk([1, 2])));
    const { ctx, handlers, contexts } = makeCtx();
    // 去抖 30s：刚 turn/end 索引过，压缩仍须 force 补一次（不得被去抖吞掉而又宣称已收入）
    mod.apply(ctx, { akashaDir: CORE, log, sessionsRoot, metaFile: join(dir, 'meta.json'), storeFile: join(dir, 'store.jsonl'), minIndexIntervalMs: 30000, indexMode: 'inline' });
    const fire = (sid, event) => (handlers['session/event'] ?? []).forEach((fn) => fn({ id: sid }, event));
    fire('cmp00001', { type: 'turn/end', data: { turn: 1 } });
    appendFileSync(join(sDir, 'session.v4.jsonl.zstd'), zstdCompressSync(mk([3])));
    fire('cmp00001', { type: 'compaction/end', data: { turn: 2 } });
    let lines = readLines(log);
    const comp = lines.find((l) => l.kind === 'session-compact');
    assert.equal(comp.indexed, true, JSON.stringify(lines));
    const idx = lines.filter((l) => l.kind === 'session-index');
    assert.equal(idx.length, 2, '压缩路径绕过去抖真跑一次：' + JSON.stringify(lines));
    assert.equal(idx[1].trigger, 'compaction');
    assert.equal(idx[1].added, 1);
    assert.ok(lines.indexOf(idx[1]) < lines.indexOf(comp), '先索引后记压缩');
    let line = contexts[0].text();
    assert.ok(line.includes('已收入'), line);
    // 失败 → 追平：另一会话先压缩（档案尚未落盘）→ 未收入；档案出现后 turn/end 索引成功 → 改口
    fire('cmp00002', { type: 'compaction/end', data: { turn: 1 } });
    line = contexts[0].text();
    assert.ok(!line.includes('已收入') && line.includes('可能未进会话层'), line);
    const sDir2 = join(sessionsRoot, '--W--', 'session-cmp00002');
    mkdirSync(sDir2, { recursive: true });
    writeFileSync(join(sDir2, 'session.v4.jsonl.zstd'), zstdCompressSync(mk([1])));
    fire('cmp00002', { type: 'compaction/end', data: { turn: 2 } }); // force 绕过 not-found 背压
    lines = readLines(log).filter((l) => l.kind === 'session-compact' && l.session === 'cmp00002');
    assert.deepEqual(lines.map((l) => l.indexed), [false, true], JSON.stringify(lines));
    line = contexts[0].text();
    assert.ok(line.includes('已收入') && line.includes('3 次'), line);
    rmSync(dir, { recursive: true, force: true });
  });
  tz('索引：档案未变 → stat 快路跳过；effectiveThrottle 自适应', () => {
    assert.equal(mod.effectiveThrottle(1024, 30000), 30000);
    assert.equal(mod.effectiveThrottle(20 * 1024 * 1024, 30000), 120000);
    const dir = mkdtempSync(join(SCRATCH, 'akasha-sesplug-'));
    const log = join(dir, 'hooks.jsonl');
    const sessionsRoot = join(dir, 'sessions');
    const sDir = join(sessionsRoot, '--W--', 'session-abc12345');
    mkdirSync(sDir, { recursive: true });
    const mk = (seqs) => Buffer.from(seqs.map((seq) => JSON.stringify({ seq, time: 1791312000000 + seq * 1000, type: 'user/message', data: { content: [{ type: 'text', text: '第' + seq + '条' }] } })).join('\n') + '\n');
    writeFileSync(join(sDir, 'session.v4.jsonl.zstd'), zstdCompressSync(mk([1])));
    const { ctx, handlers } = makeCtx();
    mod.apply(ctx, { akashaDir: CORE, log, sessionsRoot, metaFile: join(dir, 'meta.json'), storeFile: join(dir, 'store.jsonl'), minIndexIntervalMs: 0, indexMode: 'inline' });
    const fire = () => (handlers['session/event'] ?? []).forEach((fn) => fn({ id: 'abc12345' }, { type: 'turn/end', data: { turn: 1 } }));
    fire();
    fire();
    const idx = readLines(log).filter((l) => l.kind === 'session-index');
    const skips = readLines(log).filter((l) => l.kind === 'session-index-skip');
    assert.equal(idx.length, 1, JSON.stringify(readLines(log)));
    assert.equal(idx[0].added, 1);
    assert.ok(skips.some((s) => s.reason === 'unchanged'), JSON.stringify(skips));
    rmSync(dir, { recursive: true, force: true });
  });
  tz('索引：失败后不停滞（不快路跳过；统一背压限定重报）', () => {
    const dir = mkdtempSync(join(SCRATCH, 'akasha-sesplug-'));
    const log = join(dir, 'hooks.jsonl');
    const sessionsRoot = join(dir, 'sessions');
    const sDir = join(sessionsRoot, '--W--', 'session-abc12345');
    mkdirSync(sDir, { recursive: true });
    const mk = (seqs) => Buffer.from(seqs.map((seq) => JSON.stringify({ seq, time: 1791312000000 + seq * 1000, type: 'user/message', data: { content: [{ type: 'text', text: '第' + seq + '条' }] } })).join('\n') + '\n');
    writeFileSync(join(sDir, 'session.v4.jsonl.zstd'), zstdCompressSync(mk([1])));
    const { ctx, handlers } = makeCtx();
    // 2026-10-08 合并批：appendSegments 现已自动建父目录（真修复）——改用「store.jsonl 是目录」注入失败
    // （父目录存在、mkdir 救不了，追加必失败），保持「失败后不停滞」用例语义。
    mkdirSync(join(dir, 'store.jsonl'));
    mod.apply(ctx, { akashaDir: CORE, log, sessionsRoot, metaFile: join(dir, 'meta.json'), storeFile: join(dir, 'store.jsonl'), minIndexIntervalMs: 0, indexMode: 'inline' });
    const fire = () => (handlers['session/event'] ?? []).forEach((fn) => fn({ id: 'abc12345' }, { type: 'turn/end', data: { turn: 1 } }));
    fire();
    fire();
    const lines = readLines(log);
    assert.equal(lines.filter((l) => l.kind === 'session-index-error').length, 1, '统一背压：' + JSON.stringify(lines));
    assert.ok(!lines.some((l) => l.kind === 'session-index-skip' && l.reason === 'unchanged'), '失败不得被 unchanged 快路掩盖（stat 只记成功）：' + JSON.stringify(lines));
    rmSync(dir, { recursive: true, force: true });
  });
  tz('会话 id 完整保留（Q06：不剥前缀——两个合法 ID 可区分）', () => {
    const dir = mkdtempSync(join(SCRATCH, 'akasha-sesplug-'));
    const log = join(dir, 'hooks.jsonl');
    const sessionsRoot = join(dir, 'sessions');
    const sDir = join(sessionsRoot, '--W--', 'session-abc12345');
    mkdirSync(sDir, { recursive: true });
    const mk = (seqs) => Buffer.from(seqs.map((seq) => JSON.stringify({ seq, time: 1791312000000 + seq * 1000, type: 'user/message', data: { content: [{ type: 'text', text: '第' + seq + '条' }] } })).join('\n') + '\n');
    writeFileSync(join(sDir, 'session.v4.jsonl.zstd'), zstdCompressSync(mk([1])));
    const { ctx, handlers } = makeCtx();
    mod.apply(ctx, { akashaDir: CORE, log, sessionsRoot, metaFile: join(dir, 'meta.json'), storeFile: join(dir, 'store.jsonl'), minIndexIntervalMs: 0, indexMode: 'inline' });
    (handlers['session/event'] ?? []).forEach((fn) => fn({ id: 'session-abc12345' }, { type: 'turn/end', data: { turn: 1 } }));
    const idx = readLines(log).filter((l) => l.kind === 'session-index');
    assert.equal(idx.length, 1, JSON.stringify(readLines(log)));
    assert.equal(idx[0].session, 'session-abc12345', '台账记完整原始 ID（Q06）');
    assert.equal(idx[0].added, 1);
    rmSync(dir, { recursive: true, force: true });
  });
  t('循环观测：classifyChunk 四类 + shouldCheckStream 边界 + summarizeWatch 去重/截断', () => {
    assert.equal(mod.classifyChunk({ type: 'reasoning-delta', text: 'x' }).stream, 'reasoning');
    assert.equal(mod.classifyChunk({ type: 'text-delta', text: 'x' }).stream, 'text');
    assert.equal(mod.classifyChunk({ type: 'tool-call-delta', name: 'read' }).stream, 'tool');
    assert.equal(mod.classifyChunk({ type: 'usage' }), null);
    assert.equal(mod.shouldCheckStream(260, 0, 480, 200), false, '未到节流点');
    assert.equal(mod.shouldCheckStream(500, 0, 480, 200), true);
    assert.equal(mod.shouldCheckStream(500, 480, 480, 200), false);
    assert.equal(mod.shouldCheckStream(150, 0, 480, 200), false, '未到最小字符');
    const hitSet = new Set();
    const res = { exact: [{ count: 3, excerpt: 'x'.repeat(90) }], variant: [], punctRuns: [] };
    const s1 = mod.summarizeWatch(res, 'reasoning', 1234, hitSet);
    assert.ok(s1 && s1.hit.type === 'exact' && s1.hit.excerpt.length <= 60 && s1.atChars === 1234, JSON.stringify(s1));
    assert.equal(mod.summarizeWatch(res, 'reasoning', 1300, hitSet), null, '同类已报过 → 去重为 null');
  });
  t('循环观测：流环命中 → loop-watch（stream）；干跑（只写观测线）', () => {
    const dir = mkdtempSync(join(SCRATCH, 'akasha-sesplug-'));
    const log = join(dir, 'hooks.jsonl');
    const { ctx, handlers } = makeCtx();
    mod.apply(ctx, { akashaDir: CORE, log, sessionsRoot: join(dir, 'sessions'), metaFile: join(dir, 'meta.json'), storeFile: join(dir, 'store.jsonl'), loopWatch: true, watchMinChars: 10, watchCheckEvery: 20 });
    const fire = (chunk) => (handlers['session/event'] ?? []).forEach((fn) => fn({ id: 'wx1' }, { type: 'assistant/chunk', data: { turn: 1, step: 1, chunk } }));
    const seg = '这是一段用于测试的重复分析文本，反复重算同一件事。';
    for (let i = 0; i < 16; i += 1) fire({ type: 'reasoning-delta', index: 0, text: seg });
    const lines = readLines(log).filter((l) => l.kind === 'loop-watch');
    assert.ok(lines.length >= 1, '应记 loop-watch：' + JSON.stringify(readLines(log)));
    assert.equal(lines[0].phase, 'stream');
    assert.equal(lines.filter((l) => l.phase === 'stream').length, 1, '同 (turn, stream, type) 去重一次：' + JSON.stringify(lines));
    rmSync(dir, { recursive: true, force: true });
  });
  t('循环观测：turn 环（事件流缓存取数；turn-stopping 与 turn/end 双路径）', () => {
    const dir = mkdtempSync(join(SCRATCH, 'akasha-sesplug-'));
    const log = join(dir, 'hooks.jsonl');
    const { ctx, handlers } = makeCtx();
    mod.apply(ctx, { akashaDir: CORE, log, sessionsRoot: join(dir, 'sessions'), metaFile: join(dir, 'meta.json'), storeFile: join(dir, 'store.jsonl'), loopWatch: true });
    const rep = ('我们需要重新核对这个路径下的文件内容与之前分析保持一致。').repeat(6);
    const fire = (session, event) => (handlers['session/event'] ?? []).forEach((fn) => fn(session, event));
    // 2026-10-07 复查：官方 Session 无 .events 属性（同步读者已弃用，宿主改事件驱动）→ 缓存取自 session/event 事件流
    fire({ id: 't9' }, { type: 'assistant/message', data: { turn: 2, step: 1, message: { content: [{ type: 'reasoning', text: rep }, { type: 'text', text: '正常收尾。' }] } } });
    (handlers['agent/turn-stopping'] ?? []).forEach((fn) => fn({ agent: { id: 'ag1', session: { id: 't9' } }, turn: 2 }));
    let lines = readLines(log).filter((l) => l.kind === 'loop-watch' && l.phase === 'turn');
    assert.ok(lines.some((l) => l.stream === 'reasoning' && l.turn === 2), 'turn-stopping 路径应命中：' + JSON.stringify(readLines(log)).slice(0, 400));
    // 路径 B：turn/end 兜底（新回合，经缓存）
    fire({ id: 't9' }, { type: 'assistant/message', data: { turn: 3, step: 1, message: { content: [{ type: 'reasoning', text: rep }] } } });
    fire({ id: 't9' }, { type: 'turn/end', data: { turn: 3 } });
    lines = readLines(log).filter((l) => l.kind === 'loop-watch' && l.phase === 'turn');
    assert.ok(lines.some((l) => l.turn === 3), 'turn/end 兜底路径应命中：' + JSON.stringify(lines));
    rmSync(dir, { recursive: true, force: true });
  });
  t('循环观测：assistant-stream 帧（现役格式）→ loop-watch（stream）', () => {
    const dir = mkdtempSync(join(SCRATCH, 'akasha-sesplug-'));
    const log = join(dir, 'hooks.jsonl');
    const { ctx, handlers } = makeCtx();
    mod.apply(ctx, { akashaDir: CORE, log, sessionsRoot: join(dir, 'sessions'), metaFile: join(dir, 'meta.json'), storeFile: join(dir, 'store.jsonl'), loopWatch: true, watchMinChars: 10, watchCheckEvery: 20 });
    const fire = (frame) => (handlers['agent/assistant-stream'] ?? []).forEach((fn) => fn({ agent: { id: 'ag2', session: { id: 's9' } }, frame }));
    fire({ type: 'start', attemptId: 's9:1', turn: 5, step: 1 });
    const seg = '这是一段用于测试的重复分析文本，反复重算同一件事。';
    for (let i = 0; i < 16; i += 1) fire({ type: 'chunk', attemptId: 's9:1', index: i, chunk: { type: 'reasoning-delta', index: 0, text: seg } }); // 真实宿主 chunk 帧不带 turn/step（补齐靠 start 缓存）
    const lines = readLines(log).filter((l) => l.kind === 'loop-watch');
    assert.ok(lines.some((l) => l.phase === 'stream'), '应记 loop-watch（stream）：' + JSON.stringify(readLines(log)).slice(0, 400));
    assert.equal(lines[0].turn, 5, 'chunk 帧无 turn/step → 应从 start 帧缓存补全：' + JSON.stringify(lines[0]));
    assert.ok(readLines(log).some((l) => l.kind === 'loop-watch-probe' && String(l.type).includes('chunk')), '探针应记录帧/chunk 类型');
    rmSync(dir, { recursive: true, force: true });
  });
  t('循环观测：上下文长度代理 ctxChars（自上次压缩累计；压缩归零）——只记录不干预（2026-10-14 加）', () => {
    const dir = mkdtempSync(join(SCRATCH, 'akasha-sesplug-'));
    const log = join(dir, 'hooks.jsonl');
    const { ctx, handlers } = makeCtx();
    mod.apply(ctx, { akashaDir: CORE, log, sessionsRoot: join(dir, 'sessions'), metaFile: join(dir, 'meta.json'), storeFile: join(dir, 'store.jsonl'), loopWatch: true, watchMinChars: 10, watchCheckEvery: 20 });
    const fire = (frame) => (handlers['agent/assistant-stream'] ?? []).forEach((fn) => fn({ agent: { id: 'ag7', session: { id: 'c7' } }, frame }));
    fire({ type: 'start', attemptId: 'c7:1', turn: 1, step: 1 });
    fire({ type: 'chunk', attemptId: 'c7:1', index: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'abcd'.repeat(5) } }); // 20 字符
    // 探针在「处理该帧之前」记录 ⇒ 首个探针 ctxChars=0；再喂一帧新类型，其探针应已含前帧累计
    fire({ type: 'chunk', attemptId: 'c7:1', index: 0, chunk: { type: 'text-delta', index: 1, text: 'x'.repeat(5) } });         // +5 字符
    const p1 = readLines(log).filter((l) => l.kind === 'loop-watch-probe');
    assert.ok(p1.length >= 2, '应有至少两种类型的探针：' + JSON.stringify(readLines(log)).slice(0, 300));
    assert.ok(p1.every((l) => typeof l.ctxChars === 'number'), '每条探针须带 ctxChars：' + JSON.stringify(p1));
    assert.ok(p1[p1.length - 1].ctxChars >= 20, '后续探针应已累计前帧流字符（≥20）：' + JSON.stringify(p1[p1.length - 1]));
    // 压缩完成 → 代理归零；随后未知类型帧的探针应从零起
    (handlers['session/event'] ?? []).forEach((fn) => fn({ id: 'c7' }, { type: 'compaction/end', data: {} }));
    fire({ type: 'chunk', attemptId: 'c7:2', index: 0, chunk: { type: 'unknown-delta', index: 2, text: 'y'.repeat(5) } });
    const p2 = readLines(log).filter((l) => l.kind === 'loop-watch-probe');
    const last = p2[p2.length - 1];
    assert.ok(last.ctxChars <= 5.0001, '压缩后应从零重算（≤5）：' + JSON.stringify(last));
    rmSync(dir, { recursive: true, force: true });
  });
  t('循环观测：缓冲饱和（>20K）后仍继续检查（seen 单调计数）', () => {
    const dir = mkdtempSync(join(SCRATCH, 'akasha-sesplug-'));
    const log = join(dir, 'hooks.jsonl');
    const { ctx, handlers } = makeCtx();
    mod.apply(ctx, { akashaDir: CORE, log, sessionsRoot: join(dir, 'sessions'), metaFile: join(dir, 'meta.json'), storeFile: join(dir, 'store.jsonl'), loopWatch: true, watchMinChars: 21000, watchCheckEvery: 480 });
    const fire = (text) => (handlers['session/event'] ?? []).forEach((fn) => fn({ id: 'wbig' }, { type: 'assistant/chunk', data: { turn: 3, step: 1, chunk: { type: 'reasoning-delta', index: 0, text } } }));
    const seg = '这是一段用于测试的重复分析文本，反复重算同一件事。';
    for (let i = 0; i < 900; i += 1) fire(seg);
    const lines = readLines(log).filter((l) => l.kind === 'loop-watch');
    assert.ok(lines.length >= 1, '饱和后仍应命中（F1 修复）');
    assert.ok(lines[0].atChars >= 21000, 'atChars 应为单调累计：' + JSON.stringify(lines[0]));
    rmSync(dir, { recursive: true, force: true });
  });
  t('循环观测：观测线去重——同 turn 多帧只落首报；跨 turn 各自落（2026-10-15 复检修正）', () => {
    const dir = mkdtempSync(join(SCRATCH, 'akasha-sesplug-'));
    const log = join(dir, 'hooks.jsonl');
    const { ctx, handlers } = makeCtx();
    mod.apply(ctx, { akashaDir: CORE, log, sessionsRoot: join(dir, 'sessions'), metaFile: join(dir, 'meta.json'), storeFile: join(dir, 'store.jsonl'), loopWatch: true, watchMinChars: 10, watchCheckEvery: 20 });
    const fire = (frame) => (handlers['agent/assistant-stream'] ?? []).forEach((fn) => fn({ agent: { id: 'ag9', session: { id: 'd9' } }, frame }));
    const seg = '这是一段用于测试的重复分析文本，反复重算同一件事。';
    // turn 1：attempt A 命中 → 首报；attempt B（同 turn、新 attemptId）再命中 → 不得重复落线
    fire({ type: 'start', attemptId: 'd9:a', turn: 1, step: 1 });
    for (let i = 0; i < 16; i += 1) fire({ type: 'chunk', attemptId: 'd9:a', index: i, chunk: { type: 'reasoning-delta', index: 0, text: seg } });
    fire({ type: 'start', attemptId: 'd9:b', turn: 1, step: 2 });
    for (let i = 0; i < 16; i += 1) fire({ type: 'chunk', attemptId: 'd9:b', index: i, chunk: { type: 'reasoning-delta', index: 0, text: seg } });
    let streamHits = readLines(log).filter((l) => l.kind === 'loop-watch' && l.phase === 'stream');
    assert.equal(streamHits.length, 1, '同 turn 多帧只落首报：' + JSON.stringify(streamHits));
    assert.equal(streamHits[0].turn, 1, '保留的是首报（turn 1）');
    // turn 2：新的命中 → 应各自落线（跨 turn 不去重；会话级一刀切会欠报样本）
    fire({ type: 'start', attemptId: 'd9:c', turn: 2, step: 1 });
    for (let i = 0; i < 16; i += 1) fire({ type: 'chunk', attemptId: 'd9:c', index: i, chunk: { type: 'reasoning-delta', index: 0, text: seg } });
    streamHits = readLines(log).filter((l) => l.kind === 'loop-watch' && l.phase === 'stream');
    assert.equal(streamHits.length, 2, '跨 turn 应各自落线（复检修正：会话级去重会欠报）：' + JSON.stringify(streamHits));
    assert.equal(streamHits[1].turn, 2, '第二条应为 turn 2：' + JSON.stringify(streamHits[1]));
    rmSync(dir, { recursive: true, force: true });
  });
  t('格式密度：densityTag 四档边界 + 节奏条密度行（含「观测行自身无加粗」自指哨兵；2026-10-15）', () => {
    assert.equal(mod.densityTag(0), '绿');
    assert.equal(mod.densityTag(14.9), '绿');
    assert.equal(mod.densityTag(15), '黄');
    assert.equal(mod.densityTag(39.9), '黄');
    assert.equal(mod.densityTag(40), '橙');
    assert.equal(mod.densityTag(119.9), '橙');
    assert.equal(mod.densityTag(120), '红');
    assert.equal(mod.densityTag(500), '红');
    const state = { meta: { sessions: { s1: { segments: 10 } } }, compacts: [], density: { rate: 12.3, tag: '绿', rounds: 5, chars: 5000 } };
    const line = mod.renderSessionLine(state, Date.now());
    assert.ok(line.includes('格式密度 12.3/千字'), line);
    assert.ok(line.includes('绿区'), line);
    assert.equal(/\*\*/.test(line), false, '密度观测行自身不得含加粗标记（防自指喂密度）：' + line);
    const noD = mod.renderSessionLine({ meta: { sessions: { s1: { segments: 10 } } }, compacts: [], density: { rate: 12.3, tag: '绿', rounds: 1, chars: 500 } }, Date.now());
    assert.equal(noD.includes('格式密度'), false, '样本不足（<2000ch）不显示：' + noD);
    const noD2 = mod.renderSessionLine({ meta: { sessions: { s1: { segments: 10 } } }, compacts: [] }, Date.now());
    assert.equal(noD2.includes('格式密度'), false, '无密度数据时不得显示：' + noD2);
  });
  t('格式密度：turn 结束累计 → hooks 落 density 线（rate=**数/字符×1000；2026-10-15）', () => {
    const dir = mkdtempSync(join(SCRATCH, 'akasha-sesplug-'));
    const log = join(dir, 'hooks.jsonl');
    const { ctx, handlers } = makeCtx();
    mod.apply(ctx, { akashaDir: CORE, log, sessionsRoot: join(dir, 'sessions'), metaFile: join(dir, 'meta.json'), storeFile: join(dir, 'store.jsonl'), loopWatch: true });
    const fire = (session, event) => (handlers['session/event'] ?? []).forEach((fn) => fn(session, event));
    // 10 段 ×（'**甲**' + 95 字）＝ 每段 100 字符含 2 个 ** 匹配 ⇒ 1000 字符 20 个 ** ⇒ rate = 20.0（黄区）
    const seg = ('**甲**' + '字'.repeat(95));
    fire({ id: 'd1' }, { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: seg.repeat(10) }] } } });
    fire({ id: 'd1' }, { type: 'turn/end', data: { turn: 1 } });
    const dens = readLines(log).filter((l) => l.kind === 'density');
    assert.ok(dens.length >= 1, '应落 density 线：' + JSON.stringify(readLines(log)).slice(0, 400));
    assert.equal(dens[0].session, 'd1');
    assert.ok(Math.abs(dens[0].rate - 20) < 0.05, 'rate 应=20.0（20 个 **匹配/1000 字符）：' + JSON.stringify(dens[0]));
    assert.equal(dens[0].tag, '黄', '20 应为黄区：' + JSON.stringify(dens[0]));
    assert.ok(dens[0].rounds === 1 && dens[0].chars === 1000, JSON.stringify(dens[0]));
    rmSync(dir, { recursive: true, force: true });
  });
  t('格式密度：整轮累计口径——同 turn 两条消息之和（2026-10-15 首验修正）', () => {
    const dir = mkdtempSync(join(SCRATCH, 'akasha-sesplug-'));
    const log = join(dir, 'hooks.jsonl');
    const { ctx, handlers } = makeCtx();
    mod.apply(ctx, { akashaDir: CORE, log, sessionsRoot: join(dir, 'sessions'), metaFile: join(dir, 'meta.json'), storeFile: join(dir, 'store.jsonl'), loopWatch: true });
    const fire = (session, event) => (handlers['session/event'] ?? []).forEach((fn) => fn(session, event));
    const seg = ('**甲**' + '字'.repeat(95)); // 100 字符 · 2 个 ** 匹配
    // 同一 turn 两条消息（各 5 段 = 500 字符 10 个 **）⇒ 整轮 1000ch / 20 ** ⇒ rate 20.0
    fire({ id: 'd2' }, { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: seg.repeat(5) }] } } });
    fire({ id: 'd2' }, { type: 'assistant/message', data: { turn: 1, step: 2, message: { content: [{ type: 'reasoning', text: seg.repeat(5) }] } } });
    fire({ id: 'd2' }, { type: 'turn/end', data: { turn: 1 } });
    const dens = readLines(log).filter((l) => l.kind === 'density');
    assert.ok(dens.length >= 1, '应落 density 线：' + JSON.stringify(readLines(log)).slice(0, 300));
    assert.equal(dens[0].chars, 1000, '整轮口径应＝两条消息之和（1000ch）：' + JSON.stringify(dens[0]));
    assert.equal(dens[0].bold, 20, '整轮 ** 匹配数应为 20：' + JSON.stringify(dens[0]));
    assert.ok(Math.abs(dens[0].rate - 20) < 0.05, JSON.stringify(dens[0]));
    rmSync(dir, { recursive: true, force: true });
  });
  t('循环观测：turn 相命中标 src=turn（供下游与流线去重；2026-10-15）', () => {
    const dir = mkdtempSync(join(SCRATCH, 'akasha-sesplug-'));
    const log = join(dir, 'hooks.jsonl');
    const { ctx, handlers } = makeCtx();
    mod.apply(ctx, { akashaDir: CORE, log, sessionsRoot: join(dir, 'sessions'), metaFile: join(dir, 'meta.json'), storeFile: join(dir, 'store.jsonl'), loopWatch: true });
    const rep = ('我们需要重新核对这个路径下的文件内容与之前分析保持一致。').repeat(6);
    const fire = (session, event) => (handlers['session/event'] ?? []).forEach((fn) => fn(session, event));
    fire({ id: 't11' }, { type: 'assistant/message', data: { turn: 2, step: 1, message: { content: [{ type: 'reasoning', text: rep }] } } });
    (handlers['agent/turn-stopping'] ?? []).forEach((fn) => fn({ agent: { id: 'ag1', session: { id: 't11' } }, turn: 2 }));
    const turnHits = readLines(log).filter((l) => l.kind === 'loop-watch' && l.phase === 'turn');
    assert.ok(turnHits.length >= 1, '应记 turn 相命中：' + JSON.stringify(readLines(log)).slice(0, 300));
    assert.ok(turnHits.every((l) => l.src === 'turn'), 'turn 相须标 src=turn：' + JSON.stringify(turnHits));
    rmSync(dir, { recursive: true, force: true });
  });

  // ---------- v0.4：索引 worker 化 ----------
  await tza('worker：宿主只投递 → 后台索引 → via=worker 落线（hostMs < 5ms）', async () => {
    const dir = mkdtempSync(join(SCRATCH, 'akasha-sesplug-'));
    const log = join(dir, 'hooks.jsonl');
    const sessionsRoot = join(dir, 'sessions');
    const sDir = join(sessionsRoot, '--W--', 'session-wkr12345');
    mkdirSync(sDir, { recursive: true });
    const mk = (seqs) => Buffer.from(seqs.map((seq) => JSON.stringify({ seq, time: 1791312000000 + seq * 1000, type: 'user/message', data: { content: [{ type: 'text', text: 'worker 夹具第' + seq + '条' }] } })).join('\n') + '\n');
    writeFileSync(join(sDir, 'session.v4.jsonl.zstd'), zstdCompressSync(mk([1, 2, 3])));
    const { ctx, handlers, disposers } = makeCtx();
    mod.apply(ctx, { akashaDir: CORE, log, sessionsRoot, metaFile: join(dir, 'meta.json'), storeFile: join(dir, 'store.jsonl'), minIndexIntervalMs: 0 });
    const fire = () => (handlers['session/event'] ?? []).forEach((fn) => fn({ id: 'wkr12345' }, { type: 'turn/end', data: { turn: 1 } }));
    fire();
    const idx = await waitFor(() => readLines(log).find((l) => l.kind === 'session-index'));
    assert.equal(idx.via, 'worker', 'v0.4 默认应走 worker：' + JSON.stringify(idx));
    assert.ok(typeof idx.hostMs === 'number' && idx.hostMs < 5, '宿主投递应 < 5ms：' + idx.hostMs);
    assert.equal(idx.added, 3, JSON.stringify(idx));
    assert.equal(idx.session, 'wkr12345');
    const all = readLines(log);
    assert.ok(all.some((l) => l.kind === 'session-worker' && l.event === 'spawn'), '应有 worker spawn 线');
    assert.ok(all.some((l) => l.kind === 'session-worker' && l.event === 'ready'), '应有 worker ready 线');
    assert.equal(all.filter((l) => l.kind === 'session-worker-error').length, 0, '不得有 worker 错误：' + JSON.stringify(all.filter((l) => l.kind === 'session-worker-error')));
    const storeLines = readFileSync(join(dir, 'store.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
    // 口径修正（2026-10-13 审计）：v0.3 起索引成功后**自动建树**会追加 L1 node 行 ——
    // 「store 恰好 3 行」是建树落地前的写法，之后稳定假红（实测 4 行 = 3 段 + 1 节点）。
    // 改为断言**逻辑内容**：3 条 intent 段（本会话）+ 至多 1 个 treegen≥1 的 node。
    const segRows = storeLines.filter((r) => r.session === 'wkr12345' && r.kind !== 'node');
    assert.equal(segRows.length, 3, '应有 3 条 intent 段：' + JSON.stringify(segRows.map((r) => r.id)));
    assert.ok(segRows.every((r) => r.kind === 'intent'), '段 kind 应为 intent');
    const nodeRows = storeLines.filter((r) => r.kind === 'node');
    assert.ok(nodeRows.length <= 1, '至多 1 个自动树节点：' + nodeRows.length);
    if (nodeRows.length) assert.ok((Number(nodeRows[0].treegen) || 0) >= 1, 'node 应带 treegen：' + JSON.stringify(nodeRows[0]));
    for (const d of disposers) { try { d(); } catch { /* 静默 */ } }
    await waitFor(() => readLines(log).some((l) => l.kind === 'session-worker' && (l.event === 'bye' || l.event === 'exit')), { timeoutMs: 10000 });
    rmSync(dir, { recursive: true, force: true });
  });

  await tza('worker：降级链——worker 起不来时立即回 inline（不丢活）', async () => {
    const dir = mkdtempSync(join(SCRATCH, 'akasha-sesplug-'));
    const log = join(dir, 'hooks.jsonl');
    const sessionsRoot = join(dir, 'sessions');
    const sDir = join(sessionsRoot, '--W--', 'session-dg000001');
    mkdirSync(sDir, { recursive: true });
    const mk = (seqs) => Buffer.from(seqs.map((seq) => JSON.stringify({ seq, time: 1791312000000 + seq * 1000, type: 'user/message', data: { content: [{ type: 'text', text: '降级夹具第' + seq + '条' }] } })).join('\n') + '\n');
    writeFileSync(join(sDir, 'session.v4.jsonl.zstd'), zstdCompressSync(mk([1, 2])));
    const { ctx, handlers } = makeCtx();
    mod.apply(ctx, { akashaDir: CORE, log, sessionsRoot, metaFile: join(dir, 'meta.json'), storeFile: join(dir, 'store.jsonl'), minIndexIntervalMs: 0, indexMode: 'inline' });
    (handlers['session/event'] ?? []).forEach((fn) => fn({ id: 'dg000001' }, { type: 'turn/end', data: { turn: 1 } }));
    const idx = readLines(log).find((l) => l.kind === 'session-index');
    assert.ok(idx && idx.via === 'inline', 'indexMode:inline 应走回退路径：' + JSON.stringify(idx));
    assert.equal(idx.added, 2, JSON.stringify(idx));
    assert.ok(!readLines(log).some((l) => l.kind === 'session-worker'), 'inline 模式不应起 worker：' + JSON.stringify(readLines(log).map((l) => l.kind)));
    rmSync(dir, { recursive: true, force: true });
  });
}

// —— STORE 审计边界用例：malformed / 并发节流 / replay（纯函数，无副作用）——
if (mod) {
  t('边界·并发节流：最小间隔内不得重跑', () => { assert.equal(mod.shouldIndex(Date.now(), Date.now(), 30000), false); });
  t('边界·并发节流：超过间隔允许重跑', () => { assert.equal(mod.shouldIndex(0, 30000, 30000), true); });
  t('边界·malformed：非法时间戳按「从未索引」处理（fail closed → 允许一次）', () => {
    assert.equal(mod.shouldIndex(NaN, Date.now(), 30000), true);
    assert.equal(mod.shouldIndex(undefined, Date.now(), 30000), true);
  });
  t('边界·replay：同输入两次判定一致（纯函数、可重放）', () => {
    assert.equal(mod.shouldIndex(1000, 2000, 30000), mod.shouldIndex(1000, 2000, 30000));
  });
  t('边界·大会话自适应节流 ×4（档案 >16MB）', () => {
    assert.equal(mod.effectiveThrottle(20 * 1024 * 1024, 30000), 120000);
    assert.equal(mod.effectiveThrottle(1024, 30000), 30000);
  });
}

// N4（2026-10-17 复核）：h8 那个"压缩后补索引改判"修复此前**没有任何自动化用例**（selftest mtime 早于 h8）。
//   这里补 4 条：settle 双向 + 幂等、59/61s 边界、N2 后缀、子代理目录识别。
if (mod) {
  t('N4：settleCompactsIn 形式无关（裸↔带前缀）+ 幂等', () => {
    const a = [{ session: 'session-AAAA', ts: Date.now(), indexed: false, reason: 'queued' }];
    assert.equal(mod.settleCompactsIn(a, 'AAAA').length, 1, '裸 uuid 调用应改判带前缀条目');
    assert.equal(a[0].indexed, true);
    assert.equal(mod.settleCompactsIn(a, 'AAAA').length, 0, '已改判的条目不得重复改判（幂等）');
    const b = [{ session: 'BBBB', ts: Date.now(), indexed: false, reason: 'queued' }];
    assert.equal(mod.settleCompactsIn(b, 'session-BBBB').length, 1, '带前缀调用应改判裸条目');
    const c = [{ session: 'CCCC', ts: Date.now(), indexed: false, reason: 'queued' }];
    assert.equal(mod.settleCompactsIn(c, 'DDDD').length, 0, '不同 uuid 不得误伤');
  });

  t('N4：queued 59s ⇒ 排队中（无 ⚠）/ 61s ⇒ ⚠', () => {
    const now = Date.now();
    const base = { meta: { sessions: { AAAA: { segments: 12, conclusions: 3 } } }, density: null };
    const at = (ms) => mod.renderSessionLine({ ...base, compacts: [{ session: 'session-AAAA', ts: now - ms, indexed: false, reason: 'queued' }] }, now);
    assert.ok(!at(59000).includes('⚠'), '59s 内应说"排队中"而不是 ⚠');
    assert.ok(at(61000).includes('⚠'), '61s 后应转 ⚠');
  });

  t('N1/N2：已收入行不带 ⚠，且按归一化 id 找到 meta（带「已索引 N 段」）', () => {
    const now = Date.now();
    const line = mod.renderSessionLine({
      meta: { sessions: { AAAA: { segments: 12, conclusions: 3 } } }, density: null,
      compacts: [{ session: 'session-AAAA', ts: now - 5000, indexed: true, reason: 'recovered' }],
    }, now);
    assert.ok(!line.includes('⚠'), 'N1：已收入不该挂 ⚠：' + line);
    assert.ok(line.includes('已索引 12 段'), 'N2：应带上 meta 统计后缀：' + line);
  });

  t('子代理：resolveSessionArchive 认出裸 uuid 目录并标 child', async () => {
    const root = mkdtempSync(join(SCRATCH, 'akasha-sesproot-'));
    mkdirSync(join(root, 'session-MAIN'), { recursive: true });
    mkdirSync(join(root, 'CHILD1'), { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(root, 'session-MAIN', 'session.v4.jsonl.zstd'), 'x');
    writeFileSync(join(root, 'CHILD1', 'session.v4.jsonl.zstd'), 'x');
    const coreUrl = 'file:///' + join(CORE, 'session.mjs').replace(/\\/g, '/');
    const core = await import(coreUrl);
    const main = core.resolveSessionArchive(root, 'MAIN');
    const child = core.resolveSessionArchive(root, 'CHILD1');
    assert.equal(main.child, false, '主会话目录（session- 前缀）应 child:false');
    assert.equal(child.child, true, '裸 uuid 目录应 child:true（子代理）');
    assert.equal(core.resolveSessionFile(root, 'CHILD1').endsWith('session.v4.jsonl.zstd'), true, '旧 API 现在也应能找到子代理档案');
  });
}

// 2026-10-17：异步用例必须**落定后**才统计（否则又是"断言没跑就先记 PASS"的假绿）。
await Promise.all(pendingT);

console.log(`\n${passed} passed, ${failures.length} failed${skipped.length ? `, ${skipped.length} skipped` : ''}`);
if (failures.length) {
  console.log('失败清单：');
  for (const [name, e] of failures) console.log(' -', name, ':', e.message);
  process.exit(1);
}
// v0.4：worker 线程（即使 unref）会让事件循环不归零 → 全部用例跑完显式退出，避免"测试全绿但进程挂着"。
process.exit(0);
