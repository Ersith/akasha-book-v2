import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IndexProcess as Factory } from './lib/index-process.mjs';

const base = mkdtempSync(join(tmpdir(), 'akasha-process-test-'));
const core = join(base, 'core');
mkdirSync(core);
writeFileSync(join(core, 'session.mjs'), `
export function indexSession(job) {
  if (job.file === 'crash') process.exit(37);
  if (job.file === 'abort') process.abort();
  if (job.file === 'hang') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
  if (job.file === 'throw') throw new Error('fixture index failure');
  if (job.file === 'slow') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  return { added: 1, skipped: 0, parseFails: 0, frameFails: 0, pid: process.pid, file: job.file };
}
`);
const entry = new URL('./lib/index-worker.mjs', import.meta.url);

function harness(t, options) {
  const worker = new Factory(entry, options);
  const messages = [];
  worker.on('message', msg => messages.push(msg));
  t.after(() => worker.terminate());
  let id = 0;
  return {
    worker, messages,
    send(session, file = 'ok') { const n = ++id; worker.postMessage({type:'index',id:n,job:{akashaDir:core,session,file,trigger:'test'}}); return n; },
    async result(n) {
      const end = Date.now() + 15000;
      while (Date.now() < end) { const v = messages.find(m => m.type === 'result' && m.id === n); if(v) return v; await new Promise(r=>setTimeout(r,10)); }
      throw new Error('result timeout: ' + n);
    },
  };
}

test('index runs outside host PID and releases process after each job', async t => {
  const h = harness(t);
  const a = await h.result(h.send('a'));
  assert.equal(a.added, 1);
  assert.notEqual(a.pid, process.pid, 'index must not share the host process');
  const b = await h.result(h.send('b'));
  assert.notEqual(b.pid, a.pid, 'each job must release the previous process and caches');
});

test('queue keeps running job, supersedes waiting same session, preserves FIFO', async t => {
  const h = harness(t);
  const a = h.send('a', 'slow'); const b1 = h.send('b', 'old'); const c = h.send('c'); const b2 = h.send('b', 'new');
  assert.equal((await h.result(b1)).superseded, true);
  assert.equal((await h.result(a)).file, 'slow');
  assert.equal((await h.result(c)).file, 'ok');
  assert.equal((await h.result(b2)).file, 'new');
  assert.deepEqual(h.messages.filter(m=>m.type==='result' && !m.superseded).map(m=>m.id), [a,c,b2]);
});

test('child crash reports failure once and next queued job succeeds', async t => {
  const h = harness(t); const a = h.send('a','crash'); const b = h.send('b');
  assert.match((await h.result(a)).error, /37|exit/);
  assert.equal((await h.result(b)).added, 1);
  assert.equal(h.messages.filter(m=>m.type==='result' && m.id===a).length, 1);
});

test('caught index exception remains failure and queue continues', async t => {
  const h = harness(t); const a = h.send('a','throw'); const b = h.send('b');
  assert.match((await h.result(a)).error, /fixture index failure/);
  assert.equal((await h.result(b)).added, 1);
});

test('native abort is contained in child and subsequent index completes', async t => {
  const h = harness(t); const a = h.send('a','abort'); const b = h.send('b');
  assert.match((await h.result(a)).error, /exit/);
  assert.equal((await h.result(b)).added, 1);
});

test('timeout stops hung child and allows next job', async t => {
  const h = harness(t, {timeoutMs: 1000}); const a = h.send('a','hang'); const b = h.send('b');
  assert.match((await h.result(a)).error, /timeout/);
  assert.equal((await h.result(b)).added,1);
});

test('missing child entry reports failure rather than running in host', async t => {
  const worker = new Factory(new URL('./missing-child.mjs', import.meta.url));
  t.after(()=>worker.terminate());
  const result = new Promise(resolve=>worker.on('message',m=>{if(m.type==='result')resolve(m);}));
  worker.postMessage({type:'index',id:1,job:{akashaDir:core,session:'x',file:'ok'}});
  assert.match((await result).error,/exit/);
});

test('quit drains pending work, rejects new jobs, and reports bye', async t => {
  const h=harness(t); const a=h.send('a','slow'); const b=h.send('b');
  h.worker.postMessage({type:'quit'});
  assert.throws(()=>h.send('c'), /closed|quitting/);
  assert.equal((await h.result(a)).added,1); assert.equal((await h.result(b)).added,1);
  const end=Date.now()+5000;
  while(!h.messages.some(m=>m.type==='bye') && Date.now()<end) await new Promise(r=>setTimeout(r,10));
  assert.ok(h.messages.some(m=>m.type==='bye'));
});
