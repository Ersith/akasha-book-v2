// 自我投影（P1）：纯函数，无 I/O、无模型。
// canon 记录是已确认长期断言的来源；本模块只做确定性派生，不写回任何库。
import { createHash } from 'node:crypto';

export const SCHEMA_VERSION = 'self-projection/v1';
export const POLICY_VERSION = 'self-policy/v1';

const KIND_ORDER = ['identity', 'address', 'boundary', 'principle', 'commitment_policy'];
const KIND_LABEL = {
  identity: '身份',
  address: '称呼',
  boundary: '边界',
  principle: '原则',
  commitment_policy: '承诺',
};
const sha = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const isInactive = (record) => record.retired === true || record.revoked === true || record.valid_to != null;
const approvalDigest = (record) => {
  const lifecycle = record.retired === true ? 'retired' : (record.revoked === true ? 'revoked' : (record.valid_to != null ? `valid_to:${record.valid_to}` : ''));
  const parts = [record.kind, record.semanticKey, record.claim, record.scope, record.id, record.parentId ?? null];
  if (lifecycle) parts.push(lifecycle);
  return sha(JSON.stringify(parts));
};

function inferKind(record) {
  const tags = Array.isArray(record.tags) ? record.tags : [];
  if (record.kind && KIND_ORDER.includes(record.kind)) return record.kind;
  const id = String(record.id ?? '');
  if (id.startsWith('canon-address')) return 'address';
  if (id.startsWith('canon-self')) return 'identity';
  if (tags.includes('边界') || tags.includes('boundary')) return 'boundary';
  if (tags.includes('承诺') || tags.includes('commitment')) return 'commitment_policy';
  if (tags.includes('原则') || tags.includes('principle') || tags.includes('自我')) return 'principle';
  return null;
}

function makeApprovalIndex(approvals, subjectId) {
  const map = new Map();
  for (const approval of approvals) {
    if (!approval || typeof approval !== 'object' || Array.isArray(approval)) continue;
    if (approval.subjectId !== subjectId || approval.action !== 'self') continue;
    const key = JSON.stringify([
      approval.subjectId, approval.semanticKey, approval.expectedRevision,
      approval.canonId ?? approval.recordId ?? null, approval.parentId ?? approval.supersedes ?? null, approval.digest,
    ]);
    map.set(key, approval);
  }
  return map;
}

function approvedFor(record, approvalIndex, subjectId) {
  if (!approvalIndex) return false;
  const approval = approvalIndex.get(JSON.stringify([
    subjectId, record.semanticKey, record.revision,
    record.id, record.parentId ?? null, approvalDigest(record),
  ]));
  return !!approval && typeof approval.approvedBy === 'string' && approval.approvedBy.length > 0;
}

