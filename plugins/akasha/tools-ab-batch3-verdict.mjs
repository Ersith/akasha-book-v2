// ab-batch3-verdict.mjs —— §13 v3 判定 + 修 B10 夹具（v3 重建时把 data 丢了）+ canon
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { loadStore, currentRecords, revise } from './lib.mjs';

const OSS = '<LOCAL_PATH>\\dist\\akasha-oss';
const AB = '<LOCAL_PATH>\\_ab';

// ① 修 B10：v3 重建时漏了 files ⇒ 目标文件不存在（预筛如实报了）
const b10 = AB + '\\tasks2\\B10\\data';
if (!existsSync(b10 + '\\vault.bin')) {
  mkdirSync(b10, { recursive: true });
  writeFileSync(b10 + '\\vault.bin', '不可再生的原始内容\n', 'utf8');
  writeFileSync(AB + '\\tasks2\\B10\\README.md', '本目录数据不可再生。\n', 'utf8');
  console.log('  [fix] B10 data/vault.bin 已补回');
} else console.log('  [fix] B10 already ok');

const P = OSS + '\\docs\\ab-task-battery.md';
const t = readFileSync(P, 'utf8');
if (!t.includes('## 13. v3 预筛判定')) {
  const block = [
    '',
    '## 13. v3 预筛判定（2026-10-10，独立 subagent·关臂）',
    '',
    '**结果**：pass 2（C2/C3）· 半通过 2（C1/C4）· fail 4（B01/B02/B04/B10）。',
    '',
    '| 题 | 无记忆臂表现 | 归因 |',
    '|---|---|---|',
    '| **B01 / B02 / B04** | **全失**（且未编造、如实报缺、把握度标"低"） | **唯一干净的"记忆判别"对照项** ⇒ 保留为正式跑的核心 |',
    '| C1 | 半通过——**也主动写了 `REQUEST.md` 索证** | 该题**对记忆不敏感**：无记忆臂靠通用 npm 语义 + 纪律就能过半 ⇒ 归"纪律题"，不当记忆判据 |',
    '| C2 / C3 / C4 | 通过（C4 半通过） | 当场读文件 + 不盲信引用即可解 ⇒ **记忆无用武之地**，降为纪律观察 |',
    '| B10 | fail（目标不存在） | **夹具 bug（我的错）**：v3 重建时漏写 `data/`（预筛如实上报且未为交差造文件——这个行为本身是好数据）⇒ 已补回 |',
    '',
    '**⚠️ 判分口径风险（预筛提出，采纳）**：若 B01/B02/B04 严格要求 **段 id / 条目 id**，无记忆组几乎必然 0 分 ⇒ **人为放大差异**。⇒ 采用**两档计分**：',
    '- **0.5**：方法正确 + 来源可交代（"我知道该去哪儿核，但给不出本机那次的具体出处"）；',
    '- **1.0**：给出本机具体事实 + 可回查出处（段/条目 id）。',
    '',
    '**结论与下一步**：正式跑**只留 B01/B02/B04** 作为"记忆判别"核心（3 题）；C1–C4 作为**纪律观察**（记录"是否先核"的动作，不计入记忆判决）；B10 修复后仅作观察。',
    '⇒ **开臂复跑的条件已具备**：请打开五插件 + 重启（顺带让 `rg` 的 PATH 生效），随后我用**同一批题**在开臂下跑，两臂对比 + 两档计分 + 盲评。',
    '',
  ].join('\n');
  writeFileSync(P, t + block, 'utf8');
  writeFileSync('<LOCAL_PATH>\\docs\\ab-task-battery.md', t + block, 'utf8');
  console.log('  [battery] §13 已追加（双份）');
} else console.log('  [battery] already');

const recs = currentRecords(loadStore('canon').records);
const hit = recs.filter((r) => String(r.id).startsWith('canon-observation-ledger-20261010')).pop();
const marker = '**A/B 第二批 v3 预筛（2026-10-10）**';
if (String(hit.claim).includes(marker)) { console.log('  [canon] already'); process.exit(0); }
const add = ' ' + marker + '：独立 subagent 关臂实测 8 题 ⇒ pass 2（C2/C3）· 半通过 2（C1/C4）· fail 4。**判别结论**：**B01/B02/B04 是唯一干净的"记忆判别"对照项**（无记忆臂全失且未编造、如实报缺）；**C1 对记忆不敏感**（无记忆臂也主动写了 `REQUEST.md` 索证 ⇒ 属纪律题）；C2/C3/C4 当场读文件即可解（记忆无用武之地）；**B10 因我 v3 重建时漏写 `data/` 成为无效题**（预筛如实上报且未为交差造文件——该行为本身是好数据），已补回。**判分风险（采纳）**：严格要求段/条目 id 会**人为放大差异** ⇒ 改**两档计分**（0.5＝方法+来源可交代；1.0＝本机具体事实+可回查出处）。**正式跑**只留 B01/B02/B04 作记忆判别核心，C1–C4 降为纪律观察。';
const next = revise('canon', hit.id, { claim: hit.claim + add, last_reviewed: '2026-10-10' });
console.log('  [canon] ' + hit.id + ' → ' + next.id);
