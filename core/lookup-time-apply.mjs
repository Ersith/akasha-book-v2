// M3 · slot-preserving time ranking: only C2 moves; C1 is pinned in every apply path.
// This is a global safety rule, not a mixed-canary-only mode.
import { applyTimeBatch } from './forgetting.mjs';

/** Unevaluated hits keep their exact slot, so no unevaluated hit can leapfrog by staying still. */
export function applyTimeToHits({ hits, shadow, policy = { mode: 'rank', lambda: 0.1 }, queryContext = { mode: 'recent' }, stores = null } = {}) {
  if (!Array.isArray(hits)) throw new TypeError('hits 必须是数组');
  if (stores !== null && (!Array.isArray(stores) || stores.length === 0 || stores.some((store) => typeof store !== 'string'))) throw new TypeError('stores 必须是非空字符串数组或 null');
  if (!shadow || !Array.isArray(shadow.diagnostics)) throw new TypeError('time shadow diagnostics 缺失');
  const failed = shadow.diagnostics.some((item) => item.complete === false)
    || (shadow.skipped || []).some((item) => item.reason === 'evaluate-error')
    || (shadow.storeErrors || []).length > 0;
  if (failed) return { hits, applied: false, reason: 'incomplete-evidence', diagnostics: [] };
  const diagnostics = new Map(shadow.diagnostics.map((item) => [`${item.store}\u0000${item.id}`, item]));
  const slots = [];
  for (let index = 0; index < hits.length; index += 1) {
    const hit = hits[index];
    const item = diagnostics.get(`${hit.store}\u0000${hit.id}`);
    // Only C2 is time-decayable. C1 is pinned in its absolute slot so a mixed
    // query cannot move protected/self records just because a neighbour decays.
    // `stores` narrows the canary scope (e.g. canon-only: external mirror is not time-decayed).
    if (item && item.evaluation && item.evaluation.contentClass === 'C2' && (stores === null || stores.includes(hit.store))) slots.push({ index, hit, evaluation: item.evaluation });
  }
  if (!slots.length) return { hits, applied: false, reason: 'no-evaluated-items', diagnostics: [] };
  const candidates = slots.map(({ hit, evaluation }) => ({ ...hit, baseRank: hit.rank, evaluation, complete: true }));
  const batch = applyTimeBatch(candidates, { queryContext, policy, complete: true });
  if (!batch.applied) return { hits, applied: false, reason: batch.fallback ? (batch.reason || 'm1-fallback') : 'no-rank-change', diagnostics: batch.diagnostics || [] };
  const evaluated = slots.map((slot, i) => ({
    index: slot.index,
    hit: {
      ...slot.hit,
      rank: batch.candidates[i].rank,
      timeEvaluated: true,
      timeApplied: batch.candidates[i].rank !== slot.hit.rank,
      timeBaseRank: slot.hit.rank,
    },
  }));
  evaluated.sort((a, b) => (Number(b.hit.rank) || 0) - (Number(a.hit.rank) || 0)
    || (Number(b.hit.score) || 0) - (Number(a.hit.score) || 0)
    || String(a.hit.id).localeCompare(String(b.hit.id)));
  const updated = hits.slice();
  for (let i = 0; i < slots.length; i += 1) updated[slots[i].index] = evaluated[i].hit;
  return { hits: updated, applied: true, diagnostics: batch.diagnostics || [] };
}
