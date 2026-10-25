// M3 · paired observation: one lookup snapshot, baseline served, candidate only logged.
import { createHash, randomUUID } from 'node:crypto';
import { evaluateCanaryEligibility } from './canary-eligibility.mjs';

export const OBSERVE_SCHEMA = 'akasha-time-observe/v1';

const topIds = (hits, n) => (Array.isArray(hits) ? hits : []).slice(0, n).map((hit) => hit.id);
const allIds = (hits) => (Array.isArray(hits) ? hits : []).map((hit) => hit.id);
const sameOrder = (a, b) => a.length === b.length && a.every((id, index) => id === b[index]);
const overlap = (a, b) => {
  const set = new Set(b);
  return a.filter((id) => set.has(id)).length;
};

/** Build a structured pair from the same hits/shadow/candidate; no second lookup. */
export function buildTimeObservation({
  query, hits, shadow, candidate, origin = 'cli', requestId = randomUUID(),
  now, cutoff, today, contextRef, contentClass, lambda, intent, session, dataView, classExplicit = false,
  served = 'baseline', canary = null,
} = {}) {
  if (!Array.isArray(hits)) throw new TypeError('hits 必须是数组');
  if (!shadow || !Array.isArray(shadow.diagnostics)) throw new TypeError('shadow diagnostics 缺失');
  if (!candidate || !Array.isArray(candidate.hits)) throw new TypeError('candidate.hits 缺失');
  const baselineAll = allIds(hits);
  const candidateAll = allIds(candidate.hits);
  const baselineById = new Map(hits.map((hit, index) => [hit.id, { index, hit }]));
  const unslotMoved = candidate.hits
    .map((hit, index) => ({ hit, index }))
    .filter(({ hit, index }) => !hit.timeEvaluated && baselineById.get(hit.id)?.index !== index)
    .map(({ hit, index }) => ({ id: hit.id, store: hit.store, from: baselineById.get(hit.id)?.index ?? null, to: index }));
  const inputDigest = createHash('sha256').update(JSON.stringify({
    hits: hits.map((hit) => ({ store: hit.store, id: hit.id, rank: hit.rank, score: hit.score, timeEvaluated: !!hit.timeEvaluated })),
    diagnostics: (shadow.diagnostics || []).map((item) => ({ store: item.store, id: item.id, retention: item.retention, factor: item.factor, complete: item.complete })),
  })).digest('hex');
  const canaryEligibility = evaluateCanaryEligibility({ hits, shadow, intent, session, dataView, classExplicit });
  return {
    schemaVersion: OBSERVE_SCHEMA,
    requestId,
    origin,
    observed: 'paired',
    served,
    createdAt: new Date().toISOString(),
    query,
    clock: { now, cutoff, today },
    contextRef,
    contentClass,
    lambda,
    intent: intent || null,
    session: session || null,
    dataView: dataView || null,
    inputDigest,
    canaryEligibility,
    canary: canary || null,
    requested: hits.length,
    evaluated: shadow.diagnostics.length,
    eligible: shadow.diagnostics.filter((item) => item.complete !== false).length,
    candidateApplied: candidate.applied,
    reason: candidate.reason || null,
    skipped: (shadow.skipped || []).map((item) => ({ store: item.store, id: item.id, reason: item.reason })),
    storeErrors: shadow.storeErrors || [],
    baseline: {
      ids: baselineAll.slice(0, 10),
      allIds: baselineAll,
      top5: baselineAll.slice(0, 5),
      top10: baselineAll.slice(0, 10),
      hits: hits.length,
    },
    candidate: {
      ids: candidateAll.slice(0, 10),
      allIds: candidateAll,
      top5: candidateAll.slice(0, 5),
      top10: candidateAll.slice(0, 10),
      hits: candidate.hits.length,
    },
    rankChanged: candidate.hits.some((hit) => hit.timeApplied === true),
    orderChanged: !sameOrder(baselineAll, candidateAll),
    top1Changed: (baselineAll[0] ?? null) !== (candidateAll[0] ?? null),
    delta: {
      top5Overlap: overlap(baselineAll.slice(0, 5), candidateAll.slice(0, 5)),
      top10Overlap: overlap(baselineAll.slice(0, 10), candidateAll.slice(0, 10)),
      orderChanged: baselineAll.join('\u0000') !== candidateAll.join('\u0000'),
      unevaluatedMoved: unslotMoved,
    },
  };
}

/** Failure terminal record for the whole shadow/apply stage (no hits mutation). */
export function buildFailedObservation({
  query, stage = 'shadow', error, origin = 'cli', requestId = randomUUID(),
  now, cutoff, today, contextRef, contentClass, lambda, intent, session, dataView, canary = null,
} = {}) {
  return {
    schemaVersion: OBSERVE_SCHEMA,
    requestId,
    origin,
    observed: 'failed',
    served: 'baseline',
    createdAt: new Date().toISOString(),
    query,
    stage,
    error: String(error?.message || error || 'unknown'),
    clock: { now, cutoff, today },
    contextRef,
    contentClass,
    lambda,
    intent: intent || null,
    session: session || null,
    dataView: dataView || null,
    canary: canary || null,
  };
}

/** Deep-copy a record with every string bounded, for persistence only. */
export function boundObservationRecord(value, max = 500) {
  if (typeof value === 'string') return value.slice(0, max);
  if (Array.isArray(value)) return value.map((item) => boundObservationRecord(item, max));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = boundObservationRecord(item, max);
    return out;
  }
  return value;
}
