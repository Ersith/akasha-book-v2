// test-chain.mjs —— 「取全 + 验真」四步链条实测（只读）：topics → lookup（翻页到拿全）→ seq 回原档 → 答案比对。
// 目标会话＝推演出阿卡夏之书的那段（f362b992，2026-10-06/07）。两个可判对错的问题：
//   ① 定价函数是什么？ ② 孤案的默认权重与热载通道？
import * as s from './session.mjs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const SID = 'f362b992';
const root = s.SESSION_DEFAULTS.sessionsRoot;
let dir = null;
for (const ws of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())) {
  for (const d of readdirSync(join(root, ws.name)).filter((x) => x.startsWith('session-' + SID))) dir = d;
}
const full = dir.replace(/^session-/, '');
const { text } = s.readSessionArchive(s.resolveSessionFile(root, full));
const rows = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const tok = (n) => Math.round(n * 1.18);

const QUESTIONS = [
  { q: '定价函数是什么？', terms: ['定价'], probe: /严重度|不可逆|代价/ },
  { q: '孤案的默认权重与热载通道？', terms: ['孤案'], probe: /零权重|热载|通道|形状/ },
];

for (const { q, terms, probe } of QUESTIONS) {
  console.log('\n════ 问题：' + q + ' ════');
  // ① topics：这个话题跨几个会话
  for (const t of terms) {
    const cl = s.lookupTopics({ term: t }).concat(s.buildTopics({}).list.filter((c) => c.term.includes(t))).slice(0, 1);
    if (cl.length) console.log('  ① topics: ' + cl[0].term + '×' + cl[0].count + ' · 跨 ' + Object.keys(cl[0].sessions || {}).length + ' 会话 · 事件 ' + (cl[0].firstEvent || '?') + '~' + (cl[0].lastEvent || '?') + ' · 例 ' + (cl[0].entries[0] || '-'));
  }
  // ② lookup：翻页到拿全，记录用量
  let off = 0, pages = 0, got = 0, chars = 0, matched = 0, scope = 0, exhausted = false;
  const best = [];
  for (const t of terms) {
    off = 0; pages = 0; exhausted = false;
    while (pages < 8) {
      const d = s.lookupSegmentsDetailed(t, { session: full, limit: 5, offset: off });
      pages++; matched = d.matched; scope = d.sessionTotal;
      got += d.hits.length; off = d.nextOffset;
      chars += d.hits.reduce((a, h) => a + String(h.gist || '').length, 0);
      for (const h of d.hits) if (probe.test(String(h.gist || ''))) best.push(h);
      exhausted = d.exhausted;
      if (exhausted || d.hits.length === 0) break;
    }
    console.log('  ② lookup「' + t + '」: 命中 ' + matched + ' / 作用域 ' + scope + ' · 取回 ' + got + ' 段 / ' + pages + ' 次 · ' + tok(chars) + ' tok · ' + (exhausted ? '拿全' : '未拿全'));
  }
  // ③ seq 回原档：把含判据关键词的段逐条回溯
  const seen = new Set();
  let shown = 0;
  for (const h of best) {
    if (seen.has(h.seq)) continue;
    seen.add(h.seq);
    const row = rows.find((r) => r.seq === h.seq);
    if (!row) continue;
    const c = Array.isArray(row.data?.content) ? row.data.content.map((x) => x?.text || '').join(' ')
      : String(row.data?.content ?? row.data?.message?.content?.map?.((x) => x?.text || '').join(' ') ?? '');
    const m = probe.exec(c);
    if (!m) continue;
    const i = Math.max(0, m.index - 70);
    console.log('  ③ 原档 seq ' + h.seq + '（turn ' + h.turn + '）：…' + c.slice(i, i + 170).replace(/\s+/g, ' ') + '…');
    if (++shown >= 2) break;
  }
  if (!shown) console.log('  ③ 原档：未回溯到含判据的原文（需换词或加 --actions）');
}
