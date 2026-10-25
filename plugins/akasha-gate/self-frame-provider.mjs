// 插件侧 step-token 消费器：宿主必须显式给出逻辑步骤 token；本模块不猜全局 latest。
// token 不存在 = 老宿主，调用方走旧路径；token 存在但 frame 不可用 = 明确 fallback，不回读 latest。
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { deriveSelfCardProjection, SELF_CARD_POLICY, SELF_CARD_MAX_CHARS } from './self-card-view.mjs';

export function createSelfFrameProvider({ akashaDir, dataDir, subjectId = 'default' } = {}) {
  let modules = null;
  let loadError = null;
  const byToken = new WeakMap();
  const primitiveByToken = new Map();
  const loading = Promise.all([
    import(pathToFileURL(join(akashaDir, 'self-loader.mjs')).href),
    import(pathToFileURL(join(akashaDir, 'self-frame.mjs')).href),
  ]).then(([loader, frame]) => { modules = { ...loader, ...frame }; })
    .catch(() => { loadError = 'module-load-failed'; });

  function cacheFor(token) {
    if (token && typeof token === 'object') return { get: () => byToken.get(token), set: (v) => byToken.set(token, v) };
    return { get: () => primitiveByToken.get(token), set: (v) => primitiveByToken.set(token, v) };
  }

  function build(token) {
    if (!token) return { status: 'no-step' };
    const cache = cacheFor(token);
    const hit = cache.get();
    if (hit) return hit;
    if (!modules) {
      const value = { status: 'unavailable', reason: loadError ?? 'loading' };
      // Loading is transient. Do not poison this step before the assembly barrier.
      if (loadError) cache.set(value);
      return value;
    }
    try {
      const { source, projection: canonicalProjection } = modules.projectSelf({
        canonFile: join(dataDir, 'canon.jsonl'),
        subjectId,
        requiredKinds: ['identity', 'address'],
        inputMode: 'mixed-canon',
        maxStableChars: 8192,
        maxCardChars: SELF_CARD_MAX_CHARS,
        cardOverflow: 'omit',
      });
      if (!['ok', 'degraded'].includes(canonicalProjection.status)) {
        const value = { status: 'unavailable', reason: 'projection-failed', diagnostics: {
          projectionStatus: canonicalProjection.status, sourceErrorCount: source.errors.length,
          warningCount: canonicalProjection.warnings.length, entryCount: canonicalProjection.entries.length,
          stableChars: canonicalProjection.stableText.length, cardStatus: canonicalProjection.cardStatus,
        } };
        cache.set(value);
        return value;
      }
      const projection = deriveSelfCardProjection(canonicalProjection);
      const frame = modules.createSelfFrame({
        source, projection, subjectId,
        bindingRevision: 'akasha-gate-step/v3-self-card', storeRootId: dataDir,
        renderPolicy: { inputMode: 'mixed-canon', budgetPolicy: projection.budgetPolicy,
          selfView: 'selfCard', cardPolicy: SELF_CARD_POLICY, maxCardChars: SELF_CARD_MAX_CHARS, cardStatus: projection.cardStatus },
        requiredSemanticKeys: [], allowDegraded: true,
      });
      const value = { status: 'frame', frame };
      cache.set(value);
      return value;
    } catch {
      const value = { status: 'unavailable', reason: 'frame-build-failed' };
      cache.set(value);
      return value;
    }
  }

  return {
    ready: () => modules !== null,
    load: () => loading,
    frameFor: (token) => build(token),
    render(token, view, { taintRe = null } = {}) {
      const hit = build(token);
      if (hit.status !== 'frame') return hit;
      const frame = hit.frame;
      let text;
      if (view === 'self') text = frame.projection.stableText;
      else if (view === 'selfCard') text = frame.projection.cardText;
      else if (view === 'selfLine') text = frame.projection.views.selfLine;
      else if (view === 'address') text = frame.projection.views.addressText;
      else return { status: 'unsupported-view', frame };
      if (!text || !String(text).trim()) return { status: 'empty', frame };
      if (taintRe instanceof RegExp) {
        // Summarizing cannot hide a tainted source sentence outside the excerpt.
        const inputs = view === 'selfCard' ? [frame.projection.stableText, text] : [text];
        const pattern = new RegExp(taintRe.source, taintRe.flags);
        if (inputs.some(value => { pattern.lastIndex = 0; return pattern.test(value); })) return { status: 'tainted', frame };
      }
      return { status: 'frame', frame, text };
    },
  };
}
