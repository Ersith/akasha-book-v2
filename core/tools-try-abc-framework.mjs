// try-abc-framework.mjs —— 用新三件套在「推演出阿卡夏之书」的会话上实做一次完整取回（只读）。
// 流程：① 主题簇看全貌 → ② 按主题分页取到"拿全"（每页记调用/字符）→ ③ 抽样做**原文保真对照**（段 gist vs 档案原话）。
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
const tok = (n) => Math.round(n * 1.18);

console.log('══ ① 主题簇（先看全貌） ══');
const cl = s.sessionClusters({ session: full, topN: 18, minCount: 3 });
console.log('  簇数 = ' + cl.length);
console.log('  ' + cl.map((c) => c.term + '×' + c.count).join('  |  '));

console.log('\n══ ② 按主题分页取到「拿全」 ══');
const topics = ['库无界', '装载有界', '三层', '孤案', '双通路', '四因子', '定价', '睡眠', '镜像', '来源态', '钩子', '蒸馏'];
let calls = 0, chars = 0;
const seen = new Set();
const topicStat = [];
for (const t of topics) {
  let off = 0, pages = 0, got = 0, tChars = 0, matched = 0, scope = 0, exhausted = false;
  while (pages < 6) {
    const d = s.lookupSegmentsDetailed(t, { session: full, limit: 5, offset: off });
    calls++; pages++;
    matched = d.matched; scope = d.sessionTotal;
    const n = d.hits.length;
    got += n; off = d.nextOffset;
    const c = d.hits.reduce((a, h) => a + String(h.gist || '').length, 0);
    tChars += c; chars += c;
    for (const h of d.hits) seen.add(h.id);
    exhausted = d.exhausted;
    if (n === 0 || d.exhausted) break;
  }
  topicStat.push({ t, pages, got, matched, scope, tChars, exhausted });
  console.log('  「' + t.padEnd(4) + '」主题命中 ' + String(matched).padStart(3) + ' 段 / 作用域 ' + scope + ' · 取回 ' + String(got).padStart(2) + ' 段 / '
    + pages + ' 次 · ' + tok(tChars) + ' tok · ' + (exhausted ? '拿全' : '未拿全(达页上限)'));
}
console.log('  ── 合计：' + calls + ' 次调用 · ' + chars + ' 字符（≈' + tok(chars) + ' tok）· 去重后见到 ' + seen.size + ' 个段');

console.log('\n══ ③ 原文保真对照（段 gist vs 档案原话）══');
const { text } = s.readSessionArchive(s.resolveSessionFile(root, full));
const rows = text.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
for (const t of ['库无界', '定价', '双通路']) {
  const d = s.lookupSegmentsDetailed(t, { session: full, limit: 1 });
  const h = d.hits[0];
  if (!h) { console.log('  「' + t + '」无命中'); continue; }
  console.log('\n  ▸「' + t + '」段 ' + h.id + '（turn ' + h.turn + ' / seq ' + h.seq + '）');
  console.log('     [段 gist] ' + String(h.gist).slice(0, 150));
  // (4) 保真对照改走 **seq 直回原档**（此前按"同 turn 含该词"匹配，对工具参数形态天然对不上）
  const sameRow = rows.find((r) => r.seq === h.seq);
  let found = null;
  if (sameRow) {
    const c = Array.isArray(sameRow.data?.content) ? sameRow.data.content.map((x) => x?.text || '').join(' ')
      : String(sameRow.data?.content ?? sameRow.data?.message?.content?.map?.((x) => x?.text || '').join(' ') ?? '');
    const i = c.indexOf(t);
    found = i >= 0 ? c.slice(Math.max(0, i - 60), i + 110).replace(/\s+/g, ' ')
      : (c ? '（同一 seq 行命中，但该行不含此主题词——gist 来自该行动的语义归纳）' : null);
  }
  console.log('     [原档 seq ' + h.seq + '] ' + (sameRow ? (found || c2(sameRow)) : '（档案里未找到同 seq 行）'));
}

function c2(row) {
  const c = Array.isArray(row.data?.content) ? row.data.content.map((x) => x?.text || '').join(' ')
    : String(row.data?.content ?? '');
  return c.slice(0, 120).replace(/\s+/g, ' ');
}
