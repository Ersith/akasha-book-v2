#!/usr/bin/env node
// Akasha forgetting policy evaluator (M1, pure).
// No filesystem / network / model / Date.now. Every clock, policy, evidence and snapshot is passed in.
// 设计规格：research/forgetting-curves-spec-r3-20261024.md
import { createHash } from 'node:crypto';
import policyDefaults from './forgetting.policy.json' with { type: 'json' };

export const FORGETTING_SCHEMA = 'akasha-forgetting/v1';
export const TIME_POLICY_VERSION = 'calendar-day/v1';
export const CONTENT_CLASSES = Object.freeze(['C1', 'C2', 'C3', 'unknown']);

export const DEFAULT_POLICY = Object.freeze({
  ...policyDefaults,
  C2: Object.freeze({ ...policyDefaults.C2 }),
  C3: Object.freeze({ ...policyDefaults.C3 }),
  C4: Object.freeze({ ...policyDefaults.C4 }),
});

const isObj = (v) => v !== null && typeof v === 'object' &&
  (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const nonempty = (v) => typeof v === 'string' && v.trim().length > 0;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

function fail(message) { throw new TypeError(message); }

export function canonicalJson(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value) || isObj(value)) {
    if (ancestors.has(value)) fail('canonicalJson: circular value');
    if (Object.getOwnPropertySymbols(value).length) fail('canonicalJson: symbol keys unsupported');
    const keys = Object.keys(value);
    if (Array.isArray(value) && (keys.length !== value.length ||
        keys.some((key, i) => key !== String(i)))) fail('canonicalJson: sparse or extended array');
    if (keys.some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) {
      fail('canonicalJson: accessor unsupported');
    }
    ancestors.add(value);
    try {
      if (Array.isArray(value)) return '[' + value.map(item => canonicalJson(item, ancestors)).join(',') + ']';
      return '{' + keys.sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key], ancestors)).join(',') + '}';
    } finally { ancestors.delete(value); }
  }
  fail('canonicalJson: unsupported value');
}

function cloneJson(value) { return JSON.parse(canonicalJson(value)); }

function exactVersion(raw, label) {
  if (!Object.hasOwn(raw, 'versionId')) return raw.id;
  if (!nonempty(raw.versionId)) fail(label + '.versionId: non-empty exact version required');
  return raw.versionId;
}

export function recordDigest(raw = {}) {
  if (!isObj(raw)) fail('recordDigest: object required');
  const { store, id, content } = raw;
  if (typeof store !== 'string' || !store) fail('recordDigest.store: non-empty string required');
  if (typeof id !== 'string' || !id) fail('recordDigest.id: non-empty string required');
  const version = exactVersion(raw, 'recordDigest');
  return 'sha256:' + createHash('sha256').update(canonicalJson({
    schema: FORGETTING_SCHEMA, store, id, versionId: version, content: content ?? null,
  }), 'utf8').digest('hex');
}

export function validatePolicy(policy = {}) {
  if (!isObj(policy)) fail('policy: object required');
  for (const key of Object.keys(policy)) {
    if (!Object.hasOwn(DEFAULT_POLICY, key)) fail(`policy.${key}: unsupported field`);
  }
  for (const key of ['C2', 'C3', 'C4']) {
    if (Object.hasOwn(policy, key) && !isObj(policy[key])) fail(`policy.${key}: object required`);
    for (const field of Object.keys(policy[key] ?? {})) {
      if (!Object.hasOwn(DEFAULT_POLICY[key], field)) fail(`policy.${key}.${field}: unsupported field`);
    }
  }
  const base = {
    ...DEFAULT_POLICY,
    ...policy,
    C2: { ...DEFAULT_POLICY.C2, ...(policy.C2 || {}) },
    C3: { ...DEFAULT_POLICY.C3, ...(policy.C3 || {}) },
    C4: { ...DEFAULT_POLICY.C4, ...(policy.C4 || {}) },
  };
  if (base.schemaVersion !== FORGETTING_SCHEMA) fail('policy.schemaVersion: unsupported');
  if (!nonempty(base.policyVersion)) fail('policy.policyVersion: non-empty string');
  if (base.timePolicyVersion !== TIME_POLICY_VERSION) fail('policy.timePolicyVersion: unsupported');
  if (!['off', 'shadow', 'rank'].includes(base.mode)) fail('policy.mode: off|shadow|rank');
  if (typeof base.timezone !== 'string' || !base.timezone) fail('policy.timezone: non-empty string');
  try { new Intl.DateTimeFormat('en', { timeZone: base.timezone }); }
  catch { fail('policy.timezone: valid IANA timezone required'); }
  if (!finite(base.lambda) || base.lambda < 0 || base.lambda > 1) fail('policy.lambda: [0,1]');
  if (typeof base.c3Enabled !== 'boolean') fail('policy.c3Enabled: boolean');
  if (typeof base.hGrowth !== 'boolean') fail('policy.hGrowth: boolean');
  if (base.hGrowth) fail('policy.hGrowth: unsupported in M1');
  for (const key of ['C2', 'C3']) {
    const c = base[key];
    if (!finite(c.floor) || c.floor <= 0 || c.floor > 1) fail(`policy.${key}.floor: (0,1]`);
    if (!finite(c.halfLifeDays) || c.halfLifeDays <= 0) fail(`policy.${key}.halfLifeDays: >0`);
  }
  if (!finite(base.C4.widthDays) || base.C4.widthDays <= 0) fail('policy.C4.widthDays: >0');
  return base;
}

