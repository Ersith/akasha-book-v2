// akasha/tools/degradation-stats.mjs v2 —— 退化评测素材：每会话 轮/压缩/工具/索引/时间 + 本会话聚焦
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const ROOT = process.env.AKASHA_ROOT || '<AKASHA_DIR>';
const logs = process.env.AKASHA_LOGS || join(ROOT, 'logs');
const lines = readFileSync(join(logs, 'hooks.jsonl'), 'utf8').trim().split('\n');
const S = new Map();
const g = (sid) => { const s = String(sid).replace(/^session-/, ''); if (!S.has(s)) S.set(s, { sid: s, turns: 0, maxTurn: 0, compacts: 0, tools: 0, idxSegs: 0, first: null, last: null }); return S.get(s); };
for (const l of lines) {
  let j; try { j = JSON.parse(l); } catch { continue; }
  const sid = j.session || j.agentId || null; if (!sid) continue;
  const r = g(sid);
  if (!r.first || j.ts < r.first) r.first = j.ts;
  if (!r.last || j.ts > r.last) r.last = j.ts;
  if (j.kind === 'turn-end') { r.turns += 1; if (typeof j.turn === 'number' && j.turn > r.maxTurn) r.maxTurn = j.turn; }
  if (j.kind === 'session-compact') r.compacts += 1;
  if (j.kind === 'tool') r.tools += 1;
  if (j.kind === 'session-index') r.idxSegs += Number(j.added || 0);
}
const rows = [...S.values()].filter((r) => r.turns > 0 || r.tools > 0).sort((a, b) => (b.maxTurn + b.turns) - (a.maxTurn + a.turns));
const days = (a, b) => a && b ? ((Date.parse(b) - Date.parse(a)) / 86400000).toFixed(1) : '—';
console.log('会话 ｜ 轮次  maxTurn  压缩  工具  索引段  跨度  窗口');
console.log('─'.repeat(96));
for (const r of rows.slice(0, 16)) console.log([r.sid.slice(0, 12), r.turns, r.maxTurn, r.compacts, r.tools, r.idxSegs, days(r.first, r.last), (r.first || '').slice(5, 10) + '→' + (r.last || '').slice(5, 10)].join('  |  '));
console.log('─'.repeat(96));
console.log('会话总数:', rows.length, '| 压缩事件总:', rows.reduce((n, r) => n + r.compacts, 0), '| 工具总:', rows.reduce((n, r) => n + r.tools, 0), '| 轮总:', rows.reduce((n, r) => n + r.turns, 0));
// 本会话识别：以 hooks 最后一条 preflight/wake 的 session 为准（近 5 分钟内活动最多的）
const recent = rows.filter((r) => r.last && Date.parse(r.last) > Date.now() - 3600e3);
console.log('\n近 1 小时活动会话（=当前/最近会话）:');
for (const r of recent) console.log('  ', r.sid, '| maxTurn', r.maxTurn, '| 压缩', r.compacts, '| 工具', r.tools);
