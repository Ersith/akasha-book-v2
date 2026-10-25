// ingest-design.mjs —— 把设计稿 §2.1–2.14 十四个设计块 + v0 计划里程碑**逐条落 canon**（2026-10-11 用户裁定「需要，搞吧」）。
// 原则：① 机械提取（不手抄 ⇒ 不走样）；② 每条带段落锚点 source.ref（设计稿路径#§X.Y）；③ event_time=2026-10-06（事件时间轴）；
//       ④ 幂等（同 id 已存在则跳过）；⑤ tags 带「设计块」「源头设计」+ 标题词，供话题簇/检索使用。
import { readFileSync } from 'node:fs';
import { appendRecord, currentRecords, loadStore, STORES } from './lib.mjs';

const DRAFT = '<LOCAL_PATH>/research/ai-memory-architecture-20261006.md';
const PLAN = '<LOCAL_PATH>/docs/superpowers/plans/2026-10-06-akasha-v0.md';
const lines = readFileSync(DRAFT, 'utf8').split('\n');

// 已有 id 集合（幂等）
const existing = new Set(currentRecords(loadStore('canon').records).map((r) => String(r.id)));

// 抽 §2.1–2.14：从标题行到下一个 ### 或 ## 之前
const blocks = [];
for (let i = 0; i < lines.length; i++) {
  const m = /^### (2\.\d+) (.+)$/.exec(lines[i]);
  if (!m) continue;
  const start = i;
  let j = i + 1;
  while (j < lines.length && !/^#{2,3} /.test(lines[j])) j++;
  blocks.push({ sec: m[1], title: m[2].trim(), body: lines.slice(start + 1, j).filter((l) => l.trim()).join('\n'), line: start + 1 });
}

console.log('提取到设计块 ' + blocks.length + ' 条：' + blocks.map((b) => '§' + b.sec).join(' '));

let added = 0, skipped = 0;
for (const b of blocks) {
  const slug = b.sec.replace('.', '-');
  const id = 'canon-design-' + slug + '-20261006';
  if (existing.has(id)) { skipped++; continue; }
  const claim = '**设计块 §' + b.sec + ' ' + b.title + '（源头设计，2026-10-06 讨论稿原文；本条为机械提取，未经改写）**：\n' + b.body
    + '\n\n**出处**：`research/ai-memory-architecture-20261006.md` §' + b.sec + '（第 ' + b.line + ' 行起）。'
    + '**用途**：漂移审计的基准（"最初怎么定的"以此条为准；与当前实现比对时，判定只分「一致／偏离／合理演化」三类，偏离须带证据）。';
  appendRecord('canon', {
    id, claim,
    source: { type: '复现', ref: 'research/ai-memory-architecture-20261006.md#§' + b.sec },
    event_time: '2026-10-06',
    last_reviewed: '2026-10-11',
    tags: ['设计块', '源头设计', '§' + b.sec, ...b.title.split(/[·、（)）\s]+/).filter((x) => x.length >= 2)],
  });
  added++;
}
console.log('canon 落库：新增 ' + added + ' 条，跳过（已存在）' + skipped + ' 条');

// v0 计划里程碑（若可机械提取）
try {
  const planLines = readFileSync(PLAN, 'utf8').split('\n');
  const ms = planLines.filter((l) => /^#{2,3}\s*(M\d+|里程碑)/.test(l.trim())).map((l) => l.trim());
  if (ms.length && !existing.has('canon-design-v0-milestones-20261006')) {
    appendRecord('canon', {
      id: 'canon-design-v0-milestones-20261006',
      claim: '**v0 计划里程碑（源头设计，机械提取）**：\n' + ms.join('\n')
        + '\n\n**出处**：`docs/superpowers/plans/2026-10-06-akasha-v0.md`。**用途**：与当前实现比对（漂移审计基准）。',
      source: { type: '复现', ref: 'docs/superpowers/plans/2026-10-06-akasha-v0.md' },
      event_time: '2026-10-06', last_reviewed: '2026-10-11',
      tags: ['设计块', '源头设计', 'v0计划', '里程碑'],
    });
    console.log('v0 里程碑：新增 1 条（' + ms.length + ' 个里程碑标题）');
  } else {
    console.log('v0 里程碑：无可提取标题或已存在');
  }
} catch (e) {
  console.log('v0 计划读取跳过：' + e.message);
}
