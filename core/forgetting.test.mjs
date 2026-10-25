import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_POLICY, canonicalJson, recordDigest, validatePolicy, dateOnly, dayDiff,
  classifyLegacy, normalizeView, reduceEvidence, evaluate, reviewOverlay, applyTime, shadowScore,
} from './forgetting.mjs';

const policy = validatePolicy({ mode: 'rank', lambda: 0.1, c3Enabled: true });
const now = '2026-10-24T04:00:00Z';
const view = (over = {}) => ({
  store: 'canon', id: 'canon-x', versionId: 'canon-x-r1', content: { text: 'x' },
  contentClass: 'C2', eventDay: '2026-09-24', contextRef: 'env:test', review: null, ...over,
});
const target = () => ({ store: 'canon', id: 'canon-x', versionId: 'canon-x-r1', digest: recordDigest(view()) });
const evidenceOptions = () => ({ target: target(), contextRef: 'env:test', cutoff: '2026-10-24T03:00:00Z', now });
const event = (over = {}) => ({
  schemaVersion: 'akasha-evidence/v1',
  eventId: 'e1', kind: 'review-result', result: 'pass',
  target: target(), contextRef: 'env:test', actor: { type: 'human', id: 'reviewer:test' },
  attemptId: 'a1', criterionId: 'c1', occurredAt: '2026-10-24T02:00:00Z',
  recordedAt: '2026-10-24T02:01:00Z', evidenceRefs: ['file:test'], ...over,
});
const nonResultEvent = (over = {}) => {
  const { result, attemptId, criterionId, evidenceRefs, ...common } = event();
  return { ...common, kind: 'mention', ...over };
};

test('canonical JSON is key-order independent and digest changes on content/version', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }));
  assert.equal(recordDigest({ store: 'canon', id: 'x', content: { a: 1 } }), recordDigest({ store: 'canon', id: 'x', content: { a: 1 } }));
  assert.notEqual(recordDigest({ store: 'canon', id: 'x', content: { a: 1 } }), recordDigest({ store: 'canon', id: 'x', content: { a: 2 } }));
  assert.notEqual(recordDigest({ store: 'canon', id: 'x', content: { a: 1 } }), recordDigest({ store: 'canon', id: 'x', versionId: 'x-r2', content: { a: 1 } }));
});

test('date parsing is strict and calendar-real', () => {
  assert.equal(dateOnly('2026-10-24').status, 'ok');
  assert.equal(dateOnly('2024-02-29').status, 'ok');
  assert.equal(dateOnly('2026-02-29').status, 'invalid');
  assert.equal(dateOnly('2026-02-30').status, 'invalid');
  assert.equal(dateOnly('2026-10-24T00:00:00Z').status, 'invalid');
  assert.equal(dateOnly('').status, 'missing');
  assert.equal(dayDiff('2026-09-24', '2026-10-24'), 30);
});

test('legacy classification protects self/protocol and does not default canon to C1', () => {
  assert.deepEqual(classifyLegacy('canon', { id: 'canon-self', tags: ['自我'] }), { contentClass: 'C1', protection: true, reasons: ['self-or-protocol'] });
  assert.equal(classifyLegacy('canon', { id: 'canon-plain', tags: [] }).contentClass, 'unknown');
  assert.equal(classifyLegacy('canon', { id: 'canon-exp', tags: ['经验'] }).contentClass, 'C2');
  assert.equal(classifyLegacy('mirror', { id: 'm', role: 'solution' }).contentClass, 'C2');
  assert.equal(classifyLegacy('orphan', { id: 'o' }).contentClass, 'unknown');
  assert.equal(classifyLegacy('session', { id: 's', temporary: true }).contentClass, 'C3');
});

test('C1/protected are always retention 1; unknown is null/factor 1', () => {
  const c1 = evaluate(view({ contentClass: 'C1', protection: true }), {}, { today: '2026-10-24', policy });
  assert.equal(c1.retention, 1);
  assert.equal(c1.factor, 1);
  const unknown = evaluate(view({ contentClass: 'unknown' }), {}, { today: '2026-10-24', policy });
  assert.equal(unknown.retention, null);
  assert.equal(unknown.factor, 1);
});

