// 2026-10-08 收尾清理（一次性）：把 4 条非学术条目在 frontier 里的全部残迹删干净
// （含被误重放的墓碑/重复行），目标终态：行数=136、当前集=123、退役 id=0、无重复 id。
// ⚠️ 一次性脚本：正常重跑会 no-op（见 _oneShot 守卫），需要重放请设 AKASHA_ALLOW_REPLAY=1。
import { retireRecord, loadStore, currentRecords, retiredIds } from './lib.mjs';

if (process.env.AKASHA_ALLOW_REPLAY !== '1') {
  console.log('一次性脚本：已收官，本次不改变任何数据（需要重放请设 AKASHA_ALLOW_REPLAY=1）。');
  process.exit(0);
}

const IDS = [
  'frontier-joycaption-comfyui-node',
  'frontier-animalorastudio-anime-lora',
  'frontier-kohya-bucket-management-doc',
  'frontier-depth-controlnet-tutorial-comfyui',
];

const before = loadStore('frontier').records;
console.log('清理前：行数', before.length, '｜当前集', currentRecords(before).length, '｜退役 id', [...retiredIds(before)].length);
for (const id of IDS) {
  try {
    const r = retireRecord('frontier', id, { hard: true });
    console.log(`  ${id} → 移除 ${r.removed} 行（备份 ${r.trash}）`);
  } catch (e) {
    console.log(`  ${id} → 无需处理（${String(e.message).slice(0, 40)}）`);
  }
}
const after = loadStore('frontier').records;
const dup = after.map((r) => r.id).filter((id, i, a) => a.indexOf(id) !== i);
console.log('清理后：行数', after.length, '｜当前集', currentRecords(after).length, '｜退役 id', [...retiredIds(after)].length, '｜重复 id', dup.length ? dup.join(',') : '无');