/** 日龄/日期只接受日历日；时间戳必须先由 adapter 映射到 policy 时区的日期。 */
export function dateOnly(value) {
  if (value === undefined || value === null || value === '') return { day: null, status: 'missing' };
  if (typeof value !== 'string') return { day: null, status: 'invalid' };
  if (!DATE_RE.test(value)) return { day: null, status: 'invalid' };
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(value + 'T00:00:00Z');
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return { day: null, status: 'invalid' };
  return { day: value, status: 'ok' };
}

/** Parse an instant without consulting the system clock or accepting local-time guesses. */
export function parseInstant(value) {
  const bad = status => ({ status, ms: null, iso: null });
  if (value == null || value === '') return bad('missing');
  if (typeof value !== 'string') return bad('invalid');
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match || dateOnly(match[1]).status !== 'ok' || +match[2] > 23 ||
      +match[3] > 59 || +match[4] > 59 || +(match[6] ?? 0) > 23 || +(match[7] ?? 0) > 59) return bad('invalid');
  const ms = Date.parse(value);
  return finite(ms) ? { status: 'ok', ms, iso: new Date(ms).toISOString() } : bad('invalid');
}

function localDay(ms, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone, calendar: 'gregory', numberingSystem: 'latn', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ms));
  const field = name => parts.find(p => p.type === name).value;
  return `${field('year').padStart(4, '0')}-${field('month')}-${field('day')}`;
}

function clockContext(today, now, timezone) {
  const instant = parseInstant(now);
  const day = today == null && instant.status === 'ok' ? localDay(instant.ms, timezone) : dateOnly(today).day;
  if (!day) fail('today: valid YYYY-MM-DD or explicit now required');
  if (now != null && instant.status !== 'ok') return { day, ms: null, error: 'invalid-now' };
  if (instant.status === 'ok' && localDay(instant.ms, timezone) !== day) return { day, ms: instant.ms, error: 'today-now-mismatch' };
  return { day, ms: instant.ms, error: null };
}

export function dayDiff(fromDay, toDay) {
  const a = dateOnly(fromDay), b = dateOnly(toDay);
  if (a.status !== 'ok' || b.status !== 'ok') fail('dayDiff: valid YYYY-MM-DD required');
  return Math.round((Date.parse(b.day + 'T00:00:00Z') - Date.parse(a.day + 'T00:00:00Z')) / 86400000);
}

export function classifyLegacy(store, record = {}, { protocolIds = [] } = {}) {
  if (typeof store !== 'string' || !store) fail('classifyLegacy.store: non-empty string');
  if (!isObj(record)) fail('classifyLegacy.record: object required');
  const tags = Array.isArray(record.tags) ? record.tags.map(String) : [];
  const id = String(record.id ?? '');
  const selfKind = ['identity', 'address', 'boundary', 'principle', 'commitment_policy', 'self', 'protocol'].includes(record.kind);
  const selfId = /^canon-(self-concept|address-layers|memory-auto-record)/.test(id);
  const protocolId = id === 'canon-akasha-usage' || id.startsWith('canon-akasha-usage-r');
  if (store === 'canon' && (selfKind || selfId || protocolId || tags.includes('自我') || protocolIds.includes(id))) {
    return { contentClass: 'C1', protection: true, reasons: ['self-or-protocol'] };
  }
  if (store === 'canon' && tags.includes('经验')) return { contentClass: 'C2', protection: false, reasons: ['tag-experience'] };
  if (store === 'mirror' && ['solution', 'boundary'].includes(record.role)) return { contentClass: 'C2', protection: false, reasons: ['mirror-role'] };
  if (store === 'frontier') return { contentClass: 'C1', protection: false, reasons: ['frontier-base'] };
  if (store === 'session' && record.temporary === true) return { contentClass: 'C3', protection: false, reasons: ['explicit-temporary'] };
  return { contentClass: 'unknown', protection: false, reasons: ['unknown-default'] };
}

