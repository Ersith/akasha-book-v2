// tools/add-traps-and-retest.mjs —— 补 4 条可执行条目 + 挂映射表 + 验证 + 反事实回测
import { loadStore, currentRecords, appendRecord, lookupDetailed } from './lib.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

const recs = currentRecords(loadStore('canon').records);
const has = (id) => recs.some((r) => String(r.id).startsWith(id));
const TRAPS = [
  {
    id: 'canon-trap-read-offset-range',
    claim:
      '**工具陷阱·`read` 行号越界（可执行条目）**。**触发**：凭印象/凭上次的行号给 `offset`，而文件已变短或被改过。**症状**：`offset N is out of range for "<path>" (M lines)`（本机 10-07/10-08 两例）。' +
      '**正确动作**：① 大文件先 `grep` 定位目标行（拿到真实行号）再 `read`；② 或先 `read` 头部确认总行数；③ 报"越界"后**不要**继续猜，改用 `grep` 锚点定位。**反例**：沿用上一轮的行号；一次跳读很深的 offset。**自检**：「我这个 offset 是**刚拿到的**行号吗？」',
    tags: ['陷阱', 'read', '工具坑', 'C1素材'],
  },
  {
    id: 'canon-trap-grep-exit2-path',
    claim:
      '**工具陷阱·`grep`/rg 退出码 2（可执行条目）**。**触发**：目标路径不可访问或不适合遍历——权限不足、目录不存在、指向 `node_modules`/vectordb 等海量或受保护目录、路径含特殊字符。**症状**：`grep search failed (exit 2): rg: <path> …`（本机四例）。' +
      '**正确动作**：① 用**明确的文件或浅目录**为范围（先 `glob` 列文件，再逐个 `grep`）；② 排除 `node_modules/.git/data` 等（工具自带 ignore 之外要显式）；③ 路径带空格/中文时给引号；④ 权限类失败**换副本或降范围**，不要反复重试同一路径。**自检**：「这个路径**适合 grep 吗**？」',
    tags: ['陷阱', 'grep', '工具坑', 'C1素材'],
  },
  {
    id: 'canon-trap-unknown-tool-name',
    claim:
      '**工具陷阱·未知工具名（可执行条目）**。**触发**：凭"通用记忆"写工具名（如 `multi_tool_use.parallel` 之类本机并不存在的名字）。**症状**：`unknown tool "X"`（本机 10-07 一例）。' +
      '**正确动作**：① 只从**本会话真实可见的工具面**里挑名字（工具清单/补全/上一轮真实调用）；② 多工具并行就用宿主提供的那一个（若存在）并**先小规模试**；③ 拿不准就先运行一次**单工具**验证名字。**反例**：照搬别处/别家 harness 的工具名。**自检**：「这个名字**我在本会话见过**吗？」',
    tags: ['陷阱', '工具名', '工具坑', 'C1素材'],
  },
  {
    id: 'canon-trap-provider-method-list',
    claim:
      '**工具陷阱·宿主 API/方法名臆测（可执行条目）**。**触发**：对宿主插件/检视服务**凭印象调用方法**（如 `describeService`）。**症状**：`provider "X" has no method "Y"`（本机 10-06 一例）。' +
      '**正确动作**：① 先**列举**再调用——用宿主检视面（`cordis_inspect_list/query`）列出 provider 与**方法清单**，照抄方法名；② 找不到就查官方文档/源码导出，不猜；③ 猜错一次后**换路径**（列清单）而不是换拼写继续猜。**自检**：「这个方法名是**我列出来的**，还是我想出来的？」',
    tags: ['陷阱', '宿主API', '工具坑', 'C1素材'],
  },
];
let added = 0;
for (const t of TRAPS) {
  if (has(t.id)) { console.log('  = 已存在 ' + t.id); continue; }
  appendRecord('canon', { id: t.id, claim: t.claim, source: { type: '复现', ref: '_scratch/prevability/queries-hits.jsonl（步 4 判定产出的供给缺口）' }, event_time: '2026-10-10', last_reviewed: '2026-10-10', tags: t.tags });
  added++;
  console.log('  + ' + t.id);
}

// 映射表挂新条目
const MAP = [
  ["  read: ['canon-review-manual-20261010'],", "  read: ['canon-trap-read-offset-range', 'canon-review-manual-20261010'],"],
  ["  grep: ['canon-review-manual-20261010'],", "  grep: ['canon-trap-grep-exit2-path', 'canon-review-manual-20261010'],"],
  ["  'multi_tool_use.parallel': [],", "  'multi_tool_use.parallel': ['canon-trap-unknown-tool-name'],"], // 可能不存在，下面兜底
];
for (const F of ['<AKASHA_DIR>\\lib.mjs', '<LOCAL_PATH>\\dist\\akasha-oss\\core\\lib.mjs']) {
  let t = readFileSync(F, 'utf8');
  t = t.replace("  read: ['canon-review-manual-20261010'],", "  read: ['canon-trap-read-offset-range', 'canon-review-manual-20261010'],");
  t = t.replace("  grep: ['canon-review-manual-20261010'],", "  grep: ['canon-trap-grep-exit2-path', 'canon-review-manual-20261010'],");
  if (!t.includes('canon-trap-unknown-tool-name')) {
    t = t.replace("});", "  'multi_tool_use.parallel': ['canon-trap-unknown-tool-name'],\n  cordis_inspect_query: ['canon-trap-provider-method-list'],\n});", 1);
  }
  writeFileSync(F, t, 'utf8');
  console.log('  映射表更新 ' + F.split('\\').pop());
}

// 验证：四条模板问句是否命中新条目
const checks = [
  ['read 行号 编码 错位', 'canon-trap-read-offset-range'],
  ['grep 模式 行号 编码 坑', 'canon-trap-grep-exit2-path'],
  ['并行调用 未落 校验 坑', 'canon-trap-unknown-tool-name'],
  ['cordis inspect 查询 坑', 'canon-trap-provider-method-list'],
];
for (const [q, id] of checks) {
  const d = lookupDetailed(q, {});
  const hit = (d.hits ?? []).some((h) => String(h.id).startsWith(id));
  console.log('  验证 "' + q + '" → ' + (hit ? '✅ 命中 ' + id : '❌ 未命中'));
}

// 反事实回测：忽略时间过滤，看"若当时已有这些条目"，多少 case 有覆盖性命中
const rows = readFileSync('<LOCAL_PATH>\\_scratch\\prevability\\queries-hits.jsonl', 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
const NEW_IDS = ['canon-trap-edit-context-mismatch', 'canon-trap-read-offset-range', 'canon-trap-grep-exit2-path', 'canon-trap-unknown-tool-name', 'canon-trap-provider-method-list'];
let cf = 0;
const detail = [];
for (const r of rows) {
  let d = { hits: [] };
  try { d = lookupDetailed(r.query, {}); } catch { /* ignore */ }
  const covered = (d.hits ?? []).some((h) => h.strong && NEW_IDS.some((n) => String(h.id).startsWith(n)));
  if (covered) { cf++; detail.push(r.case_id + '/' + r.tool); }
}
writeFileSync('<LOCAL_PATH>\\_scratch\\prevability\\counterfactual.json', JSON.stringify({ cases: rows.length, covered: cf, detail }, null, 1), 'utf8');
console.log('  [反事实回测] 49 条中 **' + cf + '** 条有"若当时有料则覆盖"的强命中（' + (cf / rows.length * 100).toFixed(0) + '%）');
console.log('    明细（前 12）：' + detail.slice(0, 12).join(' , '));
