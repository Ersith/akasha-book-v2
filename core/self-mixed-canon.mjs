// Optional mixed-canon intake. Pure: never reads/writes canon or selects a primary identity.
import { buildSelfProjection, validateSelfHistory } from './self-projection.mjs';

export const MIXED_POLICY_VERSION = 'mixed-canon/v1';
const KINDS = new Set(['identity', 'address', 'boundary', 'principle', 'commitment_policy']);
const own = (value, key) => Object.hasOwn(value, key);
const str = value => typeof value === 'string' && value.trim().length > 0;
const legacyFamily = id => /^canon-self-concept(?:-|$)/.test(id) ? 'identity'
  : /^canon-address-layers(?:-|$)/.test(id) ? 'address'
  : /^canon-memory-auto-record(?:-|$)/.test(id) ? 'principle' : null;
const hasSelfTag = record => Array.isArray(record.tags) && record.tags.includes('自我');
const domainMember = record => KINDS.has(record.kind) || hasSelfTag(record) || !!legacyFamily(record.id);
const controlType = record => own(record, 'retires') ? 'retires' : own(record, 'revokes') ? 'revokes' : null;
const globalScope = record => record.scope == null || !/^(task|session):/.test(record.scope);
const scopeOf = record => record.scope ?? 'global';

function inferredLegacyKind(chain) {
  // Membership is decided by the current tip; inference cannot admit ordinary knowledge.
  const root = chain[0];
  const tip = chain.at(-1);
  const fixed = legacyFamily(root.id) ?? legacyFamily(tip.id);
  if (fixed) return fixed;
  if (/^canon-address(?:-|$)/.test(root.id)) return 'address';
  if (/^canon-self(?:-|$)/.test(root.id)) return 'identity';
  const tags = Array.isArray(tip.tags) ? tip.tags : [];
  if (tags.includes('边界') || tags.includes('boundary')) return 'boundary';
  if (tags.includes('承诺') || tags.includes('commitment')) return 'commitment_policy';
  return 'principle';
}

/**
 * Validate all references before domain filtering. Assertion supersedes edges form chains;
 * retires/revokes rows may clone an assertion's supersedes but are not new revisions.
 * `history` retains selected ancestors and related controls; `records` is validated render
 * history after effective tombstones. Diagnostics contain only structural metadata.
 */
