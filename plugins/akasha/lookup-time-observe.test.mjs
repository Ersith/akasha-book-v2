import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordReviewResult } from './evidence.mjs';
import { recordToView } from './record-view.mjs';
import { timeShadowLookup } from './lookup-time.mjs';
import { applyTimeToHits } from './lookup-time-apply.mjs';
import { boundObservationRecord, buildFailedObservation, buildTimeObservation } from './lookup-time-observe.mjs';

test('observation pairs one snapshot and preserves baseline hits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'akasha-time-observe-'));
  const file = join(dir, 'evidence.jsonl');
  try {
    const fresh = { id: 'canon-observe-fresh', claim: 'fresh', event_time: '2026-09-24' };
    const stale = { id: 'canon-observe-stale', claim: 'stale', event_time: '2026-09-24' };
    const view = recordToView(fresh, { store: 'canon', contentClass: 'C2', contextRef: 'lookup:observe' });
    recordReviewResult({
      target: { store: 'canon', id: fresh.id, versionId: view.versionId, digest: view.digest },
      contextRef: 'lookup:observe', eventId: 'ev-observe-1', result: 'pass',
      humanId: 'master', attemptId: 'a1', criterionId: 'c1',
      occurredAt: '2026-10-24T02:00:00Z', recordedAt: '2026-10-24T02:01:00Z', evidenceRefs: ['n1'],
    }, { file });
    const hits = [
      { store: 'canon', id: 'canon-observe-stale', rank: 1, score: 1 },
      { store: 'canon', id: 'canon-observe-fresh', rank: 2, score: 2 },
    ];
    const shadow = timeShadowLookup({
      hits, recordsByStore: { canon: [fresh, stale] }, evidenceFile: file,
      now: '2026-10-24T04:00:00Z', cutoff: '2026-10-24T04:00:00Z', today: '2026-10-24', lambda: 1, contentClass: 'C2', contextRef: 'lookup:observe',
    });
    const before = JSON.stringify(hits);
    const candidate = applyTimeToHits({ hits, shadow, policy: { mode: 'rank', lambda: 1 } });
    const observation = buildTimeObservation({
      query: 'test', hits, shadow, candidate, now: '2026-10-24T04:00:00Z', cutoff: '2026-10-24T04:00:00Z', today: '2026-10-24', contextRef: 'lookup:observe', contentClass: 'C2', lambda: 1,
    });
    assert.equal(observation.baseline.ids[0], 'canon-observe-stale');
    assert.equal(observation.candidate.ids[0], 'canon-observe-fresh');
    assert.equal(observation.served, 'baseline');
    assert.equal(observation.candidateApplied, true);
    assert.equal(observation.selected, undefined);
    assert.equal(observation.eligible, 2);
    assert.equal(observation.delta.unevaluatedMoved.length, 0);
    assert.equal(observation.delta.orderChanged, true);
    assert.equal(observation.orderChanged, true);
    assert.equal(observation.rankChanged, true);
    assert.equal(observation.top1Changed, true);
    assert.match(observation.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(JSON.stringify(hits), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('orderChanged covers the tail beyond top-10', () => {
  const hits = Array.from({ length: 12 }, (_, i) => ({ store: 'canon', id: `h${i}`, rank: 12 - i, score: 12 - i }));
  const candidateHits = hits.slice();
  [candidateHits[10], candidateHits[11]] = [candidateHits[11], candidateHits[10]];
  const observation = buildTimeObservation({
    query: 'tail', hits, shadow: { diagnostics: [], skipped: [], storeErrors: [] },
    candidate: { hits: candidateHits, applied: false },
  });
  assert.equal(observation.delta.orderChanged, true);
  assert.equal(observation.delta.top10Overlap, 10);
});

test('failed stage produces a terminal observation with baseline served', () => {
  const failure = buildFailedObservation({ query: 'q', stage: 'shadow', error: new Error('bad evidence') });
  assert.equal(failure.observed, 'failed');
  assert.equal(failure.served, 'baseline');
  assert.equal(failure.stage, 'shadow');
  assert.match(failure.error, /bad evidence/);
  assert.match(failure.requestId, /^[0-9a-f-]{36}$/);
});

test('persistence bounding is a deep copy with bounded strings', () => {
  const source = { a: 'x'.repeat(20), nested: { b: 'y'.repeat(20) } };
  const bounded = boundObservationRecord(source, 5);
  assert.equal(bounded.a.length, 5);
  assert.equal(bounded.nested.b.length, 5);
  assert.equal(source.a.length, 20);
});


test('observe path keeps C1 pinned while C2 neighbours move', () => {
  const hits = [
    { store: 'canon', id: 'c2a', rank: 2, score: 2 },
    { store: 'canon', id: 'c1', rank: 1.5, score: 1.5 },
    { store: 'canon', id: 'c2b', rank: 1, score: 1 },
  ];
  const shadow = { diagnostics: [
    { store: 'canon', id: 'c2a', complete: true, evaluation: { contentClass: 'C2', retention: 0.25, protection: false } },
    { store: 'canon', id: 'c1', complete: true, evaluation: { contentClass: 'C1', retention: 1, protection: true } },
    { store: 'canon', id: 'c2b', complete: true, evaluation: { contentClass: 'C2', retention: 1, protection: false } },
  ], skipped: [], storeErrors: [] };
  const candidate = applyTimeToHits({ hits, shadow, policy: { mode: 'rank', lambda: 1 } });
  const observation = buildTimeObservation({ query: 'c1-pin', hits, shadow, candidate, now: '2026-10-24T04:00:00Z', cutoff: '2026-10-24T04:00:00Z', today: '2026-10-24', contextRef: 'lookup:c1-pin', contentClass: 'C2', lambda: 1 });
  assert.equal(candidate.hits[1].id, 'c1');
  assert.equal(observation.candidate.ids[1], 'c1');
});
