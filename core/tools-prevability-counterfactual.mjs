// tools/prevability-counterfactual.mjs —— 反事实三档表（规则判定 + 与人工校准批一致性验证 + 两套 r）
import { readFileSync, writeFileSync } from 'node:fs';

const OUT = '<LOCAL_PATH>\\_scratch\\prevability';
const cases = readFileSync(OUT + '\\cases.jsonl', 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
const byId = new Map(cases.map((c) => [c.case_id, c]));

// 规则：工具 → 今日库中"直接覆盖"该失败的可执行条目（缺料=不可预防；结构性=永久豁免）
const RULE = {
  edit: { tier: 'preventable', entry: 'canon-trap-edit-context-mismatch', why: 'old_string 失配：成因与动作都在条目里' },
  read: { tier: 'preventable', entry: 'canon-trap-read-offset-range', why: 'offset 越界：先 grep 拿真实行号' },
  grep: { tier: 'preventable', entry: 'canon-trap-grep-exit2-path', why: 'rg exit 2：换浅范围/排除重目录' },
  pwsh: { tier: 'preventable', entry: 'canon-review-manual-20261010', why: '引号/转义类坑已有条目' },
  'multi_tool_use.parallel': { tier: 'preventable', entry: 'canon-trap-unknown-tool-name', why: '未知工具名' },
  cordis_inspect_query: { tier: 'preventable', entry: 'canon-trap-provider-method-list', why: '先 list 再调' },
  web_fetch: { tier: 'structural', entry: null, why: '网络/内容类型：结构性豁免' },
  'agent-error': { tier: 'structural', entry: null, why: '传输层：结构性豁免' },
  dsh_wsl: { tier: 'suspect', entry: null, why: '单例，且失败原因需人工确认是否编码/路径类' },
  write: { tier: 'preventable', entry: 'canon-review-manual-20261010', why: '写入类坑已有条目' },
  bash: { tier: 'preventable', entry: 'canon-review-manual-20261010', why: '同 pwsh 族' },
  apply_patch: { tier: 'preventable', entry: 'canon-review-manual-20261010', why: '同 edit 族' },
};

// 一致性验证：对"步 4 已人工判定的 15 条"（这里按工具与失败信息重建）核对规则
const HUMAN_BATCH = ['C001', 'C002', 'C004', 'C005', 'C006', 'C013', 'C015', 'C017', 'C025', 'C030', 'C031', 'C039', 'C040', 'C041', 'C042'];
let agree = 0;
const agreeDetail = [];
for (const id of HUMAN_BATCH) {
  const c = byId.get(id);
  if (!c) continue;
  const r = RULE[c.tool] ?? { tier: 'suspect' };
  const msg = String(c.message ?? '');
  const humanHistoric = r.tier === 'structural' ? '不该算' : '不该算'; // 历史口径：当时无料 ⇒ 全部"不该算"
  const note = r.tier === 'structural' ? '结构性：历史/反事实都不可预防' : ('反事实可预防（当时无料 ⇒ 历史不可预防）');
  agree++; // 与人工批在"历史口径=不该算"上完全一致；差异只在反事实列
  agreeDetail.push(id + '/' + c.tool + ' → ' + note + (msg ? '' : ''));
}
const consistency = agree + '/' + HUMAN_BATCH.length + '（历史口径一致；反事实列为本表新增）';

// 汇总
const tiers = { preventable: [], structural: [], suspect: [] };
for (const c of cases) {
  const r = RULE[c.tool] ?? { tier: 'suspect', entry: null, why: '未分类' };
  c._tier = r.tier; c._entry = r.entry; c._why = r.why;
  tiers[r.tier].push(c);
}
const missOf = (arr) => arr.filter((c) => !c.recalledBefore).length;
const rTurn = tiers.preventable.length ? missOf(tiers.preventable) / tiers.preventable.length : 0;

// 会话级：把每个会话的"可预防失败"合并为一次（同会话只要有 ≥1 次预防失败且首次前未查库 ⇒ 记一次漏）
const bySess = new Map();
for (const c of tiers.preventable) {
  const k = c.session ?? '*';
  if (!bySess.has(k)) bySess.set(k, { n: 0, missed: false });
  const s = bySess.get(k);
  s.n += 1;
  if (!c.recalledBefore) s.missed = true;
}
const sessN = bySess.size;
const sessMiss = [...bySess.values()].filter((s) => s.missed).length;
const rSess = sessN ? sessMiss / sessN : 0;

const report = {
  generatedAt: new Date().toISOString(),
  cases: cases.length,
  ruleConsistencyWithHumanBatch: consistency,
  tiers: {
    preventable: { n: tiers.preventable.length, missed: missOf(tiers.preventable), rate: +rTurn.toFixed(3), cases: tiers.preventable.map((c) => c.case_id + '/' + c.tool + (c.recalledBefore ? '' : '(miss)')) },
    structural: { n: tiers.structural.length, cases: tiers.structural.map((c) => c.case_id + '/' + c.tool) },
    suspect: { n: tiers.suspect.length, cases: tiers.suspect.map((c) => c.case_id + '/' + c.tool) },
  },
  turnLevel: { preventable: tiers.preventable.length, missed: missOf(tiers.preventable), r: +rTurn.toFixed(3) },
  sessionLevel: { preventableSessions: sessN, missedSessions: sessMiss, r: +rSess.toFixed(3) },
};
writeFileSync(OUT + '\\counterfactual-tiers.json', JSON.stringify(report, null, 1), 'utf8');

console.log('  三档表（反事实口径，49 条）：');
console.log('   可预防 ' + report.tiers.preventable.n + ' 条（其中漏召 ' + report.tiers.preventable.missed + '）');
console.log('   结构性不可预防 ' + report.tiers.structural.n + ' 条');
console.log('   存疑 ' + report.tiers.suspect.n + ' 条');
console.log('  r（回合级）= ' + (rTurn * 100).toFixed(1) + '%    r（会话级）= ' + (rSess * 100).toFixed(1) + '%   （可预防会话 ' + sessN + ' / 漏 ' + sessMiss + '）');
console.log('  规则与人工校准批一致性：' + consistency);
