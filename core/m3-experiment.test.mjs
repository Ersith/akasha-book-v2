import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveM3Experiment, selectExperimentRequest, experimentIdentity } from './m3-experiment.mjs';
import { selectedByBucket } from './canary-bucket.mjs';

const good = JSON.stringify({ enabled: true, status: 'active', version: 1, experimentId: 'exp-1', seed: 'seed-1', percent: 50 });

test('default is disabled and malformed config is explicit', () => {
  assert.equal(resolveM3Experiment({}).enabled, false);
  assert.throws(() => resolveM3Experiment({ AKASHA_M3_EXPERIMENT: '{bad' }), /JSON/);
  assert.throws(() => resolveM3Experiment({ AKASHA_M3_EXPERIMENT: JSON.stringify({ enabled: true, status: 'paused', version: 1 }) }), /status/);
  assert.throws(() => resolveM3Experiment({ AKASHA_M3_EXPERIMENT: JSON.stringify({ enabled: true, status: 'active', version: 2, experimentId: 'e', seed: 's', percent: 1 }) }), /version/);
  assert.throws(() => resolveM3Experiment({ AKASHA_M3_EXPERIMENT: JSON.stringify({ enabled: true, status: 'active', version: 1, experimentId: 'e', seed: 's', percent: 101 }) }), /percent/);
  assert.throws(() => resolveM3Experiment({ AKASHA_M3_EXPERIMENT: JSON.stringify({ enabled: true, status: 'active', version: 1, experimentId: 'x'.repeat(129), seed: 's', percent: 1 }) }), /experimentId/);
});

test('selection is stable per request and default off never selects', () => {
  const config = resolveM3Experiment({ AKASHA_M3_EXPERIMENT: good });
  assert.equal(config.enabled, true);
  assert.equal(config.serveCandidate, false);
  assert.equal(config.eligibilityMode, 'strict');
  assert.equal(resolveM3Experiment({ AKASHA_M3_EXPERIMENT: JSON.stringify({ enabled: true, status: 'active', version: 1, experimentId: 'e', seed: 's', percent: 1, eligibilityMode: 'mixed' }) }).eligibilityMode, 'mixed');
  assert.throws(() => resolveM3Experiment({ AKASHA_M3_EXPERIMENT: JSON.stringify({ enabled: true, status: 'active', version: 1, experimentId: 'e', seed: 's', percent: 1, eligibilityMode: 'all' }) }), /eligibilityMode/);
  const a = selectExperimentRequest(config, 'request-1');
  const b = selectExperimentRequest(config, 'request-1');
  assert.deepEqual(a, b);
  assert.equal(selectExperimentRequest(resolveM3Experiment({}), 'request-1').selected, false);
  assert.throws(() => selectExperimentRequest(config, ''), /requestId/);
});


test('canonical identity keeps unpaired surrogates distinct', () => {
  const a = resolveM3Experiment({ AKASHA_M3_EXPERIMENT: JSON.stringify({ enabled: true, status: 'active', version: 1, experimentId: '\uD800', seed: 's', percent: 50 }) });
  const b = resolveM3Experiment({ AKASHA_M3_EXPERIMENT: JSON.stringify({ enabled: true, status: 'active', version: 1, experimentId: '\uD801', seed: 's', percent: 50 }) });
  assert.notEqual(experimentIdentity(a).experimentIdHash, experimentIdentity(b).experimentIdHash);
  assert.equal(experimentIdentity(a).version, 1);
});


test('strict keeps its historical bucket key; mixed is isolated', () => {
  const strict = resolveM3Experiment({ AKASHA_M3_EXPERIMENT: JSON.stringify({ enabled: true, status: 'active', version: 1, experimentId: 'e', seed: 's', percent: 50 }) });
  const mixed = resolveM3Experiment({ AKASHA_M3_EXPERIMENT: JSON.stringify({ enabled: true, status: 'active', version: 1, experimentId: 'e', seed: 's', percent: 50, eligibilityMode: 'mixed' }) });
  for (let i = 0; i < 20; i += 1) {
    const requestId = `request-${i}`;
    assert.equal(selectExperimentRequest(strict, requestId).selected, selectedByBucket({ experimentId: 'e', seed: 's', key: requestId, percent: 50 }));
    assert.equal(selectExperimentRequest(mixed, requestId).selected, selectedByBucket({ experimentId: 'e', seed: 's', key: `${requestId}\u0000mixed`, percent: 50 }));
  }
});
