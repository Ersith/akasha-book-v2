// M4.5 · mirror situation gate. Mirror is an external situation match, not a topic hit.
import { mirrorMatch, mirrorSituationScore } from './lib.mjs';

/**
 * Gate mirror hits by the current situation. A hit must share at least one
 * multi-character situation token; patterns are only a tie-breaker, never a
 * substitute for a situation hit. Default evidence is `story` (external mirror),
 * so own-log experience is not admitted as a paradigm mirror.
 */
export function gateMirrorSituations(text, opts = {}) {
  const { limit = 3, minSituationScore = 2, ...matchOpts } = opts;
  if (!String(text ?? '').trim()) return [];
  const candidates = mirrorMatch(text, {
    ...matchOpts,
    evidence: matchOpts.evidence ?? 'story',
    limit: Number.MAX_SAFE_INTEGER,
  });
  const gated = [];
  for (const hit of candidates) {
    const { situationScore, patternScore } = mirrorSituationScore(text, hit);
    if (situationScore < minSituationScore) continue;
    gated.push({ ...hit, situationScore, patternScore });
  }
  return gated.sort((a, b) => b.situationScore - a.situationScore || b.patternScore - a.patternScore || b.score - a.score).slice(0, limit);
}
