// M4 · blind review packet builder. Pure; the candidate side comes from CSPRNG.
import { createHash, randomInt } from 'node:crypto';

export const REVIEW_PACKET_SCHEMA = 'akasha-m3-review-packet/v1';
const project = (hits) => hits.map((hit) => ({ id: String(hit.id), snippet: String(hit.snippet ?? '') }));
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Stable row identity: ordered baseline/candidate IDs, not just a set. */
export function reviewRowDigest(row) {
  return digest({
    query: String(row?.query ?? ''),
    baseline: (row?.baseline || []).map((item) => [String(item.id), String(item.snippet ?? '')]),
    candidate: (row?.candidate || []).map((item) => [String(item.id), String(item.snippet ?? '')]),
  });
}

/** Digest over the public packet; reviewer signs this exact artifact. */
export function reviewPacketDigest(packet) {
  return digest({ schemaVersion: packet?.schemaVersion, packets: packet?.packets });
}

/** rows: {query, baseline:[{id,snippet}], candidate:[{id,snippet}], visibleOrderChanged}. */
export function buildBlindPackets(rows, { limit = 20 } = {}) {
  if (!Array.isArray(rows)) throw new TypeError('rows 必须是数组');
  if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('limit 必须是正整数');
  const selected = rows.filter((row) => row.visibleOrderChanged === true && Array.isArray(row.baseline) && Array.isArray(row.candidate) && row.baseline.length && row.candidate.length);
  const packets = []; const key = [];
  for (const [index, row] of selected.slice(0, limit).entries()) {
    const id = `pair-${String(index + 1).padStart(3, '0')}`;
    const candidateSide = randomInt(2) === 0 ? 'left' : 'right';
    const baseline = project(row.baseline);
    const candidate = project(row.candidate);
    const left = candidateSide === 'left' ? candidate : baseline;
    const right = candidateSide === 'right' ? candidate : baseline;
    const rowDigest = reviewRowDigest(row);
    packets.push({ id, rowDigest, query: String(row.query), left, right });
    key.push({ id, rowDigest, query: String(row.query), candidateSide });
  }
  return { schemaVersion: REVIEW_PACKET_SCHEMA, packets, key };
}

/** Packet and key must be distinct under the current platform's path semantics. */
export function assertDistinctTargets(packetPath, keyPath) {
  if (typeof packetPath !== 'string' || typeof keyPath !== 'string' || !packetPath || !keyPath) throw new TypeError('packet/key 路径必须非空');
  const same = process.platform === 'win32'
    ? packetPath.toLowerCase() === keyPath.toLowerCase()
    : packetPath === keyPath;
  if (same) throw new Error('packet 与 key 不能是同一目标');
}
