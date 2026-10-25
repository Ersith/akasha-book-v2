// M4 · canary readiness gate. Pure; never starts traffic or serves candidates.
export function evaluateCanaryReadiness({
  samples = 0, orderChanged = 0, humanReview = null,
  stopSwitch = false, budgetRoot = false, journal = false,
} = {}) {
  const reasons = [];
  if (!Number.isSafeInteger(samples) || samples < 20) reasons.push('samples-below-20');
  if (!Number.isSafeInteger(orderChanged) || orderChanged < 5) reasons.push('order-changed-below-5');
  if (humanReview?.verdict !== 'pass') reasons.push('human-review-not-passed');
  if (stopSwitch !== true) reasons.push('stop-switch-not-verified');
  if (budgetRoot !== true) reasons.push('budget-root-not-explicit');
  if (journal !== true) reasons.push('journal-not-wired');
  return { ready: reasons.length === 0, reasons };
}
