import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as f from './forgetting.mjs';

// Pure fixtures only: no bank, logs, ambient clock or filesystem access.
const today = '2026-10-24';
const now = '2026-10-24T04:00:00Z';
const policy = { mode: 'rank', lambda: 0.1, c3Enabled: true, timezone: 'Asia/Shanghai' };
const view = (over = {}) => ({
  store: 'canon', id: 'fixture', versionId: 'fixture-r1', content: { text: 'fixture-body' },
  contentClass: 'C2', eventDay: '2026-09-24', eligibility: true, review: null, ...over,
});
const evaluate = (over = {}, opts = {}) => f.evaluate(view(over), undefined, { today, now, policy, ...opts });
const overlay = (review, over = {}) => f.reviewOverlay(view({ review, ...over }), { today, now, policy });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);
const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};
const batch = (candidates, opts = {}) => f.applyTimeBatch(candidates, {
  queryContext: { mode: 'recent' }, policy, generation: 'fixture-g1', ...opts,
});
const candidates = () => freeze([
  { id: 'A', baseRank: 100, raw: 101, strong: true, threshold: 50, eligibility: true,
    generation: 'fixture-g1', evaluation: { retention: 0.625 } },
  { id: 'B', baseRank: 99, raw: 102, strong: false, threshold: 51, eligibility: { eligible: true, reason: 'fixture' },
    generation: 'fixture-g1', evaluation: { retention: 1 } },
]);

