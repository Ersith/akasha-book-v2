import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReviewResult, recordReviewResult, replayEvidence } from './evidence.mjs';

const target = {
  store: 'canon',
  id: 'canon-review-fixture',
  versionId: 'canon-review-fixture-r1',
  digest: 'sha256:' + 'a'.repeat(64),
};
const base = {
  eventId: 'ev-m2-fixture-1',
  result: 'pass',
  target,
  contextRef: 'ctx:manual-review-1',
  humanId: 'master',
  attemptId: 'attempt-1',
  criterionId: 'criterion-1',
  occurredAt: '2026-10-24T00:00:00Z',
  recordedAt: '2026-10-24T00:01:00Z',
  evidenceRefs: ['review-note-1'],
};

test('review-result append is human-only, idempotent and replayable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'akasha-evidence-'));
  const file = join(dir, 'evidence.jsonl');
  try {
    assert.throws(() => buildReviewResult({ ...base, actorType: 'tool' }), /human actor/);
    const first = recordReviewResult(base, { file });
    assert.equal(first.ok, true);
    assert.equal(first.already, false);
    const again = recordReviewResult(base, { file });
    assert.equal(again.already, true);
    assert.throws(() => recordReviewResult({ ...base, result: 'fail' }, { file }), /内容不同/);
    const replay = replayEvidence({
      target, contextRef: base.contextRef, now: '2026-10-24T02:00:00Z', cutoff: '2026-10-24T02:00:00Z', file,
    });
    assert.equal(replay.coverage, 'ok');
    assert.equal(replay.qualifyingPasses.length, 1);
    assert.equal(replay.lastPassAt, '2026-10-24T00:00:00.000Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
