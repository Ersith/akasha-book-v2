// Run from any cwd: node --test tests/review5-sleep.test.mjs
// All stores/logs are synthetic and isolated; never imports code or data from the installed Harness.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scratch = resolve(fileURLToPath(new URL('../_scratch/', import.meta.url)));
mkdirSync(scratch, { recursive: true });
const root = mkdtempSync(join(scratch, 'review5-sleep-'));
process.env.AKASHA_ROOT = join(root, 'default-data');
process.env.AKASHA_LOGS = join(root, 'default-logs');
process.env.AKASHA_QUERY_LOG = 'off';
mkdirSync(process.env.AKASHA_ROOT); mkdirSync(process.env.AKASHA_LOGS);
const lib = await import('../core/lib.mjs');
const sleep = await import('../core/sleep.mjs');
after(() => {
  assert.equal(dirname(resolve(root)), scratch, 'cleanup stays inside this checkout scratch directory');
  rmSync(root, { recursive: true, force: true });
});

const jsonl = (file, rows) => writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const canon = (id, ref = 'same', extra = {}) => ({
  id, claim: 'same established fact alpha beta gamma', source: { type: '复现', ref },
  last_reviewed: '2026-10-14', logged_at: '2026-10-14T00:00:00Z', ...extra
});
const mirror = (id, extra = {}) => ({
  id, story: 'asset import observation', situation: 'asset import failure alpha beta gamma',
  behavior: 'reimport asset delta epsilon', outcome: 'asset restored', social_reaction: 'accepted', emotion: 'relieved', ...extra
});
function fixture(name, rows = []) {
  const dir = join(root, name); mkdirSync(dir);
  const files = Object.fromEntries(lib.STORES.map((store) => [store, join(dir, store + '.jsonl')]));
  for (const file of Object.values(files)) writeFileSync(file, '');
  jsonl(files.canon, rows);
  const receipt = join(dir, 'apply.json'); const reviewLog = join(dir, 'review.jsonl');
  return {
    dir, files, receipt,
    records: (store = 'canon') => lib.loadStore(store, files[store]).records,
    current: (store = 'canon') => lib.currentRecords(lib.loadStore(store, files[store]).records),
    plan: () => {
      const p = sleep.sleepPlan({ files, today: '2026-10-14', out: false });
      assert.equal(p.ok, true, JSON.stringify(p)); return p.plan;
    },
    apply: (plan, options = {}) => sleep.applyPlan(plan, { files, dry: false, out: receipt, reviewLog, ...options }),
    revoke: (plan, options = {}) => sleep.revokePlan(plan, { files, dry: false, receipt, out: join(dir, 'revoke.json'), reviewLog, ...options }),
    retire: (id, options = {}) => lib.retireRecord('canon', id, { file: files.canon, ...options })
  };
}
const ids = (f) => f.current().map((r) => r.id).sort();
const ok = (result) => { assert.equal(result.ok, true, JSON.stringify(result)); return result; };

test('V06: only successful absorbs contribute source and sources; keeper provenance remains', () => {
  const f = fixture('mixed-sources', [
    canon('canon-a', 'A', { sources: [{ type: '复现', ref: 'prior-A' }] }),
    canon('canon-b', 'B', { sources: [{ type: '复现', ref: 'prior-B' }] }),
    canon('canon-c', 'C', { source: { type: '官方', ref: 'C' } }),
    canon('canon-akasha-usage', 'PROTECTED'), canon('canon-e', 'RETIRED')
  ]);
  for (const r of f.records()) assert.deepEqual(lib.validateRecord('canon', r), []);
  f.retire('canon-e', { reason: 'independent retirement' });
  const p = f.plan(); const op = p.ops.find((o) => o.keep === 'canon-a'); assert.ok(op);
  op.absorb.push('canon-c', 'canon-akasha-usage', 'canon-e');
  const a = ok(f.apply(p));
  assert.equal(a.receipt.basisOk, true); assert.equal(a.receipt.force, false);
  assert.deepEqual(a.receipt.ops[0].detail.map((d) => d.status), ['retired', 'refused-source-mismatch', 'refused-exempt', 'skipped']);
  const keeper = f.current().find((r) => r.id === 'canon-a-r1'); assert.ok(keeper);
  assert.deepEqual(keeper.source, { type: '复现', ref: 'A' });
  assert.deepEqual(keeper.sources.map((s) => s.ref), ['A', 'prior-A', 'B', 'prior-B']);
});

