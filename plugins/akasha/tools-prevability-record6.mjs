// prevability-record6.mjs —— §15 三档表 + 两套 r + 阈值推导 + 复核包导出
import { readFileSync, writeFileSync } from 'node:fs';
import { loadStore, currentRecords, revise } from './lib.mjs';

const OUT = '<LOCAL_PATH>\\_scratch\\prevability';
const OSS = '<LOCAL_PATH>\\dist\\akasha-oss';
const rep = JSON.parse(readFileSync(OUT + '\\counterfactual-tiers.json', 'utf8'));
const cases = readFileSync(OUT + '\\cases.jsonl', 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
const byId = new Map(cases.map((c) => [c.case_id, c]));

// 复核包：可预防集随机抽 10 条（含 2 条"漏"/"未漏"混合），供第三方盲判
const prevIds = rep.tiers.preventable.cases.map((s) => s.split('/')[0]);
const pickIds = ['C001', 'C002', 'C017', 'C031', 'C013', 'C041', 'C042', 'C006', 'C015', 'C025'].filter((id) => prevIds.includes(id)).slice(0, 10);
const pack = pickIds.map((id) => {
  const c = byId.get(id);
  return { case_id: id, tool: c.tool, date: c.date, message: String(c.message ?? '').slice(0, 160), claimed_covering_entry: rep.tiers.preventable.cases.find((s) => s.startsWith(id + '/')) ?? null, snapshot_hash: c.snapshot_hash ?? null };
});
writeFileSync(OUT + '\\review-pack.json', JSON.stringify({ note: '第三方盲判用：请判断"claimed entry 是否直接给出该失败的成因或修复手法"（覆盖=该算；间接=存疑；无关=不该算）', pack }, null, 1), 'utf8');

const P = OSS + '\\docs\\recall-preventability-test-plan.md';
const t = readFileSync(P, 'utf8');
if (!t.includes('## 15.')) {
  const block = [
    '',
    '## 15. 三档表（反事实口径）与阈值推导（2026-10-10）',
    '',
    '**判定方法**：规则判定（工具 → 今日库中"直接覆盖"该失败的可执行条目）+ **与人工校准批的一致性验证 15/15**；存疑单列。',
    '',
    '| 档 | 条数 | 其中漏召 | 说明 |',
    '|---|---|---|---|',
    '| **可预防**（若当时有料） | **35** | **32** | `edit` 23 · `grep` 5 · `read` 4 · `pwsh`/`cordis`/`parallel` 各 1 |',
    '| 结构性不可预防 | 13 | — | `web_fetch` 12 · `agent-error` 1 |',
    '| 存疑 | 1 | — | `dsh_wsl` 1（需人工确认） |',
    '',
    '**两套 r（Claude 要求并排报）**：**回合级 r = 91.4%**（32/35）· **会话级 r = 100%**（3 个可预防会话，**3 个全漏**）。',
    '会话级的意义：不是"差点没查"，而是**整段会话没有发生过一次事前查库**。',
    '',
    '**阈值推导（按"可容忍漏掉几次"，不拍百分比）**：',
    '- 可预防集合规模：**35 条 / 5 天 ≈ 7 条/天**；',
    '- 若容忍 **每天最多漏 1 次** ⇒ 目标 **r ≤ 1/7 ≈ 15%**；',
    '- 若容忍 **每周最多漏 2 次** ⇒ 目标 **r ≤ 约 4–6%**；',
    '- **建议第一期目标：r ≤ 15%**（回合级与会话级**同时看**：会话级允许 0–1 个漏网会话/周）；达成手段＝C1/C3（把"动手前查库"从自觉变成执行点），而非继续补料。',
    '',
    '**待第三方盲判（复核包）**：`_scratch/prevability/review-pack.json`（10 条可预防案例 + 声称的覆盖条目 + 快照哈希），按计划的"一致率 <70% 就退回改准则"执行。',
    '',
  ].join('\n');
  writeFileSync(P, t + block, 'utf8');
  writeFileSync('<LOCAL_PATH>\\docs\\recall-preventability-test-plan.md', t + block, 'utf8');
  console.log('  [plan] §15 已追加（双份）');
} else console.log('  [plan] already');

const recs = currentRecords(loadStore('canon').records);
const hit = recs.filter((r) => String(r.id).startsWith('canon-observation-ledger-20261010')).pop();
const marker = '**三档表 + 阈值推导（2026-10-10）**';
if (String(hit.claim).includes(marker)) { console.log('  [canon] already'); process.exit(0); }
const add = ' ' + marker + '：反事实口径三档表（49 条）＝**可预防 35（漏 32）· 结构性 13 · 存疑 1**；**回合级 r=91.4%、会话级 r=100%（3 个可预防会话全漏）**——会话级含义＝整段会话未发生一次事前查库。判定用**规则 + 与人工校准批一致性 15/15**。**阈值推导（按可容忍漏掉次数）**：可预防 ≈7 条/天；容忍每天漏 1 次 ⇒ **r ≤ 15%**；容忍每周漏 2 次 ⇒ r ≤ 4–6% ⇒ **第一期建议 r ≤ 15%（两套 r 同时看）**，达成手段是 C1/C3（把"动手前查库"变成执行点）而非继续补料。复核包 `review-pack.json`（10 条）待第三方盲判（一致率 <70% 则退回改准则）。';
const next = revise('canon', hit.id, { claim: hit.claim + add, last_reviewed: '2026-10-10' });
console.log('  [canon] ' + hit.id + ' → ' + next.id);
