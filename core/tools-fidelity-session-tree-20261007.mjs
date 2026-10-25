// akasha/tools/fidelity-session-tree-20261007.mjs
// 2026-10-07 会话层 v0.2 保真抽查（RECOMP 口径的机械版）：
// 对每个当前代 L1 节点，从孩子段提取「受保护 token」（路径 / 数字 /「引文」/ ASCII≥4），
// 统计其在 节点 gist（展示层 400）/ extra（找回层 1200）/ 两者皆无 的保有率。只读。
import { loadStore, currentRecords } from './lib.mjs';
import { latestNodes } from './session.mjs';

const RECORDS = loadStore('session').records;
const byId = new Map(RECORDS.map((r) => [r.id, r]));
const sessions = [...new Set(RECORDS.filter((r) => r.kind !== 'node').map((r) => r.session))];

const extractTokens = (seg) => {
  const text = [seg.gist, (seg.keywords ?? []).join(' ')].filter(Boolean).join(' ');
  const out = new Map(); // token -> class
  const add = (t, cls) => { const k = String(t).toLowerCase(); if (!out.has(k)) out.set(k, cls); };
  for (const m of text.matchAll(/[A-Za-z]:\\[^\s，。；、「」）()]+/g)) add(m[0], 'path');
  for (const m of text.matchAll(/「[^」]{2,24}」/g)) add(m[0], 'quote');
  for (const m of text.matchAll(/\d{2,}(?:\.\d+){0,3}/g)) add(m[0], 'num');
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_.-]{3,}/g)) add(m[0], 'ascii');
  return out;
};

let total = 0, inGist = 0, extraOnly = 0, lost = 0;
const perClass = {};
const report = [];

for (const sid of sessions) {
  const nodes = latestNodes(undefined, sid).filter((n) => n.level === 1);
  for (const n of nodes) {
    const children = (n.children ?? []).map((id) => byId.get(id)).filter(Boolean);
    const tokens = new Map();
    for (const c of children) for (const [t, cls] of extractTokens(c)) if (!tokens.has(t)) tokens.set(t, cls);
    const gistL = String(n.gist ?? '').toLowerCase();
    const extraL = String(n.extra ?? '').toLowerCase();
    let g = 0, e = 0, l = 0;
    for (const [t, cls] of tokens) {
      perClass[cls] ??= { total: 0, gist: 0, extra: 0, lost: 0 };
      perClass[cls].total += 1;
      if (gistL.includes(t)) { g += 1; perClass[cls].gist += 1; }
      else if (extraL.includes(t)) { e += 1; perClass[cls].extra += 1; }
      else { l += 1; perClass[cls].lost += 1; }
    }
    total += tokens.size; inGist += g; extraOnly += e; lost += l;
    report.push({ session: sid.slice(0, 8), node: n.id, children: children.length, tokens: tokens.size, gist: g, extra: e, lost: l });
    console.log(`${n.id}  孩子 ${String(children.length).padStart(3)}  token ${String(tokens.size).padStart(3)}  gist ${String(g).padStart(3)}  extra ${String(e).padStart(3)}  丢 ${String(l).padStart(3)}`);
  }
}

const pct = (x) => ((x / Math.max(1, total)) * 100).toFixed(1) + '%';
console.log('—— 汇总 ——');
console.log(`受保护 token 总数 ${total}：gist 保有 ${inGist}（${pct(inGist)}）/ extra 找回 ${extraOnly}（${pct(extraOnly)}）/ 丢失 ${lost}（${pct(lost)}）`);
for (const [cls, c] of Object.entries(perClass)) {
  console.log(`  ${cls}: ${c.total} → gist ${c.gist} / extra ${c.extra} / lost ${c.lost}`);
}
