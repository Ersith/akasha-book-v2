// M4.5 · own-experience baseline review. Pure; no store writes and no traffic.
export const BASELINE_STATUS = Object.freeze({
  CURRENT: 'baseline-still-current',
  CAPABILITY_CHANGED: 'capability-changed',
  PAST_FAILURE: 'past-failure-needs-review',
  CANDIDATE: 'candidate-needs-validation',
  NEEDS_EVIDENCE: 'needs-evidence',
});

const OUTCOMES = new Set(['success', 'partial', 'failure']);

/**
 * Compare a past own-experience baseline with the current approach.
 * A different approach only becomes a candidate after evidence is attached;
 * evidence makes it reviewable, not proven better.
 */
export function compareBaseline({ past, now } = {}) {
  if (!past || typeof past !== 'object') throw new TypeError('past baseline 必须是对象');
  if (!now || typeof now !== 'object') throw new TypeError('now 必须是对象');
  if (!OUTCOMES.has(past.outcome)) throw new TypeError('past.outcome 必须是 success/partial/failure');
  if (typeof past.approach !== 'string' || !past.approach.trim()) throw new TypeError('past.approach 必须是非空字符串');
  if (typeof now.approach !== 'string' || !now.approach.trim()) throw new TypeError('now.approach 必须是非空字符串');
  const evidence = Array.isArray(now.evidence) ? now.evidence.filter((item) => typeof item === 'string' && item.trim()) : [];
  const capabilityChanged = typeof now.capability === 'string' && typeof past.capability === 'string' && now.capability !== past.capability;
  if (now.approach === past.approach) {
    if (past.outcome === 'failure') {
      return { status: BASELINE_STATUS.PAST_FAILURE, requiresReview: true, reasons: ['past-failure-same-approach'], evidence };
    }
    return {
      status: capabilityChanged ? BASELINE_STATUS.CAPABILITY_CHANGED : BASELINE_STATUS.CURRENT,
      requiresReview: capabilityChanged,
      reasons: capabilityChanged ? ['same-approach-capability-changed'] : ['same-approach'],
      evidence,
    };
  }
  if (!evidence.length) {
    return { status: BASELINE_STATUS.NEEDS_EVIDENCE, requiresReview: true, reasons: ['new-approach-without-evidence'], evidence };
  }
  return {
    status: BASELINE_STATUS.CANDIDATE,
    requiresReview: true,
    reasons: ['new-approach-with-evidence-not-yet-validated'],
    evidence,
  };
}