// 先验历史，再取 current；不能先 currentRecords 再验批准/生命周期。
export function validateSelfHistory(history, {
  subjectId = 'default',
  sourceErrors = [],
  requireApproval = false,
  approvals = [],
} = {}) {
  if (!Array.isArray(history)) throw new TypeError('history 必须是数组');
  if (!Array.isArray(sourceErrors)) throw new TypeError('sourceErrors 必须是数组');
  if (typeof requireApproval !== 'boolean') throw new TypeError('requireApproval 必须是 boolean');
  if (!Array.isArray(approvals)) throw new TypeError('approvals 必须是数组');
  const diagnostics = [];
  const byId = new Map();
  for (const [i, raw] of history.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { diagnostics.push(`history[${i}] 不是对象`); continue; }
    if (raw.subjectId != null && raw.subjectId !== subjectId) continue;
    if (raw.scope != null && /^(task|session):/.test(String(raw.scope))) continue;
    if (typeof raw.id !== 'string' || raw.id.length === 0) { diagnostics.push(`history[${i}].id 缺失`); continue; }
    if (byId.has(raw.id)) { diagnostics.push(`重复 ID：${raw.id}`); continue; }
    if ('retires' in raw || 'revokes' in raw) {
      diagnostics.push(`不支持的控制事件：${raw.id}（retires/revokes）`);
      continue;
    }
    if (isInactive(raw)) {
      diagnostics.push(`不支持的生命周期状态：${raw.id}（需状态级批准，P3）`);
      continue;
    }
    if (raw.parentId != null && raw.parentId !== raw.supersedes) {
      diagnostics.push(`parentId 与 supersedes 不一致：${raw.id}`);
      continue;
    }
    byId.set(raw.id, raw);
  }

  const canonicalKeys = new Map();
  for (const record of byId.values()) {
    let root = record.id;
    const seen = new Set();
    while (byId.get(root)?.supersedes != null && !seen.has(root)) { seen.add(root); root = byId.get(root).supersedes; }
    canonicalKeys.set(record.id, record.semanticKey ?? root);
  }
  const supersededBy = new Map();
  for (const record of byId.values()) {
    const parent = record.supersedes;
    if (parent == null) continue;
    if (!byId.has(parent)) { diagnostics.push(`${record.id} supersedes 目标不存在：${parent}`); continue; }
    if (isInactive(byId.get(parent))) { diagnostics.push(`不能 supersede 已失效记录：${parent}`); continue; }
    if (supersededBy.has(parent)) diagnostics.push(`${parent} 有多个后继 tip：${supersededBy.get(parent)} / ${record.id}`);
    const parentRecord = byId.get(parent);
    const childKind = inferKind(record);
    const parentKind = inferKind(parentRecord);
    const childKey = canonicalKeys.get(record.id);
    const parentKey = canonicalKeys.get(parentRecord.id);
    if (childKind !== parentKind || childKey !== parentKey) diagnostics.push(`普通修订不得迁移 kind/semanticKey：${record.id}`);
    supersededBy.set(parent, record.id);
  }
  for (const id of byId.keys()) {
    const seen = new Set();
    let cur = id;
    while (cur != null) {
      if (seen.has(cur)) { diagnostics.push(`修订链循环：${cur}`); break; }
      seen.add(cur);
      cur = byId.get(cur)?.supersedes ?? null;
    }
  }

  const approvalIndex = requireApproval ? makeApprovalIndex(approvals, subjectId) : null;
  if (approvalIndex) {
    for (const record of byId.values()) {
      if (record.supersedes == null && !isInactive(record)) continue;
      const shaped = {
        ...record, parentId: record.supersedes ?? null,
        kind: inferKind(record), semanticKey: canonicalKeys.get(record.id),
        claim: record.claim, scope: record.scope ?? 'global',
        revision: record.revision ?? record.last_reviewed,
      };
      if (!approvedFor(shaped, approvalIndex, subjectId)) diagnostics.push(`生命周期事件缺少有效批准：${record.id}`);
    }
  }

  const current = [];
  const rootIds = new Map();
  for (const record of byId.values()) {
    if (isInactive(record) || supersededBy.has(record.id)) continue;
    let root = record.id;
    const seen = new Set();
    while (byId.get(root)?.supersedes != null && !seen.has(root)) {
      seen.add(root);
      root = byId.get(root).supersedes;
    }
    rootIds.set(record.id, root);
    current.push(record);
  }
  const bad = sourceErrors.length > 0 || diagnostics.length > 0;
  return { records: current, diagnostics, sourceErrors, status: bad ? 'failed' : 'ok', rootIds, semanticKeys: canonicalKeys };
}