test('Q01: two normally generated merges preserve transitive provenance A <- (B <- C)', () => {
  const f = fixture('source-chain', [canon('canon-b', 'B'), canon('canon-c', 'C')]);
  ok(f.apply(f.plan()));
  jsonl(f.files.canon, [...f.records(), canon('canon-a', 'A', { logged_at: '2026-10-13T00:00:00Z' })]);
  const p = f.plan(); const a = ok(f.apply(p));
  assert.equal(a.receipt.basisOk, true);
  assert.deepEqual(f.current()[0].sources.map((s) => s.ref), ['A', 'B', 'C']);
  // Revoke only restores absorbed entries; successful provenance remains by the published contract.
  ok(f.revoke(p));
  assert.deepEqual(f.current().find((r) => r.id === 'canon-a-r1').sources.map((s) => s.ref), ['A', 'B', 'C']);
});

test('Q02: nonempty mergedText rejects before mutations, whitespace preserves keeper body', () => {
  for (const ref of ['same', 'different']) {
    const f = fixture('merged-text-' + ref, [canon('canon-a'), canon('canon-b', ref)]);
    const p = f.plan(); p.ops[0].mergedText = 'replacement claim';
    const before = readFileSync(f.files.canon, 'utf8');
    const a = ok(f.apply(p));
    assert.equal(a.receipt.ops[0].status, 'refused-merged-text');
    assert.equal(a.receipt.summary.retired, 0);
    assert.equal(readFileSync(f.files.canon, 'utf8'), before);
    p.ops[0].mergedText = ' \n\t';
    assert.equal(ok(f.apply(p)).receipt.summary.retired, 1);
    assert.equal(f.current()[0].claim, canon('unused').claim);
    if (ref === 'same') assert.equal(f.current()[0].id, 'canon-a', 'identical source causes no needless keeper revision');
  }
});

test('V07: self-absorption rejects the entire merge before retiring any participant', () => {
  for (const first of [true, false]) {
    const f = fixture('self-absorb-' + first, [canon('canon-a'), canon('canon-b')]);
    const p = f.plan(); const op = p.ops.find((o) => o.keep === 'canon-a'); assert.ok(op);
    if (first) op.absorb.unshift(op.keep); else op.absorb.push(op.keep);
    const before = readFileSync(f.files.canon, 'utf8');
    const a = ok(f.apply(p));
    assert.equal(a.receipt.ops[0].status, 'refused-self-absorb');
    assert.equal(a.receipt.summary.retired, 0);
    assert.equal(a.receipt.summary.refused, 1);
    assert.equal(readFileSync(f.files.canon, 'utf8'), before, 'reject before retiring either keeper or other candidates');
    assert.deepEqual(ids(f), ['canon-a', 'canon-b']);
  }
});

test('Q05/V07: receipt and reconstruction both reject protocol, self-layer and nonmembers', () => {
  const f = fixture('exempt-members', [canon('canon-a'), canon('canon-b'), canon('canon-akasha-usage'), canon('canon-self', 'same', { tags: ['自我'] }), canon('canon-outsider', 'outside', { claim: 'unrelated record' })]);
  const p = f.plan(); const a = ok(f.apply(p));
  const bad = [];
  for (const id of ['canon-akasha-usage', 'canon-self', 'canon-outsider']) {
    if (id !== 'canon-outsider') p.ops.push({ op: 'discard', store: 'canon', id });
    const r = f.retire(id, { reason: 'manual retirement', extra: { sleep_plan_id: p.planId, sleep_op_id: 'discard|canon|' + id } });
    bad.push({ op: 'discard', store: 'canon', id, tombstone: r.tombstone });
  }
  writeFileSync(f.receipt, JSON.stringify({ planId: p.planId, ops: [...a.receipt.ops, ...bad] }));
  const r = ok(f.revoke(p));
  assert.deepEqual(r.revoke.results.map((x) => x.id), ['canon-b']);
  assert.deepEqual(ids(f), ['canon-a', 'canon-b']);
});

