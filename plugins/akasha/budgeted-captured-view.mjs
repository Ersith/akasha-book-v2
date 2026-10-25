// Opt-in adapter: capture bytes and managed logs share one explicit budget root.
// It neither appends observations nor changes serving / CLI / apply semantics.
import { captureLookupView } from './captured-lookup-view.mjs';
import { preparePairedLookupRequest, evaluateCapturedLookupView } from './paired-lookup-view.mjs';
import { isM3ResourceBudget } from './m3-resource-budget.mjs';

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const fail = (code, message, fields = {}) => Object.assign(new Error(message), { code, ...fields });
const errorInfo = error => ({ code: error?.code || 'M3_CAPTURE_IO', message: String(error?.message || error) });

function captureLimits(budget, input) {
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input))) {
    throw fail('M3_CAPTURE_BUDGET_ARGUMENT', 'capture limits must be an object');
  }
  const limits = { ...input };
  const ceiling = Math.min(MAX_CAPTURE_BYTES, budget.limits.maxLeaseBytes);
  const bytes = Object.hasOwn(limits, 'maxTotalBytes') ? limits.maxTotalBytes : ceiling;
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > ceiling) {
    throw fail('M3_CAPTURE_BUDGET_ARGUMENT', 'capture byte limit exceeds the managed per-capture ceiling');
  }
  return Object.freeze({ ...limits, maxTotalBytes: bytes });
}

function release(budget, token) {
  try {
    const result = budget.releaseCapture(token);
    return result.ok ? { ok: true, stage: 'complete', released: true, errors: [] }
      : { ...result, ok: false, stage: 'budget', errors: result.errors || [] };
  } catch (error) {
    return { ok: false, stage: 'budget', unknown: error.unknown === true, errors: [errorInfo(error)] };
  }
}

// A failed attempt can be retried, but concurrent calls share one cleanup. Budget
// release never runs when view cleanup failed or consumption still holds a lease.
function disposer(budget, token, disposeView) {
  let pending = null, done = false;
  return function dispose() {
    if (pending) return pending;
    pending = (async () => {
      if (done) return { ok: true, stage: 'complete', released: true, errors: [] };
      if (disposeView) {
        let status;
        try { status = await disposeView(); }
        catch (error) { return { ok: false, stage: 'view', errors: [errorInfo(error)] }; }
        if (!status.ok) return { ...status, ok: false, stage: 'view' };
      }
      const result = release(budget, token);
      done = result.ok;
      return result;
    })().finally(() => { pending = null; });
    return pending;
  };
}

/**
 * Explicit capture API (itself an opt-in). Reserve the full hard byte ceiling
 * before any source IO. The lease is retained until owned files AND the owned
 * lease directory are removed. Calling view.dispose() directly is safe but
 * leaves the budget charged until this holder's dispose() is also called.
 */
export async function captureBudgetedLookupView({ budget, files, evidenceFile, limits: inputLimits } = {}) {
  if (!isM3ResourceBudget(budget)) throw fail('M3_CAPTURE_BUDGET_ARGUMENT', 'an owned M3 resource budget is required');
  const limits = captureLimits(budget, inputLimits);
  const reservation = budget.reserveCapture({ bytes: limits.maxTotalBytes });
  if (!reservation.ok) throw fail('M3_CAPTURE_BUDGET_REFUSED', 'capture reservation refused', { budgetStatus: reservation });
  let view;
  try {
    view = await captureLookupView({ files, evidenceFile, limits, tempRoot: reservation.tempRoot });
  } catch (cause) {
    // Input accessors can throw arbitrary values before capture owns files.
    // Always retain a mutable error on which cleanup/retry can be reported.
    const error = cause instanceof Error && Object.isExtensible(cause) ? cause
      : fail('M3_CAPTURE_FAILED', 'capture failed with an unannotatable error', { cause });
    const innerCleanup = error.cleanup;
    const retry = disposer(budget, reservation.token, error.dispose || null);
    // captureLookupView has already attempted its own cleanup. Do not retry a
    // failed deletion silently, and never erase a retained capture's charge.
    error.cleanup = innerCleanup && !innerCleanup.ok
      ? { ...innerCleanup, stage: 'view' } : await retry();
    error.reservation = reservation;
    if (!error.cleanup.ok) error.dispose = retry;
    throw error;
  }
  return Object.freeze({ view, reservation: Object.freeze({ ...reservation }),
    dispose: disposer(budget, reservation.token, () => view.dispose()) });
}

/** Default off. Active calls use the prepared immutable request and serve baseline. */
export async function budgetedPairedLookupView(input = {}) {
  if (input.enabled !== true) return { enabled: false, mode: 'off', reason: 'disabled' };
  const parameters = preparePairedLookupRequest(input); // before resource acquisition / first await
  const holder = await captureBudgetedLookupView({ budget: input.budget, files: input.files,
    evidenceFile: input.evidenceFile, limits: input.limits });
  let result, cause, failed = false;
  try { result = await evaluateCapturedLookupView(holder.view, parameters); }
  catch (error) { failed = true; cause = error; }
  const cleanup = await holder.dispose();
  if (!cleanup.ok) throw fail('M3_CAPTURED_VIEW_CLEANUP', 'managed captured view cleanup failed', {
    ...(failed ? { cause } : {}), cleanup, reservation: holder.reservation, dispose: holder.dispose,
  });
  if (failed) throw cause;
  return result;
}
