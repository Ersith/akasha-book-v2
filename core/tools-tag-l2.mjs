// tag-l2.mjs —— ⑥ L2 抽象规则层显式标记（2026-10-11，用户令「开搞」）
//   判据（确定性、可核对）：条目的 tags 含 {纪律, 原则, 判据, 红线, 方法论, 行为规格, 约定, 规范} 之一 ⇒ 视为**抽象规则**，
//   追加 tag `抽象规则`（保留原 tags；经修订链写入、不改原文）。canon 的检索字段已含 tags ⇒ 打标后即可被检索与过滤。
//   幂等：已含「抽象规则」则跳过。逐条打印（可人工核对）。
import { currentRecords, loadStore, revise } from './lib.mjs';

const L2_TAGS = ['纪律', '原则', '判据', '红线', '方法论', '行为规格', '约定', '规范'];
const cur = currentRecords(loadStore('canon').records);
let tagged = 0;
for (const r of cur) {
  const tags = (r.tags || []).map(String);
  if (tags.includes('抽象规则')) continue;
  const hit = L2_TAGS.filter((t) => tags.includes(t));
  if (!hit.length) continue;
  revise('canon', r.id, { tags: [...tags, '抽象规则'], source: { ...(r.source || {}), ref: (r.source && r.source.ref) || 'L2 标记（tag-l2 批量，2026-10-11）' } });
  tagged += 1;
  console.log('  + ' + r.id + '  ← 命中 ' + hit.join('/'));
}
console.log('打标完成：' + tagged + ' 条（判据：tags ∋ ' + L2_TAGS.join('|') + '）');
const after = currentRecords(loadStore('canon').records).filter((r) => (r.tags || []).includes('抽象规则'));
console.log('现「抽象规则」条目 = ' + after.length + ' 条');
