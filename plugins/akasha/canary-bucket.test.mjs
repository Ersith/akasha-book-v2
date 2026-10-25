import test from 'node:test';
import assert from 'node:assert/strict';
import { BUCKET_VERSION, bucketPercent, selectedByBucket } from './canary-bucket.mjs';

test('bucket is stable for the same key and respects percentage bounds', () => {
  assert.equal(BUCKET_VERSION, 1);
  const base = { experimentId: 'exp-1', seed: 'seed-1', key: 'request-1' };
  const a = bucketPercent(base);
  const b = bucketPercent(base);
  assert.equal(a, b);
  assert.ok(a >= 0 && a < 100);
  assert.equal(selectedByBucket({ ...base, percent: 0 }), false);
  assert.equal(selectedByBucket({ ...base, percent: 100 }), true);
  assert.equal(selectedByBucket({ ...base, percent: a + 0.0001 }), true);
  assert.equal(selectedByBucket({ ...base, percent: a }), false);
});

test('field boundaries and unicode cannot alias the bucket', () => {
  const a = bucketPercent({ experimentId: 'exp\u0000seed', seed: 'one', key: 'req' });
  const b = bucketPercent({ experimentId: 'exp', seed: 'seed\u0000one', key: 'req' });
  assert.notEqual(a, b);
  const c = bucketPercent({ experimentId: 'exp-é', seed: 'seed-1', key: 'request-1' });
  const d = bucketPercent({ experimentId: 'exp-e', seed: 'seed-1', key: 'request-1' });
  assert.notEqual(c, d);
});

test('bucket rejects missing identity and invalid percent', () => {
  assert.throws(() => bucketPercent({ experimentId: '', seed: 's', key: 'k' }), /experimentId/);
  assert.throws(() => selectedByBucket({ experimentId: '', seed: 's', key: 'k', percent: 100 }), /experimentId/);
  assert.throws(() => selectedByBucket({ experimentId: 'e', seed: 's', key: 'k', percent: -1 }), /percent/);
  assert.throws(() => selectedByBucket({ experimentId: 'e', seed: 's', key: 'k', percent: 101 }), /percent/);
});

test('unpaired surrogate sequences do not alias', () => {
  const a = bucketPercent({ experimentId: 'exp-\ud800', seed: 's', key: 'k' });
  const b = bucketPercent({ experimentId: 'exp-\ud801', seed: 's', key: 'k' });
  assert.notEqual(a, b);
});
