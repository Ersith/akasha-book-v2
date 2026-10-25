import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'akasha-paired-view-test-'));
process.env.AKASHA_ROOT = join(root, 'unavailable-data');
process.env.AKASHA_LOGS = join(root, 'logs');
process.env.TEMP = process.env.TMP = root;
process.env.AKASHA_CATEGORY_SWITCH = '1';
mkdirSync(process.env.AKASHA_LOGS);
after(() => rmSync(root, { recursive: true, force: true }));

const { pairedLookupView, evaluateCapturedLookupView } = await import('./paired-lookup-view.mjs');
const pairedModule = await import('./paired-lookup-view.mjs');
const { captureLookupView } = await import('./captured-lookup-view.mjs');
const { lookupDetailed, loadStore, STORES } = await import('./lib.mjs');
const { recordReviewResult } = await import('./evidence.mjs');
const { recordToView } = await import('./record-view.mjs');
const clock = { now: '2026-10-25T00:00:00Z', cutoff: '2026-10-25T00:00:00Z', today: '2026-10-25' };
const record = (id, extra = {}) => ({ id, claim: 'memory repair', tags: ['经验'], event_time: '2026-09-01', ...extra });
function fixture(rows = [record('canon-a'), record('canon-b')]) {
  const dir = mkdtempSync(join(root, 'fixture-'));
  const tempRoot = join(dir, 'captures');
  mkdirSync(tempRoot);
  const files = Object.fromEntries(STORES.map(name => [name, join(dir, name + '.jsonl')]));
  for (const [name, file] of Object.entries(files)) writeFileSync(file, name === 'canon' ? rows.map(r => JSON.stringify(r) + '\n').join('') : '');
  return { dir, files, tempRoot, evidenceFile: join(dir, 'evidence.jsonl') };
}
const request = (extra = {}) => ({ query: 'memory', ...clock, ...extra });

test('disabled is a no-op even when source/parameters would throw; no temp/log writes', async () => {
  const before = readdirSync(root);
  const input = { get files() { throw new Error('source accessed'); }, get query() { throw new Error('query accessed'); } };
  assert.deepEqual(await pairedLookupView(input), { enabled: false, mode: 'off', reason: 'disabled' });
  input.enabled = false;
  assert.deepEqual(await pairedLookupView(input), { enabled: false, mode: 'off', reason: 'disabled' });
  assert.deepEqual(readdirSync(root), before);
  assert.deepEqual(readdirSync(process.env.AKASHA_LOGS), []);
});

test('paired result serves exactly one unchanged baseline and only observes candidate', async () => {
  const f = fixture();
  const before = readFileSync(f.files.canon);
  const result = await pairedLookupView({ enabled: true, ...f, ...request() });
  const expected = lookupDetailed('memory', { today: clock.today, files: f.files, categorySwitch: false, loadBalance: false, queryLog: false, __noQueryLog: true });
  assert.deepEqual(result.baseline, expected);
  assert.strictEqual(result.served, result.baseline);
  assert.equal(result.appliedToResults, false);
  assert.equal(result.shadow.evaluated, 2);
  assert.equal(result.view.atomicSourceSnapshot, false);
  assert.equal(result.inputDigest.length, 71);
  assert.deepEqual(readFileSync(f.files.canon), before);
  assert.deepEqual(readdirSync(f.tempRoot), []);
  assert.deepEqual(readdirSync(process.env.AKASHA_LOGS), []);
});

test('capture pins full stores and evidence even after originals are replaced', async () => {
  const rows = [record('canon-a'), record('canon-b')];
  const f = fixture(rows);
  const target = recordToView(rows[1], { store: 'canon', contextRef: 'lookup:captured' });
  recordReviewResult({ target: { store: target.store, id: target.id, versionId: target.versionId, digest: target.digest }, contextRef: 'lookup:captured', eventId: 'review-b', result: 'pass', humanId: 'fixture', attemptId: 'attempt-b', criterionId: 'criterion-b', occurredAt: '2026-10-24T20:00:00Z', recordedAt: '2026-10-24T20:01:00Z', evidenceRefs: ['fixture'] }, { file: f.evidenceFile });
  const view = await captureLookupView(f);
  try {
    const first = await evaluateCapturedLookupView(view, request({ lambda: 1 }));
    writeFileSync(f.files.canon, JSON.stringify(record('canon-replaced')) + '\n');
    writeFileSync(f.evidenceFile, '{broken');
    const second = await evaluateCapturedLookupView(view, request({ lambda: 1 }));
    assert.deepEqual(second, first);
    assert.deepEqual(first.baseline.hits.map(h => h.id), ['canon-a', 'canon-b']);
    assert.equal(first.candidate.hits[0].id, 'canon-b');
    assert.equal(first.served.hits[0].id, 'canon-a');
  } finally { assert.equal((await view.dispose()).ok, true); }
});

