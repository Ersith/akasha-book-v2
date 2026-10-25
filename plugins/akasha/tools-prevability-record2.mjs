// prevability-record2.mjs —— 计划修订 + 台账口径修正 + canon（修正数组语法后重跑）
import { readFileSync, writeFileSync } from 'node:fs';
import { loadStore, currentRecords, revise } from './lib.mjs';

const OSS = '<LOCAL_PATH>\\dist\\akasha-oss';
const NL = '\n';

// ① 计划文档追加
const P = OSS + '\\docs\\recall-preventability-test-plan.md';
let t = readFileSync(P, 'utf8');
if (!t.includes('评审后修订（Claude')) {
  const rows = [
    '| # | 评审补充 | 落实方式 |',
    '|---|---|---|',
    '| 1 | **问句模板卡**：先给短模板（工具名 + 报错关键字 + 操作意图），再人工改写——减后见之明 | §4 步 2 加"模板卡先行"；示例：`<工具> <报错关键字> <意图> 坑` |',
    '| 2 | **会话簇标注**：同会话多失败**不得当独立样本**；报**回合级 r** 与**会话级 r** 两套 | 已落 `cases.jsonl` 的 `cluster_size`；实测最大簇 37 ⇒ 两套 r 差距会很大 |',
    '| 3 | **库时序防泄漏**：机器初筛只许用**失败时刻之前**的库版本 | 已落 `library-snapshot.json`（按日 canon/orphan 条目集 + 哈希） |',
    '| 4 | **基准库快照必做**（否则不可复现） | 同 3；`cases.sha256` 一起钉死 |',
    '| 5 | **存疑单列、不折半**；一致率**按三档分开报** | §2/§5/§6 已改口径 |',
    '| 6 | 全量可做，但**首 15 条精判校准准则卡 → 中间粗判 → 末 10 条再精判**防疲劳漂移 | §4 加分段法 |',
  ].join(NL);
  const block = [
    '',
    '---',
    '',
    '## 10. 评审后修订（Claude，2026-10-10；已采纳）',
    '',
    rows,
    '',
    '**Claude 对 §9 八问的答复（要点）**：覆盖准则够硬、存疑宁紧不错；盲化可行但**必须模板约束**；威胁补"会话内非独立 / 库时序泄漏 / 问句改写次数的选择偏差"；**用"可容忍漏掉次数"定阈值更诚实**（可并行报百分比便于沟通）；存疑单列不折半；**A/B 重犯更强但贵**——本法先定分母，有余力再抽"可预防子集做关闭臂回放"。**结论**：可开干；优先落地取证脚本、快照、双评准则卡，阈值等三档表出来再定。',
    '',
    '## 11. 第 1 步执行结果与当场发现（2026-10-10）',
    '',
    '- **取证完成**：`_scratch/prevability/cases.jsonl`（**49** 条，sha256 `264840df56c8`）+ `library-snapshot.json`（逐日 canon/orphan 条目集与哈希）+ `cases.sha256`。',
    '- **当场发现（口径缺陷，已修）**：原 59 条"失败"里 **11 条是门控拒绝**（守卫按设计工作）⇒ 被计成任务失败，漏召率被自家守卫灌水。修正后：**失败 49 · 未查库 41 · 漏召率 83.7% · 可预防口径 34/31 ⇒ 91.2%**；回归断言入核心套件（**140/140**）。',
    '- **失败类分布（修正后）**：`edit` 上下文失配 **21**（最大类，**可预防**：改前先读原文）· 环境/网络 **7**（结构性豁免）· 其余语法/其它。',
    '- **待做**：步 2（模板卡 + 盲造问句）→ 步 3（带时序约束的机器初筛）→ 步 4（双评，一致率按三档分开报）→ 步 5（三档表 + 阈值推导）。',
    '',
  ].join(NL);
  writeFileSync(P, t + block, 'utf8');
  console.log('  [plan] 已追加评审修订 + 第 1 步结果');
} else console.log('  [plan] already');

// ② 台账口径修正
const L = OSS + '\\docs\\observation-ledger.md';
let lt = readFileSync(L, 'utf8');
const anchor = '**C2 已落地（2026-10-10，外部评审指定的第一优先）**';
if (lt.includes('口径修正（2026-10-10，可预防性测试第 1 步')) console.log('  [ledger] already');
else if (lt.includes(anchor)) {
  const note = '**口径修正（2026-10-10，可预防性测试第 1 步当场发现）**：原「失败 59 / 未查库 50 / 84.7% / 可预防 44-40-90.9%」**含 11 条门控拒绝**（守卫按设计工作，非任务失败）⇒ 修正为 **失败 49 · 未查库 41 · 83.7% · 可预防 34-31-91.2%**；回归断言入核心套件（140/140）。*教训：度量分母也要"防自家组件灌水"。*' + NL + NL + anchor;
  writeFileSync(L, lt.replace(anchor, note), 'utf8');
  console.log('  [ledger] 口径修正已记');
} else console.log('  [ledger] anchor MISS');

// ③ canon
const recs = currentRecords(loadStore('canon').records);
const hit = recs.filter((r) => String(r.id).startsWith('canon-observation-ledger-20261010')).pop();
const marker = '**可预防性测试开跑（2026-10-10）**';
if (String(hit.claim).includes(marker)) { console.log('  [canon] already'); process.exit(0); }
const canonAdd = ' ' + marker + '：① **计划成文并过审**（`docs/recall-preventability-test-plan.md`；Claude 六条补充已采纳：问句模板卡 / 会话簇双口径 r / **库时序防泄漏** / 基准快照 / 存疑单列·一致率分档 / 首末精判防疲劳）；② **第 1 步执行完成**：`_scratch/prevability/cases.jsonl`（49 条，sha `264840df56c8`）+ `library-snapshot.json`（逐日条目集+哈希）+ `cases.sha256`；③ **当场发现口径缺陷并修复**：原 59 条含 **11 条门控拒绝**（守卫按设计工作却被计成任务失败）⇒ 修正为 **失败 49 · 未查库 41（83.7%）· 可预防 34/31（91.2%）**，核心套件 **140/140**（新增回归：门控拒绝不得计入失败）；失败类分布：`edit` 上下文失配 **21**（最大且可预防）· 环境/网络 7（结构性豁免）；④ 待做：模板卡+盲造问句 → 时序约束机器初筛 → 双评（一致率分档）→ 三档表 + 阈值推导。';
const next = revise('canon', hit.id, { claim: hit.claim + canonAdd, last_reviewed: '2026-10-10' });
console.log('  [canon] ' + hit.id + ' → ' + next.id);
