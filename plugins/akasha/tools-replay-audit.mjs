// replay-audit.mjs —— ④ 历史回放（对抗性审计）（2026-10-11 用户令「开搞」；设计稿 §2.10）
//   口径（设计稿原文）：**新规则重压旧事故** ⇒ ① 能否**重现已知红线**（该事故是否已被现行规则覆盖）② 有无**误杀**（规则是否宽到会误伤正常场景）。
//   语料（全部库内现成，不新增采集）：**旧事故**＝canon 中 tags 含 {坑,事故,失败,教训,trap} 的条目 + orphan 库的失败孤案；
//   **现行规则**＝canon 中 tags 含「抽象规则」（L2 层，⑥ 已打标）∪ 含 {纪律,红线,判据,坑} 的条目 ∪ RECALL_TRAP_MAP（工具坑表）。
//   判定（机械可复核）：事故的"触发词"（工具名/路径片段/关键词）能匹配到 ≥1 条现行规则 ⇒ **可预防**；否则 ⇒ **缺口**；
//   规则触发词过度宽泛（仅 1 个 ≤2 字常见词）⇒ 标 **可能误杀**。
// 2026-10-17 发版修：原为 `file:///<AKASHA_DIR>/lib.mjs`（活树绝对路径）——
//   同步到 OSS 时会被替换成占位符 `<AKASHA_DIR>`，而 `file:///<AKASHA_DIR>/lib.mjs` 是**非法 file URL**
//   （实测 ERR_INVALID_FILE_URL_PATH: must be absolute）。改成相对引用，两套布局都能由同步器映射。
import { currentRecords, loadStore, recallToolTraps } from './lib.mjs';

const INCIDENT_TAGS = new Set(['坑', '事故', '失败', '教训', 'trap']);
const RULE_TAGS = new Set(['抽象规则', '纪律', '红线', '判据', '坑', '方法论']);

const all = (store) => currentRecords(loadStore(store).records);
const canon = all('canon');
const incidents = [];
for (const r of canon) {
  const tags = (r.tags || []).map(String);
  if (tags.some((t) => INCIDENT_TAGS.has(t))) incidents.push({ id: String(r.id), text: String(r.claim || ''), tags, src: 'canon' });
}
for (const r of all('orphan')) {
  const tags = (r.tags || []).map(String);
  const text = String(r.summary || r.claim || '');
  // 口径修正（2026-10-11）：orphan 只收**真事故类**——tags 命中事故/失败/坑，或文本含事故线索；
  // 剔除「[inbox候选] …」聚合条与研究型孤案（它们不是"旧事故"）
  const incidentish = tags.some((t) => INCIDENT_TAGS.has(t)) || /(事故|失败|踩坑|崩|静默失效|挂了|坏了)/.test(text);
  if (incidentish && !/^\[inbox候选\]/.test(text)) {
    incidents.push({ id: String(r.id), text, tags, src: 'orphan' });
  }
}
const rules = canon.filter((r) => (r.tags || []).map(String).some((t) => RULE_TAGS.has(t)))
  .map((r) => ({ id: String(r.id), text: String(r.claim || ''), tags: (r.tags || []).map(String) }));
const traps = recallToolTraps ? [...recallToolTraps().entries()].map(([tool, ids]) => ({ tool, ids: [...ids] })) : [];

