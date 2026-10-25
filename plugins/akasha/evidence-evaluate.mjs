// M2 · evaluate one record view with the evidence summary supplied to M1.
import { evaluate, recordDigest } from './forgetting.mjs';
import { snapshotEvidence, summaryForSnapshot } from './evidence-index.mjs';

/** Pure adapter: one snapshot -> M1 evidence summary -> M1 evaluation. No writes. */
export function evaluateEvidence({ file, target, contextRef, view, now, cutoff, today, policy = {} } = {}) {
  if (!target || typeof target !== 'object') throw new TypeError('target 必须是对象');
  if (!view || typeof view !== 'object' || Array.isArray(view)) throw new TypeError('view 必须是对象');
  for (const key of ['store', 'id', 'versionId', 'digest']) {
    if (view[key] !== target[key]) throw new TypeError(`view.${key} 必须与 target 一致`);
  }
  if (view.content !== undefined) {
    const computed = recordDigest({ ...target, content: view.content });
    if (computed !== view.digest) throw new TypeError('view.digest 与 view.content 不一致');
  }
  const snap = snapshotEvidence(file);
  const summary = summaryForSnapshot(snap, { target, contextRef, now, cutoff });
  const evaluation = evaluate({ ...view, ...target, contextRef }, summary, { today, now, policy });
  return { summary, evaluation };
}
