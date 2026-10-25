import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'akasha-clusters-root-'));
process.env.AKASHA_ROOT = root;
process.env.AKASHA_LOGS = join(root, 'logs');
mkdirSync(process.env.AKASHA_LOGS, { recursive: true });

const { sessionClusters } = await import('./session.mjs');

test('sessionClusters: scoped fixture, explicit recent boundary and metadata', () => {
  const dir = mkdtempSync(join(root, 'case-'));
  const storeFile = join(dir, 'session.jsonl');
  try {
    const rows = [
      { id: 'seg-c1', kind: 'intent', session: 'fixture-s1', seq: 1, time: '2026-10-23T00:00:00Z', gist: '缓存前缀 缓存后缀 稳定段' },
      { id: 'seg-c2', kind: 'intent', session: 'fixture-s1', seq: 2, time: '2026-10-24T00:00:00Z', gist: '缓存前缀 动态段 稳定段' },
      { id: 'seg-c3', kind: 'conclusion', session: 'fixture-s1', seq: 3, time: '2026-10-24T00:01:00Z', gist: '缓存前缀 结论' },
      { id: 'seg-epoch', kind: 'intent', session: 'fixture-s1', seq: 4, time: '1970-01-01T00:00:00Z', gist: '缓存前缀 epoch' },
      { id: 'seg-old', kind: 'intent', session: 'fixture-s1', seq: 5, time: '2025-01-01T00:00:00Z', gist: '缓存前缀 old' },
      { id: 'seg-future', kind: 'intent', session: 'fixture-s1', seq: 6, time: '2099-01-01T00:00:00Z', gist: '缓存前缀 future' },
      { id: 'seg-unknown', kind: 'intent', session: 'fixture-s1', seq: 7, gist: '缓存前缀 unknown' },
    ];
    writeFileSync(storeFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

    const scoped = sessionClusters({ storeFile, session: 'fixture-s1', topN: 5, minCount: 2 });
    assert.ok(Array.isArray(scoped));
    assert.ok(scoped.length >= 1);
    assert.ok(scoped[0].count >= 2);
    assert.equal(scoped.window, null);

    const bounded = sessionClusters({
      storeFile,
      recent: true,
      maxSegments: 1,
      windowDays: 30,
      nowMs: Date.parse('2026-10-24T01:00:00Z'),
      topN: 5,
      minCount: 1,
    });
    assert.equal(bounded.window.bounded, true);
    assert.equal(bounded.window.selected, 1);
    assert.equal(bounded.window.truncated, true);
    assert.equal(bounded.window.considered, 3, 'only 10-23/10-24 rows are in [cutoff, asOf]');
    assert.equal(bounded.window.unknownTime, 1, 'missing time must be counted, not included');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.after(() => rmSync(root, { recursive: true, force: true }));
