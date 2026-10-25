import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';

const temporaryParent = path.resolve(tmpdir());
const root = fs.mkdtempSync(path.join(temporaryParent, 'akasha-process-integration-'));
const priorEnv = Object.fromEntries(['AKASHA_DIR', 'AKASHA_ROOT', 'AKASHA_LOGS', 'AKASHA_COMPANIONS'].map(k => [k, process.env[k]]));
Object.assign(process.env, {
  AKASHA_DIR: root, AKASHA_ROOT: path.join(root, 'absent-data'),
  AKASHA_LOGS: path.join(root, 'absent-logs'), AKASHA_COMPANIONS: path.join(root, 'absent-companions.json'),
});
const { apply } = await import('./lib/index.js');
let serial = 0;
test.after(() => {
  for (const [key, value] of Object.entries(priorEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  assert.equal(path.dirname(path.resolve(root)), temporaryParent);
  assert.ok(path.basename(root).startsWith('akasha-process-integration-'));
  fs.rmSync(root, { recursive: true, force: true });
});

const rows = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
async function until(predicate, description, timeoutMs = 10000) {
  const limit = Date.now() + timeoutMs;
  while (Date.now() < limit) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.fail('Timed out: ' + description);
}

function fixture() {
  const dir = path.join(root, String(++serial)); fs.mkdirSync(dir);
  const log = path.join(dir, 'hooks.jsonl'), trace = path.join(dir, 'trace.jsonl');
  const state = path.join(dir, 'state.json'), release = path.join(dir, 'release');
  fs.writeFileSync(state, JSON.stringify({ target: 'success', blocker: 'hold' }));
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ version: 1, sessions: { target: { lastSeq: 1, segments: 7, conclusions: 2 } } }));
  for (const sid of ['target', 'blocker']) fs.writeFileSync(path.join(dir, sid + '.archive'), 'the same source archive bytes');
  fs.writeFileSync(path.join(dir, 'session.mjs'), `
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=dirname(fileURLToPath(import.meta.url));
const hostPid=${process.pid};
const trace=(row)=>fs.appendFileSync(join(root,'trace.jsonl'),JSON.stringify({...row,pid:process.pid})+'\\n');
const normalized=s=>String(s).replace(/^session-/,'');
export function resolveSessionArchive(sessionsRoot,sid){return {file:join(root,normalized(sid)+'.archive'),child:false};}
export function resolveSessionFile(sessionsRoot,sid){return resolveSessionArchive(sessionsRoot,sid).file;}
export function indexSession(job){
  const session=normalized(job.session),mode=JSON.parse(fs.readFileSync(join(root,'state.json'),'utf8'))[session];
  trace({kind:'index',session,mode,file:job.file,host:process.pid===hostPid});
  if(process.pid===hostPid)throw Error('HOST_INLINE_INDEX_FORBIDDEN');
  if(mode==='throw')throw Error('fixture index throw');
  if(mode==='exit')process.exit(71);
  if(mode==='hold'){
    const end=Date.now()+8000;
    while(!fs.existsSync(join(root,'release'))){
      if(Date.now()>end)throw Error('fixture hold timeout');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);
    }
  }
  trace({kind:'complete',session,mode});
  return {session,added:1,skipped:0,parseFails:0,frameFails:0,lastSeq:1};
}
export function autoBuildTree(opts){trace({kind:'tree',session:normalized(opts.session)});return {built:false,reason:'fixture-unchanged'};}
`);
  const handlers = {}, contexts = [], disposers = [];
  const ctx = {
    on(name, fn) { (handlers[name] ??= []).push(fn); },
    systemPrompt: { context(item) { contexts.push(item); } },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
    interval() { return () => {}; },
  };
  apply(ctx, {
    akashaDir: dir, sessionsRoot: dir, log, storeFile: path.join(dir, 'session.jsonl'),
    metaFile: path.join(dir, 'meta.json'), indexMode: 'worker', loopWatch: false,
    minIndexIntervalMs: 0, timerCheckMs: 600000,
  });
  const fire = (sid, type = 'compaction/end') => { for (const fn of handlers['session/event'] ?? []) fn({ id: sid }, { type, data: { turn: 1 } }); };
  const setMode = mode => fs.writeFileSync(state, JSON.stringify({ target: mode, blocker: 'hold' }));
  const logs = () => rows(log), traces = () => rows(trace);
  const text = () => contexts.find(x => x.name === 'akasha:session').text();
  return { dir, log, trace, release, fire, setMode, logs, traces, text, async dispose() {
    fs.writeFileSync(release, 'release');
    for (const fn of disposers.reverse()) fn();
    await until(() => logs().some(x => x.kind === 'session-worker' && x.event === 'bye'), 'queue drains during disposal');
  } };
}