function normalizeReview(review) {
  if (review == null) return { kind: null, dueDay: null, boundary: null, openState: null, sourceTaskRef: null };
  if (!isObj(review)) fail('view.review: object or null');
  const kind = review.kind ?? null;
  if (kind != null && !['legacy-review', 'frontier-review', 'task'].includes(kind)) fail('view.review.kind: unsupported');
  const due = dateOnly(review.dueDay);
  const boundary = review.boundary ?? (kind === 'frontier-review' ? 'on-or-after' : 'after');
  if (!['after', 'on-or-after'].includes(boundary)) fail('view.review.boundary: after|on-or-after');
  const openState = review.openState ?? null;
  if (openState != null && !['open', 'blocked', 'closed', 'reopened', 'unknown'].includes(openState)) fail('view.review.openState: unsupported');
  return {
    kind,
    dueDay: due.day,
    dueStatus: due.status,
    boundary,
    openState: kind === 'task' ? openState : null,
    sourceTaskRef: kind === 'task' && review.sourceTaskRef != null ? cloneJson(review.sourceTaskRef) : null,
    basisRef: review.basisRef == null ? null : cloneJson(review.basisRef),
    reviewBasis: review.reviewBasis == null ? null : cloneJson(review.reviewBasis),
  };
}

export function normalizeView(raw = {}) {
  if (!isObj(raw)) fail('view: object required');
  const store = raw.store;
  const id = raw.id;
  if (typeof store !== 'string' || !store) fail('view.store: non-empty string');
  if (typeof id !== 'string' || !id) fail('view.id: non-empty string');
  const versionId = exactVersion(raw, 'view');
  const digest = raw.digest ?? (raw.content !== undefined ? recordDigest({ store, id, versionId, content: raw.content }) : null);
  if (digest != null && (typeof digest !== 'string' || !DIGEST_RE.test(digest))) fail('view.digest: sha256 digest required');
  if (raw.contextRef != null && !nonempty(raw.contextRef)) fail('view.contextRef: non-empty string');
  const eventTime = raw.eventTime ?? raw.eventDay ?? null;
  const event = dateOnly(eventTime);
  const instant = event.status === 'ok' ? null : parseInstant(eventTime);
  const contentClass = raw.contentClass ?? 'unknown';
  if (!CONTENT_CLASSES.includes(contentClass)) fail('view.contentClass: unsupported');
  if (raw.protection != null && typeof raw.protection !== 'boolean') fail('view.protection: boolean');
  if (raw.eligibility != null && typeof raw.eligibility !== 'boolean' &&
      !(isObj(raw.eligibility) && typeof raw.eligibility.eligible === 'boolean')) fail('view.eligibility: boolean or {eligible:boolean}');
  const protection = classifyLegacy(store, { ...(isObj(raw.content) ? raw.content : {}), ...raw }).protection;
  return {
    store, id, versionId, digest,
    contentClass,
    protection: raw.protection === true || protection,
    protectionReasons: cloneJson(raw.protectionReasons ?? (protection ? ['self-or-protocol'] : [])),
    eligibility: raw.eligibility == null ? null : cloneJson(raw.eligibility),
    chain: raw.chain == null ? null : cloneJson(raw.chain),
    currentVersion: raw.currentVersion == null ? null : cloneJson(raw.currentVersion),
    contextRef: raw.contextRef ?? null,
    eventTime,
    eventPrecision: event.status === 'ok' ? 'day' : instant?.status === 'ok' ? 'instant' : 'unknown',
    eventDay: event.day,
    eventStatus: event.status === 'ok' ? 'ok' : instant.status,
    review: normalizeReview(raw.review),
  };
}

