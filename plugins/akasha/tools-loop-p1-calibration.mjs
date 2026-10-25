// tmp/loop-p1-calibration.mjs —— 只读：把 loop-watch 命中摊开分类，供 P1 阈值标定
import { readFileSync } from 'node:fs';

const raw = readFileSync('<AKASHA_DIR>/logs/hooks.jsonl', 'utf8').split('\n');
const hits = [];
for (const line of raw) {
  if (!line.includes('"loop-watch"')) continue;
  let j; try { j = JSON.parse(line); } catch { continue; }
  if (j.kind === 'loop-watch') hits.push(j);
}
console.log('命中总数：', hits.length);

const by = (f) => { const m = new Map(); for (const h of hits) { const k = f(h); m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]); };
console.log('\n── 按 type × phase');
for (const [k, n] of by((h) => h.hit.type + ' / ' + h.phase)) console.log(`  ${k}: ${n}`);
console.log('\n── 按 stream（流相）');
for (const [k, n] of by((h) => h.stream || '(回合相)')) console.log(`  ${k}: ${n}`);
console.log('\n── 按会话（前 10）');
for (const [k, n] of by((h) => String(h.session).slice(0, 8)).slice(0, 10)) console.log(`  ${k}: ${n}`);
console.log('\n── 按日');
for (const [k, n] of by((h) => String(h.ts).slice(0, 10))) console.log(`  ${k}: ${n}`);

console.log('\n── exact 全列（真环最可能的形态）');
for (const h of hits.filter((h) => h.hit.type === 'exact')) console.log('  ', h.ts, String(h.session).slice(0, 8), 'turn', h.turn, h.stream || '', JSON.stringify(String(h.hit.excerpt).slice(0, 60)));

console.log('\n── punct 去重摘录（前 20）');
const seen = new Set();
for (const h of hits.filter((h) => h.hit.type === 'punct')) { const e = JSON.stringify(String(h.hit.excerpt).slice(0, 40)); if (!seen.has(e)) { seen.add(e); console.log('  ', e); } }
console.log('（punct 去重后共', seen.size, '种）');

console.log('\n── variant 抽样（每会话取 1 条，看是否都属「重述类」）');
const per = new Map();
for (const h of hits.filter((h) => h.hit.type === 'variant')) { const s = String(h.session).slice(0, 8); if (!per.has(s)) per.set(s, h); }
for (const [s, h] of per) console.log('  ', s, 'turn', h.turn, JSON.stringify(String(h.hit.excerpt).slice(0, 70)));

console.log('\n── 上下文长度代理 ctxChars（2026-10-14 起的新线；旧命中无此字段）');
const withCtx = hits.filter((h) => typeof h.ctxChars === 'number');
if (!withCtx.length) console.log('   （当前 0 条带 ctxChars——session 0.3.2-h5 待重启生效后才有新数据）');
else {
  const nums = withCtx.map((h) => h.ctxChars).sort((a, b) => a - b);
  const q = (p) => nums[Math.min(nums.length - 1, Math.floor(nums.length * p))];
  console.log(`   带 ctxChars 命中 ${withCtx.length} 条：min ${nums[0]} / p50 ${q(0.5)} / p90 ${q(0.9)} / max ${nums[nums.length - 1]}`);
}

console.log('\n── 同一会话同一 turn 的聚集（≥2 次命中 = 持续环候选）');
const agg = new Map();
for (const h of hits) { const k = String(h.session).slice(0, 8) + '#' + h.turn; agg.set(k, (agg.get(k) || 0) + 1); }
for (const [k, n] of [...agg.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);
