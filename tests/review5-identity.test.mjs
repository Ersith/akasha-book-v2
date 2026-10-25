// Zero external dependencies. All data and worker writes stay in a fresh temporary directory.
// Optional real-host contract check:
// DSH_HOST_NODE_MODULES=<host node_modules> node --test tests/review5-identity.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as zlib from 'node:zlib';
import { apply as applySession } from '../plugins/akasha-session/lib/index.js';
import { apply as applySleep, latestIntentGist } from '../plugins/akasha-sleep/lib/index.js';

// These overrides are process-local. Never let a caller's real data/log roots enter a fixture.
delete process.env.AKASHA_ROOT;
delete process.env.AKASHA_LOGS;
const core = join(dirname(fileURLToPath(import.meta.url)), '..', 'core');
const hasZstd = typeof zlib.zstdCompressSync === 'function';
const asLines = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const intent = (session, gist) => ({ session, kind: 'intent', gist });
// 2026-10-19：集成段改用 UUID 形态——读侧归一已门控到 UUID（`session-<uuid>` ↔ `<uuid>` 互认，
//   非 UUID 一律精确匹配，见 sleep lib latestIntentGist）。旧测试用 `session-1` 这类非 UUID，
//   在门控后既不互认也无法代表真实会话形态（真库 52046 行全 UUID），属测试过期。
const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';
const agent = (id) => ({ id, session: { id, header: { origin: 'user' } } });
const contractContext = (a) => ({ agent: a, scope: a });
const readRows = (file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Fixture worker did not complete within 5 seconds');
    await delay(10);
  }
}

test('unmarked full IDs stay readable, without treating another full ID as an alias', () => {
  const rows = asLines([intent('session-1', 'A version')]);
  assert.equal(latestIntentGist(rows, 'session-1'), 'A version');
  assert.equal(latestIntentGist(rows, '1'), null);
  assert.equal(latestIntentGist(rows, 'session-session-1'), null);
  const both = asLines([intent('session-1', 'A version'), intent('session-session-1', 'B painting')]);
  assert.equal(latestIntentGist(both, 'session-1'), 'A version');
  assert.equal(latestIntentGist(both, 'session-session-1'), 'B painting');
});

test('legacy short IDs are not guessed; explicit unknown identities fail closed', () => {
  const rows = asLines([intent('1', 'legacy version'), intent('session-other', 'other version')]);
  assert.equal(latestIntentGist(rows, 'session-1'), null);
  for (const sid of [null, '', '(unknown)']) assert.equal(latestIntentGist(rows, sid), null);
  // Existing one-argument offline tail-reading API remains compatible.
  assert.equal(latestIntentGist(rows), 'other version');
});

test('unusable own intent does not authorize an alias, and ordinary filtering remains intact', () => {
  const rows = asLines([
    intent('session-1', 'another session version'),
    intent('session-session-1', '<injected block>'),
    intent('session-session-1', 'x'.repeat(801)),
  ]);
  assert.equal(latestIntentGist(rows, 'session-session-1'), null);
  assert.equal(latestIntentGist(asLines([intent('session-1', 'older own'), intent('session-1', '<skip>')]), 'session-1'), 'older own');
  assert.equal(latestIntentGist('not json\n' + rows, 'session-session-1'), null);
});

function fixture(t, { mode = 'inline', assemble = contractContext, render } = {}) {
  const scratchParent = resolve(tmpdir());
  const root = mkdtempSync(join(scratchParent, 'akasha-review5-identity-'));
  mkdirSync(join(root, 'data')); mkdirSync(join(root, 'logs')); mkdirSync(join(root, 'sessions'));
  for (const name of readdirSync(core).filter((n) => n.endsWith('.mjs'))) copyFileSync(join(core, name), join(root, name));
  for (const name of ['canon', 'mirror', 'orphan', 'pricing', 'lexicon', 'frontier', 'session']) writeFileSync(join(root, 'data', name + '.jsonl'), '');
  writeFileSync(join(root, 'data', 'canon.jsonl'), asLines([
    { id: 'canon-fixture', claim: 'fixturetool {{template}}', source: { type: '实验', ref: 'test fixture' }, last_reviewed: '2026-10-14' },
    { id: 'canon-trap-edit-context-mismatch', claim: 'edit fixture', hint: 'Read source before editing', source: { type: '实验', ref: 'test fixture' }, last_reviewed: '2026-10-14' },
  ]));
  const store = join(root, 'data', 'session.jsonl');
  const log = join(root, 'logs', 'session-hooks.jsonl');
  const stateFile = join(root, 'logs', 'sleep-state.json');
  writeFileSync(stateFile, JSON.stringify({ lastRunAt: new Date().toISOString() }));
  const disposers = [], sessionEvents = new Map(), sleepEvents = new Map(), contexts = new Map();
  const ctx = (events, capture = false) => ({
    on(name, callback) { const list = events.get(name) || []; list.push(callback); events.set(name, list); },
    systemPrompt: { context(c) { if (capture) contexts.set(c.name, c); } },
    interval() { return () => {}; },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
  });
  applySession(ctx(sessionEvents), { akashaDir: root, sessionsRoot: join(root, 'sessions'), storeFile: store, metaFile: join(root, 'data', 'session-meta.json'), log, indexMode: mode, loopWatch: false });
  applySleep(ctx(sleepEvents, true), { akashaDir: root, stateFile, log: join(root, 'logs', 'hooks.jsonl'), inboxFile: join(root, 'logs', 'inbox.jsonl'), wakeNote: false });
  const events = () => readRows(log);
  t.after(async () => {
    for (const dispose of disposers) dispose();
    if (mode === 'worker') await until(() => events().some((e) => e.kind === 'session-worker' && e.event === 'exit'));
    const rel = relative(scratchParent, resolve(root));
    assert.ok(rel.startsWith('akasha-review5-identity-') && !rel.includes('..') && !rel.includes('/') && !rel.includes('\\'));
    rmSync(root, { recursive: true, force: true });
  });
  return {
    rows: () => readRows(store),
    text(name, a) {
      const text = contexts.get(name).text(assemble(a));
      if (render && text) render({ contexts: [{ name, text }], variables: {} });
      return text;
    },
    sleepEvent(name, ...args) { for (const fn of sleepEvents.get(name) || []) fn(...args); },
    async index(id, message, type = 'turn/end') {
      const a = agent(id), directory = join(root, 'sessions', id);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(asLines([
        { seq: 1, time: Date.now(), type: 'user/message', data: { content: [{ type: 'text', text: message }] } },
      ]))));
      // 2026-10-19：worker / 会话层日志里 session 用**裸 uuid**（normalizeSid 的形态），
      //   测试此前只认完整 `session-<uuid>` ⇒ 5s 等不到而超时。两种形态都算命中。
      const matches = (v) => v === id || v === id.replace(/^session-/, '');
      for (const fn of sessionEvents.get('session/event') || []) fn(a.session, { type, data: { turn: 1 } });
      if (mode === 'worker') await until(() => events().some((e) => e.kind === 'session-index' && matches(e.session) && e.via === 'worker'));
      // 2026-10-19：生产者按 normalizeSid 存**归一后**身份（`session-<uuid>` → `<uuid>`；双前缀去一个），
      //   故断言接受「完整或归一后」两种合法形态；读侧精确读取由下面的 h.text() 断言覆盖。
            const bare = id.replace(/^session-/, '');
      assert.ok(this.rows().some((r) => (r.session === id || r.session === bare) && r.kind === 'intent'), 'producer must persist the session identity (full or normalized form)');
      if (type === 'compaction/end') assert.ok(events().some((e) => e.kind === 'session-compact' && matches(e.session)));
      return a;
    },
  };
}

