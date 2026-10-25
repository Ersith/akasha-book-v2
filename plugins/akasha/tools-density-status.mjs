// akasha/tools/density-status.mjs —— 格式密度状态（只读）
// 读 hooks.jsonl 的 density 线（@akasha-book/akasha-session 每轮落一条），输出最近状态与分档趋势。
// 分档（初值，可校准）：绿 <15 · 黄 15-40 · 橙 40-120 · 红 >120（依据：全库 70 会话归因，见 canon-degradation-attribution-r2/r3）
// 用法：
//   node akasha/tools/density-status.mjs                 # 最近 20 条
//   node akasha/tools/density-status.mjs --limit 50      # 更多
//   node akasha/tools/density-status.mjs --session 0fd7  # 只看某会话
import fs from 'node:fs';
import path from 'node:path';

const HOME = process.env.AKASHA_HOME || '<AKASHA_DIR>';
const LOG = process.env.AKASHA_LOGS ? path.join(process.env.AKASHA_LOGS, 'hooks.jsonl') : path.join(HOME, 'logs', 'hooks.jsonl');

const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const LIMIT = Number(arg('--limit', 20)) || 20;
const SESS = arg('--session', null);

let lines = [];
try { lines = fs.readFileSync(LOG, 'utf8').split('\n'); } catch { console.error('读不到 ' + LOG); process.exit(1); }
const rows = [];
for (const l of lines) {
  if (!l.includes('"density"')) continue;
  let o; try { o = JSON.parse(l); } catch { continue; }
  if (o.kind !== 'density') continue;
  if (SESS && !String(o.session ?? '').startsWith(SESS)) continue;
  rows.push(o);
}
if (!rows.length) {
  console.log('（暂无 density 线——@akasha-book/akasha-session ≥0.3.5 安装并重启后，自「首个 turn 结束」起每轮落一条）');
  console.log('  历史口径可先用: node tmp/degradation-attrib/r2g-density-curve.mjs <会话档案>');
  process.exit(0);
}
const tail = rows.slice(-LIMIT);
const fmtT = (ts) => new Date(Date.parse(ts) + 0).toISOString().replace('T', ' ').slice(5, 19);
console.log(`格式密度（hooks 线 · 最近 ${tail.length}/${rows.length} 条）`);
console.log('时刻(UTC)'.padEnd(17), '会话'.padEnd(10), '轮'.padStart(4), '密度/千字'.padStart(9), '档'.padStart(3), '近N轮'.padStart(5), '累计ch'.padStart(8));
for (const r of tail) {
  console.log(
    fmtT(r.ts).padEnd(17), String(r.session ?? '').slice(0, 8).padEnd(10), String(r.turn ?? '-').padStart(4),
    String(r.rate ?? '-').padStart(9), String(r.tag ?? '-').padStart(3), String(r.rounds ?? '-').padStart(5), String(r.chars ?? '-').padStart(8),
  );
}
// 按会话的最新
const last = new Map();
for (const r of rows) last.set(String(r.session ?? ''), r);
console.log('\n各会话最新一档：');
for (const [sid, r] of [...last.entries()].slice(-10)) {
  console.log(`  ${sid.slice(0, 12).padEnd(14)} 密度 ${String(r.rate).padStart(6)} （${r.tag}）· 轮 ${r.turn} · 近 ${r.rounds} 轮`);
}
const maxRow = rows.reduce((a, b) => ((b.rate ?? 0) > (a?.rate ?? 0) ? b : a), null);
if (maxRow) console.log(`\n本次观测期峰值：${maxRow.rate}/千字（${maxRow.tag}）@ ${String(maxRow.session).slice(0, 12)} 轮 ${maxRow.turn}`);
