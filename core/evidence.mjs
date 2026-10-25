// M2 · human review-result evidence log (append-only, outside the six stores).
// This is the first real evidence producer: only a human actor may write review-result.
// It never writes `last_reviewed` or any truth field back to the six stores.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { LOGS_DIR, withFileLock } from './lib.mjs';
import { canonicalJson, reduceEvidence, validateEvidenceEvent } from './forgetting.mjs';

export const EVIDENCE_LOG = join(LOGS_DIR, 'evidence.jsonl');

function eventIdOf(event) {
  return 'ev-' + createHash('sha256').update(canonicalJson(event)).digest('hex').slice(0, 24);
}

function readLines(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`证据日志第 ${index + 1} 行不是合法 JSON`); }
  });
}

export function loadEvidence(file = EVIDENCE_LOG) {
  return readLines(file);
}

export function buildReviewResult(input = {}) {
  if (!input || typeof input !== 'object') throw new TypeError('review-result: input object required');
  if (input.actorType !== undefined && input.actorType !== 'human') throw new Error('review-result 只接受 human actor');
  const recordedAt = input.recordedAt || new Date().toISOString();
  const raw = {
    schemaVersion: 'akasha-evidence/v1',
    eventId: input.eventId || undefined,
    kind: 'review-result',
    result: input.result,
    target: input.target,
    contextRef: input.contextRef,
    actor: { type: 'human', id: input.humanId },
    attemptId: input.attemptId,
    criterionId: input.criterionId,
    occurredAt: input.occurredAt,
    recordedAt,
    evidenceRefs: input.evidenceRefs,
    ...(input.revokesEvent ? { revokesEvent: input.revokesEvent } : {}),
  };
  if (!raw.eventId) {
    const seed = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined));
    raw.eventId = eventIdOf(seed);
  }
  return validateEvidenceEvent(raw);
}

function inspectBoundary(file) {
  if (!existsSync(file)) return { needsLF: false };
  const text = readFileSync(file, 'utf8');
  if (!text) return { needsLF: false };
  const endsLF = text.endsWith('\n');
  const lines = text.split('\n');
  if (endsLF) lines.pop();
  for (let i = 0; i < lines.length; i++) {
    try { JSON.parse(lines[i]); }
    catch { throw new Error(`证据日志第 ${i + 1} 行不是合法 JSON；未写入新记录`); }
  }
  return { needsLF: !endsLF };
}

/** Append one human review-result; identical duplicate is idempotent, changed duplicate is rejected. */
export function recordReviewResult(input = {}, { file = EVIDENCE_LOG } = {}) {
  const event = buildReviewResult(input);
  mkdirSync(dirname(file), { recursive: true });
  return withFileLock(file + '.append', () => {
    const boundary = inspectBoundary(file);
    if (boundary.needsLF) appendFileSync(file, '\n', { encoding: 'utf8', flush: true });
    const existing = loadEvidence(file);
    const sameId = existing.filter((x) => x.eventId === event.eventId);
    if (sameId.length) {
      if (sameId.length === 1 && canonicalJson(sameId[0]) === canonicalJson(event)) {
        return { ok: true, already: true, event, file };
      }
      throw new Error('证据 eventId 已存在但内容不同');
    }
    appendFileSync(file, JSON.stringify(event) + '\n', { encoding: 'utf8', flush: true });
    const verified = loadEvidence(file).filter((x) => x.eventId === event.eventId);
    if (verified.length !== 1 || canonicalJson(verified[0]) !== canonicalJson(event)) {
      throw new Error('证据追加未核验：' + event.eventId);
    }
    return { ok: true, already: false, event, file };
  });
}

/** Read-only replay; the caller supplies the as-of clock and target scope. */
export function replayEvidence({ target, contextRef, now, cutoff, file = EVIDENCE_LOG } = {}) {
  return reduceEvidence(loadEvidence(file), { target, contextRef, now, cutoff });
}