test('F01 versioned SHA256 has a fixed known vector, no body leakage, stable key order and immutable projection', () => {
  const source = freeze({ store: 'canon', id: 'x', versionId: 'x-r1', content: { claim: 'marker-original-content' } });
  const before = JSON.stringify(source);
  const digest = f.recordDigest(source);
  assert.equal(digest, 'sha256:964e6f50c132bfb218d2a96f7cc5365d39752fdcacdef521203db018b2ca8a99');
  assert.match(digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(digest.includes(source.content.claim), false);
  const payload = f.canonicalJson({ schema: f.FORGETTING_SCHEMA, ...source });
  assert.equal(digest, 'sha256:' + createHash('sha256').update(payload).digest('hex'));
  assert.equal(f.recordDigest({ ...source, content: { b: 2, a: 1 } }), f.recordDigest({ ...source, content: { a: 1, b: 2 } }));
  for (const delta of [{ store: 'mirror' }, { id: 'y' }, { versionId: 'x-r2' }, { content: { claim: 'changed' } }]) {
    assert.notEqual(f.recordDigest({ ...source, ...delta }), digest);
  }
  const projected = f.normalizeView({ ...source, contentClass: 'C2', eventDay: '2026-09-24' });
  assert.equal(projected.digest, digest);
  assert.equal(JSON.stringify(projected).includes(source.content.claim), false);
  assert.equal(JSON.stringify(source), before);
});

test('F01 canonical JSON rejects sparse, cyclic, nonplain and unsupported values', () => {
  const cyclic = {}; cyclic.self = cyclic;
  for (const value of [new Array(1), [, 1], cyclic, new Date(0), new Map(), new Set(), /x/, undefined, NaN, Infinity, 1n]) {
    assert.throws(() => f.canonicalJson(value), TypeError);
  }
  assert.equal(f.canonicalJson({ b: [null, true, 'x'], a: 1 }), '{"a":1,"b":[null,true,"x"]}');
});

test('F02 normalized view preserves upstream eligibility, chain, current version, protection reasons and time precision', () => {
  const source = freeze(view({ eligibility: { eligible: false, reason: 'superseded' },
    chain: { rootId: 'fixture', supersedes: 'fixture-r0' }, currentVersion: 'fixture-r2',
    protectionReasons: ['self-layer'], contextRef: 'env:fixture', eventDay: undefined,
    eventTime: '2026-10-17T04:00:00Z' }));
  const normalized = f.normalizeView(source);
  for (const key of ['eligibility', 'chain', 'currentVersion', 'protectionReasons', 'contextRef', 'eventTime']) {
    assert.deepEqual(normalized[key], source[key], key);
  }
  assert.equal(f.normalizeView(view({ eligibility: false })).eligibility, false);
  const rejected = evaluate({ eligibility: { eligible: false, reason: 'superseded' } });
  assert.equal(f.applyTime(100, rejected, { mode: 'recent' }, policy).rank, 100);
});

test('F02 self kinds, tags, legacy IDs and protocol IDs take precedence over experience classification', () => {
  for (const record of [
    { id: 'tagged', tags: ['经验', '自我'] },
    { id: 'identity-record', kind: 'identity', tags: ['经验'] },
    { id: 'address-record', kind: 'address', tags: ['经验'] },
    { id: 'canon-self-concept-r2', tags: ['经验'] },
    { id: 'canon-address-layers-r2', tags: ['经验'] },
    { id: 'canon-memory-auto-record-r2', tags: ['经验'] },
    { id: 'canon-akasha-usage-r3', tags: ['经验'] },
  ]) {
    const cls = f.classifyLegacy('canon', record);
    assert.equal(cls.contentClass, 'C1', record.id);
    assert.equal(cls.protection, true, record.id);
  }
  assert.equal(f.classifyLegacy('canon', { id: 'extra-protocol', tags: ['经验'] }, { protocolIds: ['extra-protocol'] }).protection, true);
});

test('F03 legacy review stays strictly after 30 days and frontier review includes the due day', () => {
  for (const [anchor, age, due] of [['2026-09-24', 30, false], ['2026-09-23', 31, true]]) {
    assert.equal(evaluate({ eventDay: anchor }).ageDays, age);
    const dueDay = anchor === '2026-09-24' ? '2026-10-24' : '2026-10-23';
    const result = overlay({ kind: 'legacy-review', dueDay, boundary: 'after' });
    assert.equal(result.state === 'overdue', due, anchor);
  }
  for (const [dueDay, due] of [['2026-10-23', true], ['2026-10-24', true], ['2026-10-25', false]]) {
    assert.equal(overlay({ kind: 'frontier-review', dueDay, boundary: 'on-or-after' }).state === 'overdue', due, dueDay);
  }
});

test('F04 missing and invalid dates fail closed for C2/C3 while C1 remains protected', () => {
  for (const eventDay of [undefined, '', '2026-02-29', '2026-02-30', '2026-99-99', '2026-10-24garbage']) {
    for (const contentClass of ['C2', 'C3']) {
      const result = evaluate({ eventDay, contentClass });
      assert.equal(result.retention, null, `${contentClass} ${eventDay}`);
      assert.equal(f.applyTime(100, result, { mode: 'recent' }, policy).factor, 1);
    }
    assert.equal(evaluate({ eventDay, contentClass: 'C1' }).retention, 1);
  }
  for (const eventTime of ['2026-10-17T04:00:00', '2026-02-30T04:00:00Z', 'bad-time']) {
    assert.equal(evaluate({ eventDay: undefined, eventTime }).retention, null, eventTime);
  }
  assert.equal(f.dateOnly('2024-02-29').status, 'ok');
  assert.equal(f.dateOnly('2026-02-29').status, 'invalid');
});

test('F04 future event dates and instants cannot become a fresh retention anchor', () => {
  assert.equal(evaluate({ eventDay: '2026-10-25' }).retention, null);
  assert.equal(evaluate({ eventDay: undefined, eventTime: '2026-10-24T04:00:01Z' }).retention, null);
  assert.equal(evaluate({ eventDay: undefined, eventTime: '2026-10-17T04:00:00Z' }, { now: undefined }).retention, null);
  assert.equal(evaluate({}, { now: undefined }).retention, 0.625);
});

test('F06 protected retention is not evidence of verification and unknown is not temporary C3', () => {
  for (const over of [{ contentClass: 'C1' }, { contentClass: 'C2', protection: true }]) {
    const result = evaluate(over);
    assert.equal(result.retention, 1);
    assert.equal(result.factor, 1);
    assert.notEqual(result.verified, true);
    assert.equal(f.applyTime(100, result, { mode: 'recent' }, policy).rank, 100);
  }
  const unknown = evaluate({ contentClass: 'unknown' });
  assert.equal(unknown.retention, null);
  assert.equal(unknown.contentClass, 'unknown');
  assert.equal(f.classifyLegacy('session', { id: 'unmarked' }).contentClass, 'unknown');
});

test('F07 C2 fixed half-life curve is monotonic, bounded and does not grow H', () => {
  const rows = [['2026-10-24', 0, 1], ['2026-09-24', 30, 0.625], ['2026-08-25', 60, 0.4375]];
  const values = rows.map(([eventDay, age, retention]) => {
    const result = evaluate({ eventDay });
    assert.equal(result.ageDays, age); assert.equal(result.retention, retention); return result.retention;
  });
  assert.ok(values[0] >= values[1] && values[1] >= values[2]);
  assert.ok(evaluate({ eventDay: '1900-01-01' }).retention >= 0.25);
  assert.throws(() => f.validatePolicy({ hGrowth: true }), /hGrowth/);
});

test('F08 C3 uses event time, explicit temporary classification and its own fixed half-life', () => {
  for (const [eventDay, retention] of [['2026-10-24', 1], ['2026-10-17', 0.625], ['2026-10-10', 0.4375]]) {
    assert.equal(evaluate({ store: 'session', contentClass: 'C3', eventDay }).retention, retention);
  }
  const oldEvent = evaluate({ store: 'session', contentClass: 'C3', eventDay: undefined,
    eventTime: '2026-10-17T04:00:00Z', logged_at: now });
  assert.equal(oldEvent.ageDays, 7); assert.equal(oldEvent.retention, 0.625);
  assert.equal(f.classifyLegacy('session', { id: 'temp', temporary: true }).contentClass, 'C3');
  assert.equal(f.classifyLegacy('session', { id: 'temp', temporary: false }).contentClass, 'unknown');
  assert.equal(evaluate({ contentClass: 'C3' }, { policy: { ...policy, c3Enabled: false } }).retention, null);
  const promoted = evaluate({ id: 'promoted', versionId: 'promoted-r1', contentClass: 'C2', eventDay: '2026-10-17' });
  near(promoted.retention, 0.25 + 0.75 * 2 ** (-7 / 30));
});

test('F09 C4 urgency exact vectors do not multiply severity', () => {
  for (const [dueDay, urgency] of [['2026-10-25', 0], ['2026-10-24', 0],
    ['2026-10-14', 0.6321205588285577], ['2026-10-04', 0.8646647167633873]]) {
    const review = { kind: 'frontier-review', dueDay, boundary: 'on-or-after' };
    const a = overlay({ ...review, severity: 1 }, { severity: 1 });
    const b = overlay({ ...review, severity: 100 }, { severity: 100 });
    near(a.urgency, urgency); assert.equal(a.urgency, b.urgency);
  }
});

test('F10 C4 is orthogonal; closed disables without a date, blocked stays open, unknown tasks are not fabricated', () => {
  const sourceTaskRef = { source: 'fixture-tasks', id: 't1', revision: 'r1' };
  for (const dueDay of [undefined, '2026-10-01']) {
    const closed = overlay({ kind: 'task', dueDay, openState: 'closed', sourceTaskRef });
    assert.equal(closed.state, 'closed'); assert.equal(closed.active, false); assert.equal(closed.urgency, null);
  }
  const blocked = overlay({ kind: 'task', dueDay: '2026-10-01', openState: 'blocked', sourceTaskRef });
  assert.equal(blocked.active, true); assert.equal(blocked.state, 'overdue');
  for (const review of [
    { kind: 'task', dueDay: '2026-10-01', openState: 'open' },
    { kind: 'task', dueDay: '2026-10-01', openState: 'open', sourceTaskRef: { id: 't1' } },
    { kind: 'task', dueDay: '2026-10-01', sourceTaskRef },
    { kind: 'task', dueDay: '2026-10-01', openState: 'unknown', sourceTaskRef },
    { kind: 'task', openState: 'open', sourceTaskRef },
  ]) {
    const result = overlay(review);
    assert.equal(result.state, 'unknown'); assert.equal(result.active, false); assert.equal(result.urgency, null);
  }
  const review = { kind: 'legacy-review', dueDay: '2026-10-01' };
  assert.equal(overlay(review).state, 'overdue');
  assert.equal(evaluate({ review }).retention, evaluate().retention);
  assert.equal(evaluate({ review }).factor, evaluate().factor);
});

test('F16 time multiplier has fixed rank vectors and factor-one preserves exact baseline values', () => {
  for (const [retention, factor, rank] of [[0.625, 0.9625, 96.25], [0.4375, 0.94375, 94.375]]) {
    const score = f.applyTime(100, { retention }, { mode: 'recent' }, policy);
    assert.equal(score.factor, factor); assert.equal(score.rank, rank);
  }
  for (const baseRank of [0, 1e-15, 1.123456789012345]) {
    for (const mode of ['exact', 'historical', 'unknown']) {
      assert.equal(f.applyTime(baseRank, { retention: 0.625 }, { mode }, policy).rank, baseRank);
    }
    assert.equal(f.applyTime(baseRank, { retention: 0.625 }, { mode: 'recent' }, { ...policy, lambda: 0 }).rank, baseRank);
    assert.equal(f.applyTime(baseRank, { retention: 1 }, { mode: 'recent' }, policy).rank, baseRank);
  }
});

test('F16 ranking copies preserve raw, strong, thresholds and upstream eligibility', () => {
  const input = candidates(); const before = JSON.stringify(input);
  const result = batch(input);
  assert.equal(result.applied, true); assert.equal(result.fallback, false);
  assert.notEqual(result.candidates, input);
  assert.equal(result.candidates.find((c) => c.id === 'A').rank, 96.25);
  for (const source of input) {
    const scored = result.candidates.find((c) => c.id === source.id);
    for (const key of ['raw', 'strong', 'threshold', 'eligibility', 'baseRank']) assert.deepEqual(scored[key], source[key], key);
  }
  assert.equal(JSON.stringify(input), before);
});

test('F17 off and shadow preserve the same candidate array and order; shadow diagnostics carry proposed scores', () => {
  const input = candidates(); const before = JSON.stringify(input);
  for (const mode of ['off', 'shadow']) {
    const result = batch(input, { policy: { ...policy, mode } });
    assert.equal(result.candidates, input); assert.equal(result.applied, false); assert.equal(result.fallback, false);
    assert.deepEqual(result.candidates.map((c) => c.id), ['A', 'B']);
    if (mode === 'shadow') assert.equal(result.diagnostics.find((d) => d.id === 'A').rank, 96.25);
  }
  assert.equal(JSON.stringify(input), before);
});

test('F17 frozen replay is deterministic without consulting Date.now', () => {
  const input = candidates(); const originalNow = Date.now;
  Date.now = () => { throw new Error('ambient clock forbidden'); };
  try {
    const first = batch(input, { policy: { ...policy, mode: 'shadow' } });
    assert.deepEqual(batch(input, { policy: { ...policy, mode: 'shadow' } }), first);
    assert.deepEqual(evaluate(), evaluate());
  } finally { Date.now = originalNow; }
});

test('F18 policy rejects invalid nested shapes, unknown timezones, empty versions and unsupported H growth', () => {
  for (const field of ['C2', 'C3', 'C4']) {
    for (const bad of [null, false, 7, 'bad', [], new Date(0)]) {
      assert.throws(() => f.validatePolicy({ [field]: bad }), TypeError, `${field} ${String(bad)}`);
    }
  }
  for (const bad of [{ timezone: 'Mars/Olympus' }, { policyVersion: '' }, { policyVersion: ' ' }, { policyVersion: {} }, { hGrowth: true }]) {
    assert.throws(() => f.validatePolicy(bad), TypeError);
  }
});

test('F18 invalid retention and nonfinite or negative base rank are rejected rather than clamped', () => {
  for (const retention of [-0.1, 1.1, NaN, Infinity, '0.625']) {
    assert.throws(() => f.applyTime(100, { retention }, { mode: 'recent' }, policy), TypeError);
  }
  for (const baseRank of [-1, NaN, Infinity, -Infinity]) {
    assert.throws(() => f.applyTime(baseRank, { retention: 0.625 }, { mode: 'recent' }, policy), TypeError);
  }
});

test('F18 second-candidate failure, bad policy, incomplete snapshot and generation mismatch fall back as a whole', () => {
  const input = candidates();
  const invalidSecond = freeze([input[0], { ...input[1], evaluation: { retention: NaN } }]);
  const wrongGeneration = freeze([input[0], { ...input[1], generation: 'fixture-g2' }]);
  const cases = [[invalidSecond, {}], [input, { policy: { ...policy, C2: 'bad' } }],
    [input, { complete: false }], [wrongGeneration, {}]];
  for (const [source, opts] of cases) {
    const result = batch(source, opts);
    assert.equal(result.candidates, source); assert.equal(result.fallback, true); assert.equal(result.applied, false);
    assert.equal(typeof result.reason, 'string'); assert.ok(result.reason.length > 0);
    assert.equal(result.candidates.length, 2);
    assert.equal(result.candidates[0].rank, undefined);
  }
});

test('F18 batch accepts materialized candidates only and never executes an eligibility callback', () => {
  assert.equal(typeof f.applyTimeBatch, 'function');
  let called = false;
  assert.throws(() => batch(() => { called = true; throw new Error('upstream-eligibility'); }), TypeError);
  assert.equal(called, false);
  const upstreamError = new Error('upstream-eligibility');
  let batchStarted = false;
  const upstream = () => { throw upstreamError; };
  assert.throws(() => { const input = upstream(); batchStarted = true; batch(input); }, (error) => error === upstreamError);
  assert.equal(batchStarted, false);
});

test('F18 an incomplete evaluate result restores the entire batch while valid unknown dates remain neutral', () => {
  const first = candidates()[0];
  for (const summary of [
    { schemaVersion: 'unsupported' },
    { schemaVersion: 'akasha-evidence-summary/v1', coverage: 'ok', conflicts: [{ code: 'attempt-result-conflict' }], qualifyingPasses: [] },
  ]) {
    const incomplete = f.evaluate(view(), summary, { today, now, policy });
    assert.equal(incomplete.retention, null);
    const input = freeze([first, { id: 'B', baseRank: 99, generation: 'fixture-g1', evaluation: incomplete }]);
    const result = batch(input);
    assert.equal(result.candidates, input, 'A must stay at baseline when B has an incomplete evidence evaluation');
    assert.equal(result.fallback, true);
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'incomplete-evaluation');
    assert.equal(incomplete.complete, false);
  }
  const legitimateUnknown = evaluate({ eventDay: undefined });
  assert.equal(legitimateUnknown.retention, null);
  assert.equal(legitimateUnknown.complete, true);
  const result = batch(freeze([first, { id: 'B', baseRank: 99, generation: 'fixture-g1', evaluation: legitimateUnknown }]));
  assert.equal(result.fallback, false);
  assert.equal(result.candidates.find((item) => item.id === 'A').rank, 96.25);
  assert.equal(result.candidates.find((item) => item.id === 'B').rank, 99);
});
