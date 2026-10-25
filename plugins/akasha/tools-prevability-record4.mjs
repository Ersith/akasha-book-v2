// prevability-record4.mjs —— 步4 校准结果（首批 15 条精判）+ 结论：初筛几乎全假阳性、当前可预防集合≈0
import { readFileSync, writeFileSync } from 'node:fs';
import { loadStore, currentRecords, revise } from './lib.mjs';

const OSS = '<LOCAL_PATH>\\dist\\akasha-oss';
const P = OSS + '\\docs\\recall-preventability-test-plan.md';
let t = readFileSync(P, 'utf8');
if (!t.includes('## 13.')) {
  const block = [
    '',
    '## 13. 步 4 校准批结果（首批 15 条精判，2026-10-10）',
    '',
    '> 抽样：**分层**（每 (会话×工具) ≤2 条，共 4 个会话）——避免首 15 条全落在同一簇（最大簇 37）造成的非独立偏差。',
    '',
    '| 判定 | 条数 | 案例 | 依据（准则卡） |',
    '|---|---|---|---|',
    '| **该算（覆盖）** | **0** | — | 无一条命中给出"成因或修复手法" |',
    '| **不该算·结构性豁免** | 4 | C004/C005/C040（`web_fetch` 网络与内容类型）、C030（传输层） | 与库内容无因果 |',
    '| **不该算·命中不覆盖** | 5 | C013/C025/C039/C041（`grep` exit 2）、C017/C031（`read` offset 越界） | 命中确为强命中但**主题相关**（讲 OSS 打包/会话基准），**非成因** |',
    '| **不该算·供给缺口** | 6 | C001/C002/C042（`edit` 失配）、C006（provider 方法名）、C015（未知工具名） | 当时**库里没有**对应可执行条目 ⇒ 当时不可预防 |',
    '',
    '**关键结论（推翻初筛）**：机器初筛报"16/49 有合法强命中"，**精判首批 15 条的真阳性为 0**——强命中**≠**覆盖，初筛精度极低（这正是"双评"存在的意义）。',
    '**更重要的推论**：在"库里有可执行条目"的意义上，**当前可预防集合 ≈ 0** ⇒ **现在讨论阈值没有分母**。',
    '**该做的不是定阈值，而是补料**：把反复出现的失败类写成**可执行条目**（`edit` 已补；待补：`read` offset 先查行数、`grep` exit 2 的路径/权限、未知工具名先查可用工具、provider 方法名先 list），',
    '让"可预防集合"**长出来**，再谈漏召率与阈值。',
    '',
    '**三档表（首批口径）**：该算 0 · 不该算 15（其中结构性 4 / 不覆盖 5 / 缺口 6）· 存疑 0。',
    '',
  ].join('\n');
  writeFileSync(P, t + block, 'utf8');
  writeFileSync('<LOCAL_PATH>\\docs\\recall-preventability-test-plan.md', t + block, 'utf8');
  console.log('  [plan] §13 已追加（双份同步）');
} else console.log('  [plan] already');

const recs = currentRecords(loadStore('canon').records);
const hit = recs.filter((r) => String(r.id).startsWith('canon-observation-ledger-20261010')).pop();
const marker = '**可预防性测试 步4 校准批（2026-10-10）**';
if (String(hit.claim).includes(marker)) { console.log('  [canon] already'); process.exit(0); }
const add = ' ' + marker + '：分层抽 15 条（每 会话×工具 ≤2，4 会话）精判 ⇒ **该算 0 · 不该算 15（结构性豁免 4 / 命中不覆盖 5 / 供给缺口 6）· 存疑 0**。' +
  '**推翻初筛**：机器初筛"16/49 有合法强命中"在精判首批里**真阳性为 0**——强命中≠覆盖，初筛精度极低（双评必要性的实证）。' +
  '**核心推论**：按"库里有可执行条目"的口径，**当前可预防集合 ≈ 0** ⇒ **阈值现阶段没有分母**；正确动作是**补料**（`edit` 已补；待补 `read` offset 先查行数、`grep` exit 2 路径/权限、未知工具名先查清单、provider 方法先 list）让集合长出来。' +
  '（与 Claude 的"阈值等三档表出来再定"一致，但更强：三档表大概率显示"该算≈0"。）';
const next = revise('canon', hit.id, { claim: hit.claim + add, last_reviewed: '2026-10-10' });
console.log('  [canon] ' + hit.id + ' → ' + next.id);
