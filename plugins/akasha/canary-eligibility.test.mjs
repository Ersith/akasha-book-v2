import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCanaryEligibility } from './canary-eligibility.mjs';

const base = {
  hits: [{ store: 'canon', id: 'a' }],
  shadow: { diagnostics: [{ complete: true, evaluation: { contentClass: 'C2' } }], storeErrors: [], skipped: [] },
  intent: { kind: 'recent' },
  session: { present: true, wellFormed: true },
  dataView: { valid: true, consistent: true },
};

test('eligible only when every canary precondition holds', () => {
  assert.deepEqual(evaluateCanaryEligibility(base), { scope: 'observed-eligibility', eligible: true, reasons: [] });
  assert.equal(evaluateCanaryEligibility({ ...base, shadow: { ...base.shadow, skipped: [{ reason: 'evaluate-error' }] } }).eligible, false);
  assert.equal(evaluateCanaryEligibility({ ...base, shadow: { ...base.shadow, skipped: [{ reason: 'unsupported-store' }] } }).eligible, true);
  assert.equal(evaluateCanaryEligibility({ ...base, intent: { kind: 'none' } }).eligible, false);
  assert.equal(evaluateCanaryEligibility({ ...base, classExplicit: true }).eligible, false);
  assert.equal(evaluateCanaryEligibility({ ...base, dataView: { valid: true, consistent: false } }).eligible, false);
  assert.equal(evaluateCanaryEligibility({ ...base, session: { present: false } }).eligible, true);
  assert.equal(evaluateCanaryEligibility({ ...base, shadow: { ...base.shadow, storeErrors: [{ store: 'canon' }] } }).eligible, false);
  assert.equal(evaluateCanaryEligibility({ ...base, shadow: { diagnostics: [{ complete: false, evaluation: { contentClass: 'C2' } }], storeErrors: [] } }).eligible, false);
  assert.equal(evaluateCanaryEligibility({ ...base, shadow: { diagnostics: [{ complete: true, evaluation: { contentClass: 'C1' } }], storeErrors: [] } }).eligible, false);
  assert.equal(evaluateCanaryEligibility({ ...base, hits: [{ store: 'orphan', id: 'o', zeroWeight: true }] }).eligible, false);
});

test('mixed mode requires at least one C2 but allows C1 neighbours', () => {
  const base = {
    hits: [{ store: 'canon', id: 'a' }],
    intent: { kind: 'recent' },
    dataView: { valid: true, consistent: true },
    classExplicit: false,
  };
  const mixedShadow = {
    diagnostics: [
      { complete: true, evaluation: { contentClass: 'C1' } },
      { complete: true, evaluation: { contentClass: 'C2' } },
    ],
    skipped: [], storeErrors: [],
  };
  assert.equal(evaluateCanaryEligibility({ ...base, shadow: mixedShadow }).eligible, false);
  assert.equal(evaluateCanaryEligibility({ ...base, shadow: mixedShadow, requireAllC2: false }).eligible, true);
  const noC2 = { ...mixedShadow, diagnostics: [{ complete: true, evaluation: { contentClass: 'C1' } }] };
  assert.equal(evaluateCanaryEligibility({ ...base, shadow: noC2, requireAllC2: false }).eligible, false);
});


test('mixed mode rejects C3/unknown, not only missing C2', () => {
  const base = {
    hits: [{ store: 'canon', id: 'a' }],
    intent: { kind: 'recent' },
    dataView: { valid: true, consistent: true },
    classExplicit: false,
    requireAllC2: false,
  };
  const mixed = { diagnostics: [
    { complete: true, evaluation: { contentClass: 'C2' } },
    { complete: true, evaluation: { contentClass: 'C3' } },
  ], skipped: [], storeErrors: [] };
  const result = evaluateCanaryEligibility({ ...base, shadow: mixed });
  assert.equal(result.eligible, false);
  assert.ok(result.reasons.includes('non-c1-c2'));
});
