// tools/recall-timeline.mjs —— 漏召率的时间分布（复用 lib 的窗口逻辑；只读）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isRecallRecord, sessionKeyOf, RECALL_TOOLS, RECALL_CLI } from './lib.mjs';

const LOG = process.argv[2] ?? '<AKASHA_DIR>\\logs\\hooks.jsonl';
const raw = readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean);
const recs = [];
for (const line of raw) { try { recs.push(JSON.parse(line)); } catch { /* 坏行跳过 */ } }

const wins = new Map();
const fails = [];
const win = (k) => { let w = wins.get(k); if (!w) { w = { recalled: false, failed: null, late: false }; wins.set(k, w); } return w; };
const close = (k) => {
  const w = wins.get(k);
  wins.delete(k);
  if (w?.failed) fails.push({ ...w.failed, recalled: w.recalled, late: w.late });
};
for (const rec of recs) {
  if (!rec || typeof rec !== 'object') continue;
  const k = sessionKeyOf(rec);
  if (rec.kind === 'turn-end') { close(k); if (k !== '*') close('*'); continue; }
  if (rec.kind !== 'tool' && rec.kind !== 'agent-error') continue;
  if (isRecallRecord(rec)) {
    const w = win(k);
    if (w.failed) w.late = true; else w.recalled = true;
    if (k === '*') for (const [kk, ww] of wins) if (kk !== '*' && !ww.failed) ww.recalled = true;
    continue;
  }
  const isFail = (rec.kind === 'tool' && rec.ok === false && !String(rec.tool ?? '').startsWith('mcp__akasha__')) || rec.kind === 'agent-error';
  if (!isFail) continue;
  const w = win(k);
  if (w.failed) continue;
  if (!w.recalled && k !== '*' && wins.get('*')?.recalled) w.recalled = true;
  w.failed = { ts: rec.ts ?? null, tool: rec.kind === 'agent-error' ? 'agent-error' : String(rec.tool ?? '?') };
}
for (const k of [...wins.keys()]) close(k);

// 汇总
const day = (ts) => String(ts ?? '').slice(0, 10);
const byDay = new Map();
for (const f of fails) {
  const d = day(f.ts);
  const b = byDay.get(d) ?? { n: 0, miss: 0, late: 0, tools: new Map() };
  b.n += 1;
  if (!f.recalled) { b.miss += 1; if (f.late) b.late += 1; }
  b.tools.set(f.tool, (b.tools.get(f.tool) ?? 0) + 1);
  byDay.set(d, b);
}
console.log('=== 漏召率时间分布（按天；窗口口径同 metrics）===');
console.log('  日期        失败  未查库  漏召率   事后查  工具 top3');
for (const [d, b] of [...byDay.entries()].sort()) {
  const rate = b.n ? (b.miss / b.n * 100).toFixed(0) + '%' : '—';
  const top = [...b.tools.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3).map(([t, n]) => t + '×' + n).join(' ');
  console.log('  ' + d.padEnd(12) + String(b.n).padStart(4) + String(b.miss).padStart(7) + '  ' + rate.padStart(6) + String(b.late).padStart(7) + '   ' + top);
}
const all = fails.length; const allMiss = fails.filter((f) => !f.recalled).length;
console.log('  合计：失败 ' + all + ' / 未查库 ' + allMiss + '（' + (all ? (allMiss / all * 100).toFixed(1) : '0') + '%）');
console.log('');
console.log('=== 近三日按小时（看是"均匀"还是"某段抬升"）===');
const byHour = new Map();
for (const f of fails) {
  const h = String(f.ts ?? '').slice(0, 13);
  const b = byHour.get(h) ?? { n: 0, miss: 0 };
  b.n += 1; if (!f.recalled) b.miss += 1;
  byHour.set(h, b);
}
for (const [h, b] of [...byHour.entries()].sort().slice(-28)) {
  console.log('  ' + h + 'Z  失败 ' + String(b.n).padStart(2) + '  未查 ' + String(b.miss).padStart(2));
}
