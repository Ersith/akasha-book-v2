// 阶段 3 材料导出 v3（只读）：按压缩 seq 锚点切用户消息，附 data 键位与来源线索。
// 运行：node tools\replay-extract-20261007.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSessionArchive } from './session.mjs';

const SESSION_FILE = '<LOCAL_PATH>\\official-home\\sessions\\--H-Harness--\\session-f362b992-b105-470c-b0aa-d87d16b9b0b6\\session.v4.jsonl.zstd';
const OUT_DIR = '<LOCAL_PATH>\\research\\session-replay-20261007';
mkdirSync(OUT_DIR, { recursive: true });

const { text } = readSessionArchive(SESSION_FILE);
const records = [];
for (const l of text.split(/\r?\n/)) {
  if (!l.trim()) continue;
  try { records.push(JSON.parse(l)); } catch { /* skip */ }
}

const SUMMARY_ANCHORS = records.filter((r) => r.type === 'compaction/summary').map((r) => r.seq);
console.log('compaction seq anchors:', JSON.stringify(SUMMARY_ANCHORS));

const INJECTION_MARKERS = ['<compacted-summary>', '【阿卡夏·起床包】', '<openviking-context>', 'automatically generated checkpoint', '<user-profile', '<system-reminder>', '<runtime', 'MEMORY-TEST', '<skill', 'session-layer'];
const userMsgs = records.filter((r) => r.type === 'user/message').map((r) => {
  const d = r.data ?? {};
  const content = Array.isArray(d.content) ? d.content : [];
  const txt = content.filter((x) => x && x.type === 'text').map((x) => x.text).join(' ');
  const marker = INJECTION_MARKERS.find((m) => txt.includes(m)) ?? null;
  return {
    seq: r.seq, time: r.time, len: txt.length,
    dataKeys: Object.keys(d),
    srcKind: d.source?.kind ?? d.message?.source?.kind ?? null,
    marker, injection: marker !== null,
    head: txt.slice(0, 400),
  };
});
const late = userMsgs.filter((u) => u.seq > SUMMARY_ANCHORS[0]);
writeFileSync(join(OUT_DIR, 'user-msgs-late.json'), JSON.stringify(late, null, 2), 'utf8');

console.log(JSON.stringify({
  total: userMsgs.length, late: late.length,
  lateRows: late.map((u) => ({ seq: u.seq, len: u.len, inj: u.injection, mk: u.marker, src: u.srcKind, head: u.head.slice(0, 90) })),
}, null, 2));