export const EVIDENCE_SCHEMA = 'akasha-evidence/v1';
export const SUMMARY_SCHEMA = 'akasha-evidence-summary/v1';

const EVIDENCE_RESULT_KINDS = new Set(['review-result', 'reproduce-result', 'evaluation-result']);
const EVIDENCE_EVENT_FIELDS = new Set([
  'schemaVersion', 'eventId', 'kind', 'result', 'target', 'contextRef', 'actor',
  'attemptId', 'criterionId', 'occurredAt', 'recordedAt', 'evidenceRefs', 'revokesEvent',
]);
const evidenceCompareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const evidenceNonempty = value => typeof value === 'string' && value.trim().length > 0;

function evidenceFailure(code, field) {
  const error = new TypeError(`evidence.${field}: ${code}`);
  error.code = code;
  error.field = field;
  throw error;
}

function evidenceTarget(raw) {
  if (!isObj(raw)) evidenceFailure('invalid-target', 'target');
  for (const key of ['store', 'id', 'versionId']) {
    if (!evidenceNonempty(raw[key])) evidenceFailure('invalid-target', `target.${key}`);
  }
  if (typeof raw.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(raw.digest)) {
    evidenceFailure('invalid-target', 'target.digest');
  }
  const unknown = Object.keys(raw).filter(key => !['store', 'id', 'versionId', 'digest'].includes(key)).sort()[0];
  if (unknown) evidenceFailure('unsupported-field', `target.${unknown}`);
  return { store: raw.store, id: raw.id, versionId: raw.versionId, digest: raw.digest };
}

function evidenceContext(value) {
  if (!evidenceNonempty(value) || /^(?:n\/a|not-applicable)$/i.test(value.trim()) ||
      (value.startsWith('not-applicable:') && !value.slice('not-applicable:'.length).trim())) {
    evidenceFailure('invalid-context', 'contextRef');
  }
  return value;
}

function normalizeEvent(raw = {}) {
  if (!isObj(raw)) evidenceFailure('invalid-event', 'event');
  if (raw.schemaVersion !== EVIDENCE_SCHEMA) evidenceFailure('unsupported-schema', 'schemaVersion');
  if (!evidenceNonempty(raw.eventId)) evidenceFailure('invalid-event-id', 'eventId');
  const unknown = Object.keys(raw).filter(key => !EVIDENCE_EVENT_FIELDS.has(key)).sort()[0];
  if (unknown) evidenceFailure('unsupported-field', unknown);
  const kind = raw.kind;
  if (!EVIDENCE_RESULT_KINDS.has(kind) && !['mention', 'exposure', 'revoke'].includes(kind)) {
    evidenceFailure('unsupported-kind', 'kind');
  }
  const target = evidenceTarget(raw.target);
  const contextRef = evidenceContext(raw.contextRef);
  const actor = raw.actor;
  if (!isObj(actor) || !['human', 'tool'].includes(actor.type) || !evidenceNonempty(actor.id) ||
      Object.keys(actor).some(key => !['type', 'id'].includes(key))) {
    evidenceFailure('invalid-actor', 'actor');
  }
  if (kind === 'review-result' && actor.type !== 'human') evidenceFailure('review-requires-human', 'actor.type');
  const occurred = parseInstant(raw.occurredAt);
  const recorded = parseInstant(raw.recordedAt);
  if (occurred.status !== 'ok') evidenceFailure('invalid-time', 'occurredAt');
  if (recorded.status !== 'ok') evidenceFailure('invalid-time', 'recordedAt');
  const event = {
    schemaVersion: EVIDENCE_SCHEMA, eventId: raw.eventId, kind, target, contextRef,
    actor: { type: actor.type, id: actor.id }, occurredAt: occurred.iso, recordedAt: recorded.iso,
  };
  if (EVIDENCE_RESULT_KINDS.has(kind)) {
    if (!['pass', 'fail', 'inconclusive'].includes(raw.result)) evidenceFailure('invalid-result', 'result');
    if (!evidenceNonempty(raw.attemptId)) evidenceFailure('missing-attempt-or-criterion', 'attemptId');
    if (!evidenceNonempty(raw.criterionId)) evidenceFailure('missing-attempt-or-criterion', 'criterionId');
    if (!Array.isArray(raw.evidenceRefs) || !raw.evidenceRefs.length || !raw.evidenceRefs.every(evidenceNonempty)) {
      evidenceFailure('invalid-evidence-refs', 'evidenceRefs');
    }
    Object.assign(event, {
      result: raw.result, attemptId: raw.attemptId, criterionId: raw.criterionId,
      evidenceRefs: cloneJson(raw.evidenceRefs),
    });
  } else {
    for (const field of ['result', 'attemptId', 'criterionId', 'evidenceRefs']) {
      if (Object.hasOwn(raw, field)) evidenceFailure('unsupported-field', field);
    }
  }
  if (Object.hasOwn(raw, 'revokesEvent')) {
    if ((kind !== 'revoke' && !EVIDENCE_RESULT_KINDS.has(kind)) || !evidenceNonempty(raw.revokesEvent)) {
      evidenceFailure('invalid-revocation', 'revokesEvent');
    }
    event.revokesEvent = raw.revokesEvent;
  } else if (kind === 'revoke') {
    evidenceFailure('invalid-revocation', 'revokesEvent');
  }
  return { event, occurredMs: occurred.ms, recordedMs: recorded.ms };
}

