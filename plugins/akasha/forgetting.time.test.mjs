import test from 'node:test';
import assert from 'node:assert/strict';

// Pure fixtures only. The override allows replay against the preserved RED snapshot.
const m = await import(process.env.FORGETTING_MODULE_URL || new URL('./forgetting.mjs', import.meta.url).href);
const NOW = '2026-10-24T04:00:00.000Z';
const TODAY = '2026-10-24';
const ENV = 'fixture:windows-node24';
const TARGET = Object.freeze({ store: 'canon', id: 'canon-time', versionId: 'canon-time-r2', digest: 'sha256:' + 'a'.repeat(64) });
const POLICY = Object.freeze({ mode: 'rank', lambda: 0.1, c3Enabled: true, timezone: 'Asia/Shanghai' });
const view = (extra = {}) => ({ ...TARGET, contextRef: ENV, contentClass: 'C2', eventDay: '2026-09-24', ...extra });
const opts = (extra = {}) => ({ today: TODAY, now: NOW, policy: POLICY, ...extra });
const event = (extra = {}) => ({
  schemaVersion: 'akasha-evidence/v1', eventId: 'time-pass-1', kind: 'review-result', result: 'pass',
  target: { ...TARGET }, actor: { type: 'human', id: 'fixture-reviewer' }, contextRef: ENV,
  attemptId: 'time-attempt-1', criterionId: 'time-criterion-1', evidenceRefs: ['fixture://results/time-pass-1'],
  occurredAt: '2026-10-24T02:00:00.000Z', recordedAt: '2026-10-24T02:01:00.000Z', ...extra,
});
const summary = (events = [event()], extra = {}) => m.reduceEvidence(events, {
  target: TARGET, contextRef: ENV, cutoff: NOW, now: NOW, ...extra,
});
const neutral = (actual) => {
  assert.equal(actual.retention, null);
  assert.equal(actual.factor, 1);
};

test('time: date-only anchor works with an explicit today and no now', () => {
  const actual = m.evaluate(view(), {}, { today: TODAY, policy: POLICY });
  assert.equal(actual.ageDays, 30);
  assert.equal(actual.retention, 0.625);
});

test('time: eventTime date and instants use the policy calendar day', () => {
  for (const [eventTime, expectedAge] of [
    ['2026-10-23', 1],
    ['2026-10-23T15:59:59Z', 1],
    ['2026-10-23T16:00:00Z', 0],
  ]) {
    const actual = m.evaluate(view({ eventDay: undefined, eventTime }), {}, opts());
    assert.equal(actual.ageDays, expectedAge, eventTime);
    if (expectedAge === 0) assert.equal(actual.retention, 1);
  }
});

test('time: equivalent Z and offset instants have the same age and retention', () => {
  const a = m.evaluate(view({ eventDay: undefined, eventTime: '2026-10-23T20:00:00Z' }), {}, opts());
  const b = m.evaluate(view({ eventDay: undefined, eventTime: '2026-10-24T04:00:00+08:00' }), {}, opts());
  assert.equal(a.ageDays, 0);
  assert.equal(b.ageDays, 0);
  assert.equal(a.retention, 1);
  assert.equal(b.retention, a.retention);
});

test('time: New York DST spring and fall both advance one calendar day', () => {
  const policy = { ...POLICY, timezone: 'America/New_York' };
  for (const input of [
    { eventTime: '2026-03-08T00:00:00-05:00', today: '2026-03-09', now: '2026-03-09T16:00:00Z' },
    { eventTime: '2026-11-01T00:00:00-04:00', today: '2026-11-02', now: '2026-11-02T17:00:00Z' },
  ]) {
    const actual = m.evaluate(view({ eventDay: undefined, eventTime: input.eventTime }), {}, { ...input, policy });
    assert.equal(actual.ageDays, 1, input.eventTime);
  }
});

test('time: parseInstant rejects nonexistent dates and timestamps without offsets', () => {
  assert.equal(typeof m.parseInstant, 'function');
  for (const value of ['2026-02-30T12:00:00Z', '2026-11-31T12:00:00+08:00', '2026-10-24T02:00:00', '2026-10-24T02:00:00+24:00', 'bad']) {
    assert.notEqual(m.parseInstant(value).status, 'ok', value);
  }
  const z = m.parseInstant('2026-10-23T20:00:00.123Z');
  const offset = m.parseInstant('2026-10-24T04:00:00.123+08:00');
  assert.equal(z.status, 'ok');
  assert.equal(offset.status, 'ok');
  assert.equal(z.ms, offset.ms);
  assert.equal(z.iso, '2026-10-23T20:00:00.123Z');
});

