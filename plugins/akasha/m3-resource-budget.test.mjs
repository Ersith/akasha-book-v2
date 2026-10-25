import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, unlinkSync, renameSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBudget, isM3ResourceBudget } from './m3-resource-budget.mjs';

const CONTROL = 2 * 65536 + 4096;
function fixture(t, limits = {}) {
  const base = mkdtempSync(join(tmpdir(), 'm3-managed-test-'));
  const root = join(base, 'budget'); mkdirSync(root);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  return { base, root, manager: openBudget({ root, limits }) };
}
async function child(t, code, args) {
  const p = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { if (p.exitCode === null) p.kill(); });
  let stdout = ''; let stderr = '';
  p.stdout.on('data', (b) => { stdout += b; }); p.stderr.on('data', (b) => { stderr += b; });
  const done = once(p, 'close').then(([exit]) => { assert.equal(exit, 0, stderr); return JSON.parse(stdout); });
  return { process: p, done };
}
const moduleURL = new URL('./m3-resource-budget.mjs', import.meta.url).href;

test('owned explicit root, persistent config identity, fixed whitelist and immutable manager', (t) => {
  const { root, manager: m } = fixture(t, { maxTotalBytes: CONTROL + 10000 });
  assert.equal(isM3ResourceBudget(m), true);
  assert.equal(isM3ResourceBudget({ ...m }), false);
  assert.equal(m.inspectBudget().usedBytes, CONTROL);
  assert.throws(() => openBudget({ root, limits: { maxTotalBytes: CONTROL + 20000 } }), { code: 'M3_CONFIG' });
  assert.equal(openBudget({ root }).inspectBudget().usedBytes, CONTROL);
  assert.equal(m.appendManagedLog({ operationId: 'bad', log: '../escape', record: {} }).ok, false);
  assert.throws(() => openBudget({ root: 'relative' }), { code: 'M3_ARGUMENT' });
});

test('nonempty unowned root is refused without deleting existing contents', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'm3-unowned-test-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  writeFileSync(join(base, 'keep.txt'), 'keep');
  assert.throws(() => openBudget({ root: base }), { code: 'M3_ROOT_NOT_OWNED' });
  assert.equal(readFileSync(join(base, 'keep.txt'), 'utf8'), 'keep');
});

test('capture reservations count the maximum of reservation and actual, release only after empty', (t) => {
  const { manager: m } = fixture(t, { maxTotalBytes: CONTROL + 1000 });
  const lease = m.reserveCapture({ id: 'one', bytes: 700 });
  assert.equal(lease.ok, true);
  writeFileSync(join(lease.tempRoot, 'partial.jsonl'), 'x'.repeat(500));
  writeFileSync(join(lease.tempRoot, 'empty.jsonl'), '');
  const inspected = m.inspectBudget();
  assert.equal(inspected.tempActualBytes, 500);
  assert.equal(inspected.tempChargedBytes, 700);
  assert.equal(inspected.usedBytes, CONTROL + 700);
  assert.equal(m.reserveCapture({ bytes: 301 }).ok, false);
  assert.equal(m.releaseCapture(lease.token).reason, 'capture-not-empty');
  assert.equal(m.inspectBudget().tempChargedBytes, 700);
  unlinkSync(join(lease.tempRoot, 'partial.jsonl'));
  unlinkSync(join(lease.tempRoot, 'empty.jsonl'));
  assert.equal(m.releaseCapture(lease.token).ok, true);
  assert.equal(m.inspectBudget().usedBytes, CONTROL);
});

test('append is idempotent for stable ID and canonical payload; ID conflicts never append', (t) => {
  const { root, manager: m } = fixture(t);
  const first = m.appendManagedLog({ operationId: 'stable', log: 'observations', record: { b: 2, a: 1 } });
  assert.equal(first.status, 'committed');
  const path = join(root, 'logs', 'observations.jsonl');
  const before = readFileSync(path);
  const again = m.appendManagedLog({ operationId: 'stable', log: 'observations', record: { a: 1, b: 2 } });
  assert.equal(again.status, 'committed');
  assert.equal(again.replayed, true);
  assert.equal(m.appendManagedLog({ operationId: 'stable', log: 'observations', record: { a: 3 } }).reason, 'operation-conflict');
  assert.deepEqual(readFileSync(path), before);
  assert.equal(m.reconcileOperation('stable').status, 'committed');
});

