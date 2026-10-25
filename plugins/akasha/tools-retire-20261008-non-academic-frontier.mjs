// 2026-10-08：把 4 条非学术来源从 frontier 当前集里退役（软退役；内容已转 canon）。
// 为什么用脚本而不是 CLI --reason：见 canon-powershell-native-args-20261008——中文经命令行参数会被 ANSI 截断。
import { retireRecord } from './lib.mjs';

// 一次性脚本（2026-10-08 复查教训）：这类「按某次裁定改变库状态」的脚本正常重跑必须 no-op——
// 否则一次重放又追加一条墓碑（当晚真的发生了）。需要重放请显式设 AKASHA_ALLOW_REPLAY=1。
if (process.env.AKASHA_ALLOW_REPLAY !== '1') {
  console.log('一次性脚本：已执行过，本次不改变任何数据（需要重放请设 AKASHA_ALLOW_REPLAY=1）。');
  process.exit(0);
}

const REASON = '非基石：这是工具/教程/文档类资料，按 2026-10-08 用户裁定，frontier 只收来源可靠且有学术或前沿背景的组织之论文文献；内容已转入 canon（canon-tool-joycaption-20261008 / canon-tool-animalorastudio-20261008 / canon-guide-kohya-bucket-20261008 / canon-guide-depth-controlnet-20261008）。';

const IDS = [
  'frontier-joycaption-comfyui-node',
  'frontier-animalorastudio-anime-lora',
  'frontier-kohya-bucket-management-doc',
  'frontier-depth-controlnet-tutorial-comfyui',
];

for (const id of IDS) {
  const r = retireRecord('frontier', id, { reason: REASON });
  console.log(r.already ? `已是退役态 ${id}` : `已退役 ${id} → 墓碑 ${r.tombstone}（链尾 ${r.retired}）`);
}