test('time: invalid event timestamps are neutral rather than normalized by Date.parse', () => {
  for (const eventTime of ['2026-02-30T12:00:00Z', '2026-10-24T02:00:00', 'bad']) {
    neutral(m.evaluate(view({ eventDay: undefined, eventTime }), {}, opts()));
  }
});

test('time: future eventDay and same-day now plus one second are neutral', () => {
  neutral(m.evaluate(view({ eventDay: '2026-10-25' }), {}, opts()));
  const actual = m.evaluate(view({ eventDay: undefined, eventTime: '2026-10-24T04:00:01Z' }), {}, opts());
  neutral(actual);
  assert.match(JSON.stringify(actual.reasons), /clock-skew/);
});

test('time: timestamp evaluation requires now and a matching local today', () => {
  const timestampView = view({ eventDay: undefined, eventTime: '2026-10-23T20:00:00Z' });
  neutral(m.evaluate(timestampView, {}, { today: TODAY, policy: POLICY }));
  neutral(m.evaluate(timestampView, {}, opts({ today: '2026-10-23' })));
});

test('summary: a valid exact-target pass resets age without changing the half-life', () => {
  const actual = m.evaluate(view(), summary(), opts());
  assert.equal(actual.ageDays, 0);
  assert.equal(actual.retention, 1);
  const oldPass = event({ occurredAt: '2026-09-24T02:00:00Z', recordedAt: '2026-09-24T02:01:00Z' });
  assert.equal(m.evaluate(view(), summary([oldPass]), opts()).retention, 0.625);
});

test('summary: a qualifying pass is mapped to the policy timezone before anchoring', () => {
  const lateZ = event({ occurredAt: '2026-10-23T20:00:00Z', recordedAt: '2026-10-23T20:01:00Z' });
  const actual = m.evaluate(view(), summary([lateZ]), opts());
  assert.equal(actual.anchorDay, '2026-10-24');
  assert.equal(actual.ageDays, 0);
  assert.equal(actual.retention, 1);
});

test('summary: store, logical id, exact version and digest are bound independently', () => {
  const valid = summary();
  for (const patch of [
    { store: 'mirror' }, { id: 'canon-other' }, { versionId: 'canon-time-r1' }, { digest: 'sha256:' + 'b'.repeat(64) },
  ]) {
    neutral(m.evaluate(view(), { ...valid, target: { ...TARGET, ...patch } }, opts()));
  }
});

test('summary: environment mismatch cannot refresh the validation anchor', () => {
  neutral(m.evaluate(view(), { ...summary(), contextRef: 'fixture:other-environment' }, opts()));
});

test('summary: conflicted, incomplete and unsupported summaries are neutral', () => {
  const valid = summary();
  for (const coverage of ['conflicted', 'incomplete', 'unknown']) {
    neutral(m.evaluate(view(), { ...valid, coverage }, opts()));
  }
  neutral(m.evaluate(view(), { ...valid, schemaVersion: 'akasha-evidence-summary/v999' }, opts()));
});

test('summary: now and cutoff cannot be ahead of the evaluation snapshot', () => {
  const valid = summary();
  neutral(m.evaluate(view(), { ...valid, now: '2026-10-24T04:00:01Z' }, opts()));
  neutral(m.evaluate(view(), { ...valid, cutoff: '2026-10-24T04:00:01Z' }, opts()));
});

test('summary: future lastPassAt cannot become age zero through clamping', () => {
  const valid = summary();
  neutral(m.evaluate(view(), { ...valid, lastPassAt: '2026-10-25T02:00:00Z' }, opts()));
  neutral(m.evaluate(view(), { ...valid, lastPassAt: '2026-10-24T04:00:01Z' }, opts()));
});

test('summary: evidence evaluation requires an explicit now', () => {
  neutral(m.evaluate(view(), summary(), { today: TODAY, policy: POLICY }));
});

test('summary: a future event is quarantined and the incomplete summary is neutral', () => {
  const future = event({ occurredAt: '2026-10-24T04:00:01Z', recordedAt: '2026-10-24T04:00:02Z' });
  const reduced = summary([future]);
  assert.equal(reduced.coverage, 'incomplete');
  assert.match(JSON.stringify(reduced), /clock-skew/);
  neutral(m.evaluate(view(), reduced, opts()));
});

test('summary: a complete stream without qualifying successes uses only the original anchor', () => {
  const exposure = event({ kind: 'exposure' });
  for (const key of ['result', 'attemptId', 'criterionId', 'evidenceRefs']) delete exposure[key];
  const reduced = summary([exposure]);
  assert.equal(reduced.coverage, 'ok');
  assert.equal(reduced.lastPassAt, null);
  const actual = m.evaluate(view(), reduced, opts());
  assert.equal(actual.anchorDay, '2026-09-24');
  assert.equal(actual.retention, 0.625);
});