test('digest binds non-hit bytes, policy and clock as well as query results', async () => {
  const f = fixture();
  const a = await pairedLookupView({ enabled: true, ...f, ...request() });
  writeFileSync(f.files.lexicon, JSON.stringify({ id: 'lex-unmatched', term: 'other' }) + '\n');
  const b = await pairedLookupView({ enabled: true, ...f, ...request() });
  assert.deepEqual(a.baseline, b.baseline);
  assert.notEqual(a.inputDigest, b.inputDigest);
  const c = await pairedLookupView({ enabled: true, ...f, ...request({ lambda: 0.5 }) });
  assert.notEqual(b.inputDigest, c.inputDigest);
  const d = await pairedLookupView({ enabled: true, ...f, ...request({ cutoff: '2026-10-24T23:59:59Z' }) });
  assert.notEqual(b.inputDigest, d.inputDigest);
});

test('unsupported live inputs and invalid clocks are rejected before capture', async () => {
  const f = fixture();
  for (const options of [{ loadBalance: true }, { usageWindow: {} }, { files: f.files }, { categorySwitch: true }, { queryLog: 'x' }, { trace: true }, { misspelledOption: true }]) {
    await assert.rejects(pairedLookupView({ enabled: true, ...f, ...request({ options }) }), /unsupported|option/i);
  }
  for (const override of [{ now: 'yesterday' }, { today: '2026-02-30' }, { today: '2026-10-24' }, { cutoff: '2027-01-01T00:00:00Z' }, { query: 'x'.repeat(5000) }, { lambda: Infinity }, { policy: { mode: 'off' } }]) {
    await assert.rejects(pairedLookupView({ enabled: true, ...f, ...request(override) }));
  }
  assert.deepEqual(readdirSync(f.tempRoot), []);
});

test('request parameters are copied before async capture; caller mutation has no effect', async () => {
  const f = fixture();
  const options = { tag: '经验' };
  const policy = { C2: { halfLifeDays: 20 } };
  const pending = pairedLookupView({ enabled: true, ...f, ...request({ options, policy }) });
  options.tag = 'missing';
  policy.C2.halfLifeDays = 999;
  const result = await pending;
  assert.equal(result.baseline.hits.length, 2);
  assert.equal(result.parameters.options.tag, '经验');
  assert.equal(result.parameters.policy.C2.halfLifeDays, 20);
});

test('perspective typo is rejected rather than silently filtering out all hits', async () => {
  const f = fixture([record('canon-world', { perspective: 'world' })]);
  await assert.rejects(pairedLookupView({ enabled: true, ...f, ...request({ options: { perspective: 'experince' } }) }), /perspective/);
  assert.deepEqual(readdirSync(f.tempRoot), []);
  const good = await pairedLookupView({ enabled: true, ...f, ...request({ options: { perspective: 'world' } }) });
  assert.equal(good.baseline.hits.length, 1);
});

test('superseded records and repeated cached consumption share the captured current version', async () => {
  const f = fixture([record('canon-old'), record('canon-new', { supersedes: 'canon-old' })]);
  const view = await captureLookupView(f);
  try {
    const a = await evaluateCapturedLookupView(view, request());
    const b = await evaluateCapturedLookupView(view, request());
    assert.deepEqual(a, b);
    assert.deepEqual(a.baseline.hits.map(h => h.id), ['canon-new']);
    assert.deepEqual(a.shadow.diagnostics.map(h => h.id), ['canon-new']);
  } finally { await view.dispose(); }
});

test('tampered/forged/disposed views cannot produce a valid pair', async () => {
  const f = fixture();
  await assert.rejects(evaluateCapturedLookupView({ files: f.files, verify: async () => ({ ok: true }) }, request()), /captured|view/i);
  const view = await captureLookupView(f);
  try {
    writeFileSync(view.files.canon, JSON.stringify(record('canon-tampered')) + '\n');
    await assert.rejects(evaluateCapturedLookupView(view, request()), /integrity|captured|changed/i);
  } finally { await view.dispose(); }
  await assert.rejects(evaluateCapturedLookupView(view, request()), /captured|view/i);
});

test('legacy object cache cannot replace the captured bytes named by the digest', async () => {
  const f = fixture();
  const view = await captureLookupView(f);
  try {
    const cached = loadStore('canon', view.files.canon);
    cached.records[0].claim = 'cache-only-content';
    const result = await evaluateCapturedLookupView(view, request());
    assert.deepEqual(result.baseline.hits.map(h => h.id), ['canon-a', 'canon-b']);
    assert.equal(result.shadow.evaluated, 2);
    assert.ok(result.baseline.hits.every(h => !h.snippet.includes('cache-only-content')));
  } finally { await view.dispose(); }
});

