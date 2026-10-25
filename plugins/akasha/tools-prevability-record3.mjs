// prevability-record3.mjs —— §12（步2+3 结果 + Claude 三条补充）+ canon
import { readFileSync, writeFileSync } from 'node:fs';
import { loadStore, currentRecords, revise } from './lib.mjs';

const OSS = '<LOCAL_PATH>\\dist\\akasha-oss';
const P = OSS + '\\docs\\recall-preventability-test-plan.md';
let t = readFileSync(P, 'utf8');
if (!t.includes('## 12.')) {
  const block = [
    '',
    '## 12. Claude 二轮补充（已采纳）与步 2+3 结果（2026-10-10）',
    '',
    '**二轮补充**：① 会话级 r **必须与回合级并排报**（最大簇 37，只报回合级会误导）；② 步 2 对 `edit` 用**固定模板**（`edit 改前读原文 上下文失配`），少自由发挥；③ 步 3 时序筛选用 **snapshot 按失败日切库**，报告写明**每条用的快照哈希**。',
    '',
    '**步 2+3 执行结果**（`_scratch/prevability/queries-hits.jsonl`）：',
    '- 粗口径：49 条中 **16 条**有"**合法强命中**"（命中分 ≥1 且条目在失败日**已存在**）——回合级看约 **33%**；**会话级口径待步 4 一并报**（最大簇 37 会把两套数字拉开）。',
    '- 按工具：`grep 5/5`·`read 4/4`（这两类**几乎必然可预防**）· `edit 3/23` · `web_fetch 1/12`（结构性豁免，不入可预防）· `agent-error/dsh_wsl/pwsh` 各 1。',
    '- **供给缺口（新发现）**：`edit` 的固定模板问句仅命中 3/23 ⇒ **库里缺"edit 上下文失配"的针对性条目**——我们有"改前先读"的教训散记，但没有一条**可直接执行的条目**（这正是 C1"易错点前置"要补的料）。',
    '- 每条命中都带 `snapshot_hash`（失败日 canon 条目集哈希），满足"报告写明快照哈希"。',
    '',
    '**待做（步 4+5）**：双评（我 + 第三方盲判，**一致率按三档分开报**；首 15 条精判校准准则卡 → 中间粗判 → 末 10 条再精判）→ 三档表（该算/不该算/存疑）→ **阈值推导**（用"可容忍漏掉次数"表达）。',
    '',
  ].join('\n');
  writeFileSync(P, t + block, 'utf8');
  writeFileSync('<LOCAL_PATH>\\docs\\recall-preventability-test-plan.md', t + block, 'utf8');
  console.log('  [plan] §12 已追加（仓 + 工作区双份同步）');
} else console.log('  [plan] already');

const recs = currentRecords(loadStore('canon').records);
const hit = recs.filter((r) => String(r.id).startsWith('canon-observation-ledger-20261010')).pop();
const marker = '**可预防性测试 步2+3（2026-10-10）**';
if (String(hit.claim).includes(marker)) { console.log('  [canon] already'); process.exit(0); }
const add = ' ' + marker + '：① Claude 二轮三条已采纳（**会话级 r 必须并排报**／`edit` 用**固定模板**少自由发挥／时序筛选用 snapshot 切库并在报告写明**快照哈希**）；② 步 2+3 完成：`_scratch/prevability/queries-hits.jsonl`——49 条中 **16 条有"合法强命中"**（≥1 分且条目在失败日已存在，回合级约 33%；会话级待步 4 并报）；按工具 `grep 5/5`·`read 4/4`·`edit 3/23`·`web_fetch 1/12（豁免）`；③ **新发现供给缺口**：`edit` 固定模板仅命中 3/23 ⇒ 库里缺"edit 上下文失配"的**可执行条目**（C1 易错点前置缺料）；④ 待做：步 4 双评（一致率三档分开报；首末精判防疲劳）→ 步 5 三档表 + 阈值推导（用"可容忍漏掉次数"表达）。';
const next = revise('canon', hit.id, { claim: hit.claim + add, last_reviewed: '2026-10-10' });
console.log('  [canon] ' + hit.id + ' → ' + next.id);
