// Outcome credit side log: append-only, no scoring changes, no automatic verdicts.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { withFileLock } from './lib.mjs';

export const OUTCOME_VERDICTS = Object.freeze(['success', 'partial', 'failure', 'unknown']);
const VERDICT_ALIASES = new Map([
  ['成功', 'success'], ['部分', 'partial'], ['失败', 'failure'], ['未判定', 'unknown'],
]);
const SOURCES = new Set(['用户验收', '用户纠正', '复审', '机检', '未判定']);

export function normalizeVerdict(value) {
  const raw = String(value ?? 'unknown').trim();
  const mapped = VERDICT_ALIASES.get(raw) ?? raw;
  if (!OUTCOME_VERDICTS.includes(mapped)) throw new TypeError('verdict 必须是 success/partial/failure/unknown');
  return mapped;
}

export function makeOutcome({ ids, verdict = 'unknown', source = '未判定', session = null, turn = null, injected = [], note = null, now = new Date() } = {}) {
  const cleanIds = [...new Set((Array.isArray(ids) ? ids : []).map((id) => String(id).trim()).filter(Boolean))];
  if (!cleanIds.length) throw new TypeError('outcome 需要至少一个 id');
  const v = normalizeVerdict(verdict);
  const s = String(source ?? '未判定');
  if (!SOURCES.has(s)) throw new TypeError('source 必须是 用户验收/用户纠正/复审/机检/未判定');
  return {
    ts: new Date(now).toISOString(),
    ids: cleanIds,
    injected: [...new Set((Array.isArray(injected) ? injected : []).map((id) => String(id).trim()).filter(Boolean))],
    verdict: v,
    source: s,
    session: session == null ? null : String(session),
    turn: Number.isFinite(Number(turn)) ? Number(turn) : null,
    ...(note ? { note: String(note).slice(0, 240) } : {}),
  };
}

export function appendOutcome(file, input = {}) {
  const rec = makeOutcome(input);
  mkdirSync(dirname(file), { recursive: true });
  withFileLock(file, () => appendFileSync(file, JSON.stringify(rec) + '\n', 'utf8'));
  return rec;
}

export function readOutcomes(file) {
  if (!existsSync(file)) return [];
  const out = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const text = line.trim();
    if (!text) continue;
    try { out.push(JSON.parse(text)); } catch { /* keep reading */ }
  }
  return out;
}

export function summarizeOutcomes(records, { since = null } = {}) {
  const byId = new Map();
  let total = 0;
  for (const rec of records ?? []) {
    if (!rec || !Array.isArray(rec.ids)) continue;
    if (since && String(rec.ts ?? '').slice(0, 10) < String(since).slice(0, 10)) continue;
    total += 1;
    for (const id of rec.ids) {
      const row = byId.get(id) ?? { id, success: 0, partial: 0, failure: 0, unknown: 0, total: 0, sources: [] };
      const verdict = OUTCOME_VERDICTS.includes(rec.verdict) ? rec.verdict : 'unknown';
      row[verdict] += 1;
      row.total += 1;
      if (rec.source && !row.sources.includes(rec.source)) row.sources.push(rec.source);
      byId.set(id, row);
    }
  }
  const rows = [...byId.values()].sort((a, b) => (b.failure - a.failure) || (b.total - a.total) || a.id.localeCompare(b.id));
  return {
    total,
    ids: rows.length,
    good: rows.reduce((n, r) => n + r.success, 0),
    bad: rows.reduce((n, r) => n + r.failure, 0),
    partial: rows.reduce((n, r) => n + r.partial, 0),
    unknown: rows.reduce((n, r) => n + r.unknown, 0),
    rows,
  };
}