test('evaluation errors remain visible and never turn candidate into served output', async () => {
  const f = fixture([record('canon-bad', { review: { kind: 'nope' } })]);
  const result = await pairedLookupView({ enabled: true, ...f, ...request() });
  assert.ok(result.shadow.skipped.some(item => item.reason === 'evaluate-error'));
  assert.equal(result.candidate.applied, false);
  assert.equal(result.candidate.reason, 'incomplete-evidence');
  assert.strictEqual(result.served, result.baseline);
  assert.deepEqual(readdirSync(f.tempRoot), []);
});

test('mutation during evidence consumption is rejected by the final verification', async () => {
  const f = fixture();
  const view = await captureLookupView(f);
  const originalRead = fs.readFileSync;
  try {
    fs.readFileSync = function(file, ...args) {
      const bytes = originalRead.call(this, file, ...args);
      if (file === view.evidenceFile) writeFileSync(view.files.canon, JSON.stringify(record('canon-late-change')) + '\n');
      return bytes;
    };
    syncBuiltinESMExports();
    await assert.rejects(evaluateCapturedLookupView(view, request()), { code: 'CAPTURED_VIEW_INTEGRITY' });
  } finally {
    fs.readFileSync = originalRead;
    syncBuiltinESMExports();
    assert.equal((await view.dispose()).ok, true);
  }
});

test('cleanup failure is explicit, preserves foreign entries and exposes a retry', async () => {
  const f = fixture();
  const originalRead = fs.readFileSync;
  let extra, failure;
  try {
    fs.readFileSync = function(file, ...args) {
      const bytes = originalRead.call(this, file, ...args);
      if (String(file).endsWith('evidence.jsonl') && String(file).startsWith(f.tempRoot)) {
        extra = join(dirname(file), 'foreign.txt');
        writeFileSync(extra, 'preserve');
      }
      return bytes;
    };
    syncBuiltinESMExports();
    await assert.rejects(pairedLookupView({ enabled: true, ...f, ...request() }), error => {
      failure = error;
      assert.equal(error.code, 'CAPTURED_VIEW_CLEANUP');
      assert.equal(error.cause.code, 'CAPTURED_VIEW_INTEGRITY');
      assert.equal(error.cleanup.ok, false);
      return true;
    });
  } finally {
    fs.readFileSync = originalRead;
    syncBuiltinESMExports();
    if (extra) {
      assert.equal(readFileSync(extra, 'utf8'), 'preserve');
      fs.unlinkSync(extra);
    }
    if (failure?.dispose) assert.equal((await failure.dispose()).ok, true);
  }
  assert.deepEqual(readdirSync(f.tempRoot), []);
});

test('paired evaluation owns the view until post-verification and rejects overlapping disposal/evaluation', async () => {
  const f = fixture(); const view = await captureLookupView(f);
  let pending;
  try {
    pending = evaluateCapturedLookupView(view, request());
    await assert.rejects(view.dispose(), { code: 'CAPTURE_IN_USE' });
    await assert.rejects(evaluateCapturedLookupView(view, request()), { code: 'CAPTURE_IN_USE' });
    const result = await pending;
    assert.strictEqual(result.served, result.baseline);
    assert.equal(result.appliedToResults, false);
    assert.equal((await view.verify()).ok, true);
  } finally { if (pending) await pending.catch(() => {}); assert.equal((await view.dispose()).ok, true); }
});

test('prepared requests are branded immutable copies and ordinary parameter objects cannot bypass validation', async () => {
  const f = fixture(); const view = await captureLookupView(f);
  const options = { tag: '经验' }, policy = { C2: { halfLifeDays: 20 } };
  try {
    const prepared = pairedModule.preparePairedLookupRequest(request({ options, policy }));
    options.tag = 'missing'; policy.C2.halfLifeDays = 999;
    assert.throws(() => { prepared.options.tag = 'changed'; }, TypeError);
    assert.throws(() => { prepared.policy.C2.halfLifeDays = 999; }, TypeError);
    const result = await evaluateCapturedLookupView(view, prepared);
    assert.strictEqual(result.parameters, prepared);
    assert.equal(result.baseline.hits.length, 2);
    assert.equal(prepared.policy.C2.halfLifeDays, 20);
    await assert.rejects(evaluateCapturedLookupView(view, { ...prepared }), /controlled|unsupported|option/i);
  } finally { assert.equal((await view.dispose()).ok, true); }
});
