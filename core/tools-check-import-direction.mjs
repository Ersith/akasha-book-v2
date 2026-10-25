// 模块 import 方向 lint（P4，2026-10-20）：读 contract.mjs，检查根级核心 .mjs 的层方向、断链、环与未登记模块。
// 退出码：0 = 全绿；1 = 有错误。CI/本地同源；不写任何文件。
import { checkImportDirection, CONTRACT_VERSION } from './contract.mjs';

const r = checkImportDirection();
if (r.ok) {
  console.log(`OK contract v${CONTRACT_VERSION}：${r.checked} 个根模块 / ${r.edges.length} 条 import，方向全绿。`);
  process.exitCode = 0;
} else {
  console.error(`FAIL contract v${CONTRACT_VERSION}：${r.errors.length} 个问题`);
  for (const e of r.errors) console.error(' - ' + e);
  process.exitCode = 1;
}
