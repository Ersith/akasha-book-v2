import test from 'node:test';
import assert from 'node:assert/strict';
import { planSessionCompaction } from './session-compact.mjs';

test('compaction keeps last occurrence per id and preserves order', () => {
  const plan = planSessionCompaction([
    { id: 'a', seq: 1 }, { id: 'b', seq: 1 }, { id: 'a', seq: 2 }, { id: 'c' }, { id: 'a', seq: 3 },
  ]);
  assert.equal(plan.before, 5);
  assert.equal(plan.after, 3);
  assert.equal(plan.removed, 2);
  assert.equal(plan.duplicateIds, 1);
  assert.deepEqual(plan.records.map((row) => [row.id, row.seq ?? null]), [['b', 1], ['c', null], ['a', 3]]);
});

test('records without id are preserved', () => {
  const plan = planSessionCompaction([{ id: 'a' }, { id: 'a' }, { seq: 9 }]);
  assert.equal(plan.records.length, 2);
  assert.deepEqual(plan.records[1], { seq: 9 });
});
