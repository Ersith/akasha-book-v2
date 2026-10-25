// compaction-loss.mjs —— 「压缩损失对照」：每次压缩，「被替换的窗口」里的话题词有多少活到了「摘要」里（只读）。
// 方法（写死，防事后调参）：
//   ① 窗口 = 上一次 compaction 之后到本次 compaction 之前的全部行文本；摘要 = compaction 之后第一条
//      content 以 "This is an automatically generated checkpoint" 开头的 user/message（官方压缩摘要）；
//   ② 词元：中文取相邻二字（bigram），ASCII 取长度 ≥3 的词（小写）；去掉停用词与纯数字；
//   ③ 取窗口内**词频前 25** 的词元为「话题词」；保留率 = 这 25 个里有多少也出现在摘要中；
//   ④ 同时给出字符量（窗口 / 摘要）与压缩比，便于看「单次损失规模」是否随会话变大。
// 用法：node tools/compaction-loss.mjs [会话前缀，默认 7fe8ec84]
import { readSessionArchive, resolveSessionFile, SESSION_DEFAULTS } from './session.mjs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const sid8 = process.argv[2] || '7fe8ec84';
const root = SESSION_DEFAULTS.sessionsRoot;
let dir = null;
for (const ws of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())) {
  for (const d of readdirSync(join(root, ws.name)).filter((x) => x.startsWith('session-' + sid8))) dir = d;
}
if (!dir) { console.log('未找到会话档案'); process.exit(2); }
const { text } = readSessionArchive(resolveSessionFile(root, dir.replace(/^session-/, '')));
const lines = text.split('\n').filter(Boolean);

const STOP = new Set(['的', '了', '是', '在', '我', '你', '他', '它', '和', '与', '就', '都', '也', '不', '要', '这', '那', '有', '没', '个', '上', '下', '里', '到', '把', '被', '而', '但', '还', '会', '能', '可以', '我们', '你们', '什么', '怎么', '为什么', 'the', 'and', 'for', 'that', 'with', 'this', 'you', 'are', 'not', 'have']);
function terms(s) {
  const out = [];
  const han = s.match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of han) for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  for (const w of (s.toLowerCase().match(/[a-z0-9._-]{3,}/g) || [])) out.push(w);
  return out.filter((t) => !STOP.has(t) && !/^\d+$/.test(t));
}
function topN(s, n) {
  const cnt = new Map();
  for (const t of terms(s)) cnt.set(t, (cnt.get(t) || 0) + 1);
  return new Map([...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, n));
}

let windowBuf = [], curTurn = null, pendingWindow = null;
const rows = [];
let seqTotal = 0;
for (const l of lines) {
  seqTotal++;
  let r; try { r = JSON.parse(l); } catch { continue; }
  const d = r.data || {};
  if (typeof d.turn === 'number') curTurn = d.turn;
  if (r.type === 'compaction/end') { pendingWindow = windowBuf.join('\n'); windowBuf = []; rows.push({ turn: curTurn, window: pendingWindow, summary: null }); continue; }
  if (r.type === 'user/message' && !rows.length === false) {
    const content = Array.isArray(d.content) ? d.content.map((c) => c?.text || '').join(' ') : String(d.content ?? '');
    const last = rows[rows.length - 1];
    if (last && last.summary === null && content.startsWith('This is an automatically generated checkpoint')) last.summary = content;
  }
  windowBuf.push(l);
}

console.log('压缩损失对照：会话 ' + sid8 + '（档案 ' + seqTotal + ' 行，压缩 ' + rows.length + ' 次）');
console.log('  #  轮次  窗口字符   摘要字符   压缩比   话题词保留（前 25）');
let ok = 0;
for (let i = 0; i < rows.length; i++) {
  const { turn, window: w, summary } = rows[i];
  if (!summary) { console.log('  ' + String(i + 1).padStart(2) + '  ' + String(turn).padStart(4) + '  （未找到摘要文本）'); continue; }
  const top = topN(w, 25);
  const sumTerms = new Set(terms(summary));
  let hit = 0;
  for (const k of top.keys()) if (sumTerms.has(k)) hit++;
  const ratio = (w.length / Math.max(1, summary.length)).toFixed(1);
  ok++;
  console.log('  ' + String(i + 1).padStart(2) + '  ' + String(turn).padStart(4) + '  ' + String(w.length).padStart(8) + '  ' + String(summary.length).padStart(8) + '  ' + String(ratio).padStart(6) + 'x   ' + hit + '/25 = ' + (100 * hit / 25).toFixed(0) + '%');
}
console.log('  可算 ' + ok + '/' + rows.length + ' 次（缺摘要文本的无法计算）');
