import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCanaryReadiness } from './m3-canary-readiness.mjs';

const pass = { samples: 20, orderChanged: 5, humanReview: { verdict: 'pass' }, stopSwitch: true, budgetRoot: true, journal: true };

test('readiness fails closed by default and passes only all gates', () => {
  const empty = evaluateCanaryReadiness();
  assert.equal(empty.ready, false);
  assert.ok(empty.reasons.includes('samples-below-20'));
  assert.deepEqual(evaluateCanaryReadiness(pass), { ready: true, reasons: [] });
  assert.equal(evaluateCanaryReadiness({ ...pass, humanReview: { verdict: 'fail' } }).ready, false);
  assert.equal(evaluateCanaryReadiness({ ...pass, orderChanged: 4 }).ready, false);
});
