// tools/prevability-export.mjs —— 可预防性测试·第 1 步：取证 + 基准库快照（只读；输出到 _scratch/prevability/）
// 采纳 Claude 评审要点：① 库时序防泄漏（只许用失败时刻之前已存在的条目）② 基准快照钉死复现 ③ 会话簇标注
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { isRecallRecord, sessionKeyOf } from './lib.mjs';

const ROOT = '<AKASHA_DIR>';
const OUT = '<LOCAL_PATH>\\_scratch\\prevability';
const LOG = join(ROOT, 'logs', 'hooks.jsonl');
mkdirSync(OUT, { recursive: true });

// ---- 1) 失败窗口（与 metrics 同口径）----
const recs = [];
for (const line of readFileSync(LOG, 'utf8').split(/\r?\n/)) { if (!line.trim()) continue; try { recs.push(JSON.parse(line)); } catch { /* 坏行 */ } }
const wins = new Map();
const cases = [];
const win = (k) => { let w = wins.get(k); if (!w) { w = { recalled: false, failed: null, late: false }; wins.set(k, w); } return w; };
const close = (k) => {
  const w = wins.get(k); wins.delete(k);
  if (!w?.failed) return;
  cases.push({ ...w.failed, recalled: w.recalled, late: w.late, session_key: k });
};
for (const rec of recs) {
  if (!rec || typeof rec !== 'object') continue;
  const k = sessionKeyOf(rec);
  if (rec.kind === 'turn-end') { close(k); if (k !== '*') close('*'); continue; }
  if (rec.kind !== 'tool' && rec.kind !== 'agent-error') continue;
  if (isRecallRecord(rec)) {
    const w = win(k); if (w.failed) w.late = true; else w.recalled = true;
    if (k === '*') for (const [kk, ww] of wins) if (kk !== '*' && !ww.failed) ww.recalled = true;
    continue;
  }
  const guardDenied = /门控|gate-denied/.test(String(rec.message ?? ''));
  const isFail = (rec.kind === 'tool' && rec.ok === false && !guardDenied && !String(rec.tool ?? '').startsWith('mcp__akasha__')) || rec.kind === 'agent-error';
  if (!isFail) continue;
  const w = win(k); if (w.failed) continue;
  if (!w.recalled && k !== '*' && wins.get('*')?.recalled) w.recalled = true;
  w.failed = {
    ts: rec.ts ?? null,
    tool: rec.kind === 'agent-error' ? 'agent-error' : String(rec.tool ?? '?'),
    message: typeof rec.message === 'string' ? rec.message.slice(0, 200) : null,
    session: k === '*' ? null : k,
    // 触发标记：是否经 shell 调 akasha CLI / 是否被门控拦（这些不是"任务失败"，此处仅留痕）
    akashaCli: rec.akashaCli ?? null,
  };
}
for (const k of [...wins.keys()]) close(k);

// ---- 2) 会话簇标注（Claude 补充 ②：同一会话多失败要标簇，别当独立样本）----
const bySession = new Map();
for (const c of cases) { const s = c.session ?? '*'; bySession.set(s, (bySession.get(s) ?? 0) + 1); }
cases.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
let seq = 0;
const lines = cases.map((c) => {
  seq += 1;
  const clusterSize = bySession.get(c.session ?? '*') ?? 1;
  return JSON.stringify({
    case_id: 'C' + String(seq).padStart(3, '0'),
    date: String(c.ts ?? '').slice(0, 10),
    ts: c.ts, tool: c.tool, message: c.message, session: c.session,
    recalledBefore: c.recalled, lateRecall: c.late,
    cluster_size: clusterSize,                       // >1 表示同会话有多次失败（非独立样本）
    as_of: String(c.ts ?? '').slice(0, 10),          // 该 case 的"库版本日"
  });
}).join('\n') + '\n';
writeFileSync(join(OUT, 'cases.jsonl'), lines, 'utf8');
const casesSha = createHash('sha256').update(lines).digest('hex');
writeFileSync(join(OUT, 'cases.sha256'), casesSha + '\n', 'utf8');

// ---- 3) 基准库快照（Claude 补充 ④：失败日允许存在的条目集 + 哈希；防未来条目泄漏）----
const idSetAt = (storeFile, asOf) => {
  const ids = [];
  for (const line of readFileSync(storeFile, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    const stamp = String(r.logged_at ?? r.event_time ?? '').slice(0, 10);
    if (stamp && stamp <= asOf) ids.push(String(r.id));
  }
  return ids;
};
const snap = { generatedAt: new Date().toISOString(), casesSha256: casesSha, perDate: {} };
for (const d of [...new Set(cases.map((c) => String(c.ts ?? '').slice(0, 10)))].sort()) {
  const canon = idSetAt(join(ROOT, 'data', 'canon.jsonl'), d);
  const orphan = idSetAt(join(ROOT, 'data', 'orphan.jsonl'), d);
  snap.perDate[d] = {
    canonIds: canon.length, orphanIds: orphan.length,
    canonHash: createHash('sha256').update(canon.join('\n')).digest('hex').slice(0, 16),
    orphanHash: createHash('sha256').update(orphan.join('\n')).digest('hex').slice(0, 16),
  };
}
writeFileSync(join(OUT, 'library-snapshot.json'), JSON.stringify(snap, null, 1), 'utf8');

console.log('  cases: ' + cases.length + '（sha256 ' + casesSha.slice(0, 12) + '）→ ' + OUT + '\\cases.jsonl');
console.log('  会话簇：' + [...bySession.entries()].filter(([, n]) => n > 1).length + ' 个会话含多次失败（最大簇 ' + Math.max(...bySession.values()) + '）');
console.log('  基准快照（按日）：');
for (const [d, v] of Object.entries(snap.perDate)) console.log('    ' + d + '  canon ' + String(v.canonIds).padStart(3) + ' 条(' + v.canonHash + ')  orphan ' + String(v.orphanIds).padStart(2) + ' 条(' + v.orphanHash + ')');
