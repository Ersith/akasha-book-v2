// find-forget.mjs —— 在会话档案里检索「用户指出模型遗忘/提醒」的原话（只读）。
// 目的（2026-10-11 用户："过去确实有一次你丢了记忆，我还指出来了……具体是不是 197-205 记不清了，得你找找看"）
// 口径：扫 user/message 行，匹配「忘 / 记错 / 没记住 / 忘了 / 提醒 / 说过 / 不是说过」等；打印 turn/时间/原话片段。
import { readSessionArchive, resolveSessionFile, SESSION_DEFAULTS } from './session.mjs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const sid8 = process.argv[2] || '7fe8ec84';
const root = SESSION_DEFAULTS.sessionsRoot;
const dirs = [];
for (const ws of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())) {
  for (const d of readdirSync(join(root, ws.name)).filter((x) => x.startsWith('session-' + sid8))) dirs.push(d);
}
if (!dirs.length) { console.log('未找到会话档案'); process.exit(2); }
const { text } = readSessionArchive(resolveSessionFile(root, dirs[0].replace(/^session-/, '')));
const lines = text.split('\n').filter(Boolean);

const RE = /(忘|记错|记不得|没记住|不记得|提醒|不是说|说过|丢了|漏了)/;
let turn = null, ts = null, hits = 0;
for (const l of lines) {
  let r; try { r = JSON.parse(l); } catch { continue; }
  const d = r.data || {};
  if (typeof d.turn === 'number') turn = d.turn;
  if (r.time || r.ts) ts = r.time || r.ts;
  if (r.type !== 'user/message') continue;
  const content = Array.isArray(d.content) ? d.content.map((c) => c?.text || '').join(' ') : String(d.content ?? '');
  if (!RE.test(content)) continue;
  hits++;
  const when = typeof ts === 'number' ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') : String(ts).slice(0, 16);
  console.log('  turn ' + String(turn ?? '?').padStart(4) + '  ' + when + '  ' + content.replace(/\s+/g, ' ').slice(0, 150));
}
console.log('  命中 ' + hits + ' 条（口径：user/message 含「忘/记得/提醒/说过」等词）');
