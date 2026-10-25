import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lookupDetailed } from './lib.mjs';

test('lookup mirror situation gate is opt-in and excludes own-log mirrors', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lookup-mirror-gate-'));
  try {
    const files = {};
    for (const store of ['canon', 'orphan', 'pricing', 'lexicon', 'frontier']) {
      files[store] = join(dir, store + '.jsonl');
      writeFileSync(files[store], '');
    }
    files.mirror = join(dir, 'mirror.jsonl');
    writeFileSync(files.mirror, [
      JSON.stringify({ id: 'story-1', story: '狼来了', situation: '反复虚构危险、消耗他人信任', behavior: '说谎', outcome: '无人相信', evidence: 'story' }),
      JSON.stringify({ id: 'own-1', story: '自身经历', situation: '反复虚构危险、消耗他人信任', behavior: '说谎', outcome: '无人相信', evidence: 'own-log' }),
    ].join('\n') + '\n');

    const plain = lookupDetailed('狼来了', { files, contextBudget: false });
    assert.ok(plain.hits.some((hit) => hit.store === 'mirror' && hit.id === 'story-1'));

    const gated = lookupDetailed('狼来了', { files, contextBudget: false, mirrorSituationGate: true });
    assert.equal(gated.hits.some((hit) => hit.store === 'mirror'), false);
    assert.ok(gated.stats.filtered.mirrorSituationGate >= 1);

    const positive = lookupDetailed('消耗信任', { files, contextBudget: false, mirrorSituationGate: true });
    assert.ok(positive.hits.some((hit) => hit.store === 'mirror' && hit.id === 'story-1'));
    assert.equal(positive.hits.some((hit) => hit.id === 'own-1'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
