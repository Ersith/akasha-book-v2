// M3 · pure canary plan: selection + eligibility + candidate, no IO or logs.
import { applyTimeToHits } from './lookup-time-apply.mjs';
import { evaluateCanaryEligibility } from './canary-eligibility.mjs';
import { selectExperimentRequest, isM3ExperimentConfig } from './m3-experiment.mjs';

/**
 * Disabled returns decision-only; the caller keeps its baseline. Enabled returns
 * selection/eligibility/candidate and served. serveCandidate defaults false.
 */
export function planCanary(input = {}) {
  const experiment = input.experiment;
  if (!experiment?.enabled) return { enabled: false, servedCandidate: false, reason: 'disabled' };
  if (!isM3ExperimentConfig(experiment)) throw new TypeError('experiment 必须来自 resolveM3Experiment');
  const { hits, shadow, intent, session, dataView, classExplicit = false, requestId, lambda = 0.1 } = input;
  if (!Number.isFinite(lambda) || lambda < 0 || lambda > 1) throw new TypeError('lambda 必须在 [0,1]');
  const selection = selectExperimentRequest(experiment, requestId);
  const eligibility = evaluateCanaryEligibility({ hits, shadow, intent, session, dataView, classExplicit, requireAllC2: experiment.eligibilityMode !== 'mixed' });
  const selected = selection.selected && eligibility.eligible;
  let candidate = { hits, applied: false, reason: selection.selected ? 'ineligible' : 'not-selected', diagnostics: [] };
  if (selected) candidate = applyTimeToHits({ hits, shadow, policy: { mode: 'rank', lambda }, queryContext: { mode: 'recent' }, stores: ['canon'] });
  const servedCandidate = selected && experiment.serveCandidate === true && candidate.applied === true;
  return {
    enabled: true, selection, eligibility, selected, candidate,
    served: servedCandidate ? candidate.hits : hits,
    servedCandidate, serveRequested: experiment.serveCandidate === true,
  };
}
