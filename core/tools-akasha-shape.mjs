#!/usr/bin/env node
// 库形态普查（2026-10-15；来源＝B 臂 W3「每臂都要重算 8 条真库形态统计」的固定税）
// 用途：一条命令给出**机械事实**（计数 / 体量 / 哈希 / id 形态分布 / 内容重复 / 活写面探测），
//       供门档各臂直接引用，不再各自重算。**只读**：不改任何库文件。
// 用法：node tools/akasha-shape.mjs [--json] [--live-wait MS]
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentKeyOf } from './tools-session-key.mjs';

const TOOLS = dirname(fileURLToPath(import.meta.url));
const AK = join(TOOLS, '..');
const DATA = process.env.AKASHA_ROOT ? String(process.env.AKASHA_ROOT) : join(AK, 'data');
const LOGS = process.env.AKASHA_LOGS ? String(process.env.AKASHA_LOGS) : join(AK, 'logs');
const asJson = process.argv.includes('--json');
const liveWait = Number((process.argv.find((a, i) => process.argv[i - 1] === '--live-wait')) ?? 3000);

const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 12);
const sizeMb = (b) => Number((b / 1048576).toFixed(2));
const readLines = (f) => { try { return readFileSync(f, 'utf8').split('\n').filter(Boolean); } catch { return []; } };

// ── 六库 ────────────────────────────────────────────────────────────────────
const STORES = ['canon', 'mirror', 'orphan', 'pricing', 'lexicon', 'frontier'];
const stores = {};
for (const s of STORES) {
  const f = join(DATA, `${s}.jsonl`);
  if (!existsSync(f)) { stores[s] = { missing: true }; continue; }
  const buf = readFileSync(f);
  stores[s] = { bytes: buf.length, mb: sizeMb(buf.length), sha12: sha(buf), lines: buf.toString('utf8').split('\n').filter(Boolean).length };
}

// ── 会话层（派生索引；**活写面**——索引器在回合边界写）────────────────────────
const SESS = join(DATA, 'session.jsonl');
const s1 = existsSync(SESS) ? readFileSync(SESS) : Buffer.from('');
const lines = s1.toString('utf8').split('\n').filter(Boolean);
const rows = [];
let bad = 0;
for (const l of lines) { try { rows.push(JSON.parse(l)); } catch { bad += 1; } }
const byKind = {};
for (const r of rows) byKind[r.kind ?? '?'] = (byKind[r.kind ?? '?'] ?? 0) + 1;
const segs = rows.filter((r) => r.kind !== 'node');
const isNew = (id) => /^seg-.{1,8}-[0-9a-f]{8}-\d+-/.test(String(id ?? ''));
const isFp4 = (id) => /^seg-.{1,8}-[0-9a-f]{4}-\d+-[0-9a-f]{8}$/.test(String(id ?? ''));
const idForms = { newOwner: 0, fp4: 0, legacy: 0 };
for (const r of segs) { if (isNew(r.id)) idForms.newOwner += 1; else if (isFp4(r.id)) idForms.fp4 += 1; else idForms.legacy += 1; }
const norm = (s) => String(s ?? '').replace(/^session-/, '');
// 口径（2026-10-15 修）：**node 行不参与重复统计**——同 id 多代是设计（跨代留档），不是重复。
// 2026-10-15（GPT N4 收尾）：内容键与 `tools/migrate-20261015-compact-session.mjs` **共用同一函数**
// （tools/session-key.mjs）——原先两处各写一套，topic/promotion 上会给出相反结论（本工具首版即踩此坑：
// 报 6588 而紧凑化脚本报 0，差额正是 node 行；第二版对 topic 又相反）。
const ck = (r) => contentKeyOf(r);
const seen = new Map();
for (const r of rows) { if (r.kind === 'node') continue; const k = ck(r); seen.set(k, (seen.get(k) ?? 0) + 1); }
const contentDup = [...seen.values()].filter((n) => n > 1).reduce((a, b) => a + b - 1, 0);
const sessKeys = new Set(rows.map((r) => norm(r.session)));

// 活写面探测（两次取样；会话层被索引器持续写 ⇒ 哈希口径应排除它）
await new Promise((res) => setTimeout(res, liveWait));
const s2 = existsSync(SESS) ? readFileSync(SESS) : Buffer.from('');
const sessionLive = sha(s1) !== sha(s2);

// ── 日志 ────────────────────────────────────────────────────────────────────
const HOOKS = join(LOGS, 'hooks.jsonl');
const hookLines = readLines(HOOKS);
let lastHookTs = null;
if (hookLines.length) { try { lastHookTs = JSON.parse(hookLines[hookLines.length - 1]).ts ?? null; } catch { /* 坏行 */ } }

const out = {
  dataRoot: DATA, logsRoot: LOGS,
  sixStores: stores,
  sixStoresTotalLines: Object.values(stores).reduce((a, s) => a + (s.lines ?? 0), 0),
  session: {
    rows: rows.length, badLines: bad, mb: sizeMb(s1.length), sha12: sha(s1),
    byKind, segments: segs.length, nodes: byKind.node ?? 0,
    idForms, contentDuplicates: contentDup, sessionKeys: sessKeys.size,
    liveWriter: sessionLive, liveWaitMs: liveWait,
  },
  hooks: { lines: hookLines.length, lastTs: lastHookTs, mb: existsSync(HOOKS) ? sizeMb(statSync(HOOKS).size) : 0 },
};

if (asJson) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }
const pad = (s, n) => String(s).padEnd(n);
console.log(`数据根 ${DATA}　日志根 ${LOGS}`);
console.log(`六库：` + STORES.map((s) => `${s} ${stores[s].lines ?? '?'}(${stores[s].mb ?? '?'}MB)`).join(' / '));
console.log(`会话层：${rows.length} 行 / ${sizeMb(s1.length)}MB / 坏行 ${bad}`);
console.log(`  · 类别：` + Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join(' / '));
console.log(`  · 段 id 形态：新方案 ${idForms.newOwner} / fp4 过渡 ${idForms.fp4} / 老形态 ${idForms.legacy}`);
console.log(`  · 内容重复行（跨形态归一后）：${contentDup}　会话键（归一后）：${sessKeys.size}`);
console.log(`  · 活写面：${sessionLive ? '**正在被写**（索引器活跃）⇒ 哈希口径须排除会话层' : `静止（${liveWait}ms 内两次取样一致）`}`);
console.log(`hooks：${hookLines.length} 行 / ${out.hooks.mb}MB　末行 ${lastHookTs ?? '(无)'}`);