export function adaptMixedCanon(history, {
  subjectId = 'default', sourceErrors = [], requireApproval = false, approvals = [],
} = {}) {
  if (!Array.isArray(history)) throw new TypeError('history 必须是数组');
  if (!str(subjectId)) throw new TypeError('subjectId 必填');
  if (!Array.isArray(sourceErrors)) throw new TypeError('sourceErrors 必须是数组');
  if (typeof requireApproval !== 'boolean') throw new TypeError('requireApproval 必须是 boolean');
  if (!Array.isArray(approvals)) throw new TypeError('approvals 必须是数组');
  const diagnostics = [];
  const add = (code, fields = {}) => diagnostics.push({ code, ...fields });
  const byId = new Map();
  const subjectOf = record => record.subjectId ?? subjectId;
  for (const [index, record] of history.entries()) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) { add('invalid-record', { index }); continue; }
    if (!str(record.id)) { add('invalid-id', { index }); continue; }
    if (byId.has(record.id)) { add('duplicate-id', { id: record.id, index }); continue; }
    byId.set(record.id, record);
    if (record.subjectId != null && !str(record.subjectId)) add('invalid-subject', { id: record.id });
    if (record.scope != null && !str(record.scope)) add('invalid-scope', { id: record.id });
    if (own(record, 'retires') && own(record, 'revokes')) add('ambiguous-control', { id: record.id });
    if (record.parentId != null && record.parentId !== record.supersedes) add('parent-mismatch', { id: record.id });
  }

  const successors = new Map();
  const edges = new Map();
  for (const record of byId.values()) {
    const refs = [];
    for (const field of ['supersedes', 'retires', 'revokes']) {
      if (!own(record, field) || (field === 'supersedes' && record[field] == null)) continue;
      const target = record[field];
      if (!str(target)) { add('invalid-reference', { id: record.id, field }); continue; }
      refs.push(target);
      const other = byId.get(target);
      if (!other) { add('missing-reference', { id: record.id, field, target }); continue; }
      if (subjectOf(record) !== subjectOf(other)) add('cross-subject', { id: record.id, field, target });
      if (scopeOf(record) !== scopeOf(other)) add('cross-scope', { id: record.id, field, target });
      if (field === 'retires' && controlType(other)) add('retire-target-is-control', { id: record.id, target });
      if (field === 'revokes' && controlType(other) !== 'retires') add('revoke-target-not-tombstone', { id: record.id, target });
      if (field === 'supersedes' && !controlType(record)) {
        if (controlType(other)) add('revision-target-is-control', { id: record.id, target });
        const children = successors.get(target) ?? [];
        children.push(record.id);
        successors.set(target, children);
      }
    }
    edges.set(record.id, refs);
  }

  // All relation cycles are invalid even if the latest record later exits the self domain.
  const colors = new Map();
  const visit = id => {
    if (colors.get(id) === 1) { add('relation-cycle', { id }); return; }
    if (colors.get(id) === 2) return;
    colors.set(id, 1);
    for (const target of edges.get(id) ?? []) if (byId.has(target)) visit(target);
    colors.set(id, 2);
  };
  for (const id of byId.keys()) visit(id);

  const chainOf = tip => {
    const chain = []; const seen = new Set(); let current = tip;
    while (current && !controlType(current) && !seen.has(current.id)) {
      seen.add(current.id); chain.unshift(current);
      current = current.supersedes == null ? null : byId.get(current.supersedes);
    }
    return chain;
  };
  const assertions = [...byId.values()].filter(record => !controlType(record));
  const relevantIds = new Set();
  // Mark the whole connected assertion component for self-specific fork/semantic checks.
  const markComponent = record => {
    const todo = [record.id];
    while (todo.length) {
      const id = todo.pop(); if (relevantIds.has(id)) continue;
      relevantIds.add(id);
      const row = byId.get(id);
      if (row?.supersedes != null && byId.has(row.supersedes) && !controlType(byId.get(row.supersedes))) todo.push(row.supersedes);
      for (const child of successors.get(id) ?? []) todo.push(child);
    }
  };
  for (const record of assertions) if (domainMember(record)) markComponent(record);
  for (const [id, children] of successors) if (children.length > 1 && relevantIds.has(id)) add('self-fork', { id, children });
  for (const record of assertions) {
    if (!relevantIds.has(record.id) || record.supersedes == null) continue;
    const explicitKinds = new Set(chainOf(record).filter(item => item.kind != null).map(item => item.kind));
    if (explicitKinds.size > 1) add('explicit-kind-conflict', { id: record.id });
    const parent = byId.get(record.supersedes);
    if (!parent || controlType(parent)) continue;
    if (record.kind != null && parent.kind != null && record.kind !== parent.kind) add('explicit-kind-change', { id: record.id, target: parent.id });
    const root = chainOf(record)[0]?.id;
    if ((record.semanticKey ?? root) !== (parent.semanticKey ?? root)) add('semantic-key-change', { id: record.id, target: parent.id });
  }

  // Existing lib.currentRecords semantics: revokes cancels a tombstone, not an assertion.
  const revokedTombs = new Set([...byId.values()].filter(r => controlType(r) === 'revokes').map(r => r.revokes));
  const retiredIds = new Set([...byId.values()].filter(r => controlType(r) === 'retires' && !revokedTombs.has(r.id)).map(r => r.retires));
  const selectedChains = assertions.filter(record => !successors.has(record.id)
    && record.status !== 'proposed'
    && subjectOf(record) === subjectId && globalScope(record) && domainMember(record)).map(chainOf);
  const selectedIds = new Set(selectedChains.flatMap(chain => chain.map(record => record.id)));
  const relatedControls = [...byId.values()].filter(record => controlType(record) === 'retires' && selectedIds.has(record.retires));
  const relatedTombs = new Set(relatedControls.map(record => record.id));
  relatedControls.push(...[...byId.values()].filter(record => controlType(record) === 'revokes' && relatedTombs.has(record.revokes)));

  const normalized = selectedChains.map(chain => {
    const explicitKinds = new Set(chain.filter(record => record.kind != null).map(record => record.kind));
    if ([...explicitKinds].some(kind => !KINDS.has(kind))) add('invalid-self-kind', { id: chain.at(-1).id });
    if (explicitKinds.size > 1) add('explicit-kind-conflict', { id: chain.at(-1).id });
    const kind = explicitKinds.size === 1 ? [...explicitKinds][0] : inferredLegacyKind(chain);
    return chain.map(record => ({ ...record, kind: record.kind ?? kind }));
  });
  const fullAssertions = normalized.flat();
  if (requireApproval && relatedControls.length) add('control-approval-not-supported', { ids: relatedControls.map(record => record.id) });
  // Full chain validation happens before control effects remove any renderable assertion.
  const checked = validateSelfHistory(fullAssertions, { subjectId, sourceErrors, requireApproval, approvals });
  for (const detail of checked.diagnostics) add('self-history', { detail });
  for (const chain of normalized) {
    for (const record of chain.slice(0, -1)) if (retiredIds.has(record.id)) add('supersedes-retired', { id: chain.at(-1).id, target: record.id });
  }
  const activeChains = normalized.filter(chain => !retiredIds.has(chain.at(-1).id));
  return {
    status: diagnostics.length || sourceErrors.length ? 'failed' : 'ok',
    records: activeChains.flat(),
    history: [...fullAssertions, ...relatedControls],
    diagnostics,
    metadata: {
      inputCount: history.length, assertionCount: assertions.length,
      selectedChainCount: normalized.length, activeChainCount: activeChains.length,
      selectedHistoryIds: [...selectedIds], controlIds: relatedControls.map(record => record.id),
      retiredTipIds: normalized.filter(chain => retiredIds.has(chain.at(-1).id)).map(chain => chain.at(-1).id),
    },
  };
}

export function buildMixedSelfProjection(history, options = {}) {
  if (options.skipHistoryValidation === true) throw new TypeError('mixed-canon 不允许 skipHistoryValidation');
  const intake = adaptMixedCanon(history, options);
  const diagnostics = intake.diagnostics.map(item => `mixed-canon:${JSON.stringify(item)}`);
  const projection = buildSelfProjection(intake.records, {
    ...options,
    policyVersion: `${options.policyVersion ?? 'self-policy/v1'}/${MIXED_POLICY_VERSION}`,
    sourceErrors: [...(options.sourceErrors ?? []), ...diagnostics],
    skipHistoryValidation: false,
  });
  return { ...projection, intake: { ...intake.metadata, status: intake.status, diagnostics: intake.diagnostics } };
}
