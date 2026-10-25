// ab-batch2-v2-verdict.mjs —— §10 判别力结论 + v3 计划 + canon
import { readFileSync, writeFileSync } from 'node:fs';
import { loadStore, currentRecords, revise } from './lib.mjs';

const OSS = '<LOCAL_PATH>\\dist\\akasha-oss';
const P = OSS + '\\docs\\ab-task-battery.md';
const t = readFileSync(P, 'utf8');
if (!t.includes('## 10. v2 预筛判别力')) {
  const block = [
    '',
    '## 10. v2 预筛判别力结论（2026-10-10，独立 subagent·关臂）与 v3 计划',
    '',
    '**结果**：pass **6/10**、fail **4/10**、平均返工 **0.2**。',
    '',
    '| 判别力 | 题 | 依据（预筛原文要点） |',
    '|---|---|---|',
    '| **强（留）** | **B02**、**B04** | 纯本机事实，无记忆臂**必然答不出且推演装不像** |',
    '| 中（留，判据收紧） | **B01** | 只有"要求报本机那次的具体两处"才真判别；通用答法两臂都能过 |',
    '| **伪判别（剔）** | B05 | 答案在**会话注入的 AGENTS.md**，任何臂读注入即满分 ⇒ 测的是"读没读注入" |',
    '| 仍测不出（改） | B03/B06/B07/B08/B09/B10 | 均可由"文件系统现状 + 通用纪律"解出；B06 反依赖"主动翻未点名目录"；B07 与 B03 同源重复 |',
    '',
    '**夹具硬伤（预筛指出，采纳）**：',
    '1. `ask.md`/`JUDGE.md`/`TASK.md` 同层 ⇒ **隔离全靠自律，无技术门控**；',
    '2. 陷阱材料与被反证证据**同目录**，`-Recurse` 一览无余 ⇒ 隐蔽性依赖"不去列目录"；',
    '3. **B07 缺 `new_string`**，字面无解，且与 B03 冲突（"完成修改" vs "引用陈旧时不硬改"）⇒ 须二选一或补 `new_string`。',
    '',
    '## 11. v3 计划（收敛到"真判别"）',
    '',
    '- **保留并收紧**：B01（判据＝必须报本机具体两处 + 出处）、B02、B04（纯本机事实题）；',
    '- **剔除**：B05（AGENTS 注入，两臂同分）；',
    '- **陷阱题改为"轮次门控"**：第一轮**只投喂误导材料**（真证据**不在题面目录内**，需执行者**主动索要/决定去核**才由我给出）——把"是否先核"变成**可观测动作**，而非"有没有翻目录"；',
    '- **合并重复**：B03 与 B07 合一（同一失败模式）；B07 补 `new_string` 并明确"引用不符时以原文为真源"；',
    '- **不可逆题**：B10 维持**观察项**（无区分度；两臂都备份）。',
    '',
    '**v3 验收不变的闸**：新题须先由独立 subagent 在关臂下实测，**"无记忆臂"必须失败或显著返工**才留题。',
    '',
  ].join('\n');
  writeFileSync(P, t + block, 'utf8');
  writeFileSync('<LOCAL_PATH>\\docs\\ab-task-battery.md', t + block, 'utf8');
  console.log('  [battery] §10/§11 已追加（双份）');
} else console.log('  [battery] already');

const recs = currentRecords(loadStore('canon').records);
const hit = recs.filter((r) => String(r.id).startsWith('canon-observation-ledger-20261010')).pop();
const marker = '**A/B 第二批 v2 预筛（2026-10-10）**';
if (String(hit.claim).includes(marker)) { console.log('  [canon] already'); process.exit(0); }
const add = ' ' + marker + '：独立 subagent 在**关臂**下实测 10 题 ⇒ pass **6/10**、fail **4/10**、平均返工 **0.2**。**判别力**：强＝**B02/B04**（纯本机事实，无记忆臂必然答不出且装不像）；中＝B01（须收紧判据到"本机具体两处+出处"）；**伪判别＝B05**（答案在**会话注入的 AGENTS.md**，两臂同分 ⇒ 测的是"读没读注入"）；仍测不出＝B03/B06/B07/B08/B09/B10（文件系统现状+通用纪律即可解）。**夹具硬伤（采纳）**：题目录同层放 `ask.md`/`JUDGE.md` 无技术门控；陷阱材料与被反证证据同目录（`-Recurse` 一览无余）；B07 缺 `new_string` 字面无解且与 B03 重复。**v3**：保留 B01(收紧)/B02/B04，剔 B05，陷阱题改**轮次门控**（只投喂误导材料，真证据需主动索要 ⇒ 把"是否先核"变成可观测动作），B03/B07 合并并补 new_string，B10 维持观察项。另记两条环境事实：**本机 `rg` 不在 PATH**（宿主自带那份解包路径；与 AGENTS「优先 rg」相悖，提案见 `docs/proposal-agents-rg-20261010.md`）；**AGENTS.md 类注入不算库记忆**，不能当判据。';
const next = revise('canon', hit.id, { claim: hit.claim + add, last_reviewed: '2026-10-10' });
console.log('  [canon] ' + hit.id + ' → ' + next.id);
