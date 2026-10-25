// 阶段 3 实验材料准备（只读）：从马拉松档案提取压缩摘要与压缩后问题候选。
// 运行：node tools\replay-prep-20261007.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSessionArchive } from './session.mjs';

const SESSION_FILE = '<LOCAL_PATH>\\official-home\\sessions\\--H-Harness--\\session-f362b992-b105-470c-b0aa-d87d16b9b0b6\\session.v4.jsonl.zstd';
const OUT_DIR = '<LOCAL_PATH>\\research\\session-replay-20261007';
mkdirSync(OUT_DIR, { recursive: true });

const { text, frames, frameFails } = readSessionArchive(SESSION_FILE);
const lines = text.split(/\r?\n/).filter(Boolean);
const records = [];
let parseFails = 0;
for (const l of lines) { try { records.push(JSON.parse(l)); } catch { parseFails++; } }

const typeCounts = {};
for (const r of records) { const t = String(r.type ?? '?'); typeCounts[t] = (typeCounts[t] ?? 0) + 1; }

// 压缩相关记录：type 含 compaction / compact
const compactionish = records.filter((r) => /compact/i.test(String(r.type ?? '')));
// 用户消息（带 turn + 全文长度 + 头 240 字）
const userMsgs = records.filter((r) => r.type === 'user/message').map((r) => {
  const d = r.data ?? {};
  const content = Array.isArray(d.content) ? d.content : [];
  const txt = content.filter((x) => x && x.type === 'text').map((x) => x.text).join(' ');
  return { seq: r.seq, turn: d.turn ?? null, time: r.time, len: txt.length, head: txt.slice(0, 240) };
});

const out = {
  source: SESSION_FILE, frames, frameFails, records: records.length, parseFails,
  typeCounts,
  compactionCount: compactionish.length,
  compactionSample: compactionish.slice(0, 3).map((r) => ({ seq: r.seq, type: r.type, time: r.time, keys: Object.keys(r), dataHead: JSON.stringify(r.data ?? {}).slice(0, 600) })),
  userMsgCount: userMsgs.length,
  userMsgs,
};
writeFileSync(join(OUT_DIR, 'recon.json'), JSON.stringify(out, null, 2), 'utf8');
console.log(JSON.stringify({
  records: records.length, parseFails, compactionCount: compactionish.length,
  userMsgCount: userMsgs.length, types: typeCounts,
  compactionSample: out.compactionSample,
}, null, 2));
