// M3 · session identity for paired/canary grouping; only hashed identity is persisted.
import { createHash } from 'node:crypto';

const SESSION_RE = /^(?:session-)?[A-Za-z0-9._:-]{8,160}$/;

/** Resolve a stable session id from host env; never invents one. */
export function resolveSessionIdentity(env = process.env) {
  const candidates = [
    ['akasha', env.AKASHA_SESSION_ID],
    ['dsh', env.DSH_SESSION_ID],
  ];
  for (const [source, raw] of candidates) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const value = raw.trim();
    if (!SESSION_RE.test(value)) return { present: true, source, wellFormed: false, idHash: null };
    return {
      present: true,
      source,
      wellFormed: true,
      idHash: createHash('sha256').update(value).digest('hex').slice(0, 16),
    };
  }
  return { present: false, source: 'none', wellFormed: false, idHash: null };
}
