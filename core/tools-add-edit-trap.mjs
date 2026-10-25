// tools/add-edit-trap.mjs —— 补「edit 上下文失配」可执行条目 + 挂进 RECALL_TRAP_MAP + 验证命中
import { loadStore, currentRecords, appendRecord, lookupDetailed } from './lib.mjs';
import { readFileSync, writeFileSync } from 'node:fs';

const recs = currentRecords(loadStore('canon').records);
const ID = 'canon-trap-edit-context-mismatch';
if (recs.some((r) => String(r.id).startsWith(ID))) { console.log('= 条目已存在'); }
else {
  const r = appendRecord('canon', {
    id: ID,
    claim:
      '**工具陷阱·`edit` 上下文失配（可执行条目；2026-10-10 由可预防性测试的"供给缺口"倒逼补料）**。' +
      '**触发**：用 `edit` 替换文本，而 `old_string` 与文件当前内容**不完全一致**——常见来源：缩进/空白/换行差异、全角半角、BOM/编码、' +
      '**该行已被更早的编辑改过**、以及"凭记忆或摘要写 old_string"。' +
      '**症状**：工具返回 `old_string was not found in "<path>"`（本机 10-06~10-10 共 **21 次**，占全部任务失败 **43%**，是最大失败类）。' +
      '**正确动作（按序）**：① **改前先读**——`read` 目标区间或 `grep` 定位行号，**逐字确认**原文；② **一次一处**，改完立即 `read`/`grep` **复核**；' +
      '③ **批量/并行 edit**：逐个文件核对**最终内容**（"已更新 N 个文件"的计数**不算证据**）；④ 大范围替换：先 `grep` 列出全部命中点再逐点改（或改脚本 + 整体复查）。' +
      '**反例（禁止）**：凭记忆写 `old_string`；多文件并行改后不逐个复核；为省事用 `write` 整文件覆盖（丢原文与历史）。' +
      '**自检问句**：「我这次 edit 的 `old_string`，**是不是我刚读到的原文**？」读不到就不改。',
    source: { type: '复现', ref: '_scratch/prevability/{cases.jsonl(sha 264840df56c8),queries-hits.jsonl}：21/49 失败属此类、模板问句原仅命中 3/23' },
    event_time: '2026-10-10',
    last_reviewed: '2026-10-10',
    tags: ['陷阱', 'edit', '工具坑', 'C1素材', '可执行条目'],
  });
  console.log('已入 canon：' + r.id);
}

// 挂进 C2 映射表（edit → 新条目）
for (const F of ['<AKASHA_DIR>\\lib.mjs', '<LOCAL_PATH>\\dist\\akasha-oss\\core\\lib.mjs']) {
  let t = readFileSync(F, 'utf8');
  const oldLine = "  edit: ['canon-review-manual-20261010'],";
  const newLine = "  edit: ['canon-trap-edit-context-mismatch', 'canon-review-manual-20261010'],";
  if (t.includes(oldLine)) { writeFileSync(F, t.replace(oldLine, newLine), 'utf8'); console.log('  映射表已挂：' + F.split('\\').pop()); }
  else if (t.includes('canon-trap-edit-context-mismatch')) console.log('  映射表已含（' + F.split('\\').pop() + '）');
  else console.log('  映射表锚点 MISS：' + F);
}

// 验证：模板问句是否命中新条目（缺口是否堵上）
const q = 'edit 改前读原文 上下文失配';
const d = lookupDetailed(q, {});
const hits = (d.hits ?? []).slice(0, 5).map((h) => h.store + ':' + h.id + '(' + h.score + (h.strong ? ',strong' : '') + ')');
console.log('  验证问句 "' + q + '" → ' + (hits.join(' | ') || '(无命中)'));
console.log('  新条目命中：' + ((d.hits ?? []).some((h) => String(h.id).startsWith(ID)) ? '✅ 是' : '❌ 否'));
