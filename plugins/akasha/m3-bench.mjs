// M4 · offline benchmark metrics and report helpers. Report creation requires a
// trusted output parent; this module does not open canary traffic or store logs.
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const BENCH_SCHEMA = 'akasha-m3-bench/v1';

const ids = (hits) => (Array.isArray(hits) ? hits.map((hit) => hit.id) : []);
const overlap = (a, b) => { const set = new Set(b); return a.filter((id) => set.has(id)).length; };
const inside = (root, path) => {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};
const physical = (path) => {
  const full = resolve(path);
  if (existsSync(full)) return realpathSync(full);
  const parent = dirname(full);
  return existsSync(parent) ? join(realpathSync(parent), basename(full)) : full;
};

/** Refuse outputs that can replace the query set, stores, logs, or evidence.
 * The output parent is a trusted, operator-controlled directory and must not be
 * renamed/swapped during the run; this is a static-path guard, not a defense
 * against an adversarial rename between the check and the create. */
export function assertSafeOutput(outputFile, { queryFile, protectedPaths = [] } = {}) {
  if (typeof outputFile !== 'string' || !outputFile.trim()) throw new TypeError('outputFile 必须是非空路径');
  const out = physical(outputFile);
  if (queryFile && out.toLowerCase() === physical(queryFile).toLowerCase()) throw new Error('outputFile 不能覆盖查询集');
  for (const path of protectedPaths) {
    if (typeof path !== 'string' || !path.trim()) continue;
    if (inside(physical(path), out)) throw new Error('outputFile 不能写入受保护路径：' + path);
  }
  return out;
}

/** Metrics for one baseline/candidate pair; applied and orderChanged are distinct. */
export function pairMetrics(baselineHits, candidateHits) {
  const baseline = ids(baselineHits);
  const candidate = ids(candidateHits);
  return {
    hits: baseline.length,
    top5Overlap: overlap(baseline.slice(0, 5), candidate.slice(0, 5)),
    top10Overlap: overlap(baseline.slice(0, 10), candidate.slice(0, 10)),
    rankChanged: Array.isArray(candidateHits) && candidateHits.some((hit) => hit.timeApplied === true),
    orderChanged: baseline.join('\u0000') !== candidate.join('\u0000'),
    top1Changed: (baseline[0] ?? null) !== (candidate[0] ?? null),
  };
}

/** Aggregate rows produced by the benchmark runner. Overlap averages exclude zero-hit rows. */
export function summarizeBench(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const count = (key) => list.filter((row) => row[key] === true).length;
  const ranked = list.filter((row) => (row.hits ?? 0) > 0);
  const avg = (key) => ranked.length ? Number((ranked.reduce((sum, row) => sum + (row[key] ?? 0), 0) / ranked.length).toFixed(3)) : null;
  return {
    schemaVersion: BENCH_SCHEMA,
    queries: list.length,
    rankedQueries: ranked.length,
    zeroHitQueries: list.length - ranked.length,
    eligible: count('eligible'),
    applied: count('applied'),
    rankChanged: count('rankChanged'),
    orderChanged: count('orderChanged'),
    top1Changed: count('top1Changed'),
    avgTop5Overlap: avg('top5Overlap'),
    avgTop10Overlap: avg('top10Overlap'),
    overlapDenominator: ranked.length,
    reasonCounts: list.flatMap((row) => row.reasons || []).reduce((out, reason) => {
      out[reason] = (out[reason] || 0) + 1;
      return out;
    }, {}),
  };
}

/** Create-only report write; an existing file or hardlink alias is refused. */
export function writeBenchReport(outputFile, content) {
  writeFileSync(outputFile, content, { flag: 'wx' });
}
