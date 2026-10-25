// c2-record.mjs —— 台账补 C2 实数 + canon 记录（C2 落地 / npm 5-5 更正）
import { readFileSync, writeFileSync } from 'node:fs';
import { loadStore, currentRecords, revise } from './lib.mjs';

// ① 台账 §1 补 C2 实数与口径局限
const F = '<LOCAL_PATH>\\dist\\akasha-oss\\docs\\observation-ledger.md';
let t = readFileSync(F, 'utf8');
const anchor = '**候选对策（不实现，登记待评估；须测试期解冻后另行裁定）**';
const insert = [
  '**C2 已落地（2026-10-10，外部评审指定的第一优先）**：`metrics` 的召回信号扩为**分层口径**——',
  '- 原始：失败回合 **59** · 未查库 **50（84.7%）** · 事后才查 7；',
  '- **可预防口径**：库内有同类坑的失败 **44** 次，其中漏召 **40** 次 ⇒ **可预防漏召率 90.9%**；',
  '- 按工具 top3：`edit×24`（未查 22 / 可预防漏 22）· `web_fetch×12`（未查 7，**结构性豁免**）· `pwsh×10`（未查 9 / 可预防漏 9）；',
  '- 判定（`recallToolTraps()`）：工具名在库内有**强命中**即视为"有坑可查"；**结构性工具（web_fetch / web_search）永久豁免**（网络/环境类，任何库都预防不了）；',
  '- **口径局限（自认）**：v1 是"按工具名查强命中"，会把**仅仅提到该工具**的条目也算命中（偏宽）；下一步可换"工具→坑条目"的显式映射表。分母口径 = **库内有坑的失败数**（44），不是全部失败（59）。',
  '',
  anchor,
].join('\n');
if (t.includes('C2 已落地（2026-10-10')) { console.log('  [ledger] already'); } else if (t.includes(anchor)) { writeFileSync(F, t.replace(anchor, insert), 'utf8'); console.log('  [ledger] C2 numbers inserted'); } else console.log('  [ledger] anchor MISS');

// ② canon：台账条目追加（含 npm 更正）
const recs = currentRecords(loadStore('canon').records);
const hit = recs.filter((r) => String(r.id).startsWith('canon-observation-ledger-20261010')).pop();
const marker = '**C2 落地 + npm 更正（2026-10-10 晚）**';
if (String(hit.claim).includes(marker)) { console.log('  [canon] already'); process.exit(0); }
const add = ' ' + marker + '：① **C2 分层度量已实现**（外部评审第一优先）：`recallSignals(records,{toolTraps})` 增 `byTool` 分层与 `preventable` 口径，`recallToolTraps()` 以"工具名在库内有强命中"判可预防，**结构性工具 web_fetch/web_search 永久豁免**（实测：豁免前误判 web_fetch 为可预防）；`metrics` 渲染加"可预防口径 + 按工具 top3"。**实数**：失败 59 → 未查库 50（84.7%）；**可预防**：库内有坑的失败 44、其中漏召 40 ⇒ **可预防漏召率 90.9%**；top3 `edit×24` / `web_fetch×12(豁免)` / `pwsh×10`。口径局限（按工具名强命中，偏宽）与改进方向（显式映射表）已写进台账 §1。**验证**：活树核心 **139/139**、仓核心 **138/138**（含新增 C2 用例与镜像断言兼容）；同时修两处因"镜像补标改名 -r1"而过期的断言。' +
  ' ② **npm 更正（第二次同坑）**：`sleep@1.5.4` **其实早已发布**——registry `versions` 含 1.5.4、`dist-tags.latest=1.5.4`、`npm stage list` 显示无暂存件；此前"已暂存待 2FA"是 **E409 措辞（previously staged）+ 本地缓存滞后**造成的第二次误判（首次是 session 0.3.1）。⇒ **五包 5/5 全部在架且 latest 指向新版**（gate 1.2.4 / hooks 1.2.3 / **sleep 1.5.4** / session 0.3.1 / mcp 1.1.1）；**Claude 解冻闸的第 4 项已满足**。核验纪律再强调：只看 `versions` 数组 + `dist-tag ls`，两处都 `--prefer-online`，**别信 E409 的措辞**。';
const next = revise('canon', hit.id, { claim: hit.claim + add, last_reviewed: '2026-10-10' });
console.log('  [canon] ' + hit.id + ' → ' + next.id);
