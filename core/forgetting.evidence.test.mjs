import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

// The optional override is for a frozen baseline or a workspace-only integration probe.
const source = process.env.AKASHA_FORGETTING_TEST_MODULE;
const { reduceEvidence } = await import(source ? pathToFileURL(source).href : './forgetting.mjs');
const target = { store: 'canon', id: 'canon-x', versionId: 'canon-x-r1', digest: 'sha256:' + 'a'.repeat(64) };
const options = {
  target, contextRef: 'environment:test',
  cutoff: '2026-10-24T04:00:00Z', now: '2026-10-24T05:00:00Z',
};
const common = (over = {}) => ({
  schemaVersion: 'akasha-evidence/v1', eventId: 'e1', target: { ...target },
  contextRef: options.contextRef, actor: { type: 'human', id: 'reviewer:test' },
  occurredAt: '2026-10-24T02:00:00Z', recordedAt: '2026-10-24T02:01:00Z', ...over,
});
const result = (over = {}) => ({
  ...common(), kind: 'review-result', result: 'pass', attemptId: 'a1', criterionId: 'c1',
  evidenceRefs: ['fixture:review-result'], ...over,
});
const revoke = (eventId, revokesEvent, over = {}) => ({
  ...common(), eventId, kind: 'revoke', revokesEvent,
  occurredAt: '2026-10-24T03:00:00Z', recordedAt: '2026-10-24T03:01:00Z', ...over,
});
const reduce = (events, over = {}) => reduceEvidence(events, { ...options, ...over });
const hasCode = (summary, code) => [...summary.diagnostics, ...summary.conflicts].some(x => x.code === code);

test('F11 evidence summary binds a human review to target, environment and instant cutoff', () => {
  const s = reduce([result()]);
  assert.equal(s.schemaVersion, 'akasha-evidence-summary/v1');
  assert.deepEqual(s.target, target);
  assert.equal(s.contextRef, options.contextRef);
  assert.equal(s.now, '2026-10-24T05:00:00.000Z');
  assert.equal(s.cutoff, '2026-10-24T04:00:00.000Z');
  assert.equal(s.coverage, 'ok');
  assert.equal(s.qualifyingPasses.length, 1);
  assert.equal(s.lastPassAt, '2026-10-24T02:00:00.000Z');
});

test('evidence options require a complete exact target, context and offset timestamps', () => {
  for (const patch of [
    { target: { ...target, digest: 'not-a-digest' } },
    { target: { ...target, versionId: '' } },
    { contextRef: '' }, { contextRef: 'not-applicable:' },
    { cutoff: '2026-10-24' }, { now: '2026-10-24T05:00:00' },
    { cutoff: '2026-10-24T06:00:00Z' },
  ]) assert.throws(() => reduce([], patch));
  assert.equal(reduce([], { contextRef: 'not-applicable:document-only' }).coverage, 'ok');
});

test('F12 mentions, exposure, failed and inconclusive results never qualify', () => {
  for (const kind of ['mention', 'exposure']) {
    const s = reduce([{ ...common(), kind }]);
    assert.equal(s.coverage, 'ok');
    assert.equal(s.qualifyingPasses.length, 0);
    assert.equal(s.lastPassAt, null);
  }
  for (const verdict of ['fail', 'inconclusive']) assert.equal(reduce([result({ result: verdict })]).qualifyingPasses.length, 0);
});

test('F12/F13/F15 bad evidence is isolated without a qualifying anchor', () => {
  const bad = [
    { schemaVersion: 'future/v999' }, { attemptId: null }, { criterionId: '' },
    { evidenceRefs: [] }, { evidenceRefs: [null] }, { evidenceRefs: [''] },
    { actor: null }, { actor: { type: 'human', id: '' } },
    { actor: { type: 'tool', id: 'tool:test' } },
    { target: { ...target, digest: null } }, { contextRef: null },
    { contextRef: 'not-applicable:' }, { occurredAt: null }, { recordedAt: null },
    { recordedAt: '2026-02-30T00:00:00Z' },
    { occurredAt: '2026-10-24T03:00:00Z', recordedAt: '2026-10-24T02:00:00Z' },
  ];
  for (const patch of bad) {
    const s = reduce([result(patch)]);
    assert.equal(s.coverage, 'incomplete', JSON.stringify(patch));
    assert.equal(s.qualifyingPasses.length, 0, JSON.stringify(patch));
    assert.equal(s.lastPassAt, null, JSON.stringify(patch));
    assert.ok(s.diagnostics.length > 0);
  }
});

test('reproduce/evaluation require explicit context, actor and result references', () => {
  for (const kind of ['reproduce-result', 'evaluation-result']) {
    const s = reduce([result({ kind, actor: { type: 'tool', id: 'runner:test' } })]);
    assert.equal(s.coverage, 'ok');
    assert.equal(s.qualifyingPasses.length, 1);
    const bad = reduce([result({ kind, contextRef: null, evidenceRefs: [null] })]);
    assert.equal(bad.coverage, 'incomplete');
    assert.equal(bad.qualifyingPasses.length, 0);
  }
});

test('F13 valid other targets or environments are excluded without contaminating coverage', () => {
  const variants = [
    { target: { ...target, store: 'mirror' } }, { target: { ...target, id: 'other' } },
    { target: { ...target, versionId: 'canon-x-r2' } },
    { target: { ...target, digest: 'sha256:' + 'b'.repeat(64) } },
    { contextRef: 'environment:other' },
  ];
  for (const patch of variants) {
    const s = reduce([result(patch)]);
    assert.equal(s.coverage, 'ok');
    assert.equal(s.qualifyingPasses.length, 0);
    assert.equal(s.lastPassAt, null);
  }
});