test('hard total/per-line/state-entry capacities refuse before writing', (t) => {
  const { root, manager: m } = fixture(t, { maxTotalBytes: CONTROL + 200, maxLineBytes: 180, maxOperations: 1 });
  assert.equal(m.appendManagedLog({ operationId: 'huge', log: 'observations', record: { value: 'x'.repeat(300) } }).reason, 'line-too-large');
  assert.equal(m.appendManagedLog({ operationId: 'one', log: 'observations', record: {} }).ok, true);
  const before = readFileSync(join(root, 'logs', 'observations.jsonl'));
  assert.equal(m.appendManagedLog({ operationId: 'two', log: 'observations', record: {} }).ok, false);
  assert.deepEqual(readFileSync(join(root, 'logs', 'observations.jsonl')), before);
});

test('partial existing tail blocks that sink, and stale locks are not deleted automatically', (t) => {
  const { root, manager: m } = fixture(t, { lockTimeoutMs: 10 });
  const file = join(root, 'logs', 'observations.jsonl'); writeFileSync(file, '{');
  assert.equal(m.appendManagedLog({ operationId: 'tail', log: 'observations', record: {} }).reason, 'incomplete-tail');
  assert.equal(readFileSync(file, 'utf8'), '{');
  const lock = join(root, 'budget.lock'); writeFileSync(lock, JSON.stringify({ pid: 99999999, token: 'stale' }));
  assert.throws(() => m.inspectBudget(), { code: 'M3_LOCK_BUSY' });
  assert.equal(JSON.parse(readFileSync(lock)).token, 'stale');
});

test('replaced lease directory cannot release its reservation', (t) => {
  const { manager: m } = fixture(t);
  const lease = m.reserveCapture({ bytes: 100 });
  renameSync(lease.tempRoot, lease.tempRoot + '-saved'); mkdirSync(lease.tempRoot);
  assert.equal(m.releaseCapture(lease.token).ok, false);
  rmSync(lease.tempRoot, { recursive: true }); renameSync(lease.tempRoot + '-saved', lease.tempRoot);
  assert.equal(m.releaseCapture(lease.token).ok, true);
});

