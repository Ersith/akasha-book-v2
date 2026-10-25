// Session index compaction. Dedupe by id, keep the last occurrence, preserve order.
export const SESSION_COMPACT_SCHEMA = 'akasha-session-compact/v1';

export function planSessionCompaction(records) {
  if (!Array.isArray(records)) throw new TypeError('records 必须是数组');
  const last = new Map();
  for (let i = 0; i < records.length; i += 1) {
    const id = records[i]?.id;
    if (typeof id === 'string' && id) last.set(id, i);
  }
  const kept = [];
  let removed = 0;
  const duplicateIds = new Set();
  for (let i = 0; i < records.length; i += 1) {
    const id = records[i]?.id;
    if (typeof id === 'string' && id) {
      if (last.get(id) !== i) { removed += 1; duplicateIds.add(id); continue; }
    }
    kept.push(records[i]);
  }
  return {
    schemaVersion: SESSION_COMPACT_SCHEMA,
    before: records.length,
    after: kept.length,
    removed,
    duplicateIds: duplicateIds.size,
    records: kept,
  };
}
