// 2026-10-08 事故清理：4 条已退役条目在 09:10:28 被某脚本复活（重复 id 追加）。
// 用库的硬删原语把「复活出来的那份」整行移出（移前自动备份到 data/_trash/<日期>-frontier.jsonl）。
// 注意语义：byId 对重复 id 取最后一次出现 ⇒ tip 解析到「复活的那份」，而原链（base/-r1/墓碑）保持不变。
import { retireRecord, loadStore, retiredIds, currentRecords } from './lib.mjs';

// 一次性脚本（2026-10-08 复查教训）：清理类脚本正常重跑必须 no-op。需要重放请设 AKASHA_ALLOW_REPLAY=1。
if (process.env.AKASHA_ALLOW_REPLAY !== '1') {
  console.log('一次性脚本：已执行过，本次不改变任何数据（需要重放请设 AKASHA_ALLOW_REPLAY=1）。');
  process.exit(0);
}

const IDS = [
  'frontier-joycaption-comfyui-node',
  'frontier-animalorastudio-anime-lora',
  'frontier-kohya-bucket-management-doc',
  'frontier-depth-controlnet-tutorial-comfyui',
];

const before = loadStore('frontier').records;
console.log('清理前行数：', before.length, '｜当前集：', currentRecords(before).length, '｜退役 id：', [...retiredIds(before)].length);

for (const id of IDS) {
  const r = retireRecord('frontier', id, { hard: true });
  console.log(`硬删复活行 ${id} → 移除 ${r.removed} 行，备份 ${r.trash}`);
}

const after = loadStore('frontier').records;
const dup = after.map((r) => r.id).filter((id, i, a) => a.indexOf(id) !== i);
console.log('清理后行数：', after.length, '｜当前集：', currentRecords(after).length, '｜重复 id：', dup.length ? dup.join(',') : '无');
console.log('四条 base id 现在还物理存在吗：', IDS.map((id) => id + '=' + after.filter((r) => r.id === id).length).join('  '));