test('two real processes compete for one quota; exited owner reservation persists', async (t) => {
  const { base, root, manager: m } = fixture(t, { maxTotalBytes: CONTROL + 5000 });
  const gate = join(base, 'go');
  const code = `import fs from 'node:fs';const [url,root,gate,id]=process.argv.slice(1);const {openBudget}=await import(url);const m=openBudget({root});while(!fs.existsSync(gate))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);console.log(JSON.stringify(m.reserveCapture({id,bytes:4000})));`;
  const a = await child(t, code, [moduleURL, root, gate, 'child-a']);
  const b = await child(t, code, [moduleURL, root, gate, 'child-b']);
  writeFileSync(gate, 'go');
  const results = await Promise.all([a.done, b.done]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  const lease = results.find((r) => r.ok);
  assert.equal(m.inspectBudget().tempChargedBytes, 4000);
  assert.equal(m.releaseCapture(lease.token).reason, 'owner-mismatch');
  assert.equal(m.recoverEmptyCapture(lease.token).ok, true);
  assert.equal(m.inspectBudget().tempChargedBytes, 0);
});

test('actual capture bytes above reservation remain charged and block further admission', (t) => {
  const { manager: m } = fixture(t, { maxTotalBytes: CONTROL + 600 });
  const lease = m.reserveCapture({ bytes: 100 });
  const file = join(lease.tempRoot, 'partial'); writeFileSync(file, 'x'.repeat(700));
  assert.equal(m.inspectBudget().tempChargedBytes, 700);
  assert.equal(m.inspectBudget().usedBytes, CONTROL + 700);
  assert.equal(m.reserveCapture({ bytes: 1 }).reason, 'total-budget-exceeded');
  assert.equal(m.appendManagedLog({ operationId: 'over', log: 'attempts', record: {} }).reason, 'total-budget-exceeded');
  assert.equal(m.releaseCapture(lease.token).ok, false);
  unlinkSync(file); assert.equal(m.releaseCapture(lease.token).ok, true);
});

test('two real processes serialize log admission against one remaining total allowance', async (t) => {
  const { base, root, manager: m } = fixture(t, { maxTotalBytes: CONTROL + 300 });
  const gate = join(base, 'go');
  const code = `import fs from 'node:fs';const [url,root,gate,id]=process.argv.slice(1);const {openBudget}=await import(url);const m=openBudget({root});while(!fs.existsSync(gate))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);console.log(JSON.stringify(m.appendManagedLog({operationId:id,log:'observations',record:{text:'x'.repeat(100)}})));`;
  const a = await child(t, code, [moduleURL, root, gate, 'log-a']);
  const b = await child(t, code, [moduleURL, root, gate, 'log-b']); writeFileSync(gate, 'go');
  const results = await Promise.all([a.done, b.done]);
  assert.equal(results.filter((r) => r.status === 'committed').length, 1);
  assert.equal(results.find((r) => !r.ok).reason, 'total-budget-exceeded');
  const text = readFileSync(join(root, 'logs', 'observations.jsonl'), 'utf8');
  assert.equal(text.trim().split('\n').length, 1);
  assert.equal(m.inspectBudget().usedBytes, CONTROL + Buffer.byteLength(text));
});

test('partial log write becomes durable unknown, same ID cannot replay, other sink remains usable', async (t) => {
  const { root } = fixture(t);
  const code = `import fs from 'node:fs';import {join} from 'node:path';const [url,root]=process.argv.slice(1);const {openBudget}=await import(url);const m=openBudget({root});const target=join(root,'logs','observations.jsonl');const originalOpen=fs.openSync,originalWrite=fs.writeSync;let targetFD,first=true;fs.openSync=function(p,...args){const fd=originalOpen(p,...args);if(p===target)targetFD=fd;return fd};fs.writeSync=function(fd,b,off,len,pos){if(fd===targetFD){if(first){first=false;return originalWrite(fd,b,off,7,pos)}throw Object.assign(new Error('synthetic partial EIO'),{code:'EIO'})}return originalWrite(fd,b,off,len,pos)};const firstResult=m.appendManagedLog({operationId:'partial',log:'observations',record:{text:'value'}});fs.openSync=originalOpen;fs.writeSync=originalWrite;const before=fs.readFileSync(target,'utf8');const same=m.appendManagedLog({operationId:'partial',log:'observations',record:{text:'value'}});const another=m.appendManagedLog({operationId:'another',log:'observations',record:{}});const otherSink=m.appendManagedLog({operationId:'terminal',log:'terminals',record:{}});console.log(JSON.stringify({firstResult,same,another,otherSink,before,after:fs.readFileSync(target,'utf8'),usage:m.inspectBudget()}));`;
  const result = await (await child(t, code, [moduleURL, root])).done;
  assert.equal(result.firstResult.status, 'unknown'); assert.equal(result.firstResult.errorCode, 'EIO');
  assert.equal(result.same.status, 'unknown'); assert.equal(result.another.reason, 'log-has-unknown-operation');
  assert.equal(result.otherSink.status, 'committed'); assert.equal(result.before.length, 7); assert.equal(result.after, result.before);
  assert.ok(result.usage.logs.observations.chargedBytes > result.usage.logs.observations.actualBytes);
  assert.deepEqual(result.usage.pendingOperations, ['partial']);
});

for (const fault of ['fsync', 'commit']) {
  test(`complete log plus ${fault} failure stays unknown until same-ID reconciliation, without duplicate`, async (t) => {
    const { root } = fixture(t);
    const code = `import fs from 'node:fs';import {join} from 'node:path';const [url,root,fault]=process.argv.slice(1);const {openBudget}=await import(url);const m=openBudget({root});const target=join(root,'logs','observations.jsonl');const originalOpen=fs.openSync,originalSync=fs.fsyncSync,originalRename=fs.renameSync;let targetFD,renames=0;fs.openSync=function(p,...args){const fd=originalOpen(p,...args);if(p===target)targetFD=fd;return fd};fs.fsyncSync=function(fd){if(fault==='fsync'&&fd===targetFD)throw Object.assign(new Error('synthetic fsync EIO'),{code:'EIO'});return originalSync(fd)};fs.renameSync=function(a,b){if(fault==='commit'&&a===join(root,'state.next')&&++renames===2)throw Object.assign(new Error('synthetic commit EIO'),{code:'EIO'});return originalRename(a,b)};const first=m.appendManagedLog({operationId:'uncertain',log:'observations',record:{text:'value'}});fs.openSync=originalOpen;fs.fsyncSync=originalSync;fs.renameSync=originalRename;const before=fs.readFileSync(target,'utf8');const reopened=openBudget({root});const same=reopened.appendManagedLog({operationId:'uncertain',log:'observations',record:{text:'value'}});console.log(JSON.stringify({first,same,before,after:fs.readFileSync(target,'utf8'),usage:reopened.inspectBudget()}));`;
    const result = await (await child(t, code, [moduleURL, root, fault])).done;
    assert.equal(result.first.status, 'unknown'); assert.equal(result.first.errorCode, 'EIO');
    assert.equal(result.same.status, 'committed'); assert.equal(result.same.replayed, true);
    assert.equal(result.before, result.after); assert.equal(result.after.trim().split('\n').length, 1);
    assert.deepEqual(result.usage.pendingOperations, []);
  });
}

for (const fault of ['EIO', 'EACCES']) {
  test(`${fault} on state read is preserved, old state remains intact and lock is released`, async (t) => {
    const { root } = fixture(t);
    const code = `import fs from 'node:fs';import {join} from 'node:path';const [url,root,fault]=process.argv.slice(1);const {openBudget}=await import(url);const m=openBudget({root});const path=join(root,'state.json');const before=fs.readFileSync(path,'utf8');const original=fs.readFileSync;fs.readFileSync=function(p,...args){if(p===path)throw Object.assign(new Error('synthetic read failure'),{code:fault});return original(p,...args)};let error;try{m.reserveCapture({bytes:10})}catch(e){error={code:e.code,unknown:e.unknown}}fs.readFileSync=original;const after=fs.readFileSync(path,'utf8');const lease=m.reserveCapture({bytes:10});console.log(JSON.stringify({error,before,after,lease,released:m.releaseCapture(lease.token),lock:fs.existsSync(join(root,'budget.lock'))}));`;
    const result = await (await child(t, code, [moduleURL, root, fault])).done;
    assert.equal(result.error.code, fault); assert.equal(result.before, result.after);
    assert.equal(result.lease.ok, true); assert.equal(result.released.ok, true); assert.equal(result.lock, false);
  });
}

test('release commit failure retains reservation and allows only known same-manager empty retry', async (t) => {
  const { root } = fixture(t);
  const code = `import fs from 'node:fs';import {join} from 'node:path';const [url,root]=process.argv.slice(1);const {openBudget}=await import(url);const m=openBudget({root});const lease=m.reserveCapture({bytes:200});const original=fs.renameSync;fs.renameSync=function(a,b){if(a===join(root,'state.next'))throw Object.assign(new Error('synthetic commit EIO'),{code:'EIO'});return original(a,b)};let code;try{m.releaseCapture(lease.token)}catch(e){code=e.code}fs.renameSync=original;const retained=m.inspectBudget();const other=openBudget({root}).releaseCapture(lease.token);const retry=m.releaseCapture(lease.token);console.log(JSON.stringify({code,retained,other,retry,final:m.inspectBudget()}));`;
  const result = await (await child(t, code, [moduleURL, root])).done;
  assert.equal(result.code, 'EIO'); assert.equal(result.retained.tempChargedBytes, 200);
  assert.equal(result.retained.leases[0].diagnostic, 'capture-missing-reservation-retained');
  assert.equal(result.other.reason, 'capture-ownership'); assert.equal(result.retry.ok, true);
  assert.equal(result.final.tempChargedBytes, 0);
});

test('missing committed log and corrupt state are not reinitialized or treated as empty', (t) => {
  const { root, manager: m } = fixture(t);
  assert.equal(m.appendManagedLog({ operationId: 'one', log: 'attempts', record: {} }).ok, true);
  unlinkSync(join(root, 'logs', 'attempts.jsonl'));
  assert.throws(() => m.inspectBudget(), { code: 'M3_LOG_STATE' });
  assert.throws(() => m.reserveCapture({ bytes: 1 }), { code: 'M3_LOG_STATE' });
  writeFileSync(join(root, 'state.json'), '{');
  assert.throws(() => openBudget({ root }), { code: 'M3_STATE' });
  assert.equal(readFileSync(join(root, 'state.json'), 'utf8'), '{');
});

test('bounded state capacity refuses an operation before its payload is appended', (t) => {
  const { root, manager: m } = fixture(t, { maxStateBytes: 1200 });
  let refused;
  for (let i = 0; i < 10; i++) {
    const result = m.appendManagedLog({ operationId: `state-${i}`, log: 'attempts', record: {} });
    if (!result.ok) { refused = result; break; }
  }
  assert.equal(refused?.reason, 'state-capacity');
  assert.ok(statSync(join(root, 'state.json')).size <= 1200);
  const lines = readFileSync(join(root, 'logs', 'attempts.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, m.inspectBudget().operationCount);
  assert.equal(readdirSync(root).includes('state.next'), false);
});

test('limits use own whitelist keys; record complexity and accessors refuse before writes', (t) => {
  const { root, manager: m } = fixture(t);
  for (const key of ['constructor', 'toString', '__proto__']) {
    const fresh = `${root}-${key}`; mkdirSync(fresh);
    assert.throws(() => openBudget({ root: fresh, limits: JSON.parse(`{"${key}":1}`) }), { code: 'M3_CONFIG' });
  }
  let getterCalls = 0;
  const accessor = { get secret() { getterCalls++; return 'not-read'; } };
  const largeArray = new Array(4097).fill(1);
  const manyKeys = Object.fromEntries(Array.from({ length: 4097 }, (_, i) => [`k${i}`, 1]));
  for (const record of [accessor, { largeArray }, manyKeys, { ['x'.repeat(150000)]: 1 }]) {
    assert.equal(m.appendManagedLog({ operationId: 'bad-record', log: 'observations', record }).ok, false);
  }
  assert.equal(getterCalls, 0);
  assert.equal(m.inspectBudget().operationCount, 0);
  assert.deepEqual(readdirSync(join(root, 'logs')), []);
});

for (const fault of ['post-rename', 'unlock']) {
  test(`release ${fault} ambiguity reconciles only this manager's bounded removal proof`, async (t) => {
    const { root } = fixture(t, { maxOperations: 1 });
    const code = `import fs from 'node:fs';import {join} from 'node:path';const [url,root,fault]=process.argv.slice(1);const {openBudget}=await import(url);const m=openBudget({root});const lease=m.reserveCapture({bytes:200});const originalRename=fs.renameSync,originalUnlink=fs.unlinkSync;fs.renameSync=function(a,b){const r=originalRename(a,b);if(fault==='post-rename'&&a===join(root,'state.next'))throw Object.assign(new Error('synthetic post-rename EIO'),{code:'EIO'});return r};fs.unlinkSync=function(p){if(fault==='unlock'&&p===join(root,'budget.lock'))throw Object.assign(new Error('synthetic unlock EIO'),{code:'EIO'});return originalUnlink(p)};let error;try{m.releaseCapture(lease.token)}catch(e){error={code:e.code,unknown:e.unknown}}fs.renameSync=originalRename;fs.unlinkSync=originalUnlink;if(fs.existsSync(join(root,'budget.lock')))fs.unlinkSync(join(root,'budget.lock'));const usage=m.inspectBudget();const unrelated=m.releaseCapture('11111111-1111-1111-1111-111111111111');const second=m.reserveCapture({bytes:100});const capped=m.releaseCapture(second.token);const retry=m.releaseCapture(lease.token);const secondRetry=m.releaseCapture(second.token);console.log(JSON.stringify({error,usage,unrelated,capped,retry,secondRetry}));`;
    const result = await (await child(t, code, [moduleURL, root, fault])).done;
    assert.equal(result.error.code, fault === 'unlock' ? 'M3_LOCK_RELEASE' : 'EIO');
    assert.equal(result.usage.tempChargedBytes, 0);
    assert.equal(result.unrelated.reason, 'unknown-token');
    assert.equal(result.capped.reason, 'release-proof-limit');
    assert.equal(result.retry.ok, true); assert.equal(result.retry.released, true);
    assert.equal(result.secondRetry.ok, true);
  });
}
