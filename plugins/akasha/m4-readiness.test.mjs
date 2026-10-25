import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCanaryReadiness } from './m4-readiness.mjs';
import { buildBlindPackets, reviewPacketDigest } from './m3-review-packet.mjs';

const rows = Array.from({ length: 20 }, (_, i) => ({
  id: i,
  eligible: i < 5,
  orderChanged: i < 5,
  visibleOrderChanged: i < 5,
  query: `q-${i}`,
  baseline: [{ id: `b-${i}`, snippet: 'b' }, { id: `b2-${i}`, snippet: 'b2' }],
  candidate: [{ id: `c-${i}`, snippet: 'c' }, { id: `c2-${i}`, snippet: 'c2' }],
  dataView: { valid: true, consistent: true },
}));
const packet = buildBlindPackets(rows, { limit: 5 });
const key = packet.key;
const report = { schemaVersion: 'akasha-m3-bench/v1', storeScope: 'canon', eligibilityMode: 'mixed', intentMode: 'recent', rows };
const humanReview = { verdict: 'pass', reviewer: 'test', packetIds: packet.packets.map((row) => row.id), packetDigest: reviewPacketDigest(packet) };
const base = {
  report, packet, key, humanReview,
  stopSwitch: { verified: true, artifact: 'stop-test' },
  budgetRoot: { verified: true, artifact: 'budget-state' },
  journal: { verified: true, artifact: 'journal-count' },
  expectedEligibilityMode: 'mixed', expectedIntentMode: 'recent',
};

test('readiness requires row digest, ordered side content, and packet digest', () => {
  const pass = assessCanaryReadiness(base);
  assert.equal(pass.ready, true);
  assert.deepEqual(pass.metrics, { samples: 20, eligible: 5, orderChanged: 5, visibleOrderChanged: 5, eligibleOrderChanged: 5, packets: 5, keys: 5 });
  const badKey = assessCanaryReadiness({ ...base, key: key.map((row, i) => ({ ...row, id: `unrelated-${i}` })) });
  assert.equal(badKey.ready, false);
  assert.ok(badKey.reasons.includes('blind-key-id-not-in-packet'));
  const badContent = structuredClone(packet);
  badContent.packets[0].left[0].id = 'x';
  const bad = assessCanaryReadiness({ ...base, packet: badContent, key: key.map((row, i) => i === 0 ? { ...row, id: badContent.packets[0].id } : row) });
  assert.equal(bad.ready, false);
  assert.ok(bad.reasons.includes('blind-packet-content-mismatch'));
  const tamperedSnippet = structuredClone(packet);
  tamperedSnippet.packets[0].left[0].snippet = 'UNRELATED REVIEW TEXT';
  const snippetReview = { ...humanReview, packetDigest: reviewPacketDigest(tamperedSnippet) };
  const snippetBad = assessCanaryReadiness({ ...base, packet: tamperedSnippet, humanReview: snippetReview });
  assert.equal(snippetBad.ready, false);
  assert.ok(snippetBad.reasons.includes('blind-packet-content-mismatch'));
});

test('readiness requires human review artifact digest and full coverage', () => {
  const uncovered = assessCanaryReadiness({ ...base, humanReview: { ...humanReview, packetIds: ['pair-001'] } });
  assert.equal(uncovered.ready, false);
  assert.ok(uncovered.reasons.includes('human-review-does-not-cover-packets'));
  const badDigest = assessCanaryReadiness({ ...base, humanReview: { ...humanReview, packetDigest: 'x' } });
  assert.equal(badDigest.ready, false);
  assert.ok(badDigest.reasons.includes('human-review-packet-digest-mismatch'));
});

test('readiness fails mode/scope mismatch and missing attestation artifact', () => {
  assert.equal(assessCanaryReadiness({ ...base, expectedEligibilityMode: 'strict' }).ready, false);
  assert.equal(assessCanaryReadiness({ ...base, report: { ...report, storeScope: 'mirror' } }).ready, false);
  assert.equal(assessCanaryReadiness({ ...base, stopSwitch: { verified: true } }).ready, false);
});

test('readiness fails when eligible order samples are below gate', () => {
  const low = assessCanaryReadiness({ ...base, report: { ...report, rows: rows.map((row) => ({ ...row, eligible: false })) } });
  assert.equal(low.ready, false);
  assert.ok(low.reasons.includes('order-changed-below-5'));
});
