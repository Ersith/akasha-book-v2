import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordReviewResult } from './evidence.mjs';
import { buildEvidenceIndex, readEvidenceIndex, updateEvidenceIndex, verifyEvidenceIndex, assertSafeReportPath } from './evidence-index.mjs';
import { reduceEvidence } from './forgetting.mjs';

const target = {
  store: 'canon',
  id: 'canon-index-fixture',
  versionId: 'canon-index-fixture-r1',
  digest: 'sha256:' + 'b'.repeat(64),
};
const contextRef = 'ctx:index-fixture';
const base = {
  target, contextRef, humanId: 'master', attemptId: 'a1', criterionId: 'c1',
  occurredAt: '2026-10-24T00:00:00Z', recordedAt: '2026-10-24T00:01:00Z', evidenceRefs: ['n1'],
};
const now = '2026-10-24T02:00:00Z';

test('index equals pure reduction, updates incrementally and rebuilds on truncation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'akasha-evidence-index-'));
  const file = join(dir, 'evidence.jsonl');
  const indexFile = join(dir, 'evidence-summary.json');
  try {
    recordReviewResult({ ...base, eventId: 'ev-index-1', result: 'pass' }, { file });
    const first = buildEvidenceIndex({ file, now, cutoff: now });
    assert.equal(first.groups.length, 1);
    assert.equal(first.groups[0].summary.qualifyingPasses.length, 1);
    assert.equal(verifyEvidenceIndex(first, { file, now, cutoff: now }).ok, true);
    writeFileSync(indexFile, JSON.stringify(first), 'utf8');

    recordReviewResult({ ...base, eventId: 'ev-index-2', result: 'fail', attemptId: 'a2' }, { file });
    const updated = updateEvidenceIndex({ file, indexFile, now, cutoff: now });
    assert.equal(updated.incremental, false, 'any append rebuilds globally because M1 diagnostics are global');
    const full = buildEvidenceIndex({ file, now, cutoff: now });
    const byKey = (groups) => [...groups].sort((a, b) => a.key.localeCompare(b.key));
    assert.deepEqual(byKey(updated.groups), byKey(full.groups));
    assert.equal(readEvidenceIndex(indexFile).source.eventCount, 2);
    const clockChanged = updateEvidenceIndex({ file, indexFile, now: '2026-10-24T03:00:00Z', cutoff: '2026-10-24T03:00:00Z' });
    assert.equal(clockChanged.incremental, false);
    assert.throws(() => assertSafeReportPath(file, { evidenceFile: file }), /受保护文件/);

    // Truncating the log is not an append-only prefix; the next update must rebuild.
    writeFileSync(file, JSON.stringify({ ...base, eventId: 'ev-index-3', result: 'pass' }) + '\n', 'utf8');
    const rebuilt = updateEvidenceIndex({ file, indexFile, now, cutoff: now });
    assert.equal(rebuilt.incremental, false);
    assert.equal(rebuilt.source.eventCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('future event in another scope invalidates every cached group', () => {
  const dir = mkdtempSync(join(tmpdir(), 'akasha-evidence-index-future-'));
  const file = join(dir, 'evidence.jsonl');
  const indexFile = join(dir, 'evidence-summary.json');
  try {
    recordReviewResult({ ...base, eventId: 'ev-future-a', result: 'pass' }, { file });
    const first = buildEvidenceIndex({ file, now, cutoff: now });
    writeFileSync(indexFile, JSON.stringify(first), 'utf8');
    const otherTarget = { ...target, id: 'canon-other-scope', versionId: 'canon-other-scope-r1' };
    recordReviewResult({
      ...base, target: otherTarget, contextRef: 'ctx:other-scope', eventId: 'ev-future-b', result: 'pass', attemptId: 'a2',
      occurredAt: '2026-10-24T05:00:00Z', recordedAt: '2026-10-24T05:01:00Z',
    }, { file });
    const updated = updateEvidenceIndex({ file, indexFile, now, cutoff: now });
    const full = buildEvidenceIndex({ file, now, cutoff: now });
    const byKey = (groups) => [...groups].sort((a, b) => a.key.localeCompare(b.key));
    assert.deepEqual(byKey(updated.groups), byKey(full.groups));
    const keyA = JSON.stringify([target.store, target.id, target.versionId, target.digest, contextRef]);
    const groupA = updated.groups.find((group) => group.key === keyA);
    assert.equal(groupA.summary.coverage, 'incomplete');
    assert.ok(groupA.summary.diagnostics.some((x) => x.code === 'clock-skew'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