/** 从事故文本抽"触发词"：工具名、文件/路径片段、显式关键词（引号内、括号内英文/中文专名） */
function triggersOf(text) {
  const out = new Set();
  for (const m of text.match(/\b(edit|read|write|grep|pwsh|bash|apply_patch|dsh_wsl|codex_exec|mcp__[a-z_]+|npm|git|node)\b/gi) || []) out.add(m.toLowerCase());
  for (const m of text.match(/canon-[a-z0-9-]{6,}/gi) || []) out.add(m.toLowerCase());
  for (const m of text.match(/[A-Za-z]:\\[^\s"'`）)]{4,}/g) || []) out.add(m.toLowerCase());
  for (const m of text.match(/「([^」]{2,12})」/g) || []) out.add(m.replace(/[「」]/g, '').toLowerCase());
  return [...out];
}

const rows = [];
for (const inc of incidents) {
  // 事故自身 id 是最强标识（后续为它补立的规则会引用它）⇒ 一并入触发集
  const trg = [inc.id.toLowerCase(), ...triggersOf(inc.text)].filter((t) => t.length >= 2);
  if (!trg.length) { rows.push({ ...inc, verdict: '缺口（无触发词可判）', covered: [] }); continue; }
  const covered = [];
  const idTail = (s) => String(s).toLowerCase().replace(/^.*?(canon|orphan|mirror)-/, '').replace(/-r\d+$/, '');
  for (const r of rules) {
    const t = (r.text + ' ' + r.id + ' ' + (r.tags || []).join(' ')).toLowerCase();
    let hit = null;
    for (const g of trg) if (t.includes(g)) { hit = g; break; }
    // 双向：规则 id 与事故 id 的语义尾段互相包含（同一事被后续条目修好/规约化）
    if (!hit) { const a = idTail(inc.id), b = idTail(r.id); if (a && b && (a.includes(b) || b.includes(a)) && Math.min(a.length, b.length) >= 8) hit = 'id:' + b; }
    if (hit) covered.push({ id: r.id, by: hit });
  }
  for (const tp of traps) {
    if (trg.some((g) => g === String(tp.tool).toLowerCase())) covered.push({ id: 'RECALL_TRAP_MAP:' + tp.tool, by: tp.tool });
  }
  const uniq = [...new Map(covered.map((c) => [c.id, c])).values()];
  rows.push({ ...inc, verdict: uniq.length ? '可预防（有现行规则覆盖）' : '缺口（无规则覆盖）', covered: uniq });
}

const sum = { '可预防（有现行规则覆盖）': 0, '缺口（无规则覆盖）': 0, '缺口（无触发词可判）': 0 };
for (const r of rows) sum[r.verdict] = (sum[r.verdict] || 0) + 1;
console.log('历史回放（新规则重压旧事故）：旧事故 ' + incidents.length + ' 条（canon 坑/事故/失败/教训 + orphan 全部）· 现行规则 ' + rules.length + ' 条 · 工具坑表 ' + traps.length + ' 项');
console.log('  汇总：可预防 ' + (sum['可预防（有现行规则覆盖）'] || 0) + ' · 缺口 ' + ((sum['缺口（无规则覆盖）'] || 0) + (sum['缺口（无触发词可判）'] || 0)));
console.log('  ── 缺口清单（应补条目或修钩子）：');
for (const r of rows.filter((x) => x.verdict.startsWith('缺口'))) console.log('   · ' + r.id + '（' + r.src + '）｜ ' + String(r.text).slice(0, 78).replace(/\n/g, ' '));
console.log('  ── 可预防样例（前 6）：');
for (const r of rows.filter((x) => x.verdict.startsWith('可预防')).slice(0, 6)) console.log('   · ' + r.id + ' ← 由 ' + r.covered.map((c) => c.id).join('、').slice(0, 60));
// 误杀候选：规则触发词过窄/过泛（本口径下先报"规则文本里只出现 1 个 ≤2 字常见词"的规则，供人工判）
const catchAll = rules.filter((r) => {
  const trg = triggersOf(r.text);
  return trg.length === 1 && trg[0].length <= 2;
});
console.log('  ── 可能误杀候选（规则触发词过泛，需人工判）：' + (catchAll.length ? catchAll.map((r) => r.id).join('、') : '无'));
console.log('  ── 纪律：本回放只报"有无覆盖"与"误杀候选"；**是否真能预防/是否真误杀**须人工结合条目证据判定（同 design-drift 口径）。');
