// M2 · lookup time shadow: evaluate evidence for existing hits without changing rank/order.
import { evaluate, reduceEvidence, shadowScore, validatePolicy } from './forgetting.mjs';
import { recordToView } from './record-view.mjs';
import { snapshotEvidence, summaryForSnapshot } from './evidence-index.mjs';

/** Pure-ish shadow pass: reads evidence and supplied current records; never mutates hits. */
export function timeShadowLookup({ hits, recordsByStore = {}, storeErrors = [], evidenceFile, contextRef = 'lookup:shadow', contentClass, now, cutoff, today, lambda = 0.1, policy = {} } = {}) {
  if (!Array.isArray(hits)) throw new TypeError('hits 必须是数组');
  if (!Number.isFinite(lambda) || lambda < 0 || lambda > 1) throw new TypeError('time lambda 必须在 [0,1]');
  if (!now || !cutoff) throw new TypeError('time shadow 需要 now 与 cutoff');
  if (typeof contextRef !== 'string' || !contextRef.trim()) throw new TypeError('time contextRef 必须是非空字符串');
  if (contentClass !== undefined && !['C1', 'C2', 'C3'].includes(contentClass)) throw new TypeError('time contentClass 必须是 C1/C2/C3');
  validatePolicy(policy);
  const probe = { store: 'canon', id: '__shadow_probe__', versionId: '__shadow_probe__', digest: 'sha256:' + '0'.repeat(64) };
  reduceEvidence([], { target: probe, contextRef, now, cutoff });
  const snap = snapshotEvidence(evidenceFile);
  const diagnostics = [];
  const skipped = [];
  const erroredStores = new Set(storeErrors.map((item) => item.store));
  for (const hit of hits) {
    const store = hit?.store;
    const id = hit?.id;
    if (erroredStores.has(store)) { skipped.push({ store, id, reason: 'store-error' }); continue; }
    const record = (recordsByStore[store] || []).find((item) => item.id === id);
    if (!record) { skipped.push({ store, id, reason: 'record-not-found' }); continue; }
    try {
      const view = recordToView(record, { store, contentClass, contextRef });
      const summary = summaryForSnapshot(snap, { target: { store, id, versionId: view.versionId, digest: view.digest }, contextRef, now, cutoff });
      const evaluation = evaluate(view, summary, { today, now, policy });
      const shadow = shadowScore(Number(hit.rank) || 0, evaluation, { mode: 'recent' }, { ...policy, mode: 'shadow', lambda });
      diagnostics.push({
        store, id, baseRank: shadow.baseRank, retention: evaluation.retention,
        factor: shadow.factor, rank: shadow.rank, applied: shadow.applied, coverage: summary.coverage,
        complete: evaluation.complete, reasons: evaluation.reasons, evaluation,
      });
    } catch (error) {
      const normal = ['unsupported-store', 'unknown-class'].includes(error.code);
      skipped.push({ store, id, reason: normal ? error.code : 'evaluate-error', detail: String(error.message) });
    }
  }
  return {
    mode: 'shadow', appliedToResults: false, source: snap.file, storeErrors,
    evaluated: diagnostics.length, skipped, diagnostics,
    policy: { lambda, mode: 'shadow' },
  };
}
