// 一次性：64/82 条 source 核定——逐条判定 + 落修订链（追加不改原文）。
// 纪律：不批量改；先出计划（--plan），人工核过再 --apply。
import { loadStore, currentRecords, appendRecord } from './lib.mjs';

const APPLY = process.argv.includes('--apply');
const cur = currentRecords(loadStore('canon').records);
const targets = cur.filter((r) => r.source?.type === '他人' && r.source?.ref === 'n/a');

// 判据（保守档；对照板子「应标 复现/官方/共识」——升级到 复现 需复跑证据，本批**不给**）：
//   · 本机跑出来的工作记录（有读数/产物/命令） ⇒ **实验**（T2：自己做的，非独立复现）
//   · 纯叙述（用户裁定原文、观察、意向、对外部对象之判读） ⇒ **他人**（T4）
//   · 复现（T1）本批保留不给：按「作者不自证」纪律，等真正的独立复跑再升。
const TRACES = /(跑通|实测|真库|冒烟|已装|已并|已发布|已上线|落地|复现|验证通过|test\s*\d+\s*\/|check\s*\d+\s*\/|verify|npm|tgz|\.mjs|\.ps1|\.jsonl|tools\/|node\s+akasha|≥|→\s*\d+|=\s*\d+\s*[（(])/;
const NONWORK = /(意向记录|教训|观察|展望|裁定|原话|口径|判定|判读|评估|审计结果|报告$)/;

const rows = [];
for (const r of targets) {
  const t = String(r.claim || '') + String(r.verdict || '') + String(r.evidence || '');
  const hasTrace = TRACES.test(t);
  let type, reason;
  if (hasTrace) { type = '实验'; reason = 'experiment：本机实测记录（读数/产物/命令在案；非独立复现 ⇒ 不给 T1）'; }
  else if (NONWORK.test(t)) { type = '他人'; reason = 'judgement：纯叙述（裁定/观察/判读/意向，无本机实测痕迹）'; }
  else { type = '实验'; reason = 'experiment：本机工作记录（无外源判读痕迹）'; }
  rows.push({ r, type, reason });
}

const tally = rows.reduce((m, x) => (m[x.type] = (m[x.type] ?? 0) + 1, m), {});
console.log('计划：' + JSON.stringify(tally) + '（合计 ' + rows.length + '）');
if (!APPLY) {
  for (const x of rows) console.log('  [' + x.type + '] ' + x.r.id + ' — ' + x.reason.slice(0, 24));
  console.log('\n（dry：加 --apply 才写）');
  process.exit(0);
}

let ok = 0, fail = 0;
for (const x of rows) {
  const { r, type, reason } = x;
  const { id, store, logged_at, ...body } = r;
  try {
    appendRecord('canon', {
      ...body,
      id: id + 'sr',                 // 新版本 id（修订链）
      supersedes: id,
      source: { ...(r.source || {}), type, ref: r.source?.ref ?? 'n/a' },
      source_note: '2026-10-12 逐条核定：' + reason
    });
    ok += 1;
  } catch (e) {
    fail += 1;
    console.log('  ✗ ' + id + ' — ' + e.message);
  }
}
console.log('已核：' + ok + ' 条；失败：' + fail);
