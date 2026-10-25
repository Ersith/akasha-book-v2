// review-pack.mjs —— 生成「记忆价值盲评包」：从历史失败案件里挑 10 例，做成两臂盲评材料。
// 目的：回答「用了记忆到底有没有更好」。原料＝**历史案件**（不用等 5–7 天观察期）。
// 铁律（canon-ab-battery-rules-20261010）：① 题面**不含**验收标准/答案（答案另放 JUDGE.md）；② 案例必须"库里有对应条目"才有意义；③ 门控拒绝**不算任务失败**（排除）。
// 用法：node tools/review-pack.mjs [--out <目录>] [--n 10]
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentRecords, loadStore, RECALL_TRAP_MAP, RECALL_STRUCTURAL_TOOLS } from './lib.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT = flag('--out', '<LOCAL_PATH>\\_ab\\review-pack');
const N = Number(flag('--n', '10'));
const HOOKS = '<AKASHA_DIR>\\logs\\hooks.jsonl';

const lines = readFileSync(HOOKS, 'utf8').split(/\r?\n/).filter(Boolean);
const recs = [];
for (const l of lines) { try { recs.push(JSON.parse(l)); } catch { /* skip */ } }

const GUARD_RE = /阿卡夏门控|门控：拒绝|gate-denied/i;
const fails = recs.filter((r) => r.kind === 'tool' && r.ok === false && !GUARD_RE.test(String(r.message ?? '')));

// 每工具每"消息指纹"取一例（去重），再按工具轮转取 N 例 ⇒ 覆盖面优先
const sig = (r) => String(r.message ?? '').slice(0, 60).replace(/\d+/g, '#');
const seen = new Set();
const uniq = [];
for (const r of fails) {
  const k = r.tool + '|' + sig(r);
  if (seen.has(k)) continue;
  seen.add(k);
  uniq.push(r);
}
const byTool = new Map();
for (const r of uniq) { const t = String(r.tool); if (!byTool.has(t)) byTool.set(t, []); byTool.get(t).push(r); }
const picked = [];
let round = 0;
const tools = [...byTool.keys()].filter((t) => !RECALL_STRUCTURAL_TOOLS.includes(t) && RECALL_TRAP_MAP[t]);
while (picked.length < N && round < 10) {
  for (const t of tools) {
    const arr = byTool.get(t) ?? [];
    if (arr[round]) picked.push(arr[round]);
    if (picked.length >= N) break;
  }
  round++;
}

// 取库内条目（rubric 来源）——只取"当前版本"
const canon = currentRecords(loadStore('canon').records);
const byId = new Map(canon.map((r) => [String(r.id), r]));

