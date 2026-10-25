import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordReviewResult } from './evidence.mjs';
import { recordToView } from './record-view.mjs';
import { timeShadowLookup } from './lookup-time.mjs';
import { applyTimeToHits } from './lookup-time-apply.mjs';

test('apply reorders only evaluated hits and leaves input untouched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'akasha-lookup-apply-'));
  const file = join(dir, 'evidence.jsonl');
  try {
    const fresh = { id: 'canon-fresh', claim: 'fresh', event_time: '2026-09-24' };
    const stale = { id: 'canon-stale', claim: 'stale', event_time: '2026-09-24' };
    const view = recordToView(fresh, { store: 'canon', contentClass: 'C2', contextRef: 'lookup:apply' });
    recordReviewResult({
      target: { store: 'canon', id: fresh.id, versionId: view.versionId, digest: view.digest },
      contextRef: 'lookup:apply', eventId: 'ev-apply-1', result: 'pass',
      humanId: 'master', attemptId: 'a1', criterionId: 'c1',
      occurredAt: '2026-10-24T02:00:00Z', recordedAt: '2026-10-24T02:01:00Z', evidenceRefs: ['n1'],
    }, { file });
    const hits = [
      { store: 'canon', id: 'canon-stale', rank: 1, score: 1 },
      { store: 'canon', id: 'canon-fresh', rank: 2, score: 2 },
    ];
    const shadow = timeShadowLookup({
      hits, recordsByStore: { canon: [fresh, stale] }, evidenceFile: file,
      now: '2026-10-24T04:00:00Z', cutoff: '2026-10-24T04:00:00Z', today: '2026-10-24', lambda: 1, contentClass: 'C2', contextRef: 'lookup:apply',
    });
    const before = JSON.stringify(hits);
    const result = applyTimeToHits({ hits, shadow, policy: { mode: 'rank', lambda: 1 } });
    assert.equal(result.applied, true);
    assert.equal(result.hits[0].id, 'canon-fresh');
    assert.equal(result.hits[0].timeEvaluated, true);
    assert.equal(JSON.stringify(hits), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('incomplete evaluation blocks the whole apply instead of ranking failed items', () => {
  const dir = mkdtempSync(join(tmpdir(), 'akasha-lookup-apply-incomplete-'));
  const file = join(dir, 'evidence.jsonl');
  try {
    const good = { id: 'canon-good', claim: 'good', event_time: '2026-09-24' };
    const future = { id: 'canon-future', claim: 'future', event_time: '2026-10-25' };
    const hits = [
      { store: 'canon', id: 'canon-good', rank: 100, score: 100 },
      { store: 'canon', id: 'canon-future', rank: 99, score: 99 },
    ];
    const shadow = timeShadowLookup({
      hits, recordsByStore: { canon: [good, future] }, evidenceFile: file,
      now: '2026-10-24T04:00:00Z', cutoff: '2026-10-24T04:00:00Z', today: '2026-10-24', lambda: 0.1, contentClass: 'C2', contextRef: 'lookup:apply',
    });
    const result = applyTimeToHits({ hits, shadow, policy: { mode: 'rank', lambda: 0.1 } });
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'incomplete-evidence');
    assert.equal(result.hits, hits);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('normal unsupported-store exclusion does not block apply; lambda0 reports no-rank-change', () => {
  const dir = mkdtempSync(join(tmpdir(), 'akasha-lookup-apply-exclude-'));
  const file = join(dir, 'evidence.jsonl');
  try {
    const good = { id: 'canon-apply-good', claim: 'good', event_time: '2026-09-24' };
    const hits = [
      { store: 'canon', id: 'canon-apply-good', rank: 1, score: 1 },
      { store: 'pricing', id: 'pricing-x', rank: 2, score: 2 },
    ];
    const shadow = timeShadowLookup({
      hits, recordsByStore: { canon: [good], pricing: [{ id: 'pricing-x', behavior: 'x' }] }, evidenceFile: file,
      now: '2026-10-24T04:00:00Z', cutoff: '2026-10-24T04:00:00Z', today: '2026-10-24', lambda: 1, contentClass: 'C2', contextRef: 'lookup:apply',
    });
    assert.ok(shadow.skipped.some((item) => item.reason === 'unsupported-store'));
    const applied = applyTimeToHits({ hits, shadow, policy: { mode: 'rank', lambda: 1 } });
    assert.equal(applied.applied, true);
    const noChange = applyTimeToHits({ hits, shadow, policy: { mode: 'rank', lambda: 0 } });
    assert.equal(noChange.applied, false);
    assert.equal(noChange.reason, 'no-rank-change');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('zero-weight orphan keeps its slot under evaluated-only reorder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'akasha-lookup-apply-zero-'));
  const file = join(dir, 'evidence.jsonl');
  try {
    const good = { id: 'canon-zero-good', claim: 'good', event_time: '2026-09-24' };
    const hits = [
      { store: 'canon', id: 'canon-zero-good', rank: 1, score: 1 },
      { store: 'orphan', id: 'orphan-x', rank: 1, score: 1, zeroWeight: true },
    ];
    const shadow = timeShadowLookup({
      hits, recordsByStore: { canon: [good] }, evidenceFile: file,
      now: '2026-10-24T04:00:00Z', cutoff: '2026-10-24T04:00:00Z', today: '2026-10-24', lambda: 1, contentClass: 'C2', contextRef: 'lookup:apply',
    });
    const result = applyTimeToHits({ hits, shadow, policy: { mode: 'rank', lambda: 1 } });
    assert.equal(result.applied, true);
    assert.equal(result.hits[1].id, 'orphan-x');
    assert.equal(JSON.stringify(hits[1]), JSON.stringify({ store: 'orphan', id: 'orphan-x', rank: 1, score: 1, zeroWeight: true }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('C1 stays pinned while C2 neighbours reorder', () => {
  const hits = [
    { store: 'canon', id: 'c2a', rank: 2, score: 2 },
    { store: 'canon', id: 'c1', rank: 1.5, score: 1.5 },
    { store: 'canon', id: 'c2b', rank: 1, score: 1 },
  ];
  const shadow = {
    diagnostics: [
      { store: 'canon', id: 'c2a', complete: true, evaluation: { contentClass: 'C2', retention: 0.25, protection: false } },
      { store: 'canon', id: 'c1', complete: true, evaluation: { contentClass: 'C1', retention: 1, protection: true } },
      { store: 'canon', id: 'c2b', complete: true, evaluation: { contentClass: 'C2', retention: 1, protection: false } },
    ],
    skipped: [], storeErrors: [],
  };
  const candidate = applyTimeToHits({ hits, shadow, policy: { mode: 'rank', lambda: 1 } });
  assert.equal(candidate.hits[0].id, 'c2b');
  assert.equal(candidate.hits[1].id, 'c1');
  assert.equal(candidate.hits[2].id, 'c2a');
});


test('stores scope pins mirror C2 while canon C2 moves', () => {
  const hits = [
    { store: 'canon', id: 'c2a', rank: 2, score: 2 },
    { store: 'mirror', id: 'm2', rank: 1.5, score: 1.5 },
    { store: 'canon', id: 'c2b', rank: 1, score: 1 },
  ];
  const shadow = { diagnostics: [
    { store: 'canon', id: 'c2a', complete: true, evaluation: { contentClass: 'C2', retention: 0.25, protection: false } },
    { store: 'mirror', id: 'm2', complete: true, evaluation: { contentClass: 'C2', retention: 1, protection: false } },
    { store: 'canon', id: 'c2b', complete: true, evaluation: { contentClass: 'C2', retention: 1, protection: false } },
  ], skipped: [], storeErrors: [] };
  const scoped = applyTimeToHits({ hits, shadow, policy: { mode: 'rank', lambda: 1 }, stores: ['canon'] });
  assert.equal(scoped.hits[1].id, 'm2');
  assert.equal(scoped.hits[0].id, 'c2b');
  assert.equal(scoped.hits[2].id, 'c2a');
});
