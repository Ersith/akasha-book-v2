// M2 · evidence summary index (derived, rebuildable, never truth).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { LOGS_DIR, storePath, writeFileAtomic } from './lib.mjs';
import { canonicalJson, reduceEvidence } from './forgetting.mjs';

export const EVIDENCE_INDEX_SCHEMA = 'akasha-evidence-index/v4';
export const EVIDENCE_INDEX = join(LOGS_DIR, 'evidence-summary.json');

function generationOfBuffer(buf) {
  return { size: buf.length, sha256: 'sha256:' + createHash('sha256').update(buf).digest('hex') };
}

function parseBuffer(buf, file) {
  const text = buf.toString('utf8');
  if (!text) return [];
  return text.split('\n').filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); }
    catch { throw new Error(`证据日志第 ${index + 1} 行不是合法 JSON`); }
  });
}

/** One filesystem read: bytes, generation and parsed records come from the same snapshot. */
export function snapshotEvidence(file) {
  const buf = existsSync(file) ? readFileSync(file) : Buffer.alloc(0);
  return { file, buf, generation: generationOfBuffer(buf), events: parseBuffer(buf, file) };
}

function groupIdentity(event) {
  return JSON.stringify([event.target.store, event.target.id, event.target.versionId, event.target.digest, event.contextRef]);
}

function groupFromIdentity(key) {
  const [store, id, versionId, digest, contextRef] = JSON.parse(key);
  return { target: { store, id, versionId, digest }, contextRef };
}

function summaryForSnapshot(snap, { target, contextRef, now, cutoff }) {
  // M1 sees the whole snapshot, including cross-scope duplicate IDs and as-of filtering.
  return reduceEvidence(snap.events, { target, contextRef, now, cutoff });
}

function validateClock(now, cutoff) {
  const target = { store: 'canon', id: '__index_clock__', versionId: '__index_clock__', digest: 'sha256:' + '0'.repeat(64) };
  reduceEvidence([], { target, contextRef: '__index_clock__', now, cutoff });
}

function buildFromSnapshot(snap, now, cutoff) {
  validateClock(now, cutoff);
  const groups = new Map();
  for (const event of snap.events) {
    const key = groupIdentity(event);
    if (!groups.has(key)) groups.set(key, groupFromIdentity(key));
  }
  const out = [...groups.entries()].map(([key, scope]) => {
    const summary = summaryForSnapshot(snap, { ...scope, now, cutoff });
    return { key, ...scope, blocked: summary.coverage === 'conflicted', summary };
  });
  return {
    schemaVersion: EVIDENCE_INDEX_SCHEMA,
    builtAt: new Date().toISOString(),
    clock: { now, cutoff },
    source: { file: snap.file, generation: snap.generation, eventCount: snap.events.length },
    globalConflicts: out.filter((group) => group.blocked).flatMap((group) => group.summary.conflicts),
    groups: out,
  };
}

export function buildEvidenceIndex({ file, now, cutoff, snap = null } = {}) {
  return buildFromSnapshot(snap || snapshotEvidence(file), now, cutoff);
}

export function readEvidenceIndex(indexFile = EVIDENCE_INDEX) {
  if (!existsSync(indexFile)) return null;
  const index = JSON.parse(readFileSync(indexFile, 'utf8'));
  if (!index || index.schemaVersion !== EVIDENCE_INDEX_SCHEMA || !Array.isArray(index.groups)) return null;
  return index;
}

/** Reuse only an unchanged cache; any append rebuilds all groups because M1 diagnostics are global. */
export function updateEvidenceIndex({ file, indexFile = EVIDENCE_INDEX, now, cutoff, snap = null } = {}) {
  const current = snap || snapshotEvidence(file);
  const old = readEvidenceIndex(indexFile);
  if (old && old.clock && old.clock.now === now && old.clock.cutoff === cutoff
      && old.source && canonicalJson(old.source.generation) === canonicalJson(current.generation)
      && old.source.eventCount === current.events.length) {
    return { ...old, incremental: true };
  }
  const index = { ...buildFromSnapshot(current, now, cutoff), incremental: false };
  writeFileAtomic(indexFile, JSON.stringify(index, null, 2) + '\n');
  return index;
}

/** Verify an index still describes the current log bytes and clock. */
export function verifyEvidenceIndex(index, { file, now, cutoff, snap = null } = {}) {
  if (!index || index.schemaVersion !== EVIDENCE_INDEX_SCHEMA) return { ok: false, reason: 'schema' };
  if (!index.clock || index.clock.now !== now || index.clock.cutoff !== cutoff) return { ok: false, reason: 'clock' };
  const current = snap || snapshotEvidence(file);
  if (canonicalJson(current.generation) !== canonicalJson(index.source.generation)) return { ok: false, reason: 'stale' };
  if (index.groups.some((group) => group.blocked)) return { ok: false, reason: 'conflict' };
  return { ok: true };
}

function physical(file) {
  try { return realpathSync.native(file); }
  catch { try { return join(realpathSync.native(dirname(file)), basename(file)); } catch { return resolve(file); } }
}

function sameFile(a, b) {
  if (physical(a).toLowerCase() === physical(b).toLowerCase()) return true;
  try { const sa = statSync(a), sb = statSync(b); return sa.dev === sb.dev && sa.ino === sb.ino; }
  catch { return false; }
}

/** Reject report paths that would overwrite the evidence log, the index, or a six-store file. */
export function assertSafeReportPath(file, { evidenceFile, indexFile = EVIDENCE_INDEX, additionalPaths = [] } = {}) {
  if (typeof file !== 'string' || !file.trim()) throw new Error('--report 必须是非空文件路径');
  const guarded = [evidenceFile, indexFile,
    ...['canon', 'mirror', 'orphan', 'pricing', 'lexicon', 'frontier'].map((store) => storePath(store)),
    ...additionalPaths];
  for (const target of guarded) if (target && sameFile(file, target)) throw new Error(`拒绝把报告写到受保护文件：${target}`);
  return file;
}

export { summaryForSnapshot };
