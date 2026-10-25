import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordReviewResult } from './evidence.mjs';
import { recordDigest } from './forgetting.mjs';
import { evaluateEvidence } from './evidence-evaluate.mjs';

const target = {
  store: 'canon', id: 'canon-eval-fixture', versionId: 'canon-eval-fixture-r1',
  digest: recordDigest({ store: 'canon', id: 'canon-eval-fixture', versionId: 'canon-eval-fixture-r1', content: { text: 'x' } }),
};
const view = {
  ...target, content: { text: 'x' }, contentClass: 'C2', eventDay: '2026-09-24', contextRef: 'ctx:eval',
};
const now = '2026-10-24T04:00:00Z';

test('evidence summary feeds M1 evaluation; a human pass restores the C2 anchor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'akasha-evidence-eval-'));
  const file = join(dir, 'evidence.jsonl');
  try {
    const before = evaluateEvidence({ file, target, contextRef: 'ctx:eval', view, now, cutoff: now, today: '2026-10-24' });
    assert.equal(before.summary.qualifyingPasses.length, 0);
    const decayed = before.evaluation.retention;

    recordReviewResult({
      target, contextRef: 'ctx:eval', eventId: 'ev-eval-1', result: 'pass',
      humanId: 'master', attemptId: 'a1', criterionId: 'c1',
      occurredAt: '2026-10-24T02:00:00Z', recordedAt: '2026-10-24T02:01:00Z',
      evidenceRefs: ['n1'],
    }, { file });
    const after = evaluateEvidence({ file, target, contextRef: 'ctx:eval', view, now, cutoff: now, today: '2026-10-24' });
    assert.equal(after.summary.qualifyingPasses.length, 1);
    assert.equal(after.evaluation.anchorDay, '2026-10-24');
    assert.ok(after.evaluation.retention > decayed);
    assert.equal(after.evaluation.complete, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('adapter rejects view.content that contradicts the explicit digest, and accepts precomputed digest views', () => {
  const dir = mkdtempSync(join(tmpdir(), 'akasha-evidence-eval-digest-'));
  const file = join(dir, 'evidence.jsonl');
  try {
    assert.throws(
      () => evaluateEvidence({ file, target, contextRef: 'ctx:eval', view: { ...view, content: { text: 'changed' } }, now, cutoff: now, today: '2026-10-24' }),
      /view.digest 与 view.content 不一致/,
    );
    const noContent = { ...view };
    delete noContent.content;
    const out = evaluateEvidence({ file, target, contextRef: 'ctx:eval', view: noContent, now, cutoff: now, today: '2026-10-24' });
    assert.equal(out.evaluation.complete, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