test('C2 and C3 curves match the fixed half-life values', () => {
  assert.equal(evaluate(view(), {}, { today: '2026-10-24', policy }).retention, 0.625);
  assert.equal(evaluate(view({ eventDay: '2026-08-25' }), {}, { today: '2026-10-24', policy }).retention, 0.4375);
  const c3 = view({ contentClass: 'C3', eventDay: '2026-10-17' });
  assert.equal(evaluate(c3, {}, { today: '2026-10-24', policy }).retention, 0.625);
  assert.equal(evaluate(c3, {}, { today: '2026-10-24', policy: validatePolicy({ ...DEFAULT_POLICY, c3Enabled: false }) }).retention, null);
});

test('C2 uses a qualifying pass as a new anchor, not mention counts', () => {
  const summary = reduceEvidence([event()], evidenceOptions());
  const fresh = evaluate(view(), summary, { today: '2026-10-24', now, policy });
  assert.equal(fresh.retention, 1);
  const mention = reduceEvidence([nonResultEvent()], evidenceOptions());
  assert.equal(evaluate(view(), mention, { today: '2026-10-24', now, policy }).retention, 0.625);
});

test('evidence dedup, attempt conflict and revocation fail closed', () => {
  const same = reduceEvidence([event(), event()], evidenceOptions());
  assert.equal(same.events, 1);
  assert.equal(same.qualifyingPasses.length, 1);
  const conflict = reduceEvidence([event(), event({ eventId: 'e2', result: 'fail' })], evidenceOptions());
  assert.equal(conflict.qualifyingPasses.length, 0);
  assert.ok(conflict.conflicts.some((c) => c.code === 'attempt-result-conflict'));
  const revoked = reduceEvidence([
    event(),
    nonResultEvent({ eventId: 'e2', kind: 'revoke', revokesEvent: 'e1' }),
  ], evidenceOptions());
  assert.equal(revoked.qualifyingPasses.length, 0);
});

test('C4 overlay preserves after/on-or-after boundaries and doubles no severity', () => {
  const due = reviewOverlay(view({ review: { kind: 'frontier-review', dueDay: '2026-10-14', boundary: 'on-or-after' } }), { today: '2026-10-24', policy });
  assert.equal(due.state, 'overdue');
  assert.equal(due.overdueDays, 10);
  assert.ok(Math.abs(due.urgency - 0.6321205588285577) < 1e-12);
  const scheduled = reviewOverlay(view({ review: { kind: 'frontier-review', dueDay: '2026-10-25', boundary: 'on-or-after' } }), { today: '2026-10-24', policy });
  assert.equal(scheduled.state, 'scheduled');
  assert.equal(scheduled.urgency, 0);
  const closed = reviewOverlay(view({ review: { kind: 'task', dueDay: '2026-10-01', openState: 'closed', sourceTaskRef: { source: 'fixture-tasks', id: 't1', revision: 'r1' } } }), { today: '2026-10-24', policy });
  assert.equal(closed.state, 'closed');
  assert.equal(closed.urgency, null);
});

test('rank factor and shadow are bounded; off is baseline', () => {
  const eval625 = evaluate(view(), {}, { today: '2026-10-24', policy });
  const ranked = applyTime(100, eval625, { mode: 'recent' }, policy);
  assert.equal(ranked.factor, 0.9625);
  assert.equal(ranked.rank, 96.25);
  assert.equal(applyTime(100, eval625, { mode: 'exact' }, policy).factor, 1);
  assert.equal(shadowScore(100, eval625, { mode: 'recent' }, policy).rank, 96.25);
  assert.equal(applyTime(100, eval625, { mode: 'recent' }, validatePolicy({ mode: 'off' })).rank, 100);
});

test('frozen input is not mutated and injection attempts fail on invalid policy', () => {
  const input = Object.freeze({ store: 'canon', id: 'x', content: Object.freeze({ a: 1 }), contentClass: 'C2', eventDay: '2026-09-24' });
  assert.doesNotThrow(() => normalizeView(input));
  assert.throws(() => validatePolicy({ ...DEFAULT_POLICY, C2: { floor: 0, halfLifeDays: 30 } }), /floor/);
  assert.throws(() => applyTime(100, evaluate(view(), {}, { today: '2026-10-24', policy }), { mode: 'recent' }, validatePolicy({ ...DEFAULT_POLICY, lambda: 2 })), /lambda/);
});
