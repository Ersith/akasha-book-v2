// akasha/tools/fidelity-session-tree-20261007b.mjs
// v0.2 保真抽查·第二口径（决策相关）：
//  A. 段层保真：抽样 40 段/会话 → ptr.seq 回原档取原文 → 受保护 token 在 seg.gist+why+keywords 的保有率（钻取链真正的承诺面）
//  B. 节点提及率：每个 L1 节点，孩子里每条 conclusion 的「信号 token」（引文/路径/数字/ASCII≥4/CJK≥3 关键词）是否在节点 gist+extra 出现 ≥1
//  C. 节点顶结论 token 保真：每节点取权重前 3 条 conclusion，其 token 在节点文本的保有率
import { loadStore } from './lib.mjs';
import { latestNodes, resolveSessionFile, readSessionArchive, SESSION_DEFAULTS } from './session.mjs';
const RECORDS = loadStore('session').records;
const byId = new Map(RECORDS.map((r) => [r.id, r]));
const sessions = [...new Set(RECORDS.filter((r) => r.kind !== 'node').map((r) => r.session))];

const TOKEN_RES = [
  [/[A-Za-z]:\\[^\s，。；、「」）()]+/g, 'path'],
  [/「[^」]{2,24}」/g, 'quote'],
  [/\d{2,}(?:\.\d+){0,3}/g, 'num'],
  [/[A-Za-z][A-Za-z0-9_.-]{3,}/g, 'ascii']
];
const extractTokens = (text) => {
  const out = new Map();
  for (const [re, cls] of TOKEN_RES) for (const m of String(text).matchAll(re)) { const k = m[0].toLowerCase(); if (!out.has(k)) out.set(k, cls); }
  return out;
};
const rawTextOf = (rec) => {
  if (!rec) return '';
  const t = rec.type;
  try {
    if (t === 'user/message') return (rec.data?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (t === 'assistant/message') return (rec.data?.message?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    if (t === 'tool/call') return String(rec.data?.arguments ?? '');
    if (t === 'tool/result') return (rec.data?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  } catch { /* 容错：坏结构返回空 */ }
  return '';
};

// 采样：固定步长（确定性），跳过大块工具输出行（>2KB 原文在 gist 截断下天然不可比，单独计数）
const STEP = 34;
const A = [];
for (const sid of sessions) {
  const segs = RECORDS.filter((r) => r.kind !== 'node' && r.session === sid);
  for (let i = 7; i < segs.length; i += STEP) A.push(segs[i]);
}
console.log(`A. 段层保真：抽样 ${A.length} 段（对齐原档）`);
const fileCache = new Map();
let aTot = 0, aHit = 0, aBig = 0;
const aByKind = {};
for (const seg of A) {
  if (!fileCache.has(seg.session)) {
    const f = resolveSessionFile(SESSION_DEFAULTS.sessionsRoot, seg.session);
    const recs = f ? readSessionArchive(f).text.split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
    fileCache.set(seg.session, new Map(recs.map((r) => [r.seq, r])));
  }
  const rawMap = fileCache.get(seg.session);
  const rec = rawMap.get(seg.ptr?.seq ?? seg.ptr?.callSeq);
  const raw = rawTextOf(rec);
  if (raw.length > 2048) { aBig += 1; continue; }
  const tokens = extractTokens(raw);
  if (!tokens.size) continue;
  const hay = [seg.gist, seg.why, (seg.keywords ?? []).join(' ')].filter(Boolean).join(' ').toLowerCase();
  let hit = 0;
  for (const t of tokens.keys()) if (hay.includes(t)) hit += 1;
  aTot += tokens.size; aHit += hit;
  const k = seg.kind; aByKind[k] ??= { tot: 0, hit: 0, n: 0 };
  aByKind[k].tot += tokens.size; aByKind[k].hit += hit; aByKind[k].n += 1;
}
console.log(`  受保护 token ${aTot}：保有 ${aHit}（${((aHit / Math.max(1, aTot)) * 100).toFixed(1)}%）；跳过超长原文 ${aBig} 段`);
for (const [k, v] of Object.entries(aByKind)) console.log(`  ${k}: n=${v.n} token ${v.tot} → ${((v.hit / Math.max(1, v.tot)) * 100).toFixed(1)}%`);

// B. 节点提及率
console.log('B. 节点提及率（L1；块内 conclusion 信号 ≥1 出现在节点文本）');
let bTot = 0, bMen = 0;
for (const sid of sessions) {
  for (const n of latestNodes(undefined, sid).filter((x) => x.level === 1)) {
    const text = String(n.gist ?? '') + ' ' + String(n.extra ?? '');
    const textL = text.toLowerCase();
    let tot = 0, men = 0;
    for (const cid of n.children ?? []) {
      const c = byId.get(cid);
      if (!c || c.kind !== 'conclusion') continue;
      const sig = extractTokens(c.gist);
      // 无 ASCII/数字/引文/路径信号时退回 CJK 关键词（≥3 字）
      const cjk = (c.keywords ?? []).find((k) => /^[\u4e00-\u9fff]{3,}$/u.test(k));
      const sigList = [...sig.keys()];
      if (cjk) sigList.push(cjk.toLowerCase());
      if (!sigList.length) continue;
      tot += 1;
      if (sigList.some((t) => textL.includes(t))) men += 1;
    }
    bTot += tot; bMen += men;
    console.log(`  ${n.id}  结论 ${tot} → 提及 ${men}（${((men / Math.max(1, tot)) * 100).toFixed(0)}%）`);
  }
}
console.log(`  合计：结论 ${bTot} → 提及 ${bMen}（${((bMen / Math.max(1, bTot)) * 100).toFixed(1)}%）`);

// C. 节点顶 3 结论 token 保真
console.log('C. 节点顶 3 结论 token 保真');
let cTot = 0, cHit = 0;
const W = { conclusion: 3, action: 2, intent: 1 };
for (const sid of sessions) {
  for (const n of latestNodes(undefined, sid).filter((x) => x.level === 1)) {
    const kids = (n.children ?? []).map((id) => byId.get(id)).filter((c) => c && c.kind === 'conclusion')
      .sort((a, b) => (W[b.kind] - W[a.kind]) || (a.seq ?? 0) - (b.seq ?? 0)).slice(0, 3);
    const textL = (String(n.gist ?? '') + ' ' + String(n.extra ?? '')).toLowerCase();
    let tot = 0, hit = 0;
    for (const c of kids) {
      const tokens = extractTokens(c.gist);
      for (const t of tokens.keys()) { tot += 1; if (textL.includes(t)) hit += 1; }
    }
    cTot += tot; cHit += hit;
  }
}
console.log(`  合计：token ${cTot} → 保有 ${cHit}（${((cHit / Math.max(1, cTot)) * 100).toFixed(1)}%）`);