/** Validate and canonicalize one evidence event without evaluating it. */
export function validateEvidenceEvent(raw) {
  return normalizeEvent(raw).event;
}

/** Pure, as-of evidence reduction. Invalid evidence is observable and never becomes a pass. */
export function reduceEvidence(events = [], options = {}) {
  if (!Array.isArray(events)) fail('evidence: array required');
  if (!isObj(options)) fail('evidence options: object required');
  const target = evidenceTarget(options.target);
  const contextRef = evidenceContext(options.contextRef);
  const now = parseInstant(options.now), cutoff = parseInstant(options.cutoff);
  if (now.status !== 'ok' || cutoff.status !== 'ok' || cutoff.ms > now.ms) {
    fail('evidence options: offset now/cutoff required, with cutoff <= now');
  }
  const targetKey = canonicalJson(target);
  const diagnostics = [], conflicts = [], excluded = [], idGroups = new Map();
  const addDiagnostic = (code, eventId, fields = {}) => diagnostics.push({ code, eventId, ...fields });
  for (const raw of events) {
    let item;
    try { item = normalizeEvent(raw); }
    catch (error) {
      addDiagnostic(error.code || 'invalid-event', isObj(raw) && typeof raw.eventId === 'string' ? raw.eventId : null,
        { field: error.field || 'event' });
      continue;
    }
    const { event, occurredMs, recordedMs } = item;
    if (occurredMs > now.ms || recordedMs > now.ms) {
      addDiagnostic('clock-skew', event.eventId);
      continue;
    }
    if (recordedMs > cutoff.ms) {
      excluded.push({ code: 'after-cutoff', eventId: event.eventId });
      continue;
    }
    if (occurredMs > recordedMs) {
      addDiagnostic('occurred-after-recorded', event.eventId);
      continue;
    }
    const members = idGroups.get(event.eventId) || new Map();
    members.set(canonicalJson(event), item);
    idGroups.set(event.eventId, members);
  }
  const byId = new Map();
  for (const id of [...idGroups.keys()].sort(evidenceCompareText)) {
    const members = idGroups.get(id);
    const relevant = [...members.values()].filter(({ event }) => {
      if (canonicalJson(event.target) !== targetKey) {
        excluded.push({ code: 'target-mismatch', eventId: event.eventId });
        return false;
      }
      if (event.contextRef !== contextRef) {
        excluded.push({ code: 'context-mismatch', eventId: event.eventId });
        return false;
      }
      return true;
    });
    if (!relevant.length) continue;
    if (members.size !== 1) {
      conflicts.push({ code: 'event-id-conflict', eventId: id });
    } else {
      byId.set(id, members.values().next().value);
    }
  }

  // Each event has at most one outgoing revocation edge. Controls are resolved before
  // semantic result conflicts, so an explicit withdrawal can settle pass/fail evidence.
  const invalidControls = new Set(), incoming = new Map();
  for (const [id, { event }] of byId) {
    if (!event.revokesEvent) continue;
    if (!byId.has(event.revokesEvent)) {
      invalidControls.add(id);
      addDiagnostic('unknown-revocation-target', id, { targetEventId: event.revokesEvent });
      continue;
    }
    const ids = incoming.get(event.revokesEvent) || [];
    ids.push(id);
    incoming.set(event.revokesEvent, ids);
  }
  const visited = new Set();
  for (const start of byId.keys()) {
    const path = [], positions = new Map();
    let id = start;
    while (id && byId.has(id) && !invalidControls.has(id) && !visited.has(id)) {
      if (positions.has(id)) {
        const cycle = path.slice(positions.get(id)).sort(evidenceCompareText);
        for (const member of cycle) invalidControls.add(member);
        addDiagnostic('revocation-cycle', cycle[0], { eventIds: cycle });
        break;
      }
      positions.set(id, path.length);
      path.push(id);
      id = byId.get(id).event.revokesEvent;
    }
    for (const member of path) visited.add(member);
  }
  // A replacement depending on an unresolved control must not silently supply new evidence.
  const invalidQueue = [...invalidControls];
  for (let i = 0; i < invalidQueue.length; i++) {
    for (const revoker of incoming.get(invalidQueue[i]) || []) {
      if (invalidControls.has(revoker)) continue;
      invalidControls.add(revoker);
      invalidQueue.push(revoker);
      addDiagnostic('invalid-revocation-target', revoker, { targetEventId: invalidQueue[i] });
    }
  }
  const usable = new Map([...byId].filter(([id]) => !invalidControls.has(id)));
  const unresolved = new Map([...usable.keys()].map(id => [id, 0]));
  for (const { event } of usable.values()) {
    if (event.revokesEvent) unresolved.set(event.revokesEvent, unresolved.get(event.revokesEvent) + 1);
  }
  const ready = [...unresolved].filter(([, count]) => count === 0).map(([id]) => id).sort(evidenceCompareText);
  const revoked = new Set(), active = new Map();
  for (let i = 0; i < ready.length; i++) {
    const id = ready[i], item = usable.get(id), destination = item.event.revokesEvent;
    if (!revoked.has(id)) {
      active.set(id, item);
      if (destination) revoked.add(destination);
    }
    if (destination) {
      unresolved.set(destination, unresolved.get(destination) - 1);
      if (unresolved.get(destination) === 0) ready.push(destination);
    }
  }

  const semantic = new Map();
  for (const item of active.values()) {
    const event = item.event;
    if (!EVIDENCE_RESULT_KINDS.has(event.kind)) continue;
    const key = canonicalJson({ target: event.target, contextRef: event.contextRef, attemptId: event.attemptId, criterionId: event.criterionId });
    const members = semantic.get(key) || [];
    members.push(item);
    semantic.set(key, members);
  }
  const compareRepresentative = (a, b) => a.occurredMs - b.occurredMs || a.recordedMs - b.recordedMs ||
    evidenceCompareText(a.event.eventId, b.event.eventId);
  const qualifying = [];
  for (const members of semantic.values()) {
    if (new Set(members.map(item => item.event.result)).size !== 1) {
      conflicts.push({ code: 'attempt-result-conflict', eventIds: members.map(item => item.event.eventId).sort(evidenceCompareText) });
      continue;
    }
    const representative = members.sort(compareRepresentative)[0];
    if (representative.event.result === 'pass') qualifying.push(representative);
  }
  qualifying.sort(compareRepresentative);
  const stableList = rows => [...new Map(rows.map(row => [canonicalJson(row), row])).entries()]
    .sort(([a], [b]) => evidenceCompareText(a, b)).map(([, row]) => row);
  const stableDiagnostics = stableList(diagnostics), stableConflicts = stableList(conflicts);
  return {
    schemaVersion: SUMMARY_SCHEMA, target: cloneJson(target), contextRef,
    now: now.iso, cutoff: cutoff.iso,
    coverage: stableConflicts.length ? 'conflicted' : stableDiagnostics.length ? 'incomplete' : 'ok',
    events: byId.size,
    qualifyingPasses: qualifying.map(({ event }) => cloneJson(event)),
    lastPassAt: qualifying.length ? qualifying.at(-1).event.occurredAt : null,
    conflicts: stableConflicts, diagnostics: stableDiagnostics, excluded: stableList(excluded),
  };
}

