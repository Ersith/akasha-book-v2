// M4 · evidence-backed canary readiness. Read-only; never starts traffic.
import { evaluateCanaryReadiness } from './m3-canary-readiness.mjs';
import { reviewRowDigest, reviewPacketDigest } from './m3-review-packet.mjs';

export const READINESS_SCHEMA = 'akasha-m4-readiness/v1';
const content = (items) => (Array.isArray(items) ? items.map((item) => [String(item.id), String(item.snippet ?? '')]) : []);
const sameOrdered = (left, right) => left.length === right.length && left.every((item, index) => item[0] === right[index][0] && item[1] === right[index][1]);
const sameStrings = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
const attestation = (value) => value?.verified === true && typeof value.artifact === 'string' && value.artifact.trim().length > 0;

/** Derive counts from real artifacts, then apply the pure readiness gate. */
export function assessCanaryReadiness({
  report, packet = null, key = null, humanReview = null,
  stopSwitch = false, budgetRoot = false, journal = false,
  expectedEligibilityMode = null, expectedIntentMode = null,
} = {}) {
  const rows = Array.isArray(report?.rows) ? report.rows : [];
  const eligibleRows = rows.filter((row) => row.eligible === true);
  const orderRows = rows.filter((row) => row.visibleOrderChanged === true);
  const eligibleOrderRows = orderRows.filter((row) => row.eligible === true);
  const packets = Array.isArray(packet?.packets) ? packet.packets : [];
  const keyRows = Array.isArray(key) ? key : [];
  const reasons = [];

  if (report?.schemaVersion !== 'akasha-m3-bench/v1') reasons.push('report-schema-mismatch');
  if (report?.storeScope !== 'canon') reasons.push('report-store-scope-not-canon');
  if (!expectedEligibilityMode) reasons.push('expected-eligibility-mode-missing');
  else if (report?.eligibilityMode !== expectedEligibilityMode) reasons.push('report-eligibility-mode-mismatch');
  if (!expectedIntentMode) reasons.push('expected-intent-mode-missing');
  else if (report?.intentMode !== expectedIntentMode) reasons.push('report-intent-mode-mismatch');
  if (new Set(orderRows.map((row) => row.query)).size !== orderRows.length) reasons.push('duplicate-order-row-query');
  if (orderRows.some((row) => row.dataView?.valid !== true || row.dataView?.consistent !== true)) reasons.push('order-row-data-view-invalid');

  if (packets.length !== orderRows.length) reasons.push('blind-packets-do-not-match-order-rows');
  if (keyRows.length !== packets.length) reasons.push('blind-key-does-not-match-packets');
  if (new Set(packets.map((item) => item.id)).size !== packets.length) reasons.push('blind-packet-duplicate-id');
  if (new Set(keyRows.map((item) => item.id)).size !== keyRows.length) reasons.push('blind-key-duplicate-id');
  if (new Set(packets.map((item) => item.query)).size !== packets.length) reasons.push('blind-packet-duplicate-query');
  if (new Set(keyRows.map((item) => item.query)).size !== keyRows.length) reasons.push('blind-key-duplicate-query');

  const rowByQuery = new Map(orderRows.map((row) => [row.query, row]));
  const keyById = new Map(keyRows.map((item) => [item.id, item]));
  for (const item of packets) {
    const row = rowByQuery.get(item.query);
    if (!row) { reasons.push('blind-packet-query-not-in-report'); break; }
    if (item.rowDigest !== reviewRowDigest(row)) reasons.push('blind-packet-row-digest-mismatch');
    const keyRow = keyById.get(item.id);
    if (!keyRow) { reasons.push('blind-key-id-not-in-packet'); break; }
    if (keyRow.rowDigest !== item.rowDigest) reasons.push('blind-key-row-digest-mismatch');
    if (!['left', 'right'].includes(keyRow.candidateSide)) { reasons.push('blind-key-side-invalid'); break; }
    const expectedLeft = keyRow.candidateSide === 'left' ? content(row.candidate) : content(row.baseline);
    const expectedRight = keyRow.candidateSide === 'right' ? content(row.candidate) : content(row.baseline);
    if (!sameOrdered(content(item.left), expectedLeft) || !sameOrdered(content(item.right), expectedRight)) reasons.push('blind-packet-content-mismatch');
  }
  if (keyRows.some((item) => !packets.some((packetRow) => packetRow.id === item.id))) reasons.push('blind-key-id-not-in-packet');

  if (humanReview?.verdict === 'pass') {
    if (!sameStrings([...(humanReview.packetIds || [])].sort(), packets.map((item) => item.id).sort())) reasons.push('human-review-does-not-cover-packets');
    if (humanReview.packetDigest !== reviewPacketDigest(packet)) reasons.push('human-review-packet-digest-mismatch');
    if (typeof humanReview.reviewer !== 'string' || !humanReview.reviewer.trim()) reasons.push('human-reviewer-missing');
  }

  const gate = evaluateCanaryReadiness({
    samples: rows.length,
    orderChanged: eligibleOrderRows.length,
    humanReview,
    stopSwitch: attestation(stopSwitch),
    budgetRoot: attestation(budgetRoot),
    journal: attestation(journal),
  });
  reasons.push(...gate.reasons);
  return {
    schemaVersion: READINESS_SCHEMA,
    ready: reasons.length === 0,
    reasons: [...new Set(reasons)],
    metrics: {
      samples: rows.length,
      eligible: eligibleRows.length,
      orderChanged: orderRows.length,
      visibleOrderChanged: orderRows.length,
      eligibleOrderChanged: eligibleOrderRows.length,
      packets: packets.length,
      keys: keyRows.length,
    },
    attestations: {
      stopSwitch: attestation(stopSwitch), budgetRoot: attestation(budgetRoot), journal: attestation(journal),
      humanReview: humanReview?.verdict === 'pass' ? 'pass' : (humanReview?.verdict ?? null),
    },
  };
}
