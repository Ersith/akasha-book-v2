// M3 isolated experiment: no CLI wiring, traffic selection, writes, or candidate serving.
import { createHash } from 'node:crypto';
import { captureLookupView, withCapturedLookupView } from './captured-lookup-view.mjs';
import { lookupDetailed, loadStore, invalidateStoreCache, currentRecords, STORES, loadBalanceEnabled,
  CRED_DEFAULTS, CONTEXT_BUDGET_DEFAULTS, READ_TIER, GENRE_DOSE_DEFAULTS } from './lib.mjs';
import { canonicalJson, parseInstant, dateOnly, validatePolicy } from './forgetting.mjs';
import { timeShadowLookup } from './lookup-time.mjs';
import { applyTimeToHits } from './lookup-time-apply.mjs';

export const PAIRED_VIEW_PROTOCOL = 'akasha-paired-captured-inputs/v1';
const STORE_NAMES = Object.freeze(['canon', 'mirror', 'orphan', 'pricing', 'lexicon', 'frontier']);
const BOOLEANS = new Set(['includeUndated', 'includeRefuted', 'reflect', 'contextBudget']);
const STRINGS = new Set(['tag']);
const INTEGERS = new Set(['doseThreshold', 'maxTokens', 'offset']);
const FIXED_OPTIONS = Object.freeze({ categorySwitch: false, loadBalance: false, queryLog: false, __noQueryLog: true });
const preparedRequests = new WeakSet();

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(label + ': plain object required');
  return value;
}
function jsonCopy(value, label) {
  plain(value, label);
  const json = canonicalJson(value); // Reject accessors, functions, undefined, cycles and non-finite values.
  if (Buffer.byteLength(json) > 16384) throw new RangeError(label + ': exceeds 16384 bytes');
  return JSON.parse(json);
}
function text(value, label, limit) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > limit) throw new TypeError(label + ': nonempty bounded string required');
  return value;
}
function normalizeRequest(input) {
  const query = text(input.query, 'query', 4096);
  const contextRef = text(input.contextRef ?? 'lookup:captured', 'contextRef', 1024);
  const now = parseInstant(input.now), cutoff = parseInstant(input.cutoff);
  if (now.status !== 'ok' || cutoff.status !== 'ok' || cutoff.ms > now.ms) throw new TypeError('now/cutoff: valid fixed instants with cutoff <= now required');
  const today = dateOnly(input.today);
  if (today.status !== 'ok') throw new TypeError('today: valid fixed YYYY-MM-DD required');
  const lambda = input.lambda ?? 0.1;
  if (!Number.isFinite(lambda) || lambda < 0 || lambda > 1) throw new TypeError('lambda: [0,1] required');
  const rawPolicy = jsonCopy(input.policy ?? {}, 'policy');
  if (Object.hasOwn(rawPolicy, 'mode') || Object.hasOwn(rawPolicy, 'lambda')) throw new TypeError('policy.mode/lambda: controlled by paired observation; use top-level lambda');
  const policy = validatePolicy({ ...rawPolicy, mode: 'rank', lambda });
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: policy.timezone, calendar: 'gregory', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(now.ms));
  const part = name => parts.find(p => p.type === name).value;
  if (today.day !== `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`) throw new TypeError('today/now: day must match policy timezone');
  const options = jsonCopy(input.options ?? {}, 'options');
  for (const [key, value] of Object.entries(options)) {
    if (BOOLEANS.has(key)) {
      if (typeof value !== 'boolean') throw new TypeError('option ' + key + ': boolean required');
    } else if (STRINGS.has(key)) text(value, 'option ' + key, 1024);
    else if (key === 'perspective') {
      if (!['world', 'experience'].includes(value)) throw new TypeError('option perspective: world|experience');
    }
    else if (INTEGERS.has(key)) {
      if (!Number.isSafeInteger(value) || value < 0 || value > 100000 || (key === 'maxTokens' && value === 0)) throw new TypeError('option ' + key + ': bounded integer required');
    } else if (key === 'since' || key === 'until') {
      if (dateOnly(value).status !== 'ok') throw new TypeError('option ' + key + ': YYYY-MM-DD required');
    } else if (key === 'depth') {
      if (!['pointer', 'summary', 'full'].includes(value)) throw new TypeError('option depth: pointer|summary|full');
    } else throw new TypeError('unsupported option: ' + key);
  }
  if (options.since && options.until && options.since > options.until) throw new TypeError('options: since > until');
  return freeze({ query, contextRef, now: now.iso, cutoff: cutoff.iso, today: today.day, lambda,
    options: { ...options, ...FIXED_OPTIONS, today: today.day }, policy,
    contentClass: 'natural-legacy', queryContext: { mode: 'recent' } });
}

