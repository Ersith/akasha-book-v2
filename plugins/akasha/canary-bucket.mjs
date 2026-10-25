// M3 · request-level canary bucket (no session dependency).
import { createHash } from 'node:crypto';

export const BUCKET_VERSION = 1;

function requireText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} 必须是非空字符串`);
}

/** Stable 0..100 bucket for experimentId/seed/key under bucketVersion. */
export function bucketPercent({ experimentId, seed, key } = {}) {
  requireText(experimentId, 'experimentId');
  requireText(seed, 'seed');
  requireText(key, 'key');
  const payload = JSON.stringify([BUCKET_VERSION, experimentId, seed, key]);
  const digest = createHash('sha256').update(payload).digest('hex');
  const value = Number.parseInt(digest.slice(0, 8), 16);
  return (value / 0x100000000) * 100;
}

/** 0 disables, 100 enables; otherwise key is selected when its bucket is below percent. */
export function selectedByBucket({ experimentId, seed, key, percent } = {}) {
  requireText(experimentId, 'experimentId');
  requireText(seed, 'seed');
  requireText(key, 'key');
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new TypeError('percent 必须在 [0,100]');
  if (percent === 0) return false;
  const bucket = bucketPercent({ experimentId, seed, key });
  if (percent === 100) return true;
  return bucket < percent;
}
