// compaction-turns.mjs —— 「压缩 turn 表」：读会话档案，把每次 compaction 落在哪个 turn/step 打出来。
// 目的（2026-10-11 用户观察）：判断「~200 轮后出现的遗忘」是否紧跟某次压缩（假设 b：压缩失真）。
// 只读；复用 session.mjs 的档案读取路径（与 _scratch/ctx-compare2-20261008.mjs 同源）。
// 用法：node tools/compaction-turns.mjs [会话前缀，默认 7fe8ec84]
import { readSessionArchive, resolveSessionFile, SESSION_DEFAULTS } from './session.mjs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const sid8 = process.argv[2] || '7fe8ec84';
const root = SESSION_DEFAULTS.sessionsRoot;
const dirs = [];
for (const ws of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())) {
  for (const d of readdirSync(join(root, ws.name)).filter((x) => x.startsWith('session-' + sid8))) dirs.push(d);
}
if (!dirs.length) { console.log('未找到会话 ' + sid8 + ' 的档案'); process.exit(2); }
const full = dirs[0].replace(/^session-/, '');
const { text } = readSessionArchive(resolveSessionFile(root, full));
const lines = text.split('\n').filter(Boolean);

let turn = null, step = null, ts = null;
const comps = [];
let rows = 0;
for (const l of lines) {
  rows++;
  let r; try { r = JSON.parse(l); } catch { continue; }
  const d = r.data || {};
  const t = (typeof d.turn === 'number') ? d.turn : (typeof r.turn === 'number' ? r.turn : null);
  const s = (typeof d.step === 'number') ? d.step : (typeof r.step === 'number' ? r.step : null);
  if (t !== null) turn = t;
  if (s !== null) step = s;
  if (r.time || r.ts) ts = r.time || r.ts;
  if (r.type === 'compaction/start' || r.type === 'compaction/end') {
    comps.push({ phase: r.type.split('/')[1], turn, step, ts, line: rows });
  }
}

console.log('压缩 turn 表：会话 ' + sid8 + '（档案 ' + rows + ' 行 / ' + comps.length + ' 条压缩记录）');
console.log('  #  阶段  轮次   步      时间');
comps.forEach((c, i) => {
  console.log('  ' + String(i + 1).padStart(2) + '  ' + String(c.phase).padEnd(6) + String(c.turn ?? '?').padStart(4) + '  ' + String(c.step ?? '?').padStart(5) + '   ' + String(c.ts || '').slice(0, 19));
});
// 汇总：压缩之间的轮次间隔（看频率是否随会话推进变化）
const starts = comps.filter((c) => c.phase === 'start' && typeof c.turn === 'number');
if (starts.length >= 2) {
  console.log('  ── 压缩间隔（turn）──');
  for (let i = 1; i < starts.length; i++) {
    console.log('   第 ' + (i + 1) + ' 次 ← 第 ' + i + ' 次：间隔 ' + (starts[i].turn - starts[i - 1].turn) + ' 轮（turn ' + starts[i - 1].turn + ' → ' + starts[i].turn + '）');
  }
}
