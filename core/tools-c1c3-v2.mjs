// c1c3-v2.mjs —— 把 Claude 评审的 8 条修订写进 C1/C3 计划（§7 v2）+ canon
import { readFileSync, writeFileSync } from 'node:fs';
import { loadStore, currentRecords, revise } from './lib.mjs';

const OSS = '<LOCAL_PATH>\\dist\\akasha-oss';
const P = OSS + '\\docs\\c1-c3-schedule.md';
let doc = readFileSync(P, 'utf8');
if (!doc.includes('## 7. 评审后修订（Claude')) {
  const block = [
    '',
    '## 7. 评审后修订（Claude，2026-10-10；**全部采纳**）',
    '',
    '> 评审前置判断：**"方向对，可以按这个解冻写；『知识够了缺执行点』这个判断成立。"**',
    '',
    '| # | 评审意见 | 落实（v2 定稿） |',
    '|---|---|---|',
    '| 1 | **C1 触发偏松**：edit 每天几十次会"每回合都响" | 触发加**两个前置**：① **本回合尚未发生查库/取证动作**；② 24h 失败改为「**近 N 次同工具失败 ≥ 1**」（N 初值 20，可调）。 |',
    '| 2 | 每回合 ≤1 够紧；**同回合都命中时 C3 优先** | 定为：**C3 > C1**；C1 顺延下一回合，**或**与 C3 并入同一行（分号分隔，仍 ≤80 字） |',
    '| 3 | **C3 词表先窄**，别一开始铺开 | v1 词表仅 6 项：`已发布/未发布` · `已安装/未安装` · `版本号` · `开关状态` · `存在与否` · `已过审/未过审`；漏报再加 |',
    '| 4 | **普通只提醒；不可逆要强阻断，但别塞进 C1/C3** | 采纳：覆盖/删除/`git push`/`--hard` 这类**放到门控（gate）里做强阻断**，C1/C3 仍只提醒 |',
    '| 5 | 7 天可以，**但要写基线**，别口头对比 | 加**基线期**：观察前 **5–7 天**先跑同口径指标（不开启提示）⇒ 观察期与基线**同口径对比**，写进结论 |',
    '| 6 | **别合并 C1/C3**；先上 C1，C3 紧随 | 采纳：C1 先（`edit` 失配是最大类），C3 紧随；两者独立开关、独立 order |',
    '| 7 | 补充：提示行**带条目 id 很好** | 保留 `—— 条目 <id>`；并**加"关闭时 hooks 也不写假触发"**（`preflightHints:false` ⇒ **不记** preflight 事件） |',
    '| 8 | 补充：观察脚本**会话级与回合级分开报** | 观察输出固定两栏：**会话级同坑复发**（同一会话内重复踩同坑的次数）与**回合级同坑复发** |',
    '',
    '**据此的 v2 定稿要点（与 §1/§2 的差异）**：',
    '- C1 触发 = `T ∈ RECALL_TRAP_MAP` ∧ `近 20 次调用 T 中有失败` ∧ `本回合尚无查库动作`；',
    '- 优先级 = `C3` 先于 `C1`；同一回合两条命中时**并一行**（分号分隔）；',
    '- C3 词表 = 上述 6 项（**先窄**）；',
    '- **不可逆强阻断归 gate**（不在本计划实现，另立）；',
    '- 基线期 **5–7 天** → 观察期；指标**两级分列**；',
    '- 关闭开关 ⇒ 提示与事件**双停**（不产生假数据）。',
    '',
    '**执行前提**：解冻授权（属功能）。**先做 C1**，C3 紧随。',
    '',
  ].join('\n');
  writeFileSync(P, doc + block, 'utf8');
  writeFileSync('<LOCAL_PATH>\\docs\\c1-c3-schedule.md', doc + block, 'utf8');
  console.log('  [plan] §7 评审修订已追加（双份）');
} else console.log('  [plan] already');

const recs = currentRecords(loadStore('canon').records);
const hit = recs.filter((r) => String(r.id).startsWith('canon-observation-ledger-20261010')).pop();
const marker = '**C1/C3 计划过审（2026-10-10）**';
if (String(hit.claim).includes(marker)) { console.log('  [canon] already'); process.exit(0); }
const add = ' ' + marker + '：Claude 判「方向对、**可以按这个解冻写**；『知识够了缺执行点』成立」，并给 8 条修订（**全部采纳**）：① C1 触发加两个前置（**本回合尚未查库** + 24h 改为**近 20 次同工具失败 ≥1**），否则 edit 每天几十次会每回合响；② 同回合两命中时 **C3 优先**，C1 顺延或**并一行**；③ C3 词表**先窄**（仅 6 项）；④ **不可逆强阻断归 gate**，不塞进 C1/C3；⑤ 7 天观察**须写基线期（前 5–7 天同口径）**，不许口头对比；⑥ **不合并 C1/C3**，先 C1（edit 失配是大头）、C3 紧随；⑦ 提示行**带条目 id** + **关闭时 hooks 不写假触发**；⑧ 观察脚本**会话级与回合级分列**。执行前提＝**解冻授权**。';
const next = revise('canon', hit.id, { claim: hit.claim + add, last_reviewed: '2026-10-10' });
console.log('  [canon] ' + hit.id + ' → ' + next.id);
