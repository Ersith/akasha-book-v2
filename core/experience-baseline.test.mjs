import test from 'node:test';
import assert from 'node:assert/strict';
import { compareBaseline, BASELINE_STATUS } from './experience-baseline.mjs';

const past = { eventTime: '2026-10-01', outcome: 'failure', approach: '先写后测', capability: '手写验证' };

test('same approach stays baseline unless capability changed', () => {
  assert.deepEqual(compareBaseline({ past, now: { approach: '先写后测' } }), {
    status: BASELINE_STATUS.PAST_FAILURE, requiresReview: true, reasons: ['past-failure-same-approach'], evidence: [],
  });
  const changed = compareBaseline({ past, now: { approach: '先写后测', capability: '自动化测试' } });
  assert.equal(changed.status, BASELINE_STATUS.PAST_FAILURE);
  assert.equal(changed.requiresReview, true);
});

test('a new approach is only a candidate after evidence', () => {
  const noEvidence = compareBaseline({ past, now: { approach: '先测后写' } });
  assert.equal(noEvidence.status, BASELINE_STATUS.NEEDS_EVIDENCE);
  assert.equal(noEvidence.requiresReview, true);
  const withEvidence = compareBaseline({ past, now: { approach: '先测后写', evidence: ['run-1: 316 passed', 'incident-2: caught regression'] } });
  assert.equal(withEvidence.status, BASELINE_STATUS.CANDIDATE);
  assert.equal(withEvidence.requiresReview, true);
});

test('bad outcome and empty approach fail closed', () => {
  assert.throws(() => compareBaseline({ past: { ...past, outcome: 'maybe' }, now: { approach: 'x' } }), /outcome/);
  assert.throws(() => compareBaseline({ past, now: { approach: '' } }), /now.approach/);
});