test('V07: structured plan/op ownership cannot fall back to a matching legacy reason', () => {
  const cases = [
    ['wrong-plan', (p) => ({ sleep_plan_id: p.planId + '-other', sleep_op_id: 'merge|canon|canon-a' })],
    ['wrong-op', (p) => ({ sleep_plan_id: p.planId, sleep_op_id: 'discard|canon|canon-b' })],
    ['partial-metadata', (p) => ({ sleep_plan_id: p.planId })]
  ];
  for (const [name, extra] of cases) {
    const f = fixture(name, [canon('canon-a'), canon('canon-b')]); const p = f.plan();
    const r = f.retire('canon-b', { reason: 'merged-into canon-a · plan ' + p.planId, extra: extra(p) });
    writeFileSync(f.receipt, JSON.stringify({ planId: p.planId, ops: [{ op: 'merge', store: 'canon', keep: 'canon-a', detail: [{ id: 'canon-b', tombstone: r.tombstone }] }] }));
    const before = readFileSync(f.files.canon, 'utf8');
    assert.equal(f.revoke(p).ok, false, name);
    assert.equal(readFileSync(f.files.canon, 'utf8'), before, name);
  }
});

test('V07: store and target membership are scoped to the actual retirement operation', () => {
  const f = fixture('store-target', [canon('canon-a'), canon('canon-b')]); const p = f.plan();
  // A keeper is a plan participant, but is not an authorized retirement target.
  const keepTomb = f.retire('canon-a', { reason: 'manual retirement', extra: { sleep_plan_id: p.planId, sleep_op_id: 'merge|canon|canon-a' } });
  // Same id in another store does not authorize restoring that store's tombstone.
  jsonl(f.files.mirror, [mirror('canon-b')]);
  const otherTomb = lib.retireRecord('mirror', 'canon-b', { file: f.files.mirror, extra: { sleep_plan_id: p.planId, sleep_op_id: 'merge|mirror|canon-a' } });
  writeFileSync(f.receipt, JSON.stringify({ planId: p.planId, ops: [
    { op: 'merge', store: 'canon', keep: 'canon-a', detail: [{ id: 'canon-b', tombstone: keepTomb.tombstone }] },
    { op: 'merge', store: 'mirror', keep: 'canon-a', detail: [{ id: 'canon-b', tombstone: otherTomb.tombstone }] }
  ] }));
  assert.equal(f.revoke(p).ok, false);
  assert.deepEqual(ids(f), ['canon-b']); assert.equal(f.current('mirror').length, 0);
});

test('V07: a wrong receipt operation is rejected while a legitimate tombstone can still rebuild', () => {
  const f = fixture('receipt-op', [canon('canon-a'), canon('canon-b')]); const p = f.plan();
  const a = ok(f.apply(p)); const tombstone = a.receipt.ops[0].detail[0].tombstone;
  writeFileSync(f.receipt, JSON.stringify({ planId: p.planId, ops: [{ op: 'discard', store: 'canon', id: 'canon-b', tombstone }] }));
  const r = ok(f.revoke(p));
  assert.equal(r.revoke.results[0].rebuilt, true, 'do not trust the receipt operation; validate the actual planned merge');
  assert.deepEqual(ids(f), ['canon-a', 'canon-b']);
});

