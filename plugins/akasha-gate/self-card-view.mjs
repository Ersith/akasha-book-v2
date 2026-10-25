// Gate-local display/send view. Never write this derived projection to the core
// projection cache: that cache retains its independent card-omit policy.
import { createHash } from 'node:crypto';
import { safeInject } from './prompt-safety.js';

export const SELF_CARD_POLICY = 'bounded-self-card/v1';
export const SELF_CARD_MAX_CHARS = 600;
const MIN_CARD_CHARS = 160;
const KINDS = ['identity', 'address', 'boundary', 'principle', 'commitment_policy'];
const LABELS = { identity: '身份', address: '称呼', boundary: '边界', principle: '原则', commitment_policy: '承诺' };
const SUMMARY_HEADER = '（自我摘要；以下为节选，并非完整档案）';
const SELF_OPEN = '<akasha-self-data>';
const SELF_CLOSE = '</akasha-self-data>';
const SELF_OPEN_ESCAPED = '&lt;akasha-self-data&gt;';
const SELF_CLOSE_ESCAPED = '&lt;/akasha-self-data&gt;';

/** Final send-safe text: brace interpolation and literal self-data fences are broken
 * BEFORE the 600-unit budget is measured, so escaping cannot push the card over budget. */
export function sanitizeSelfCardText(value) {
  return safeInject(String(value ?? '')
    .split(SELF_OPEN).join(SELF_OPEN_ESCAPED)
    .split(SELF_CLOSE).join(SELF_CLOSE_ESCAPED));
}

/** JSON pointer IDs: encode `{`, `<`, and `⟦` as JSON unicode escapes so the
 * displayed text has no interpolation/boundary anchor, while JSON.parse restores
 * the exact source ID. */
