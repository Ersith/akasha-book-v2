// M3 · bounded append for time-observe logs; refusal is visible, never silent drop.
import { appendFileSync, statSync } from 'node:fs';
import { withFileLock } from './lib.mjs';

export const OBSERVE_LOG_DEFAULT_MAX = 64 * 1024 * 1024;
export const OBSERVE_LOG_MAX_CAP = 1024 * 1024 * 1024;

export function resolveObserveLogLimit(env = process.env) {
  const raw = Number(env.AKASHA_TIME_OBSERVE_MAX_BYTES);
  if (!Number.isSafeInteger(raw) || raw <= 0) return OBSERVE_LOG_DEFAULT_MAX;
  return Math.min(raw, OBSERVE_LOG_MAX_CAP);
}

export function appendBoundedObservation(file, record, { maxBytes = OBSERVE_LOG_DEFAULT_MAX } = {}) {
  if (typeof file !== 'string' || !file.trim()) return { ok: false, reason: 'invalid-path' };
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return { ok: false, reason: 'invalid-budget' };
  const line = JSON.stringify(record) + '\n';
  const bytes = Buffer.byteLength(line);
  if (bytes > maxBytes) return { ok: false, reason: 'line-too-large', bytes, maxBytes };
  try {
    return withFileLock(file, () => {
      let before = 0;
      try {
        before = statSync(file).size;
      } catch (error) {
        if (error?.code !== 'ENOENT') return { ok: false, reason: 'stat-failed', error: String(error.message) };
      }
      if (before >= maxBytes) return { ok: false, reason: 'log-budget-exceeded', bytes: before, maxBytes };
      try {
        appendFileSync(file, line);
      } catch (error) {
        return { ok: false, reason: 'append-failed', error: String(error.message) };
      }
      return { ok: true, bytes: before + bytes, maxBytes };
    }, { timeoutMs: 1000 });
  } catch (error) {
    return { ok: false, reason: 'lock-timeout', error: String(error.message) };
  }
}
