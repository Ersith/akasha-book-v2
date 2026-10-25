// M3 · canary attempt/terminal journal on top of the owned resource budget.
// This module never opens a default root and never serves candidates.
import { openBudget, isM3ResourceBudget } from './m3-resource-budget.mjs';

const JOURNALS = new WeakSet();
const STAGES = Object.freeze({ attempt: 'attempts', terminal: 'terminals' });
const REQUEST = /^[A-Za-z0-9._:-]{1,96}$/;

function fail(code, message) { return Object.assign(new Error(message), { code }); }
function requestIdOf(value) {
  if (typeof value !== 'string' || !REQUEST.test(value)) throw fail('M3_JOURNAL_ARGUMENT', 'requestId 必须是 1..96 的安全字符');
  return value;
}
function operationId(requestId, stage) { return `${requestId}:${stage}`; }

/** Explicit root only; opening this journal owns no serving path. */
export function openCanaryJournal({ root, limits } = {}) {
  const budget = openBudget({ root, limits });
  const journal = Object.freeze({
    root: budget.root,
    limits: budget.limits,
    inspectBudget: () => budget.inspectBudget(),
    recordAttempt(requestId, record) { return recordStage(budget, requestId, 'attempt', record); },
    recordTerminal(requestId, record) { return recordStage(budget, requestId, 'terminal', record); },
    reconcile(requestId, stage) {
      if (!Object.hasOwn(STAGES, stage)) return { ok: false, status: 'refused', reason: 'invalid-stage' };
      const expectedLog = STAGES[stage];
      const result = budget.reconcileOperation(operationId(requestIdOf(requestId), stage));
      if (typeof result.log === 'string' && result.log !== expectedLog) return { ok: false, status: 'refused', reason: 'operation-log-mismatch', operationId: result.operationId, log: result.log };
      return result;
    },
  });
  JOURNALS.add(journal);
  return journal;
}

export function isCanaryJournal(value) { return JOURNALS.has(value); }

function recordStage(budget, requestId, stage, record) {
  if (!isM3ResourceBudget(budget)) throw fail('M3_JOURNAL_ARGUMENT', 'owned budget required');
  return budget.appendManagedLog({ operationId: operationId(requestIdOf(requestId), stage), log: STAGES[stage], record });
}