export function jsonSelfIds(ids) {
  return JSON.stringify(ids).replace(/[{<⟦]/g, char =>
    String.fromCharCode(92) + 'u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
}
const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const unique = ids => [...new Set(ids)];

// Mixed-canon preserves a revision chain's semantic root. Prefer explicit
// identity/address families over technical notes inferred to the same kind.
// An accepted identity correction takes precedence over the older concept;
// this chooses existing source text, never invents a new identity statement.
function semanticPriority(entry) {
  const key = entry.semanticKey ?? entry.id;
  if (entry.kind === 'identity') {
    if (/^canon-self-identity-correction(?:-|$)/.test(key)) return 0;
    if (/^canon-self-concept(?:-|$)/.test(key)) return 1;
    return 2;
  }
  if (entry.kind === 'address') return /^canon-address-layers(?:-|$)/.test(key) ? 0 : 1;
  return 0;
}

function checkBudget(maxChars) {
  if (!Number.isInteger(maxChars) || maxChars < MIN_CARD_CHARS || maxChars > SELF_CARD_MAX_CHARS) {
    throw new RangeError(`maxChars must be an integer from ${MIN_CARD_CHARS} to ${SELF_CARD_MAX_CHARS}`);
  }
}

function excerpt(claim, maxChars) {
  const text = claim.replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  let cut = text.slice(0, Math.max(0, maxChars - 1));
  // The character budget follows JS string length; never split a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  const at = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('. '));
  // Prefer a nearby sentence end, without throwing away a large part of the
  // reserved fact budget (e.g. the second name after an earlier sentence).
  if (at >= maxChars - 12) cut = cut.slice(0, at + 1);
  return cut.trimEnd() + '…';
}

/** Pure shared renderer for the framed selfCard view and the tokenless legacy card.
 * Pointers are whole JSON strings, not snippets; long IDs cannot crowd out the
 * minimum identity/address excerpts. Full IDs remain in the source metadata.
 */
export function renderBoundedSelfCard(entries, { maxChars = SELF_CARD_MAX_CHARS, stableText } = {}) {
  checkBudget(maxChars);
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  const ordered = entries.filter(entry => entry && !entry.conflict && !entry.approvalFail
    && KINDS.includes(entry.kind) && typeof entry.id === 'string' && entry.id.length > 0
    && typeof entry.claim === 'string' && entry.claim.trim().length > 0)
    .slice().sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind)
      || semanticPriority(a) - semanticPriority(b)
      || compare(a.semanticKey ?? a.id, b.semanticKey ?? b.id) || compare(a.id, b.id));
  if (!ordered.length) return { text: '', status: 'empty', sourceIds: [], pointerIds: [] };
  const fullText = stableText === undefined
    ? ordered.map(entry => `${LABELS[entry.kind]}：${sanitizeSelfCardText(entry.claim.trim())}`).join('\n')
    : sanitizeSelfCardText(stableText);
  if (typeof fullText !== 'string' || !fullText.trim()) throw new TypeError('stableText must be non-empty');
  if (fullText.length <= maxChars) {
    return { text: fullText, status: 'complete', sourceIds: unique(ordered.map(entry => entry.id)), pointerIds: [] };
  }

  // At most one excerpt per kind, with identity/address first. These slots are
  // reserved before adding pointers, including when those two IDs are very long.
  const seenKinds = new Set();
  const selected = ordered.filter(entry => {
    if (seenKinds.has(entry.kind)) return false;
    seenKinds.add(entry.kind);
    return true;
  }).slice(0, 3);
  const prefix = entry => `· ${LABELS[entry.kind]}：`;
  // Reserve up to a quarter of the card for each primary fact before adding
  // pointers. Long source IDs must not reduce identity/address to their titles.
  const primaryChars = Math.min(140, Math.max(24, Math.floor(maxChars / 4)));
  const lines = selected.map(entry => prefix(entry) + excerpt(sanitizeSelfCardText(entry.claim),
    ['identity', 'address'].includes(entry.kind) ? primaryChars : 24));
  const render = ids => [SUMMARY_HEADER, ...lines, ...(ids.length ? [`原文 ID：${jsonSelfIds(ids)}`] : [])].join('\n');
  const pointerIds = [];
  for (const id of unique([...selected, ...ordered].map(entry => entry.id))) {
    if (pointerIds.length >= 6) break;
    if (render([...pointerIds, id]).length <= maxChars) pointerIds.push(id);
  }
  // Spend remaining space on facts in priority order. No final hard truncation:
  // the header, each excerpt and each whole pointer are accounted for separately.
  for (const [index, entry] of selected.entries()) {
    const withoutLine = render(pointerIds).length - lines[index].length;
    const available = Math.min(140, maxChars - withoutLine - prefix(entry).length);
    lines[index] = prefix(entry) + excerpt(sanitizeSelfCardText(entry.claim), available);
  }
  const text = render(pointerIds);
  if (text.length > maxChars) throw new RangeError('self card exceeds its bounded view budget');
  return { text, status: 'summary', sourceIds: unique([...selected.map(entry => entry.id), ...pointerIds]), pointerIds };
}

/** Derive only the framed card view from an already validated source projection.
 * stableText/stableHash/schema/policy/source fields retain their canonical meaning.
 */
export function deriveSelfCardProjection(projection, { maxChars = SELF_CARD_MAX_CHARS } = {}) {
  checkBudget(maxChars);
  if (!projection || !['ok', 'degraded'].includes(projection.status)
    || typeof projection.stableText !== 'string' || !projection.stableText.trim()
    || typeof projection.schemaVersion !== 'string' || typeof projection.policyVersion !== 'string'
    || !Array.isArray(projection.entries) || !Array.isArray(projection.selectedStableIds)) {
    throw new TypeError('projection must be a deliverable validated self projection');
  }
  const stableIds = new Set(projection.selectedStableIds);
  const stableEntries = projection.entries.filter(entry => stableIds.has(entry.id));
  if (!stableEntries.length || ['identity', 'address'].some(kind => !stableEntries.some(entry => entry.kind === kind && !entry.conflict && !entry.approvalFail))) {
    throw new TypeError('selected stable entries must include identity and address');
  }
  const card = renderBoundedSelfCard(stableEntries, { maxChars, stableText: projection.stableText });
  if (!card.text) throw new TypeError('projection produced an empty self card');
  return {
    ...projection,
    cardText: card.text,
    cardHash: sha(`${projection.schemaVersion}|${projection.policyVersion}|${card.text}`),
    cardStatus: card.status,
    selectedCardIds: card.sourceIds,
    cardPointerIds: card.pointerIds,
    cardViewPolicy: { version: SELF_CARD_POLICY, maxChars, budgetUnit: 'utf16-code-units' },
  };
}