const ineligible = value => value === false || (isObj(value) && value.eligible === false);

function summaryAnchor(summary, view, clock, policy) {
  if (summary == null || (isObj(summary) && Object.keys(summary).length === 0)) return { day: null };
  if (!isObj(summary) || summary.schemaVersion !== 'akasha-evidence-summary/v1' ||
      summary.coverage !== 'ok' || !Array.isArray(summary.conflicts) || summary.conflicts.length ||
      !Array.isArray(summary.diagnostics) || summary.diagnostics.length ||
      !Array.isArray(summary.qualifyingPasses)) return { error: 'invalid-evidence-summary' };
  if (!isObj(summary.target) || !view.digest ||
      !['store', 'id', 'versionId', 'digest'].every(key => summary.target[key] === view[key]) ||
      !nonempty(view.contextRef) || summary.contextRef !== view.contextRef) return { error: 'evidence-target-mismatch' };
  const now = parseInstant(summary.now), cutoff = parseInstant(summary.cutoff);
  if (clock.ms == null) return { error: 'evidence-needs-now' };
  if (now.status !== 'ok' || cutoff.status !== 'ok' || cutoff.ms > now.ms) return { error: 'invalid-evidence-clock' };
  if (now.ms > clock.ms || cutoff.ms > clock.ms) return { error: 'clock-skew' };
  const passes = [];
  try {
    for (const raw of summary.qualifyingPasses) {
      const { event, occurredMs, recordedMs } = normalizeEvent(raw);
      if (event.result !== 'pass' || event.contextRef !== view.contextRef ||
          !['store', 'id', 'versionId', 'digest'].every(key => event.target[key] === view[key]) ||
          occurredMs > recordedMs || recordedMs > cutoff.ms) return { error: 'invalid-evidence-pass' };
      passes.push(occurredMs);
    }
  } catch { return { error: 'invalid-evidence-pass' }; }
  if (summary.lastPassAt == null) return passes.length ? { error: 'invalid-evidence-anchor' } : { day: null };
  const pass = parseInstant(summary.lastPassAt);
  if (pass.status !== 'ok') return { error: 'invalid-evidence-anchor' };
  if (pass.ms > clock.ms || pass.ms > cutoff.ms) return { error: 'clock-skew' };
  if (!passes.length || pass.ms !== passes.reduce((max, ms) => Math.max(max, ms), -Infinity)) return { error: 'invalid-evidence-anchor' };
  return { day: localDay(pass.ms, policy.timezone) };
}