test('F14 duplicate IDs are idempotent; conflicting IDs exclude all members in either order', () => {
  assert.equal(reduce([result(), result()]).qualifyingPasses.length, 1);
  const a = result(), b = result({ result: 'fail' });
  const x = reduce([a, b]), y = reduce([b, a]);
  assert.deepEqual(x, y);
  assert.equal(x.coverage, 'conflicted');
  assert.equal(x.qualifyingPasses.length, 0);
  assert.ok(hasCode(x, 'event-id-conflict'));
});

test('F14 same attempt pass/fail conflicts before any qualifying anchor is exposed', () => {
  const a = result(), b = result({ eventId: 'e2', result: 'fail' });
  const x = reduce([a, b]), y = reduce([b, a]);
  assert.deepEqual(x, y);
  assert.equal(x.coverage, 'conflicted');
  assert.equal(x.lastPassAt, null);
  assert.ok(hasCode(x, 'attempt-result-conflict'));
});

test('F14/F15 same-result semantic duplicates choose a stable conservative representative', () => {
  const late = result({ eventId: 'e2', occurredAt: '2026-10-24T03:00:00Z', recordedAt: '2026-10-24T03:01:00Z' });
  const early = result();
  const a = reduce([late, early, early]), b = reduce([early, late]);
  assert.deepEqual(a, b);
  assert.equal(a.qualifyingPasses.length, 1);
  assert.equal(a.lastPassAt, '2026-10-24T02:00:00.000Z');
});

test('invalid duplicate members cannot shadow a valid semantic member by arrival order', () => {
  const bad = result({ eventId: 'invalid', evidenceRefs: [] }), good = result();
  const a = reduce([bad, good]), b = reduce([good, bad]);
  assert.deepEqual(a, b);
  assert.equal(a.coverage, 'incomplete');
  assert.deepEqual(a.qualifyingPasses.map(x => x.eventId), ['e1']);
});

test('F15 revoke controls remove a pass and can resolve a semantic pass/fail conflict', () => {
  assert.equal(reduce([result(), revoke('r1', 'e1')]).qualifyingPasses.length, 0);
  const pass = result(), fail = result({ eventId: 'e2', result: 'fail' }), removeFail = revoke('r2', 'e2');
  const a = reduce([pass, fail, removeFail]), b = reduce([removeFail, fail, pass]);
  assert.deepEqual(a, b);
  assert.equal(a.coverage, 'ok');
  assert.deepEqual(a.qualifyingPasses.map(x => x.eventId), ['e1']);
});

test('F15 explicit result replacement revokes the old attempt and retains the new attempt', () => {
  const replacement = result({ eventId: 'e2', attemptId: 'a2', revokesEvent: 'e1', occurredAt: '2026-10-24T03:00:00Z', recordedAt: '2026-10-24T03:01:00Z' });
  const s = reduce([result(), replacement]);
  assert.equal(s.coverage, 'ok');
  assert.deepEqual(s.qualifyingPasses.map(x => x.eventId), ['e2']);
});

test('F15 a revoked revoke restores the original event deterministically', () => {
  const a = reduce([result(), revoke('r1', 'e1'), revoke('r2', 'r1')]);
  const b = reduce([revoke('r2', 'r1'), result(), revoke('r1', 'e1')]);
  assert.deepEqual(a, b);
  assert.equal(a.coverage, 'ok');
  assert.deepEqual(a.qualifyingPasses.map(x => x.eventId), ['e1']);
});

test('F15 unknown revocation and revocation cycles are incomplete, never silent success', () => {
  const missing = reduce([revoke('r1', 'absent')]);
  assert.equal(missing.coverage, 'incomplete');
  assert.ok(hasCode(missing, 'unknown-revocation-target'));
  const a = reduce([revoke('r1', 'r2'), revoke('r2', 'r1')]);
  const b = reduce([revoke('r2', 'r1'), revoke('r1', 'r2')]);
  assert.deepEqual(a, b);
  assert.equal(a.coverage, 'incomplete');
  assert.ok(hasCode(a, 'revocation-cycle'));
});

test('F15 a revoke after cutoff has no effect on the historical summary', () => {
  const later = revoke('r1', 'e1', { occurredAt: '2026-10-24T04:10:00Z', recordedAt: '2026-10-24T04:11:00Z' });
  const s = reduce([result(), later]);
  assert.equal(s.coverage, 'ok');
  assert.deepEqual(s.qualifyingPasses.map(x => x.eventId), ['e1']);
});

test('F12/F15 offset cutoff compares instants; future occurrence is isolated', () => {
  const after = result({ recordedAt: '2026-10-23T23:50:00-05:00' });
  const s = reduce([after]);
  assert.equal(s.coverage, 'ok');
  assert.equal(s.qualifyingPasses.length, 0);
  const future = reduce([result({ occurredAt: '2099-01-01T00:00:00Z' })]);
  assert.equal(future.coverage, 'incomplete');
  assert.equal(future.lastPassAt, null);
  assert.ok(hasCode(future, 'clock-skew'));
});

test('revoke requires a legal actor and does not accept result payload fields', () => {
  for (const bad of [revoke('r1', 'e1', { actor: null }), revoke('r1', 'e1', { result: 'pass' })]) {
    const s = reduce([result(), bad]);
    assert.equal(s.coverage, 'incomplete');
    assert.deepEqual(s.qualifyingPasses.map(x => x.eventId), ['e1']);
  }
});

test('reduction is deterministic and does not mutate frozen inputs', () => {
  const e = result();
  Object.freeze(e.target); Object.freeze(e.actor); Object.freeze(e.evidenceRefs); Object.freeze(e);
  const before = JSON.stringify(e);
  assert.equal(reduce([e]).coverage, 'ok');
  assert.equal(JSON.stringify(e), before);
});
