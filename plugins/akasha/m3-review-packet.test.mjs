import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBlindPackets, assertDistinctTargets } from './m3-review-packet.mjs';

const row = {
  query: '排序变化样例',
  baseline: [{ id: 'a', snippet: 'A 基线' }, { id: 'b', snippet: 'B 基线' }],
  candidate: [{ id: 'b', snippet: 'B 候选' }, { id: 'a', snippet: 'A 候选' }],
  orderChanged: true,
  visibleOrderChanged: true,
};

test('blind packets hide candidate side and keep a separate key', () => {
  const first = buildBlindPackets([row], { limit: 10 });
  assert.equal(first.packets.length, 1);
  assert.equal(first.key.length, 1);
  assert.ok(['left', 'right'].includes(first.key[0].candidateSide));
  const shown = first.key[0].candidateSide === 'left' ? first.packets[0].left : first.packets[0].right;
  assert.equal(shown[0].id, 'b');
  assert.equal(JSON.stringify(first.packets).includes('candidateSide'), false);
  assert.equal(JSON.stringify(first.packets).includes('seed'), false);
  assert.deepEqual(Object.keys(first.packets[0].left[0]).sort(), ['id', 'snippet']);
});

test('packets skip empty pairs and reject bad limits', () => {
  assert.equal(buildBlindPackets([{ query: 'x', baseline: [], candidate: [] }]).packets.length, 0);
  assert.throws(() => buildBlindPackets([row], { limit: 0 }), /limit/);
});


test('packet and key must be distinct targets', () => {
  assert.throws(() => assertDistinctTargets('H:/x/p.json', 'H:/x/p.json'), /同一目标/);
  if (process.platform === 'win32') assert.throws(() => assertDistinctTargets('H:/x/P.json', 'H:/x/p.json'), /同一目标/);
  assert.doesNotThrow(() => assertDistinctTargets('H:/x/p.json', 'H:/x/k.json'));
});
