import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordReviewResult } from './evidence.mjs';
import { recordToView } from './record-view.mjs';
import { timeShadowLookup } from './lookup-time.mjs';

test('lookup shadow evaluates hits without mutating order or rank', () => {
  const dir = mkdtempSync(join(tmpdir(), 'akasha-lookup-time-'));
  const file = join(dir, 'evidence.jsonl');
  try {
    const record = { id: 'canon-shadow', claim: '一条事实', event_time: '2026-09-24' };
    const view = recordToView(record, { store: 'canon', contentClass: 'C2', contextRef: 'lookup:shadow' });
    recordReviewResult({
      target: { store: 'canon', id: record.id, versionId: view.versionId, digest: view.digest },
      contextRef: 'lookup:shadow', eventId: 'ev-lookup-1', result: 'pass',
      humanId: 'master', attemptId: 'a1', criterionId: 'c1',
      occurredAt: '2026-10-24T02:00:00Z', recordedAt: '2026-10-24T02:01:00Z',
      evidenceRefs: ['n1'],
    }, { file });
    const hits = [
      { store: 'canon', id: 'canon-shadow', rank: 2, score: 2 },
      { store: 'pricing', id: 'pricing-x', rank: 1, score: 1 },
    ];
    const before = JSON.stringify(hits);
    const result = timeShadowLookup({
      hits, recordsByStore: { canon: [record] }, evidenceFile: file, now: '2026-10-24T04:00:00Z', cutoff: '2026-10-24T04:00:00Z', today: '2026-10-24', lambda: 0.2, contentClass: 'C2',
    });
    assert.equal(result.appliedToResults, false);
    assert.equal(result.evaluated, 1);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.diagnostics[0].id, 'canon-shadow');
    assert.equal(JSON.stringify(hits), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('one bad view does not abort other diagnostics, and store errors stay visible', () => {
  const dir = mkdtempSync(join(tmpdir(), 'akasha-lookup-time-isolation-'));
  const file = join(dir, 'evidence.jsonl');
  try {
    const good = { id: 'canon-good', claim: 'ok', event_time: '2026-09-24' };
    const bad = { id: 'canon-bad', claim: 'bad', event_time: '2026-09-24', review: { kind: 'nope' } };
    const hits = [
      { store: 'canon', id: 'canon-good', rank: 2 },
      { store: 'canon', id: 'canon-bad', rank: 1 },
    ];
    const result = timeShadowLookup({
      hits, recordsByStore: { canon: [good, bad] }, evidenceFile: file,
      now: '2026-10-24T04:00:00Z', cutoff: '2026-10-24T04:00:00Z', today: '2026-10-24', lambda: 0.1, contentClass: 'C2',
    });
    assert.equal(result.evaluated, 1);
    assert.ok(result.skipped.some((item) => item.reason === 'evaluate-error'));
    const errored = timeShadowLookup({
      hits, recordsByStore: { canon: [good, bad] }, storeErrors: [{ store: 'canon', error: 'EIO' }], evidenceFile: file,
      now: '2026-10-24T04:00:00Z', cutoff: '2026-10-24T04:00:00Z', today: '2026-10-24', lambda: 0.1, contentClass: 'C2',
    });
    assert.equal(errored.evaluated, 0);
    assert.equal(errored.storeErrors[0].error, 'EIO');
    assert.ok(errored.skipped.every((item) => item.reason === 'store-error'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('global clock/context/policy are validated even with zero hits', () => {
  assert.throws(() => timeShadowLookup({ hits: [], evidenceFile: 'nope.jsonl', now: 'not-a-date', cutoff: 'not-a-date' }), /now\/cutoff|clock|instant/i);
  assert.throws(() => timeShadowLookup({ hits: [], evidenceFile: 'nope.jsonl', now: '2026-10-24T04:00:00Z', cutoff: '2026-10-24T04:00:00Z', contextRef: '' }), /contextRef/);
  assert.throws(() => timeShadowLookup({ hits: [], evidenceFile: 'nope.jsonl', now: '2026-10-24T04:00:00Z', cutoff: '2026-10-24T04:00:00Z', policy: { mode: 'nope' } }), /mode/);
});
