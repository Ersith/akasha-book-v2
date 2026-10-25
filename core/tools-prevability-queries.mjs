// tools/prevability-queries.mjs —— 步2（模板卡造问句）+ 步3（按失败日快照切库的机器初筛）
// 采纳 Claude 2026-10-10 补充：edit 类固定模板、少自由发挥；时序筛选用 snapshot 按失败日切库；报告写明快照哈希。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { lookupDetailed } from './lib.mjs';

const OUT = '<LOCAL_PATH>\\_scratch\\prevability';
mkdirSync(OUT, { recursive: true });
const cases = readFileSync(OUT + '\\cases.jsonl', 'utf8').trim().split(/\r?\n/).map((l) => JSON.parse(l));
const snap = JSON.parse(readFileSync(OUT + '\\library-snapshot.json', 'utf8'));

// 载入库（用于按时序过滤允许的条目 id）
const loadIds = (file) => {
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); rows.push({ id: String(r.id), stamp: String(r.logged_at ?? r.event_time ?? '').slice(0, 10) }); } catch { /* skip */ }
  }
  return rows;
};
const canonRows = loadIds('<AKASHA_DIR>\\data\\canon.jsonl');
const orphanRows = loadIds('<AKASHA_DIR>\\data\\orphan.jsonl');
const allowedAt = (asOf) => new Set([...canonRows, ...orphanRows].filter((r) => r.stamp && r.stamp <= asOf).map((r) => r.id));
const stripRev = (id) => id.replace(/-r\d+$/, '');

// 步 2：模板卡（Claude：edit 固定模板，少自由发挥；其余按工具+报错关键字）
const TPL = {
  edit: () => 'edit 改前读原文 上下文失配',                    // 固定模板（Claude 指定）
  pwsh: () => 'pwsh 引号 转义 单引号 坑',                       // 本机历史第一大类
  grep: () => 'grep 模式 行号 编码 坑',
  read: () => 'read 行号 编码 错位',
  write: () => 'write 覆盖 备选 坑',
  'dsh_wsl': () => 'dsh_wsl 编码 路径 坑',
  'multi_tool_use.parallel': () => '并行调用 未落 校验 坑',
  'cordis_inspect_query': () => 'cordis inspect 查询 坑',
  'agent-error': () => 'agent 错误 复盘 坑',
};
const rows = [];
for (const c of cases) {
  const tpl = TPL[c.tool] ?? (() => c.tool + ' 坑');
  rows.push({ ...c, query: tpl(), query_source: c.tool === 'edit' ? 'FIXED_TEMPLATE(edit)' : 'TEMPLATE(' + c.tool + ')' });
}

// 步 3：机器初筛（含时序过滤）
let withLegalStrong = 0;
const hitRows = [];
for (const r of rows) {
  let d = { hits: [] };
  try { d = lookupDetailed(r.query, {}); } catch { /* 库不可用 */ }
  const allowed = allowedAt(r.as_of);
  const hits = (d.hits ?? []).slice(0, 5).map((h) => ({
    id: h.id, store: h.store, score: h.score, strong: h.strong === true,
    legalAtFailTime: allowed.has(String(h.id)) || allowed.has(stripRev(String(h.id))),
    claim: String(h.claim ?? '').slice(0, 80),
  }));
  const legalStrong = hits.filter((h) => h.strong && h.legalAtFailTime);
  if (legalStrong.length) withLegalStrong += 1;
  hitRows.push({
    case_id: r.case_id, tool: r.tool, date: r.date, cluster_size: r.cluster_size,
    session: r.session, message: r.message,          // 判定素材：会话（分层抽样用）与失败信息（覆盖判定用）
    query: r.query, query_source: r.query_source,
    snapshot_hash: snap.perDate?.[r.as_of]?.canonHash ?? null,
    hits, legalStrongCount: legalStrong.length,
    preliminary: legalStrong.length ? 'likely-preventable' : 'unlikely',
  });
}
writeFileSync(OUT + '\\queries-hits.jsonl', hitRows.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');

const byTool = {};
for (const r of hitRows) {
  const b = (byTool[r.tool] ??= { n: 0, likely: 0 });
  b.n += 1; if (r.preliminary === 'likely-preventable') b.likely += 1;
}
console.log('  步2+3 完成：' + hitRows.length + ' 条 → ' + OUT + '\\queries-hits.jsonl');
console.log('  初筛「可能有合法强命中」= ' + withLegalStrong + ' / ' + hitRows.length + '（回合级粗口径，待步4双评）');
console.log('  按工具：');
for (const [t, b] of Object.entries(byTool).sort((a, b) => b[1].n - a[1].n)) {
  console.log('    ' + t.padEnd(24) + ' n=' + String(b.n).padStart(2) + '  likely=' + b.likely);
}
