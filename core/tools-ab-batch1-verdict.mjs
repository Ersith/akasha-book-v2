// ab-batch1-verdict.mjs —— 第一批判定（闸门触发）+ 第二批重设计 + canon
import { readFileSync, writeFileSync } from 'node:fs';
import { loadStore, currentRecords, revise } from './lib.mjs';

const OUT = '<LOCAL_PATH>\\_ab';
const OSS = '<LOCAL_PATH>\\dist\\akasha-oss';
const log = readFileSync(OUT + '\\ab-log.jsonl', 'utf8').trim().split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const tasks = log.filter((r) => /^T\d\d$/.test(r.task));
const on = tasks.filter((r) => r.arm === 'on');
const off = tasks.filter((r) => r.arm === 'off');
const pass = (a) => a.filter((r) => r.result === 'pass').length;
const verdict = {
  ranAt: new Date().toISOString(),
  on: { n: on.length, pass: pass(on) },
  off: { n: off.length, pass: pass(off) },
  gateTriggered: pass(on) === on.length && pass(off) === off.length && on.length === off.length,
  notes: [
    '两臂 10/10 全过 ⇒ H1（同坑复发）/H2（失败复现）在第一批**无方向性差异**',
    '唯一一次失败发生在关臂首轮，且已查明为**起点污染（seed ref 误用）**，非臂效应，已作废重跑',
    'T06 夹具预置了实现 ⇒ 该题退化为"验证"，盲评时应降权',
    'T02 两臂均用脚本批量（仪器一致），与"逐个 edit"类题不同源',
  ],
  cause: '第一批题**不依赖记忆**：小而自足、无跨会话事实、无真陷阱，缺记忆也能做对（说明"任务设计"比"记忆有无"更决定结果）',
};
writeFileSync(OUT + '\\batch1-verdict.json', JSON.stringify(verdict, null, 1), 'utf8');
console.log('  第一批判定：开臂 ' + verdict.on.pass + '/' + verdict.on.n + '，关臂 ' + verdict.off.pass + '/' + verdict.off.n + '，闸门触发=' + verdict.gateTriggered);

const P = OSS + '\\docs\\ab-task-battery.md';
const t = readFileSync(P, 'utf8');
if (!t.includes('## 6. 第一批判定')) {
  const block = [
    '',
    '## 6. 第一批判定（2026-10-10）：**闸门触发**',
    '',
    '- **结果**：开臂 **10/10** 全过、关臂 **10/10** 全过 ⇒ **H1/H2 无方向性差异**。',
    '- **唯一失败**发生在关臂首轮，查明为**起点污染**（`reset --hard seed` 中 `seed` 只是提交信息不是 ref，静默失败）⇒ 已打标签修复并作废重跑，**不计入臂效应**。',
    '- **按 §5 闸门：暂停，不硬跑第二批**。',
    '',
    '**为什么没差别（诚实归因）**：第一批题**不依赖记忆**——它们小而自足、无跨会话事实、无真陷阱；我作为执行者对夹具又完全熟悉 ⇒ **任务设计比"记忆有无"更决定结果**。',
    '也就是说：这批题**证明不了记忆无用**，只证明**它测不出差异**（测不出 ≠ 无效）。',
    '',
    '## 7. 第二批重设计方向（据此改题，不是加量）',
    '',
    '换成**记忆承担关键作用**的题，三类：',
    '1. **跨会话事实题**：答案只存在于会话层/库（如"上次这个坑怎么修的""某个开关叫什么"）——**必须检索才能答对**（对应 H5 矛盾式漏召）；',
    '2. **陷阱题**：夹具**故意含一个我们历史上踩过的坑**（如 E409 措辞、`edit` 引用与原文不符、行号越界），且**不给提示**——考"动手前是否先查"（对应 H1/H2）；',
    '3. **不可逆 + 备份题**：判据硬化为"操作前备份存在"（对应 H3，可机检）。',
    '',
    '**题目验收（先验题再跑）**：每道新题须先通过"**无记忆者必然失败/显著变差**"的预测（我自己盲跑一次，失败或返工≥1 才留题）。',
    '',
    '**盲评**：第一批的两臂产物（20 目录）仍可交第三方按 §4 四维评——预期平分；**其主要作用是校准评分表本身**，为第二批做准备。',
    '',
  ].join('\n');
  writeFileSync(P, t + block, 'utf8');
  writeFileSync('<LOCAL_PATH>\\docs\\ab-task-battery.md', t + block, 'utf8');
  console.log('  [battery] 第一批判定 + 第二批重设计 已追加（双份）');
}

const recs = currentRecords(loadStore('canon').records);
const hit = recs.filter((r) => String(r.id).startsWith('canon-observation-ledger-20261010')).pop();
const marker = '**A/B 第一批判定（2026-10-10）**';
if (String(hit.claim).includes(marker)) { console.log('  [canon] already'); process.exit(0); }
const add = ' ' + marker + '：**闸门触发**——开臂 10/10、关臂 10/10 全过 ⇒ H1/H2 **无方向性差异**，按 §5 闸门**暂停第二批**。唯一失败为关臂首轮**起点污染**（`reset --hard seed` 的 seed 非 ref，静默失败）⇒ 已打 seed 标签 + 流程改 `reset --hard HEAD && git clean -fd`，作废重跑，不计臂效应。归因：**第一批题不依赖记忆**（小而自足、无跨会话事实、无真陷阱）⇒ 该批**证明不了记忆无用，只证明它测不出差异**。**第二批重设计**（三类：跨会话事实题 / 无提示陷阱题 / 不可逆+备份题），并新增**题目验收**：新题须先通过"无记忆者必然失败或返工≥1"的预测才留题。第一批 20 份产物仍可交第三方盲评——主要作用是**校准评分表**。';
const next = revise('canon', hit.id, { claim: hit.claim + add, last_reviewed: '2026-10-10' });
console.log('  [canon] ' + hit.id + ' → ' + next.id);