for (const mode of ['inline', 'worker']) {
  for (const event of ['turn/end', 'compaction/end']) {
    test(`${mode} ${event}: producer to reader preserves complete IDs and isolates new sessions`, {}, async (t) => {
      const h = fixture(t, { mode });
      const a = await h.index(`session-${UUID_A}`, '上次 fixturetool 版本还在吗', event);
      for (const id of [UUID_B]) {
        assert.equal(h.text('akasha:stateful', agent(id)), '');
        assert.equal(h.text('akasha:recall', agent(id)), '');
      }
      // 2026-10-19：无身份（undefined）时插件按 sleep 1.10.22-h2 约定返回**空字符串**（不是 null），
      //   目的是避免 Harness 提示词渲染在 null 上出现 indexOf 错误。语义仍是「读不到」。
      assert.equal(h.text('akasha:stateful', undefined), '');
      assert.equal(h.text('akasha:recall', undefined), '');
            const stateText = h.text('akasha:stateful', a);
      assert.match(stateText, /断言提醒/);
      const recallText = h.text('akasha:recall', a);
      assert.match(recallText, /canon-fixture/);
      const b = await h.index(`session-${UUID_B}`, 'Please describe the painting composition.', event);
      // 生产者存归一后的身份：`session-<A>` → `<A>`；`session-session-<A>` → `session-<A>`（去一个前缀）
      assert.deepEqual(h.rows().filter((r) => r.kind === 'intent').map((r) => r.session).sort(), [UUID_A, UUID_B].sort());
      assert.equal(h.text('akasha:stateful', b), '');
      assert.equal(h.text('akasha:recall', b), '');
    });
  }
}

test('real installed host context/render contract, with synthetic events only', {
  skip: !process.env.DSH_HOST_NODE_MODULES ? 'set DSH_HOST_NODE_MODULES to run this optional host check' : !hasZstd && 'Node 22.15+ with zstd required',
}, async (t) => {
  const host = process.env.DSH_HOST_NODE_MODULES;
  const load = (pkg) => import(pathToFileURL(join(host, '@deepseek-ai', pkg, 'lib', 'index.js')).href);
  const [{ assembleContextFor }, { renderContextSnapshot }, { Session }] = await Promise.all([load('dsh-agent'), load('dsh-system-prompt'), load('dsh-session')]);
  const aSession = new Session('session-1'), bSession = new Session('session-session-1');
  assert.notEqual(aSession.id, bSession.id);
  const h = fixture(t, { assemble: assembleContextFor, render: renderContextSnapshot });
  await h.index(aSession.id, '上次 fixturetool 版本还在吗');
  const a = { id: aSession.id, session: aSession }, b = { id: bSession.id, session: bSession };
  h.sleepEvent('session/event', a.session, { type: 'turn/start', data: { turn: 1 } });
  assert.equal(h.text('akasha:stateful', b), '');
  assert.equal(h.text('akasha:recall', b), '');
  assert.equal(h.text('akasha:recall', undefined), '');
  assert.match(h.text('akasha:stateful', a), /断言提醒/);
  assert.match(h.text('akasha:recall', a), /canon-fixture/);
  h.sleepEvent('tools/result', { agent: a, name: 'edit', arguments: {} }, { isError: true });
  assert.equal(h.text('akasha:preflight', a), null, 'C3 suppresses C1 within the turn');
  // Host finally emits turn/end even when agent/turn-stopping was skipped by cancellation.
  h.sleepEvent('session/event', a.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted', reason: 'synthetic cancellation' } } });
  h.sleepEvent('session/event', a.session, { type: 'turn/start', data: { turn: 2 } });
  assert.match(h.text('akasha:preflight', a), /坑前提示/, 'durable aborted turn end clears C3 suppression');
});
