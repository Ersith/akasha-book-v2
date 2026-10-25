// compaction-anchors.mjs —— 「约定级」压缩损失核对：抽若干**核心约定**，看它们在每次压缩的「窗口→摘要」里是否存活（只读）。
// 与 compaction-loss.mjs 的分工：那个走"高频词统计"（粗、可能有话题集中混杂），本工具走**人工指定的具体约定**（细、可逐条核对）。
// 用法：node tools/compaction-anchors.mjs [会话前缀]
import { readSessionArchive, resolveSessionFile, SESSION_DEFAULTS } from './session.mjs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

// 每条约定给一组「任意命中即算提到」的探针串（用最不易误伤的词形）
const ANCHORS = [
  { name: '库无界·装载有界', probes: ['库无界', '装载有界'] },
  { name: '来源态四标签', probes: ['来源态', '记得·库内', '学过'] },
  { name: '修订链（追加不改原文）', probes: ['修订链', 'supersedes', '链尾'] },
  { name: '零编造（红线）', probes: ['零编造', '编造'] },
  { name: '称呼层（Master/大肥鱼）', probes: ['大肥鱼', 'Master'] },
];

const sid8 = process.argv[2] || '7fe8ec84';
const root = SESSION_DEFAULTS.sessionsRoot;
let dir = null;
for (const ws of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())) {
  for (const d of readdirSync(join(root, ws.name)).filter((x) => x.startsWith('session-' + sid8))) dir = d;
}
if (!dir) { console.log('未找到会话档案'); process.exit(2); }
const { text } = readSessionArchive(resolveSessionFile(root, dir.replace(/^session-/, '')));
const lines = text.split('\n').filter(Boolean);

const hit = (s, probes) => probes.some((p) => s.includes(p));
let buf = [], curTurn = null;
const rows = [];
for (const l of lines) {
  let r; try { r = JSON.parse(l); } catch { continue; }
  const d = r.data || {};
  if (typeof d.turn === 'number') curTurn = d.turn;
  if (r.type === 'compaction/end') { rows.push({ turn: curTurn, win: buf.join('\n'), sum: null }); buf = []; continue; }
  if (r.type === 'user/message') {
    const content = Array.isArray(d.content) ? d.content.map((c) => c?.text || '').join(' ') : String(d.content ?? '');
    const last = rows[rows.length - 1];
    if (last && last.sum === null && content.startsWith('This is an automatically generated checkpoint')) last.sum = content;
  }
  buf.push(l);
}

console.log('约定级压缩核对：会话 ' + sid8 + '（压缩 ' + rows.length + ' 次）');
const header = '  #  轮次  ' + ANCHORS.map((a) => a.name.slice(0, 10).padEnd(11)).join('') + ' 合计';
console.log(header);
const stat = ANCHORS.map(() => ({ win: 0, sum: 0 }));
for (let i = 0; i < rows.length; i++) {
  const { turn, win, sum } = rows[i];
  if (!sum) { console.log('  ' + String(i + 1).padStart(2) + '  ' + String(turn).padStart(4) + '  （无摘要）'); continue; }
  const cells = ANCHORS.map((a, j) => {
    const w = hit(win, a.probes), s = hit(sum, a.probes);
    if (w) stat[j].win++;
    if (s) stat[j].sum++;
    return (w ? (s ? '✓存活' : '✗丢失') : '—未提').padEnd(11);
  });
  const survived = cells.filter((c) => c.startsWith('✓')).length;
  const touched = cells.filter((c) => !c.startsWith('—')).length;
  console.log('  ' + String(i + 1).padStart(2) + '  ' + String(turn).padStart(4) + '  ' + cells.join('') + ' ' + survived + '/' + Math.max(1, touched));
}
console.log('  ── 各约定：窗口提及次数 → 摘要存活次数 ──');
ANCHORS.forEach((a, j) => console.log('   ' + a.name.padEnd(22) + ' 窗口 ' + String(stat[j].win).padStart(2) + ' 次 → 摘要 ' + String(stat[j].sum).padStart(2) + ' 次'));
