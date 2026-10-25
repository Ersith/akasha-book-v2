import test from 'node:test';
import assert from 'node:assert/strict';
import { planManifestBackfill } from './session.mjs';

test('backfill plans only sessions without manifests, using the latest generation', () => {
  const records = [
    { id: 'seg-1', kind: 'process', session: 's-a' },
    { id: 'seg-2', kind: 'process', session: 's-a' },
    { id: 'n1', kind: 'node', session: 's-a', treegen: 1, children: ['seg-1'] },
    { id: 'n2', kind: 'node', session: 's-a', treegen: 2, children: ['seg-1', 'seg-2'] },
    { id: 'n3', kind: 'node', session: 's-b', treegen: 3, children: ['seg-3'] },
    { id: 'm1', kind: 'tree-manifest', session: 's-b', treegen: 3, active_ids: ['n3'] },
  ];
  const plan = planManifestBackfill(records);
  assert.equal(plan.plans.length, 1);
  assert.equal(plan.plans[0].session, 's-a');
  assert.deepEqual(plan.plans[0].active_ids, ['n1', 'n2']);
  assert.equal(plan.plans[0].partial_generation, true);
  assert.equal(plan.plans[0].inherited_nodes, 1);
  assert.equal(plan.plans[0].seg_count, 2);
  assert.equal(plan.skippedWithManifest, 1);
});
