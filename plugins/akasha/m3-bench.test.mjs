import test from 'node:test';
import assert from 'node:assert/strict';
import { pairMetrics, summarizeBench, assertSafeOutput, writeBenchReport } from './m3-bench.mjs';
import { mkdtempSync, writeFileSync, linkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('pair metrics keep applied and orderChanged distinct', () => {
  const baseline = [{ id: 'a', rank: 1 }, { id: 'b', rank: 2 }];
  const noOrder = [{ id: 'a', rank: 0.9, timeApplied: true }, { id: 'b', rank: 2 }];
  const reordered = [{ id: 'b', rank: 2 }, { id: 'a', rank: 1, timeApplied: true }];
  assert.deepEqual(pairMetrics(baseline, noOrder), {
    hits: 2, top5Overlap: 2, top10Overlap: 2, rankChanged: true, orderChanged: false, top1Changed: false,
  });
  assert.equal(pairMetrics(baseline, reordered).orderChanged, true);
  assert.equal(pairMetrics(baseline, reordered).top1Changed, true);
});

test('summary counts boolean dimensions and reason histogram', () => {
  const summary = summarizeBench([
    { hits: 2, eligible: true, applied: true, rankChanged: true, orderChanged: false, top1Changed: false, top5Overlap: 5, top10Overlap: 10, reasons: [] },
    { hits: 2, eligible: false, applied: false, rankChanged: false, orderChanged: false, top1Changed: false, top5Overlap: 3, top10Overlap: 8, reasons: ['non-c2', 'non-c2'] },
  ]);
  assert.equal(summary.queries, 2);
  assert.equal(summary.eligible, 1);
  assert.equal(summary.applied, 1);
  assert.equal(summary.rankChanged, 1);
  assert.equal(summary.orderChanged, 0);
  assert.equal(summary.avgTop5Overlap, 4);
  assert.deepEqual(summary.reasonCounts, { 'non-c2': 2 });
});


test('output guard refuses query set, store, and log paths', () => {
  assert.throws(() => assertSafeOutput('<AKASHA_DIR>/data/canon.jsonl', { protectedPaths: ['<AKASHA_DIR>/data'] }), /受保护/);
  assert.throws(() => assertSafeOutput('<AKASHA_DIR>/logs/query-log.jsonl', { protectedPaths: ['<AKASHA_DIR>/logs'] }), /受保护/);
  assert.throws(() => assertSafeOutput('<LOCAL_PATH>/tmp/q.jsonl', { queryFile: '<LOCAL_PATH>/tmp/q.jsonl' }), /查询集/);
  assert.match(assertSafeOutput('<LOCAL_PATH>/tmp/report.json', { protectedPaths: ['<AKASHA_DIR>/data'] }), /report\.json$/);
});

test('empty summary keeps the same shape and averages exclude zero-hit rows', () => {
  const empty = summarizeBench([]);
  for (const key of ['queries', 'rankedQueries', 'zeroHitQueries', 'eligible', 'applied', 'rankChanged', 'orderChanged', 'top1Changed', 'avgTop5Overlap', 'avgTop10Overlap', 'overlapDenominator']) {
    assert.ok(Object.hasOwn(empty, key), key);
  }
  const summary = summarizeBench([
    { hits: 0, eligible: false, top5Overlap: 0, top10Overlap: 0, reasons: [] },
    { hits: 2, eligible: false, top5Overlap: 1, top10Overlap: 2, reasons: [] },
  ]);
  assert.equal(summary.zeroHitQueries, 1);
  assert.equal(summary.overlapDenominator, 1);
  assert.equal(summary.avgTop5Overlap, 1);
});


test('report write is create-only so hardlink aliases cannot replace files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm3-bench-link-'));
  try {
    const target = join(dir, 'protected.jsonl');
    const alias = join(dir, 'report.json');
    writeFileSync(target, 'keep');
    linkSync(target, alias);
    assert.throws(() => writeBenchReport(alias, 'replace'), /EEXIST/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
