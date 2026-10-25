// design-drift.mjs —— 源头设计 vs 当前实现的漂移检查（2026-10-11 用户裁定「都做吧」）。
// 口径（严守）：**机械层只回答"有没有对应实现"**——「偏离 vs 合理演化」必须人工判（机械不得冒充裁决）。
//   ① 设计块＝canon 中 tags 含「设计块」且 id 以 canon-design-2- 开头的条目（§2.1–2.14）；
//   ② 关键短语＝该块 claim 里的中文 4–6 字连续短语 + ASCII ≥4 词（去停用词），取频次前 12；
//   ③ 命中＝**非设计块**条目的 claim 里含该短语（实现侧条目可来自六库任意库）；
//   ④ 判定：命中 ≥3 个短语＝「有实现」；1–2 个＝「部分」；0 个＝「未见对应实现（→ 需人工判定：未落地 or 换了名字）」。
import { currentRecords, loadStore } from './lib.mjs';

const STOP = new Set(['的', '了', '是', '在', '我', '你', '他', '它', '和', '与', '就', '都', '也', '不', '要', '这', '那', '有', '没', '个', '上', '下', '里', '到', '把', '被', '而', '但', '还', '会', '能', '可以', '我们', '什么', '怎么', '可以', '部分', '内容', '方式', '情况', '问题', '时间', '时候', '进行', '需要', '应该', '例如', '其它', '其他', '以及', '或者', '不是', '就是', '这个', '那个', '以上', '以下', '之一', '一致', '完全', '必须', '只能', '默认']);

function phrases(s, minLen = 4, maxLen = 6, topN = 12) {
  const runs = String(s).match(/[\u4e00-\u9fff]+/g) || [];
  const cnt = new Map();
  for (const run of runs) {
    for (let L = minLen; L <= maxLen; L++) {
      for (let i = 0; i + L <= run.length; i++) {
        const p = run.slice(i, i + L);
        if (STOP.has(p)) continue;
        cnt.set(p, (cnt.get(p) || 0) + 1);
      }
    }
  }
  for (const w of String(s).toLowerCase().match(/[a-z][a-z0-9._-]{3,}/g) || []) {
    if (!STOP.has(w)) cnt.set(w, (cnt.get(w) || 0) + 1);
  }
  return [...cnt.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, topN).map(([p]) => p);
}

const current = currentRecords([...loadStore('canon').records, ...loadStore('frontier').records, ...loadStore('mirror').records, ...loadStore('orphan').records, ...loadStore('pricing').records, ...loadStore('lexicon').records]);
const design = current.filter((r) => Array.isArray(r.tags) && r.tags.includes('设计块') && String(r.id).startsWith('canon-design-2-')).sort((a, b) => String(a.id).localeCompare(String(b.id)));
const impl = current.filter((r) => !(Array.isArray(r.tags) && r.tags.includes('设计块')));

console.log('源头设计漂移检查：设计块 ' + design.length + ' 条 vs 实现侧条目 ' + impl.length + ' 条');
console.log('  设计块                                    命中短语  判定        最强对应实现');
const pending = [];
const rows = [];
for (const d of design) {
  const ps = phrases(d.claim);
  const hits = [];
  for (const p of ps) {
    for (const r of impl) if (String(r.claim || '').includes(p)) hits.push({ p, id: r.id, store: r.store || '' });
  }
  const ph = new Set(hits.map((h) => h.p));
  const tally = new Map();
  for (const h of hits) tally.set(h.id, (tally.get(h.id) || 0) + 1);
  const top = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  const verdict = ph.size >= 3 ? '有实现' : ph.size >= 1 ? '部分' : '未见对应实现';
  if (verdict === '未见对应实现') pending.push(d);
  const secTitle = String(d.claim).slice(0, 40).replace(/\n/g, ' ');
  rows.push({ id: d.id, sec: secTitle, phrases: ph.size, verdict, top: top ? top[0] + '（' + top[1] + ' 短语）' : '-' });
  console.log('  ' + d.id.padEnd(34) + String(ph.size).padStart(6) + '    ' + verdict.padEnd(10) + '  ' + (top ? top[0] + '（' + top[1] + '）' : '-'));
}
const sum = { 有实现: 0, 部分: 0, 未见对应实现: 0 };
for (const r of rows) sum[r.verdict] += 1;
console.log('  ── 汇总：有实现 ' + sum['有实现'] + ' · 部分 ' + sum['部分'] + ' · 未见对应实现 ' + sum['未见对应实现']);
if (pending.length) {
  console.log('  ── 候选偏离清单（**需人工判定：未落地 or 换了名字实现**——机械层不得裁决）：');
  for (const d of pending) console.log('     · ' + d.id + ' ｜ ' + String(d.claim).slice(0, 90).replace(/\n/g, ' '));
}
console.log('  ── 纪律：本检查只报"有无对应实现"；「偏离 vs 合理演化」须人工结合代码/条目证据判定（见 canon-design-ingested 条目）。');
