// c2-final.mjs —— 台账补时间序列/召回识别缺口/矛盾式漏召 + A/B 设计挂索引 + canon 记录
import { readFileSync, writeFileSync } from 'node:fs';
import { loadStore, currentRecords, revise } from './lib.mjs';

const OSS = '<LOCAL_PATH>\\dist\\akasha-oss';
const F = OSS + '\\docs\\observation-ledger.md';
let t = readFileSync(F, 'utf8');
const anchor = '**C2 已落地（2026-10-10，外部评审指定的第一优先）**';
const add = [
  '**漏召率时间序列（2026-10-10 分析）**：按天 10-06 82% → 10-07 74% → 10-08 100% → 10-09 83% → 10-10 100%；**自上线首日即高位、无"某点之后抬升"**（按小时亦零散，无聚集）。失败**绝对数**反而下降（17→19→12→6→5，约 3×）。日样本仅 5–19 条 ⇒ **日间差在噪声内，不判 breakpoint**（不编造趋势）。',
  '**度量有效性缺口（自认）**：识别"召回动作"的口径只认 `mcp__akasha__*` 只读工具 + 被标注的 akasha CLI 子命令；**经 `dsh_wsl` 的 CLI 查库在 2026-10-10 之前不计入召回**（当日才补），其它未识别路径同理 ⇒ **真实漏召率可能低于 84.7%**。',
  '**新类别：矛盾式漏召（用户观察，2026-10-10）**：日常几乎无"明显遗忘"；唯一显著实例是**同一会话内自相矛盾**（npm 暂存事实：先经用户截图实证"队列为空"，后被 E409 措辞推翻）。⇒ 冲突裁决顺序钉死：**用户实证 > 库内记录 > 工具输出措辞**；"状态性事实"（发布/审核/文件/配置/版本/开关）**断言前必查**。',
  '',
  '**C2 v2（2026-10-10，外部评审建议）**：判定改**显式"工具→坑条目"映射表**（`RECALL_TRAP_MAP`：pwsh/bash/edit/write/read/grep/dsh_wsl/codex_exec/apply_patch → 库内坑条目 id），并**校验条目存在**（退役/更名即自动失效，不悬空）；结构性工具（web_fetch/web_search）永不入表。替换 v1 的"按工具名强命中"（那条会**仅提到该工具**也算命中）。',
  '**A/B 对照实验设计**：见 [`docs/ab-experiment-design.md`](ab-experiment-design.md)（双臂交替 + 20 题配对 + 盲评；H1 同坑复发率 / H2 失败复现率 / H3 不可逆前查库率 / H4 任务分 / **H5 矛盾式漏召**；过程指标与结果指标分栏；负结果同需入 canon）。',
  '',
  anchor,
].join('\n');
if (t.includes('漏召率时间序列')) console.log('  [ledger] already');
else if (t.includes(anchor)) { writeFileSync(F, t.replace(anchor, add), 'utf8'); console.log('  [ledger] timeline + caveats + C2v2 + A/B index inserted'); }
else console.log('  [ledger] anchor MISS');

// README 索引补 A/B 设计
const R = OSS + '\\README.md';
let rt = readFileSync(R, 'utf8');
if (!rt.includes('ab-experiment-design')) {
  rt = rt.replace('- `docs/observation-ledger.md`', '- `docs/ab-experiment-design.md` —— **开/关对照实验设计**（H1–H5 判决变量、双臂交替、盲评、负结果也入库）\n- `docs/observation-ledger.md`');
  writeFileSync(R, rt, 'utf8');
  console.log('  [README] A/B design linked');
} else console.log('  [README] already');

// canon
const recs = currentRecords(loadStore('canon').records);
const hit = recs.filter((r) => String(r.id).startsWith('canon-observation-ledger-20261010')).pop();
const marker = '**C2 v2 + 时间序列 + A/B 设计（2026-10-10 续）**';
if (String(hit.claim).includes(marker)) { console.log('  [canon] already'); process.exit(0); }
const canonAdd = ' ' + marker + '：① **C2 v2 已落地**——`RECALL_TRAP_MAP` 显式映射表（工具→坑条目 id，带存在性校验；结构性工具永不入表），替换 v1 的"按工具名强命中"（偏宽）；活树核心 **139/139** 全绿。' +
  '② **漏召率时间序列**：10-06 82% / 10-07 74% / 10-08 100% / 10-09 83% / 10-10 100% —— **首日即高位、无抬升点**（日样本 5–19，差在噪声内）；失败绝对数降约 3×（17→5）。**无任何一次阿卡夏改动对应上升**；另发现**度量有效性缺口**：`dsh_wsl` 等未识别路径的查库此前不计召回 ⇒ 真实漏召率可能偏低。' +
  '③ **新类别：矛盾式漏召**（用户观察）：日常几乎无遗忘，唯一显著实例＝**同一会话内自相矛盾**（npm 暂存事实）；据此钉死**冲突裁决顺序：用户实证 > 库内记录 > 工具输出措辞**，并把"状态性事实断言前必查"定为行为纪律。' +
  '④ **A/B 对照实验设计**入仓（`docs/ab-experiment-design.md`）：H1 同坑复发率 / H2 失败复现率 / H3 不可逆前查库率 / H4 任务分（盲评）/ **H5 矛盾式漏召**；双臂交替、20 题配对、过程指标与结果指标分栏、**负结果同样入库**；执行需解冻（关注入行/空库开关属功能类）。';
const next = revise('canon', hit.id, { claim: hit.claim + canonAdd, last_reviewed: '2026-10-10' });
console.log('  [canon] ' + hit.id + ' → ' + next.id);
