// tools/prevability-sheet.mjs —— 步4 校准表：打印指定区间 case 的判定素材（紧凑）
import { readFileSync } from 'node:fs';
const OUT = '<LOCAL_PATH>\\_scratch\\prevability';
const rows = readFileSync(OUT + '\\queries-hits.jsonl', 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
const from = Number(process.argv[2] ?? 0), to = Number(process.argv[3] ?? 15);
for (const r of rows.slice(from, to)) {
  const msg = String(r.message ?? '').replace(/\s+/g, ' ').slice(0, 64);
  const legal = (r.hits ?? []).filter((h) => h.strong && h.legalAtFailTime).slice(0, 2);
  const legalTxt = legal.length ? legal.map((h) => h.id + '(' + h.score + ') ' + String(h.claim ?? '').replace(/\s+/g, ' ').slice(0, 46)).join(' || ') : '（无合法强命中）';
  console.log([r.case_id, r.tool, r.date, '簇' + r.cluster_size].join(' ') + ' | ' + msg);
  console.log('   q=' + r.query + '  →  ' + legalTxt);
}
