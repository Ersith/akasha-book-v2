// ab-batch3-openarm-verdict.mjs —— §14 开臂结果（含污染披露）+ 修两处真缺陷 + canon
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadStore, currentRecords, revise } from './lib.mjs';

const OSS = '<LOCAL_PATH>\\dist\\akasha-oss';
const AB = '<LOCAL_PATH>\\_ab';

// ① 真缺陷修复：sleep README 版本漂移（subagent 实测：README 写 1.5.1，package.json 是 1.5.5-h1）
const readmes = [OSS + '\\plugins\\akasha-sleep\\README.md', '<LOCAL_PATH>\\dsh-akasha-sleep\\README.md'];
let fixedReadme = 0;
for (const f of readmes) {
  if (!existsSync(f)) continue;
  let t = readFileSync(f, 'utf8');
  const before = t;
  t = t.replace(/1\.5\.1/g, '1.5.5').replace(/1\.5\.4/g, '1.5.5');
  if (t !== before) { writeFileSync(f, t, 'utf8'); fixedReadme++; }
}
console.log('  [fix] sleep README 版本漂移已修：' + fixedReadme + ' 份');

// ② 真缺陷修复：C4 的 quotes.md 补 new_string（预筛指出"字面无解"）
const q4 = AB + '\\tasks3\\C4\\handed\\quotes.md';
if (existsSync(q4)) {
  const t4 = readFileSync(q4, 'utf8');
  if (!t4.includes('new_string')) {
    const patched = t4.split(/\r?\n/).filter(Boolean).map((l) => l + '  new_string="第 ' + (l.match(/files\/f(\d+)\.txt/) ?? [])[1] + ' 行（新）"').join('\n') + '\n';
    writeFileSync(q4, patched, 'utf8');
    console.log('  [fix] C4 quotes.md 已补 new_string');
  } else console.log('  [fix] C4 already');
}

const P = OSS + '\\docs\\ab-task-battery.md';
const t = readFileSync(P, 'utf8');
if (!t.includes('## 14. 开臂结果')) {
  const block = [
    '',
    '## 14. 开臂结果（2026-10-10，独立 subagent·开臂）与**三处无效声明**',
    '',
    '**结果**：pass **8/8**，平均返工 0.375（B10 1 · C2 1 · B02 0.5）。',
    '',
    '**⚠️ 三处不算数（我主动声明，不折算成"记忆的胜利"）**：',
    '1. **C1 / C2 被上一臂残留污染**：开臂跑之前**我没有 reset 题目录**——上一臂留在 `C1/REQUEST.md`（索证文件）与 `C2/target.txt`（已改）被本轮直接看到/沿用 ⇒ **C1"是否主动索证"、C2"是否先读原文"两个观测点失效**；',
    '2. **B02 的出处越界**：它读了 `_ab/README.md`（题目录之外）——虽然答案另有源码佐证，但**"只靠库记忆才能答出"的排他性被削弱**；',
    '3. **B10 与预期一致无区分度**（两臂都备份）。',
    '',
    '**真正有效的部分**：**B01 / B04** —— 开臂给出**可回查的库来源**（`canon-npm-publish-20261010-r1` / `canon-address-drift-fix-20261010`），关臂同题**全失且未编造**。⇒ 可支持的结论只有一条：**库里的本机事实确实能被检索命中并被引用**（记忆的"可达性"成立）。',
    '**不能**支持的结论：**"用了更好"仍无因果证据**（有效样本 n=2，且两臂是不同实例、条件不齐）。',
    '',
    '**流程修正（立即生效）**：**两臂之间必须重置题目录**——`git reset --hard seed && git clean -fd`（清掉上一臂产物与 `REQUEST.md`）。此前只在第一批做过，第二批**漏了**，代价是 2 题失效。',
    '',
    '**顺带收获（外部人眼更利的实例）**：① 它发现 **sleep README 版本漂移**（README 写 1.5.1、package.json 是 1.5.5-h1）⇒ 已修；② 它指出 **C4 的 quotes.md 只给 old_string** ⇒ 已补 `new_string`；③ 它报告 2 次工具失败（全仓 grep 超时、文件名猜错）—— 阿卡夏的**回查提示**当场触发（"近 30 分钟 2 次失败……先查库再继续"）✓ **这是一次真实的机制生效观测**。',
    '',
  ].join('\n');
  writeFileSync(P, t + block, 'utf8');
  writeFileSync('<LOCAL_PATH>\\docs\\ab-task-battery.md', t + block, 'utf8');
  console.log('  [battery] §14 已追加（双份）');
} else console.log('  [battery] already');

const recs = currentRecords(loadStore('canon').records);
const hit = recs.filter((r) => String(r.id).startsWith('canon-observation-ledger-20261010')).pop();
const marker = '**A/B 第二批开臂（2026-10-10）**';
if (String(hit.claim).includes(marker)) { console.log('  [canon] already'); process.exit(0); }
const add = ' ' + marker + '：独立 subagent 开臂实测 8 题 ⇒ pass **8/8**、平均返工 0.375。**三处无效声明（我主动标）**：① **C1/C2 被上一臂残留污染**——开臂前**漏做 reset**（`REQUEST.md`、已改的 `target.txt` 被沿用）⇒ 两个观测点失效；② **B02 越界读了 `_ab/README.md`** ⇒ "只靠库才能答出"的排他性削弱；③ B10 无区分度（预期）。**有效部分**：**B01/B04** 开臂给出**可回查库来源**（`canon-npm-publish-20261010-r1` / `canon-address-drift-fix-20261010`），关臂同题全失且未编造 ⇒ 只支持"**库里的本机事实可被检索命中并被引用**"（可达性成立）；**不支持"用了更好"**（有效 n=2、两臂非同条件）。**流程修正**：两臂之间必须 `git reset --hard seed && git clean -fd`（第二批漏做，代价 2 题失效）。**顺带**：外部人眼发现 **sleep README 版本漂移**（1.5.1 vs 1.5.5-h1，已修）与 **C4 缺 new_string**（已补）；其 2 次工具失败**当场触发阿卡夏回查提示** ⇒ 机制真实生效的一次观测。';
const next = revise('canon', hit.id, { claim: hit.claim + add, last_reviewed: '2026-10-10' });
console.log('  [canon] ' + hit.id + ' → ' + next.id);