export function evaluate(view, summary = {}, { today, now, policy = {} } = {}) {
  const p = validatePolicy(policy);
  const v = normalizeView(view);
  const base = { view: v, contentClass: v.contentClass, protection: v.protection, retention: null, complete: true,
    anchorDay: null, factor: 1, review: null };
  const neutral = (reason, complete = true) => ({ ...base, complete, reasons: [reason] });
  if (ineligible(v.eligibility)) return neutral('ineligible');
  if (v.protection || v.contentClass === 'C1') return { ...base, retention: 1, reasons: ['protected-or-C1'] };
  if (v.contentClass === 'unknown') return neutral('unknown-class');
  if (v.contentClass === 'C3' && !p.c3Enabled) return neutral('C3-disabled');
  const clock = clockContext(today, now, p.timezone);
  if (clock.error) return neutral(clock.error, false);
  let event = v.eventDay;
  if (v.eventPrecision === 'instant') {
    if (clock.ms == null) return neutral('timestamp-needs-now', false);
    const instant = parseInstant(v.eventTime);
    if (instant.ms > clock.ms) return neutral('clock-skew', false);
    event = localDay(instant.ms, p.timezone);
  }
  if (event && event > clock.day) return neutral('clock-skew', false);
  if (v.eventStatus === 'invalid') return neutral('invalid-event-time');
  const pass = summaryAnchor(summary, v, clock, p);
  if (pass.error) return neutral(pass.error, false);
  const anchorDay = v.contentClass === 'C2' ? [event, pass.day].filter(Boolean).sort().at(-1) : event;
  if (!anchorDay) return neutral('missing-anchor');
  const cfg = v.contentClass === 'C2' ? p.C2 : p.C3;
  const ageDays = dayDiff(anchorDay, clock.day);
  const retention = cfg.floor + (1 - cfg.floor) * Math.pow(2, -ageDays / cfg.halfLifeDays);
  return { ...base, retention, anchorDay, ageDays, factor: retention, reasons: [v.contentClass + '-decay'] };
}

