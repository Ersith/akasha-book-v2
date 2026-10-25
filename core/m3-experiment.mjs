// M3 · canary experiment config. Default off; no environment means no traffic.
import { createHash } from 'node:crypto';
import { selectedByBucket } from './canary-bucket.mjs';

export const M3_EXPERIMENT_VERSION = 1;
const EXPERIMENTS = new WeakSet();

function frozen(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}
const disabled = () => frozen({ enabled: false, status: 'disabled', reason: 'no-config' });

/** True only for configs produced by resolveM3Experiment. */
export function isM3ExperimentConfig(value) {
  return EXPERIMENTS.has(value);
}

/** Parse AKASHA_M3_EXPERIMENT JSON; malformed config is an explicit error, never silently enabled. */
export function resolveM3Experiment(env = process.env) {
  const raw = env.AKASHA_M3_EXPERIMENT;
  if (raw === undefined || raw === '') return disabled();
  let config;
  try { config = JSON.parse(raw); } catch { throw new TypeError('AKASHA_M3_EXPERIMENT 必须是 JSON'); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('experiment 必须是对象');
  if (config.enabled !== true) return disabled();
  if (config.status !== 'active') throw new TypeError('experiment.status 必须是 active');
  if (config.version !== M3_EXPERIMENT_VERSION) throw new TypeError('experiment.version 不受支持');
  if (typeof config.experimentId !== 'string' || !config.experimentId.trim() || Buffer.byteLength(config.experimentId) > 128) throw new TypeError('experimentId 必须是非空且 ≤128 字节');
  if (typeof config.seed !== 'string' || !config.seed.trim() || Buffer.byteLength(config.seed) > 128) throw new TypeError('experiment.seed 必须是非空且 ≤128 字节');
  if (!Number.isSafeInteger(config.percent) || config.percent < 0 || config.percent > 100) throw new TypeError('experiment.percent 必须是 [0,100] 整数');
  if (config.serveCandidate !== undefined && typeof config.serveCandidate !== 'boolean') throw new TypeError('experiment.serveCandidate 必须是布尔');
  if (config.eligibilityMode !== undefined && !['strict', 'mixed'].includes(config.eligibilityMode)) throw new TypeError('experiment.eligibilityMode 必须是 strict/mixed');
  const parsed = frozen({
    enabled: true, status: 'active', version: M3_EXPERIMENT_VERSION,
    experimentId: config.experimentId, seed: config.seed, percent: config.percent,
    serveCandidate: config.serveCandidate === true,
    eligibilityMode: config.eligibilityMode === 'mixed' ? 'mixed' : 'strict',
  });
  EXPERIMENTS.add(parsed);
  return parsed;
}

/** Canonical, well-formed JSON hashing keeps unpaired surrogates distinct. */
export function experimentIdentity(config) {
  if (!isM3ExperimentConfig(config)) throw new TypeError('experiment 必须来自 resolveM3Experiment');
  const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return { experimentIdHash: hash(config.experimentId), seedHash: hash(config.seed), percent: config.percent, version: config.version, eligibilityMode: config.eligibilityMode };
}

/** Stable per-request selection; requestId must be created at the entry boundary. */
export function selectExperimentRequest(config, requestId) {
  if (!config?.enabled) return { selected: false, reason: 'disabled' };
  if (!isM3ExperimentConfig(config)) throw new TypeError('experiment 必须来自 resolveM3Experiment');
  if (typeof requestId !== 'string' || !requestId.trim()) throw new TypeError('requestId 必须是非空字符串');
  // Only mixed gets a mode suffix; strict keeps its historical bucket key so an
  // existing strict cohort is not silently remapped.
  const bucketKey = config.eligibilityMode === 'mixed' ? `${requestId}\u0000mixed` : requestId;
  const selected = selectedByBucket({ experimentId: config.experimentId, seed: config.seed, key: bucketKey, percent: config.percent });
  return { selected, reason: selected ? null : 'not-selected', experimentId: config.experimentId, percent: config.percent };
}
