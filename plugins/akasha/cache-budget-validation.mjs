// Pure checks for the explicitly versioned optional-card policy. Legacy strict
// projections have neither metadata field and keep their old cache identity.
const OMIT_SUFFIX = '/card-omit-v1';
const labels = { identity: '身份', address: '称呼', boundary: '边界', principle: '原则', commitment_policy: '承诺' };
const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');
const equalIds = (left, right) => strings(left) && left.length === right.length && left.every((id, index) => id === right[index]);
const usesOmission = projection => typeof projection?.policyVersion === 'string' && projection.policyVersion.endsWith(OMIT_SUFFIX);

export function projectionBudgetIdentityParts(projection) {
  if (!usesOmission(projection)) return [];
  const policy = projection.budgetPolicy;
  // Fixed field order prevents object insertion order from changing identity.
  return [{
    budgetUnit: policy?.budgetUnit,
    maxStableChars: policy?.maxStableChars,
    maxCardChars: policy?.maxCardChars,
    cardOverflow: policy?.cardOverflow,
    requiredKinds: policy?.requiredKinds,
    requiredSemanticKeys: policy?.requiredSemanticKeys,
  }, projection.cardStatus];
}

export function validateProjectionBudget(projection) {
  if (!projection || typeof projection !== 'object') return 'projection';
  if (!usesOmission(projection)) {
    return Object.hasOwn(projection, 'budgetPolicy') || Object.hasOwn(projection, 'cardStatus')
      ? 'projection.unexpectedBudgetPolicy' : null;
  }
  const policy = projection.budgetPolicy;
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)
      || policy.budgetUnit !== 'chars' || policy.cardOverflow !== 'omit'
      || !Number.isInteger(policy.maxStableChars) || policy.maxStableChars <= 0
      || !Number.isInteger(policy.maxCardChars) || policy.maxCardChars <= 0
      || !strings(policy.requiredKinds) || !strings(policy.requiredSemanticKeys)) return 'projection.budgetPolicy';
  if (!['ok', 'degraded', 'failed', 'empty'].includes(projection.status)) return 'projection.status';
  if (!['ok', 'degraded', 'unavailable'].includes(projection.cardStatus)) return 'projection.cardStatus';
  if (!Array.isArray(projection.entries) || !strings(projection.selectedStableIds) || !strings(projection.selectedCardIds)) return 'projection.budgetCollections';
  const entries = projection.entries;
  if (entries.some(entry => !entry || typeof entry.id !== 'string' || !entry.id
      || !Object.hasOwn(labels, entry.kind) || typeof entry.semanticKey !== 'string'
      || typeof entry.claim !== 'string')) return 'projection.budgetEntry';
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) return 'projection.budgetDuplicateId';
  const valid = entries.filter(entry => !entry.conflict);
  const requiredKinds = new Set(policy.requiredKinds);
  const requiredKeys = new Set(policy.requiredSemanticKeys);
  const isRequired = entry => requiredKinds.has(entry.kind) || requiredKeys.has(entry.semanticKey);
  const lineOf = entry => `${labels[entry.kind]}：${entry.claim}`;
  const textOf = selection => selection.map(lineOf).join('\n');
  const required = valid.filter(isRequired);
  const requiredLength = textOf(required).length;
  const cardOmitted = requiredLength > policy.maxCardChars;
  const approvalFailed = entries.some(entry => entry.approvalFail);
  const select = max => {
    const picked = [...required];
    for (const entry of valid.filter(item => !isRequired(item))) {
      if (textOf([...picked, entry]).length <= max) picked.push(entry);
    }
    return picked;
  };
  const expectedStable = approvalFailed ? [] : select(policy.maxStableChars);
  const expectedCard = approvalFailed || cardOmitted ? [] : select(policy.maxCardChars);
  if (!equalIds(projection.selectedStableIds, expectedStable.map(entry => entry.id))) return 'projection.selectedStableIds.budget';
  if (!equalIds(projection.selectedCardIds, expectedCard.map(entry => entry.id))) return 'projection.selectedCardIds.budget';
  if (projection.stableText !== textOf(expectedStable)) return 'projection.stableText.budget';
  if (projection.cardText !== textOf(expectedCard)) return 'projection.cardText.budget';
  if (projection.cardText.length > policy.maxCardChars) return 'projection.cardBudgetExceeded';
  const droppedStable = valid.length - expectedStable.length;
  const droppedCard = valid.length - expectedCard.length;
  const deliverable = projection.status === 'ok' || projection.status === 'degraded';
  if (deliverable) {
    if (entries.length === 0 || entries.some(entry => entry.conflict || entry.approvalFail)
        || policy.requiredKinds.some(kind => !valid.some(entry => entry.kind === kind))
        || policy.requiredSemanticKeys.some(key => !valid.some(entry => entry.semanticKey === key))
        || requiredLength > policy.maxStableChars || projection.stableText.length > policy.maxStableChars) return 'projection.stableNotDeliverable';
    const expectedStatus = droppedStable > 0 || droppedCard > 0 ? 'degraded' : 'ok';
    if (projection.status !== expectedStatus) return 'projection.budgetStatus';
  }
  const expectedCardStatus = !deliverable || cardOmitted ? 'unavailable' : droppedCard > 0 ? 'degraded' : 'ok';
  return projection.cardStatus === expectedCardStatus ? null : 'projection.cardStatus.budget';
}