export function buildSelfProjection(history, {
  subjectId = 'default',
  schemaVersion = SCHEMA_VERSION,
  policyVersion = POLICY_VERSION,
  requiredKinds = ['identity', 'address'],
  requiredSemanticKeys = [],
  maxCardChars = 600,
  maxStableChars = 4000,
  sourceErrors = [],
  approvals = [],
  requireApproval = false,
  budgetUnit = 'chars',
  cardOverflow = 'fail',
  skipHistoryValidation = false,
} = {}) {
  if (!Array.isArray(history)) throw new TypeError('history 必须是数组');
  if (typeof subjectId !== 'string' || !subjectId) throw new TypeError('subjectId 必填');
  if (!Array.isArray(requiredKinds)) throw new TypeError('requiredKinds 必须是数组');
  if (!Array.isArray(requiredSemanticKeys)) throw new TypeError('requiredSemanticKeys 必须是数组');
  if (!Array.isArray(approvals)) throw new TypeError('approvals 必须是数组');
  if (typeof requireApproval !== 'boolean') throw new TypeError('requireApproval 必须是 boolean');
  if (typeof skipHistoryValidation !== 'boolean') throw new TypeError('skipHistoryValidation 必须是 boolean');
  if (budgetUnit !== 'chars') throw new TypeError("budgetUnit 目前只支持 'chars'");
  if (!['fail', 'omit'].includes(cardOverflow)) throw new TypeError("cardOverflow 必须是 'fail' 或 'omit'");
  if (!Number.isInteger(maxCardChars) || maxCardChars <= 0) throw new TypeError('maxCardChars 必须是正整数');
  if (!Number.isInteger(maxStableChars) || maxStableChars <= 0) throw new TypeError('maxStableChars 必须是正整数');
  if (!Array.isArray(sourceErrors)) throw new TypeError('sourceErrors 必须是数组');
  // Omission is an explicit optional-card policy; it never relaxes stable coverage.
  if (cardOverflow === 'omit') policyVersion = `${policyVersion}/card-omit-v1`;
  const budgetPolicy = { budgetUnit, maxStableChars, maxCardChars, cardOverflow, requiredKinds: [...requiredKinds], requiredSemanticKeys: [...requiredSemanticKeys] };

  const validated = skipHistoryValidation
    ? { records: history, diagnostics: [], sourceErrors, status: sourceErrors.length ? 'failed' : 'ok', rootIds: new Map(history.map((r) => [r.id, r.id])) }
    : validateSelfHistory(history, { subjectId, sourceErrors, requireApproval, approvals });
  const warnings = [...validated.diagnostics];
  const entries = [];
  const seen = new Map();
  let intakeError = false;
  const approvalIndex = requireApproval ? makeApprovalIndex(approvals, subjectId) : null;

  for (const raw of validated.records) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { warnings.push('current 记录不是对象'); intakeError = true; continue; }
    if (raw.subjectId != null && raw.subjectId !== subjectId) continue;
    if (raw.scope != null && /^(task|session):/.test(String(raw.scope))) { warnings.push(`${raw.id} scope=${raw.scope} 不进入稳定自我`); continue; }
    const id = typeof raw.id === 'string' && raw.id.length > 0 ? raw.id : null;
    if (!id) { warnings.push('current 记录 id 缺失'); intakeError = true; continue; }
    const claim = typeof raw.claim === 'string' ? raw.claim.trim() : '';
    if (!claim) { warnings.push(`${id} 的 claim 为空，已跳过`); intakeError = true; continue; }
    const kind = inferKind(raw);
    if (!kind) { warnings.push(`${id} 无 kind/可推断类别，已跳过`); intakeError = true; continue; }
    const semanticKey = validated.semanticKeys?.get(id)
      ?? (typeof raw.semanticKey === 'string' && raw.semanticKey.length > 0 ? raw.semanticKey : id);
    const revision = raw.revision ?? raw.last_reviewed ?? null;
    if (!revision) warnings.push(`${id} 缺 revision，使用 unversioned`);
    const parentId = raw.supersedes ?? null;
    const entry = {
      id, kind, semanticKey, claim, revision: revision ?? `unversioned:${sha(claim)}`,
      parentId, conflict: false, source: raw.source ?? null,
      scope: raw.scope ?? 'global', approved: false,
    };
    entry.approved = approvedFor(entry, approvalIndex, subjectId);
    if (requireApproval && !entry.approved) { warnings.push(`缺少有效批准：${semanticKey}`); entry.approvalFail = true; }
    if (seen.has(semanticKey)) {
      const prev = seen.get(semanticKey);
      warnings.push(`同键冲突/双根：${semanticKey}（${prev.id} vs ${id}）`);
      entry.conflict = true;
      entries.push(entry);
      continue;
    }
    seen.set(semanticKey, entry);
    entries.push(entry);
  }

  const missing = requiredKinds.filter((kind) => !entries.some((e) => !e.conflict && e.kind === kind));
  const missingKeys = requiredSemanticKeys.filter((key) => !entries.some((e) => !e.conflict && e.semanticKey === key));
  const ordered = [...entries].sort((a, b) => {
    const ka = KIND_ORDER.indexOf(a.kind);
    const kb = KIND_ORDER.indexOf(b.kind);
    if (ka !== kb) return ka - kb;
    if (a.semanticKey !== b.semanticKey) return a.semanticKey < b.semanticKey ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
  const valid = ordered.filter((entry) => !entry.conflict);
  if (missing.length) warnings.push(`缺少必需类别：${missing.join(',')}`);
  if (missingKeys.length) warnings.push(`缺少必需语义键：${missingKeys.join(',')}`);
  if (validated.sourceErrors.length) {
    warnings.push(`来源错误 ${validated.sourceErrors.length} 条`);
    for (const error of validated.sourceErrors) warnings.push(String(error));
  }

  const requiredSet = new Set(requiredKinds);
  const requiredKeys = new Set(requiredSemanticKeys);
  const isRequired = (entry) => requiredSet.has(entry.kind) || requiredKeys.has(entry.semanticKey);
  const lineOf = (entry) => `${KIND_LABEL[entry.kind] ?? entry.kind}：${entry.claim}`;
  const select = (max) => {
    const picked = [];
    const required = valid.filter(isRequired);
    const optional = valid.filter((entry) => !isRequired(entry));
    for (const entry of required) picked.push(entry);
    for (const entry of optional) {
      const candidate = [...picked, entry];
      if (candidate.map(lineOf).join('\n').length <= max) picked.push(entry);
    }
    return picked;
  };
  const approvalFailed = entries.some((entry) => entry.approvalFail);
  const requiredText = valid.filter(isRequired).map(lineOf).join('\n').length;
  const cardOmitted = cardOverflow === 'omit' && requiredText > maxCardChars;
  const stableEntries = approvalFailed ? [] : select(maxStableChars);
  // Never choose a partial mandatory identity/address set merely to fit a card.
  const cardEntries = approvalFailed || cardOmitted ? [] : select(maxCardChars);
  const stableText = stableEntries.map(lineOf).join('\n');
  const cardText = cardEntries.map(lineOf).join('\n');
  const droppedStable = valid.length - stableEntries.length;
  const droppedCard = valid.length - cardEntries.length;
  for (const entry of valid) if (!stableEntries.includes(entry)) warnings.push(`stable 预算裁掉 ${entry.semanticKey}`);
  for (const entry of valid) if (!cardEntries.includes(entry)) warnings.push(`card 预算裁掉 ${entry.semanticKey}`);
  if (requiredText > maxStableChars) warnings.push('stable 必需内容超预算');
  if (requiredText > maxCardChars) warnings.push(cardOmitted ? 'card 必需内容超预算：卡片不可用，stable 仍按独立预算验证' : 'card 必需内容超预算');
  if (droppedStable > 0 || droppedCard > 0) warnings.push(`预算裁掉 stable=${droppedStable} card=${droppedCard}`);

  const sourceRevisions = Object.fromEntries(stableEntries.map((entry) => [entry.id, entry.revision]).sort());
  const sourceRootIds = [...new Set(stableEntries.map((entry) => validated.rootIds?.get(entry.id) ?? entry.id))].sort();
  const stableHash = sha(`${schemaVersion}|${policyVersion}|${stableText}`);
  const cardHash = sha(`${schemaVersion}|${policyVersion}|${cardText}`);

  let status = 'ok';
  if (entries.length === 0) status = 'empty';
  else if (missing.length || missingKeys.length) status = 'failed';
  if (entries.some((entry) => entry.conflict)) status = 'failed';
  if (entries.some((entry) => entry.approvalFail)) status = 'failed';
  if (validated.status === 'failed' || intakeError) status = 'failed';
  if (requiredText > maxStableChars || stableText.length > maxStableChars
      || (!cardOmitted && (requiredText > maxCardChars || cardText.length > maxCardChars))) status = 'failed';
  if (status === 'ok' && (droppedStable > 0 || droppedCard > 0)) status = 'degraded';
  if (entries.length === 0 && validated.status === 'failed') status = 'failed';

  const addressText = stableEntries.filter((entry) => entry.kind === 'address').map((entry) => entry.claim).join('\n');
  const selfText = stableEntries.filter((entry) => entry.kind !== 'address')
    .map((entry) => `${KIND_LABEL[entry.kind] ?? entry.kind}：${entry.claim}`).join('\n');
  const selfLine = stableEntries.filter((entry) => entry.kind === 'identity' || entry.kind === 'address')
    .map((entry) => entry.claim).join('；');

  return {
    schemaVersion, subjectId, policyVersion,
    ...(cardOverflow === 'omit' ? {
      budgetPolicy,
      cardStatus: status === 'failed' || status === 'empty' || cardOmitted ? 'unavailable' : droppedCard > 0 ? 'degraded' : 'ok',
    } : {}),
    sourceRootIds, sourceRevisions,
    stableText, stableHash, cardText, cardHash,
    selectedStableIds: stableEntries.map((entry) => entry.id),
    selectedCardIds: cardEntries.map((entry) => entry.id),
    views: { selfText, selfLine, addressText },
    entries: ordered,
    warnings,
    status,
  };
}