test('V07 legacy compatibility: exact merge/discard reasons work; mentions and wrong keeper do not', () => {
  for (const kind of ['merge', 'discard']) {
    const f = fixture('legacy-' + kind, [canon('canon-a'), canon('canon-b')]); const p = f.plan();
    if (kind === 'discard') p.ops = [{ op: 'discard', store: 'canon', id: 'canon-b', reason: 'snapshot-superseded' }];
    const reason = kind === 'merge' ? 'merged-into canon-a' : 'snapshot-superseded';
    f.retire('canon-b', { reason: reason + ' · plan ' + p.planId });
    const r = ok(f.revoke(p));
    assert.equal(r.revoke.results[0].rebuilt, true); assert.deepEqual(ids(f), ['canon-a', 'canon-b']);
  }
  for (const prefix of ['manual decision mentions plan ', 'merged-into wrong-keeper · plan ']) {
    const f = fixture('legacy-refuse-' + (prefix.startsWith('manual') ? 'mention' : 'keeper'), [canon('canon-a'), canon('canon-b')]);
    const p = f.plan(); f.retire('canon-b', { reason: prefix + p.planId });
    assert.equal(f.revoke(p).ok, false); assert.deepEqual(ids(f), ['canon-a']);
  }
});

test('V07: missing references stay diagnostic and cannot invoke original-id fallback', () => {
  const f = fixture('missing-fallback', [canon('canon-a'), canon('canon-b')]); const p = f.plan();
  f.retire('canon-b', { reason: 'independent manual retirement' });
  writeFileSync(f.receipt, JSON.stringify({ planId: p.planId, ops: [{ op: 'merge', store: 'canon', keep: 'canon-a', detail: [{ id: 'canon-b', tombstone: 'canon-b' }] }] }));
  const before = readFileSync(f.files.canon, 'utf8');
  for (const dry of [true, false]) {
    const r = ok(f.revoke(p, { dry })); assert.equal(r.revoke.results[0].status, 'missing');
    assert.equal(readFileSync(f.files.canon, 'utf8'), before);
  }
  // Historical empty-plan diagnostic remains compatible, with no recovery authorization.
  assert.equal(ok(f.revoke({ planId: p.planId, ops: [] })).revoke.results[0].status, 'missing');

  const h = fixture('missing-hard-delete', [canon('canon-a'), canon('canon-b')]); const hp = h.plan(); ok(h.apply(hp));
  h.retire('canon-b', { hard: true });
  assert.equal(ok(h.revoke(hp)).revoke.results[0].status, 'missing'); assert.deepEqual(ids(h), ['canon-a']);
});

test('N03: unrelated protocol retirement, plan prefix and mismatched receipt remain rejected', () => {
  const f = fixture('n03', [canon('canon-a'), canon('canon-b'), canon('canon-akasha-usage')]);
  const p = f.plan(); ok(f.apply(p));
  f.retire('canon-akasha-usage', { reason: 'manual decision mentions plan ' + p.planId });
  const before = readFileSync(f.files.canon, 'utf8');
  assert.equal(f.revoke('plan-').ok, false);
  assert.equal(readFileSync(f.files.canon, 'utf8'), before);
  const fake = join(f.dir, 'wrong-plan.json'); writeFileSync(fake, JSON.stringify({ planId: p.planId + '-other', ops: [] }));
  assert.equal(f.revoke(p, { receipt: fake }).ok, false);
  assert.equal(ok(f.revoke(p)).revoke.count, 1); assert.deepEqual(ids(f), ['canon-a', 'canon-b']);
});

test('N04: decisive mirror metadata preserves own-log retrieval', () => {
  const f = fixture('n04');
  const a = mirror('mirror-a', { evidence: 'story', role: 'boundary', era: 'ancient', context: 'classroom' });
  const b = mirror('mirror-b', { evidence: 'own-log', role: 'solution', era: '2026', context: 'production' });
  for (const key of ['evidence', 'role', 'era', 'context']) {
    assert.equal(sleep.mergeEligiblePair('mirror', a, { ...a, [key]: b[key] }).ok, false, key);
  }
  jsonl(f.files.mirror, [a, b]);
  const p = f.plan(); assert.equal(p.ops.filter((op) => op.store === 'mirror').length, 0); ok(f.apply(p));
  assert.deepEqual(lib.mirrorMatch('asset', { file: f.files.mirror, evidence: 'own-log' }).map((r) => r.id), ['mirror-b']);
});