// 配对修复（2026-10-11，判卷者发现 case-06/07 rubric 串题）：**不再按工具名兜底**。
// 现在的配对＝把案件报错文本与候选条目的 claim 做词面重叠打分；**得分不足则判"库内无对应条目"（不计分）**。
// 这样宁可少一案，也不制造"假 rubric"（假 rubric 会同时污染打分与结论）。
const STOP = new Set(['the', 'a', 'an', 'is', 'not', 'was', 'in', 'of', 'to', 'and', 'for', 'with', 'on', 'at', 'node', 'error', 'failed']);
function tokens(s) {
  return new Set(String(s ?? '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fff_]+/).filter((t) => t.length > 2 && !STOP.has(t)));
}
function overlap(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return { hit: 0, score: 0 };
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return { hit, score: hit / Math.min(A.size, B.size) };
}
function pairRubric(tool, message) {
  const cands = (RECALL_TRAP_MAP[tool] ?? []).filter((t) => byId.has(t));
  let best = null, bestHit = 0, bestScore = 0;
  for (const id of cands) {
    const claim = String(byId.get(id).claim ?? '') + ' ' + String(byId.get(id).tags ?? '');
    const { hit, score } = overlap(message, claim);
    if (hit > bestHit || (hit === bestHit && score > bestScore)) { bestHit = hit; bestScore = score; best = id; }
  }
  // 硬条件：**至少 2 个不同词命中**（单靠工具名一个词不算——2026-10-11 实例：dsh_wsl 超时案曾被错配到可安装性条目）
  return bestHit >= 2 ? { ids: [best], score: +bestScore.toFixed(3) } : { ids: [], score: +bestScore.toFixed(3) };
}

mkdirSync(join(OUT, 'cases'), { recursive: true });
const pack = [];
picked.forEach((r, i) => {
  const id = 'case-' + String(i + 1).padStart(2, '0');
  const when = String(r.ts);
  const msg = String(r.message ?? '');
  const pr = pairRubric(r.tool, msg);
  const lesson = pr.ids.map((t) => ({ id: t, claim: String(byId.get(t).claim ?? '') }));
  const caseBody = [
    '# 案例 ' + id + '（盲评用 · 题面不含答案）',
    '',
    '## 情境（真实发生）',
    '- 时间：' + when,
    '- 工具：`' + r.tool + '`',
    '- 结果：**失败**',
    '- 报错原文：',
    '',
    '```',
    msg,
    '```',
    '',
    '## 你要回答的问题',
    '1. 这次失败**本可以避免吗**？如果可以，**在动手之前做什么**就能避免？',
    '2. 如果避免不了，说清**为什么它不可避免**。',
    '3. 你会怎么改自己的做法，使同类失败**不再出现**？',
    '',
    '（只依据上面给的信息作答；不要揣测未给出的上下文。）'
  ].join('\n');
  writeFileSync(join(OUT, 'cases', id + '.md'), caseBody, 'utf8');
  pack.push({ id, ts: when, tool: r.tool, session: r.session ?? null, message: msg, rubricRefs: lesson.map((x) => x.id) });
});

// JUDGE：评分标准（含库内要点）——与题面分离
const judge = [
  '# 盲评评分表（评审者用 · 不得展示给作答方）',
  '',
  '## 评分档',
  '| 档 | 含义 | 记分 |',
  '|---|---|---|',
  '| A 正确 | 说出的关键动作/检查与下方 rubric 要点**语义等价** | 2 |',
  '| B 部分 | 方向对但缺关键一步（例如只说"小心"没说"先查什么"） | 1 |',
  '| C 无关 | 泛泛而谈、不可执行 | 0 |',
  '| D 更差 | 给出会加重问题的做法 | -1 |',
  '',
  '## 每案的 rubric 要点（来自库内当前版本条目）',
  ''
];
for (const c of pack) {
  judge.push('### ' + c.id + '（' + c.tool + '）');
  if (!c.rubricRefs.length) judge.push('- ⚠ 库内无对应条目 ⇒ **本题不计分**（只用于观察）');
  for (const ref of c.rubricRefs) {
    const rec = byId.get(ref);
    const claim = String(rec?.claim ?? '').replace(/\s+/g, ' ').slice(0, 300);
    judge.push('- `' + ref + '`：' + claim + '…');
  }
  judge.push('');
}
writeFileSync(join(OUT, 'JUDGE.md'), judge.join('\n'), 'utf8');

const readme = [
  '# 记忆价值盲评包（review-pack）',
  '',
  '## 它回答什么',
  '「**用了记忆，到底有没有更好**」——目前只有 n=2 的弱证据（B01/B04 证明的是"可达"）。本包用**历史真实失败案件**做两臂对照。',
  '',
  '## 怎么跑（两臂 + 盲评）',
  '1. **有库臂**：允许作答方查库（`akasha_lookup` / `akasha_brief` / `akasha_session_lookup` 等），然后逐案作答。',
  '2. **无库臂**：只给 `cases/*.md`，不给任何库访问。',
  '3. **盲评**：把两臂答案**打乱编号**（不要标注来自哪臂），交给评审者按 `JUDGE.md` 打分。',
  '4. **判定**：若"有库臂"平均分不显著高于"无库臂"，如实记「**无效**」（负结果同样入 canon——这是纪律）。',
  '',
  '## 纪律',
  '- 题面**不含答案**（答案在 `JUDGE.md`，与题面分离）；',
  '- 库内**无对应条目**的案例**不计分**（只用于观察）；',
  '- 两臂用**同一批题、同一评审标准**；不得为提升指标挑选题目。',
  '',
  '## 生成方式',
  '`node <AKASHA_DIR>\\tools\\review-pack.mjs`（原料＝`akasha\\logs\\hooks.jsonl` 的历史失败记录；门控拒绝已排除）。',
  ''
].join('\n');
writeFileSync(join(OUT, 'README.md'), readme, 'utf8');
writeFileSync(join(OUT, 'pack.json'), JSON.stringify({ generated: new Date().toISOString(), n: pack.length, cases: pack }, null, 1), 'utf8');

console.log('review-pack 生成完成：' + OUT);
console.log('  案例 ' + pack.length + ' 个（工具分布：' + [...new Set(pack.map((c) => c.tool))].join(', ') + '）');
console.log('  其中有库内条目的：' + pack.filter((c) => c.rubricRefs.length).length + ' / ' + pack.length);
for (const c of pack) console.log('   · ' + c.id + '  ' + String(c.tool).padEnd(12) + ' rubric: ' + (c.rubricRefs.join(', ') || '（无）'));
