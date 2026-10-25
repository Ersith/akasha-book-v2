// 2026-10-08：把用法条目（canon-akasha-usage 链尾）的正文导出到 _scratch，便于离线打补丁后再 revise 回去。
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadStore, currentRecords } from './lib.mjs';

const OUT_DIR = '<LOCAL_PATH>/_scratch';
mkdirSync(OUT_DIR, { recursive: true });
const tip = currentRecords(loadStore('canon').records).find((r) => r.id.startsWith('canon-akasha-usage'));
if (!tip) { console.log('未找到用法条目'); process.exit(1); }
const out = OUT_DIR + '/usage-tip.json';
writeFileSync(out, JSON.stringify({ id: tip.id, claim: tip.claim, last_reviewed: tip.last_reviewed }, null, 1), 'utf8');
console.log('导出：' + tip.id + '（claim ' + tip.claim.length + ' 字符）→ ' + out);
