import test from 'node:test';
import assert from 'node:assert/strict';
import { planCanary } from './m3-canary.mjs';
import { resolveM3Experiment } from './m3-experiment.mjs';

const config = (serveCandidate = false) => resolveM3Experiment({ AKASHA_M3_EXPERIMENT: JSON.stringify({
  enabled: true, status: 'active', version: 1, experimentId: 'e', seed: 's', percent: 100, serveCandidate,
}) });
const hits = [
  { store: 'canon', id: 'a', rank: 1, score: 1 },
  { store: 'canon', id: 'b', rank: 2, score: 2 },
];
const shadow = { diagnostics: [
  { store: 'canon', id: 'a', complete: true, baseRank: 1, retention: 0.5, factor: 0.5, evaluation: { contentClass: 'C2', complete: true, retention: 0.5 } },
  { store: 'canon', id: 'b', complete: true, baseRank: 2, retention: 1, factor: 1, evaluation: { contentClass: 'C2', complete: true, retention: 1 } },
], storeErrors: [], skipped: [] };
const base = {
  hits, shadow, intent: { kind: 'recent' }, session: null,
  dataView: { valid: true, consistent: true }, classExplicit: false, requestId: 'req-1', lambda: 1,
  experiment: config(),
};

test('default canary observes candidate but serves baseline', () => {
  const plan = planCanary(base);
  assert.equal(plan.selected, true);
  assert.equal(plan.eligibility.eligible, true);
  assert.equal(plan.candidate.applied, true);
  assert.equal(plan.servedCandidate, false);
  assert.equal(plan.served, hits);
});

test('serveCandidate true serves candidate; non-recent never selects', () => {
  const served = planCanary({ ...base, experiment: config(true) });
  assert.equal(served.servedCandidate, true);
  assert.equal(served.served[0].id, 'b');
  const blocked = planCanary({ ...base, intent: { kind: 'none' } });
  assert.equal(blocked.selected, false);
  assert.equal(blocked.candidate.applied, false);
});

test('unbranded config is rejected and disabled path ignores candidate inputs', () => {
  assert.throws(() => planCanary({ ...base, experiment: { enabled: true, experimentId: 'e', seed: 's', percent: 100 } }), /resolveM3Experiment/);
  const hostile = { experiment: resolveM3Experiment({}), hits };
  Object.defineProperty(hostile, 'shadow', { get() { throw new Error('must not read'); } });
  Object.defineProperty(hostile, 'lambda', { get() { throw new Error('must not read'); } });
  const plan = planCanary(hostile);
  assert.deepEqual(plan, { enabled: false, servedCandidate: false, reason: 'disabled' });
});


test('mixed eligibility allows a pinned C1 neighbour and only C2 moves', () => {
  const mixedHits = [
    { store: 'canon', id: 'c2a', rank: 2, score: 2 },
    { store: 'canon', id: 'c1', rank: 1.5, score: 1.5 },
    { store: 'canon', id: 'c2b', rank: 1, score: 1 },
  ];
  const mixedShadow = { diagnostics: [
    { store: 'canon', id: 'c2a', complete: true, baseRank: 2, retention: 0.25, factor: 0.25, evaluation: { contentClass: 'C2', complete: true, retention: 0.25 } },
    { store: 'canon', id: 'c1', complete: true, baseRank: 1.5, retention: 1, factor: 1, evaluation: { contentClass: 'C1', complete: true, retention: 1, protection: true } },
    { store: 'canon', id: 'c2b', complete: true, baseRank: 1, retention: 1, factor: 1, evaluation: { contentClass: 'C2', complete: true, retention: 1 } },
  ], storeErrors: [], skipped: [] };
  const mixedConfig = resolveM3Experiment({ AKASHA_M3_EXPERIMENT: JSON.stringify({
    enabled: true, status: 'active', version: 1, experimentId: 'e', seed: 's', percent: 100, eligibilityMode: 'mixed',
  }) });
  const plan = planCanary({ ...base, hits: mixedHits, shadow: mixedShadow, experiment: mixedConfig });
  assert.equal(plan.eligibility.eligible, true);
  assert.equal(plan.selected, true);
  assert.equal(plan.candidate.hits[1].id, 'c1');
  assert.equal(plan.candidate.hits[0].id, 'c2b');
});


test('canary scope moves canon C2 only, mirror stays pinned', () => {
  const mixedHits = [
    { store: 'canon', id: 'c2a', rank: 2, score: 2 },
    { store: 'mirror', id: 'm2', rank: 1.5, score: 1.5 },
    { store: 'canon', id: 'c2b', rank: 1, score: 1 },
  ];
  const mixedShadow = { diagnostics: [
    { store: 'canon', id: 'c2a', complete: true, evaluation: { contentClass: 'C2', retention: 0.25, protection: false } },
    { store: 'mirror', id: 'm2', complete: true, evaluation: { contentClass: 'C2', retention: 1, protection: false } },
    { store: 'canon', id: 'c2b', complete: true, evaluation: { contentClass: 'C2', retention: 1, protection: false } },
  ], skipped: [], storeErrors: [] };
  const plan = planCanary({ ...base, hits: mixedHits, shadow: mixedShadow });
  assert.equal(plan.candidate.hits[1].id, 'm2');
  assert.equal(plan.candidate.hits[0].id, 'c2b');
});
