import test from 'node:test';
import assert from 'node:assert/strict';
import * as f from './forgetting.mjs';
const now = '2026-10-24T04:00:00Z';
const target = { store: 'canon', id: 'x', versionId: 'x-r1', digest: 'sha256:' + 'a'.repeat(64) };
const contextRef = 'fixture:review';
const options = { target, contextRef, now, cutoff: now };
const view = { ...target, contextRef, contentClass: 'C2', eventDay: '2026-09-24' };
const opts = { now, today: '2026-10-24', policy: { mode: 'rank', lambda: .1 } };
const event = { schemaVersion: f.EVIDENCE_SCHEMA, eventId: 'e1', kind: 'review-result', result: 'pass',
  target, contextRef, actor: { type: 'human', id: 'fixture:reviewer' },
  attemptId: 'a1', criterionId: 'c1', evidenceRefs: ['fixture:result'],
  occurredAt: '2026-10-24T02:00:00Z', recordedAt: '2026-10-24T02:01:00Z' };

test('F14 event ID conflicts across targets and contexts are visible in the affected projection', () => {
  for (const other of [{ ...event, target: { ...target, id: 'other' } }, { ...event, contextRef: 'fixture:other' }]) {
    for (const events of [[event, other], [other, event]]) {
      const result = f.reduceEvidence(events, options);
      assert.equal(result.coverage, 'conflicted');
      assert.equal(result.qualifyingPasses.length, 0);
    }
  }
});

test('F13/F18 summary passes must independently satisfy the complete evidence contract', () => {
  const valid = f.reduceEvidence([event], options);
  for (const patch of [{ result: 'fail' }, { target: { ...target, id: 'other' } },
    { recordedAt: '2099-01-01T00:00:00Z' }, { evidenceRefs: [null] },
    { actor: { type: 'tool', id: 'pretend-human' } }, { contextRef: 'fixture:other' }]) {
    const summary = { ...valid, qualifyingPasses: [{ ...valid.qualifyingPasses[0], ...patch }] };
    const out = f.evaluate(view, summary, opts);
    assert.equal(out.complete, false, JSON.stringify(patch));
    assert.equal(out.retention, null);
  }
  assert.equal(f.evaluate(view, { ...valid, diagnostics: [{ code: 'invalid-event' }] }, opts).complete, false);
});

test('F01 explicit invalid exact versions cannot silently become the logical identity', () => {
  for (const versionId of [false, 17, '', ' ', null, undefined]) {
    assert.throws(() => f.recordDigest({ store: 'canon', id: 'x', versionId, content: {} }), TypeError);
    assert.throws(() => f.normalizeView({ ...view, versionId }), TypeError);
  }
  assert.equal(f.normalizeView({ store: 'canon', id: 'x' }).versionId, 'x');
});

test('policy typos and malformed shadow policy must not silently inherit defaults', () => {
  for (const policy of [{ C2: { halfLifDays: 1 } }, { hGrow: true }]) assert.throws(() => f.validatePolicy(policy), TypeError);
  for (const policy of [null, [], 'rank']) assert.throws(() => f.shadowScore(100, { retention: .625 }, { mode: 'recent' }, policy), TypeError);
});