test('plugin survives repeated child throw/exit and retries identical archive on forced compaction without inline fallback', async () => {
  const f = fixture();
  try {
    for (const [i, mode] of ['throw', 'exit', 'throw', 'exit'].entries()) {
      f.setMode(mode); f.fire('session-target');
      await until(() => f.logs().filter(x => x.kind === 'session-index-error').length === i + 1, 'failure ' + (i + 1));
      await until(() => f.logs().filter(x => x.kind === 'session-worker' && x.event === 'process-exit').length === i + 1, 'exit ' + (i + 1));
      const attempts = f.traces().filter(x => x.kind === 'index');
      assert.equal(attempts.length, i + 1, 'the same archive must be retried after every failure');
      assert.ok(attempts.every(x => !x.host && x.pid !== process.pid));
      assert.equal(f.logs().filter(x => x.kind === 'session-index').length, 0);
      assert.equal(f.logs().filter(x => x.kind === 'session-compact-settled').length, 0);
      assert.equal(f.logs().filter(x => x.kind === 'session-index-skip' && x.reason === 'unchanged').length, 0);
      assert.ok(f.logs().filter(x => x.kind === 'session-compact').every(x => x.indexed === false));
      assert.doesNotMatch(f.text(), /本段历史已收入会话层/);
    }
    const before = f.traces().filter(x => x.kind === 'index').length;
    const queuedBefore = f.logs().filter(x => x.kind === 'session-worker' && x.event === 'queued').length;
    f.fire('session-target', 'turn/end');
    assert.equal(f.traces().filter(x => x.kind === 'index').length, before, 'ordinary turns respect failure backoff');
    assert.equal(f.logs().filter(x => x.kind === 'session-worker' && x.event === 'queued').length, queuedBefore);
    f.setMode('success'); f.fire('session-target');
    await until(() => f.logs().filter(x => x.kind === 'session-index').length === 1, 'forced recovery succeeds');
    await until(() => f.logs().filter(x => x.kind === 'session-worker' && x.event === 'process-exit').length === 5, 'recovery child exits');
    assert.equal(f.traces().filter(x => x.kind === 'index').length, 5);
    assert.equal(f.logs().filter(x => x.kind === 'session-compact-settled').length, 5);
    assert.match(f.text(), /本段历史已收入会话层/);
    const success = f.logs().find(x => x.kind === 'session-index');
    assert.equal(success.isolation, 'process'); assert.notEqual(success.pid, process.pid);
    f.fire('session-target');
    assert.equal(f.logs().filter(x => x.kind === 'session-compact').at(-1).indexed, true);
    assert.equal(f.logs().filter(x => x.kind === 'session-index-skip' && x.reason === 'unchanged').length, 1);
    assert.equal(f.traces().filter(x => x.kind === 'index').length, 5, 'only validated success permits the unchanged fast path');
    assert.equal(f.traces().filter(x => x.kind === 'tree').length, 1);
  } finally { await f.dispose(); }
});

test('superseded waiting jobs neither set lastStat nor settle compactions before the retained job succeeds', async () => {
  const f = fixture();
  try {
    f.fire('session-blocker');
    await until(() => f.traces().some(x => x.kind === 'index' && x.session === 'blocker'), 'blocker enters child');
    f.setMode('throw');
    for (let i = 0; i < 3; i++) f.fire('session-target');
    assert.equal(f.logs().filter(x => x.kind === 'session-worker' && x.event === 'queued' && x.session === 'session-target').length, 3);
    assert.equal(f.logs().filter(x => x.kind === 'session-index' && x.session === 'session-target').length, 0);
    assert.equal(f.logs().filter(x => x.kind === 'session-compact-settled' && x.session === 'session-target').length, 0);
    assert.equal(f.logs().filter(x => x.kind === 'session-index-skip' && x.reason === 'unchanged').length, 0);
    assert.ok(f.logs().filter(x => x.kind === 'session-compact' && x.session === 'session-target').every(x => !x.indexed));
    fs.writeFileSync(f.release, 'release');
    await until(() => f.logs().some(x => x.kind === 'session-index-error' && x.session === 'session-target'), 'retained target job fails');
    await until(() => f.logs().filter(x => x.kind === 'session-worker' && x.event === 'process-exit').length === 2, 'both active children exited');
    assert.equal(f.traces().filter(x => x.kind === 'index' && x.session === 'target').length, 1, 'coalesced old jobs never execute');
    assert.equal(f.logs().filter(x => x.kind === 'session-compact-settled' && x.session === 'session-target').length, 0);
    f.setMode('success'); f.fire('session-target');
    await until(() => f.logs().some(x => x.kind === 'session-index' && x.session === 'session-target'), 'same target archive retries after superseded and failure');
    await until(() => f.logs().filter(x => x.kind === 'session-worker' && x.event === 'process-exit').length === 3, 'recovery child exits');
    assert.equal(f.traces().filter(x => x.kind === 'index' && x.session === 'target').length, 2);
    assert.equal(f.logs().filter(x => x.kind === 'session-compact-settled' && x.session === 'session-target').length, 4);
    assert.ok(f.traces().filter(x => x.kind === 'index').every(x => !x.host && x.pid !== process.pid));
    assert.match(f.text(), /本段历史已收入会话层/);
  } finally { await f.dispose(); }
});
