// M3 · canary eligibility decision (read-only; no traffic).
// Default remains strict: every evaluated item must be C2. `requireAllC2:false`
// is an explicit trial mode: at least one C2 is required; only C1 neighbours are
// allowed, and C1 stays pinned by lookup-time-apply.
export function evaluateCanaryEligibility({ hits, shadow, intent, session, dataView, classExplicit = false, requireAllC2 = true } = {}) {
  const reasons = [];
  if (intent?.kind !== 'recent') reasons.push('intent-not-recent');
  if (!dataView?.valid) reasons.push('data-view-invalid');
  else if (!dataView?.consistent) reasons.push('data-view-changed');
  if (classExplicit) reasons.push('explicit-class');
  if (!shadow || !Array.isArray(shadow.diagnostics) || shadow.diagnostics.length === 0) reasons.push('no-evaluated-items');
  if ((shadow?.storeErrors || []).length) reasons.push('store-errors');
  if ((shadow?.skipped || []).some((item) => item.reason === 'evaluate-error')) reasons.push('evaluate-error');
  if ((shadow?.diagnostics || []).some((item) => item.complete === false)) reasons.push('incomplete-evaluation');
  const classes = (shadow?.diagnostics || []).map((item) => item.evaluation?.contentClass);
  if (requireAllC2 && classes.some((cls) => cls !== 'C2')) reasons.push('non-c2');
  if (!requireAllC2) {
    if (!classes.includes('C2')) reasons.push('no-c2');
    // Mixed is C1+C2 only: C3/unknown are not silently admitted as pinned neighbours.
    if (classes.some((cls) => !['C1', 'C2'].includes(cls))) reasons.push('non-c1-c2');
  }
  if ((hits || []).some((hit) => hit.zeroWeight === true)) reasons.push('zero-weight-hit');
  return { scope: 'observed-eligibility', eligible: reasons.length === 0, reasons: [...new Set(reasons)] };
}