test('N07: repeated apply/revoke reconstructs the new tombstone, not an already revoked one', () => {
  const f = fixture('n07', [canon('canon-a'), canon('canon-b')]); const p = f.plan();
  const a1 = ok(f.apply(p)); ok(f.revoke(p));
  assert.equal(ok(f.revoke(p)).revoke.results[0].status, 'already');
  const a2 = ok(f.apply(p, { force: true }));
  assert.notEqual(a1.receipt.ops[0].detail[0].tombstone, a2.receipt.ops[0].detail[0].tombstone);
  renameSync(f.receipt, f.receipt + '.saved');
  const r = ok(f.revoke(p)); assert.equal(r.revoke.count, 1); assert.equal(r.revoke.results[0].status, 'revoked');
  assert.equal(r.revoke.results[0].tombstone, a2.receipt.ops[0].detail[0].tombstone);
  assert.deepEqual(ids(f), ['canon-a', 'canon-b']);
});

test('R02: filtered merge and discard batches retain all successful receipt evidence', () => {
  for (const kind of ['merge', 'discard']) {
    const rows = kind === 'merge' ? [
      canon('canon-first-a', 'same', { claim: 'apple beta gamma delta' }), canon('canon-first-b', 'same', { claim: 'apple beta gamma delta' }),
      canon('canon-second-a', 'same', { claim: 'orange omega pi theta' }), canon('canon-second-b', 'same', { claim: 'orange omega pi theta' })
    ] : [canon('canon-one-20260101', 'same', { claim: 'old one' }), canon('canon-one-20261001', 'same', { claim: 'new one' }), canon('canon-two-20260101', 'same', { claim: 'old two' }), canon('canon-two-20261001', 'same', { claim: 'new two' })];
    const f = fixture('r02-' + kind, rows); const p = f.plan(); assert.equal(p.ops.length, 2);
    ok(f.apply(p, { only: p.ops[0].keep ?? p.ops[0].id }));
    ok(f.apply(p, { only: p.ops[1].keep ?? p.ops[1].id, force: true }));
    assert.equal(ok(f.revoke(p)).revoke.count, 2); assert.deepEqual(ids(f), rows.map((r) => r.id).sort());
  }
});

test('R03: receipt write failure and skipped retry still allow tombstone reconstruction', () => {
  const f = fixture('r03', [canon('canon-a'), canon('canon-b')]); const p = f.plan();
  mkdirSync(f.receipt); assert.equal(f.apply(p).ok, false); assert.deepEqual(ids(f), ['canon-a']);
  renameSync(f.receipt, f.receipt + '.blocked-directory');
  assert.equal(ok(f.apply(p, { force: true })).receipt.summary.retired, 0);
  const r = ok(f.revoke(p)); assert.equal(r.revoke.results[0].rebuilt, true); assert.deepEqual(ids(f), ['canon-a', 'canon-b']);
});

test('R14: failed inbox delivery preserves both input watermark and aggregate retry eligibility', () => {
  for (const aggregate of [false, true]) {
    const f = fixture('r14-' + aggregate);
    const opts = { log: join(f.dir, 'hooks.jsonl'), stateFile: join(f.dir, 'state.json'), inboxFile: join(f.dir, 'inbox.jsonl'), reportDir: join(f.dir, 'reports') };
    jsonl(opts.log, [aggregate ? { kind: 'gate-denied', tool: 'write', message: 'blocked' } : { kind: 'tool', tool: 'edit', ok: false, message: 'ENOENT fixture missing' }]);
    if (aggregate) writeFileSync(opts.stateFile, JSON.stringify({ processedBytes: 0, processedLines: 0, aggregates: { 'gate-denied': { miss: 1, lastCount: 1 } } }));
    mkdirSync(opts.inboxFile);
    const first = ok(sleep.sleepRun(opts));
    assert.equal(first.inboxWritten, false); assert.equal(first.state.processedBytes, 0);
    const recovered = join(f.dir, 'recovered-inbox.jsonl');
    const retry = ok(sleep.sleepRun({ ...opts, inboxFile: recovered }));
    assert.equal(retry.inboxWritten, true); assert.ok(retry.todo > 0); assert.ok(retry.state.processedBytes > 0);
    assert.ok(existsSync(recovered)); assert.ok(readFileSync(recovered, 'utf8').includes(aggregate ? 'gate-denied' : 'tool-error'));
  }
});
