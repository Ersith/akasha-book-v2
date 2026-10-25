import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gateMirrorSituations } from './mirror-gate.mjs';

test('situation-gate rescues a true situation hit below the old top-12 prefilter', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-gate-recall-'));
  try {
    const file = join(dir, 'mirror.jsonl');
    const records = [];
    for (let i = 0; i < 13; i += 1) {
      records.push({
        id: `noise-${i}`,
        evidence: 'story',
        story: `noise-${i}`,
        situation: '无关情境',
        behavior: '消耗信任 消耗信任 消耗信任 消耗信任 消耗信任 消耗信任',
        outcome: '无关',
        social_reaction: '无关',
        emotion: '无关',
      });
    }
    records.push({
      id: 'target',
      evidence: 'story',
      story: 'target',
      situation: '消耗信任',
      behavior: '无关',
      outcome: '无关',
      social_reaction: '无关',
      emotion: '无关',
    });
    writeFileSync(file, records.map((row) => JSON.stringify(row)).join('\n') + '\n');
    const hits = gateMirrorSituations('消耗信任', { file, limit: 3 });
    assert.ok(hits.some((hit) => hit.id === 'target'), JSON.stringify(hits.map((hit) => hit.id)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