/** Validate/copy/freeze before resource acquisition; only this module can brand a request. */
export function preparePairedLookupRequest(input = {}) {
  if (preparedRequests.has(input)) return input;
  const parameters = normalizeRequest(input);
  preparedRequests.add(parameters);
  return parameters;
}

function consume(view, parameters) {
  // Guard the legacy module's public mutable store list and possible future load-balance defaults.
  if (canonicalJson(STORES) !== canonicalJson(STORE_NAMES) || loadBalanceEnabled(FIXED_OPTIONS)) throw new Error('captured view: unsupported lookup runtime defaults');
  const recordsByStore = {};
  for (const name of STORE_NAMES) {
    if (typeof view.files[name] !== 'string' || !view.files[name]) throw new Error('captured view: missing store ' + name);
    // Legacy cache returns shared record objects. Re-read verified bytes, never inherit
    // records modified by another consumer; this only discards a derived optimization.
    invalidateStoreCache(name);
    const loaded = loadStore(name, view.files[name]);
    if (loaded.errors.length || loaded.records.some(r => !r || typeof r !== 'object' || Array.isArray(r))) throw new Error('captured view: invalid store ' + name);
    recordsByStore[name] = currentRecords(loaded.records);
  }
  const baseline = lookupDetailed(parameters.query, { ...parameters.options, files: view.files });
  const shadow = timeShadowLookup({ ...parameters, hits: baseline.hits, recordsByStore,
    // contentClass is intentionally not overridden: use the existing legacy classification.
    contentClass: undefined, evidenceFile: view.evidenceFile });
  const candidate = applyTimeToHits({ hits: baseline.hits, shadow, policy: parameters.policy, queryContext: parameters.queryContext });
  const binding = {
    protocol: PAIRED_VIEW_PROTOCOL, view: view.manifest, parameters,
    runtime: { node: process.version, icu: process.versions.icu, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    lookupDefaults: { credibility: CRED_DEFAULTS, contextBudget: CONTEXT_BUDGET_DEFAULTS, readTier: READ_TIER, genreDose: GENRE_DOSE_DEFAULTS },
  };
  const inputDigest = 'sha256:' + createHash('sha256').update(canonicalJson(binding)).digest('hex');
  return { enabled: true, mode: 'paired-observation', appliedToResults: false, protocol: PAIRED_VIEW_PROTOCOL,
    baseline, served: baseline, shadow, candidate, view: view.manifest, parameters,
    runtime: binding.runtime, inputDigest };
}

/** Caller owns view disposal; a captured set can be evaluated more than once with fixed parameters. */
export async function evaluateCapturedLookupView(view, input = {}) {
  const parameters = preparePairedLookupRequest(input);
  return withCapturedLookupView(view, () => consume(view, parameters));
}

/** Explicit opt-in only. Disabled calls do not inspect inputs or acquire source/temp resources. */
export async function pairedLookupView(input = {}) {
  if (input.enabled !== true) return { enabled: false, mode: 'off', reason: 'disabled' };
  const parameters = preparePairedLookupRequest(input); // Freeze caller inputs before the first async boundary.
  const view = await captureLookupView({ files: input.files, evidenceFile: input.evidenceFile, tempRoot: input.tempRoot, limits: input.limits });
  let result, failure;
  try { result = await withCapturedLookupView(view, () => consume(view, parameters)); }
  catch (error) { failure = error; }
  const cleanup = await view.dispose();
  if (!cleanup.ok) {
    const error = new Error('captured view cleanup failed', failure ? { cause: failure } : undefined);
    error.code = 'CAPTURED_VIEW_CLEANUP';
    error.cleanup = cleanup;
    error.dispose = () => view.dispose();
    throw error;
  }
  if (failure) throw failure;
  return result;
}