export function reviewOverlay(view, { today, now, policy = {} } = {}) {
  const p = validatePolicy(policy);
  const v = normalizeView(view);
  const clock = clockContext(today, now, p.timezone);
  const r = v.review;
  const unknown = reason => ({ state: 'unknown', active: false, overdueDays: null, urgency: null, reasons: [reason] });
  if (clock.error) return unknown(clock.error);
  if (!r.kind) return { state: 'unknown', active: false, overdueDays: null, urgency: null, reasons: ['no-review-kind'] };
  if (r.kind === 'task') {
    if (!isObj(r.sourceTaskRef) || !['source', 'id', 'revision'].every(key => nonempty(r.sourceTaskRef[key]))) return unknown('missing-task-source');
    if (r.openState === 'closed') return { state: 'closed', active: false, overdueDays: null, urgency: null, reasons: ['closed'] };
    if (!['open', 'blocked', 'reopened'].includes(r.openState)) return unknown('unknown-task-state');
  }
  if (r.dueStatus !== 'ok') return unknown('no-due-day');
  const diff = dayDiff(r.dueDay, clock.day);
  const isDue = r.boundary === 'after' ? diff > 0 : diff >= 0;
  if (!isDue) return { state: 'scheduled', active: true, overdueDays: 0, urgency: 0, dueInDays: -diff, reasons: ['scheduled'] };
  const overdueDays = Math.max(0, diff);
  const urgency = 1 - Math.exp(-overdueDays / p.C4.widthDays);
  return { state: 'overdue', active: true, overdueDays, urgency, reasons: ['overdue'] };
}

export function applyTime(baseRank, evaluation, queryContext = {}, policy = {}) {
  const p = validatePolicy(policy);
  if (!finite(baseRank) || baseRank < 0) fail('baseRank: finite >= 0 required');
  if (p.mode === 'off') return { baseRank, factor: 1, rank: baseRank, applied: false };
  const g = queryContext && queryContext.mode === 'recent' || queryContext && queryContext.mode === 'working-set' ? 1 : 0;
  const neutral = { baseRank, factor: 1, rank: baseRank, applied: false };
  if (!g || p.lambda === 0) return neutral;
  if (!isObj(evaluation)) fail('evaluation: object required');
  if (evaluation.protection || evaluation.contentClass === 'C1' ||
      ineligible(evaluation.eligibility) || ineligible(evaluation.view?.eligibility)) return neutral;
  const retention = evaluation.retention == null ? 1 : evaluation.retention;
  if (!finite(retention) || retention < 0 || retention > 1) fail('evaluation.retention: null or [0,1] required');
  const factor = 1 - p.lambda * g * (1 - retention);
  const rank = factor === 1 ? baseRank : baseRank * factor;
  return { baseRank, factor, rank, applied: p.mode === 'rank' && factor !== 1 };
}

export function shadowScore(baseRank, evaluation, queryContext = {}, policy = {}) {
  const p = { ...validatePolicy(policy), mode: 'shadow' };
  const out = applyTime(baseRank, evaluation, queryContext, p);
  return { ...out, applied: false, shadow: true };
}

/** Caller supplies an already-qualified batch. No upstream resolver/error is caught here. */
export function applyTimeBatch(candidates, { queryContext = {}, policy = {}, generation, complete = true } = {}) {
  if (!Array.isArray(candidates)) fail('candidates: array required');
  const baseline = (reason = null) => ({ candidates, diagnostics: [], applied: false, fallback: reason != null, reason });
  try {
    const p = validatePolicy(policy);
    if (p.mode === 'off') return baseline();
    if (complete !== true) return baseline('incomplete-batch');
    if (candidates.some(item => item?.evaluation?.complete === false)) return baseline('incomplete-evaluation');
    if (generation != null && candidates.some(item => item.generation !== generation)) return baseline('generation-mismatch');
    const diagnostics = candidates.map(item => {
      if (!isObj(item)) fail('candidate: object required');
      const evaluation = ineligible(item.eligibility) ? { ...item.evaluation, eligibility: false } : item.evaluation;
      return { id: item.id, ...applyTime(item.baseRank, evaluation, queryContext, p) };
    });
    if (p.mode === 'shadow') return { ...baseline(), diagnostics };
    const applied = diagnostics.some(item => item.applied);
    return { candidates: applied ? candidates.map((item, i) => ({ ...item, rank: diagnostics[i].rank })) : candidates,
      diagnostics, applied, fallback: false, reason: null };
  } catch (error) {
    return baseline('time-evaluation-error: ' + (error instanceof Error ? error.message : 'unknown'));
  }
}
