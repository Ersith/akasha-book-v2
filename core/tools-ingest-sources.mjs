// ingest-sources.mjs —— 库前源头材料**批量回填**（2026-10-11 用户「恩」）。
// 口径：① 只回填**阿卡夏相关**且在范围内、且 `source.ref` 尚未出现的材料；② 每条＝**标题 + 结构骨架 + 要点摘录**（≤约 1.5K 字），
//       明确标注「**本条为骨架与摘录，非原文**；原文以 ref 为准」；③ `source.ref` ＝ 路径 + 锚点；event_time ＝ 文件日期；
//       ④ 幂等（同 id 跳过）；⑤ 剔噪：其他项目（dsh-tavern）/ AGENTS 快照 / vendor / node_modules。
import { readFileSync, statSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { appendRecord, currentRecords, loadStore } from 'file:///<AKASHA_DIR>/lib.mjs';

const EXCLUDE = /(node_modules|\/vendor\/|top20\/sources\/|awesome-|\/upstream\/|dsh-tavern|history\/AGENTS-|third[_-]?party|\.min\.)/i;
const IN_SCOPE = /(akasha|memory-architecture|session-layer|superpowers\/(plans|specs)|history\/akasha|PROTOCOL|MEMORY-TEST)/i;

const walk = (dir) => {
  const out = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) { try { out.push(...walk(p)); } catch { /* skip */ } continue; }
    if (/\.(md|txt)$/.test(d.name)) out.push(p);
  }
  return out;
};

const norm = (p) => String(p).replace(/\\/g, '/');
const refs = new Set();
for (const s of ['canon', 'frontier', 'orphan', 'mirror', 'pricing', 'lexicon']) {
  for (const r of currentRecords(loadStore(s).records)) {
    const ref = norm(String((r.source && r.source.ref) || ''));
    for (const m of ref.match(/[A-Za-z0-9_/.\-]+\.(md|mjs|json|txt)/g) || []) refs.add(m.toLowerCase());
  }
}
const existingIds = new Set(currentRecords(loadStore('canon').records).map((r) => String(r.id)));

const files = [...walk('<LOCAL_PATH>/research'), ...walk('<LOCAL_PATH>/docs')]
  .map((p) => ({ p, rel: norm(p).replace('<LOCAL_PATH>/', '') }))
  .filter((x) => !EXCLUDE.test('/' + x.rel) && IN_SCOPE.test(x.rel))
  .filter((x) => ![...refs].some((r) => r.endsWith(basename(x.p).toLowerCase())))
  .sort((a, b) => statSync(b.p).size - statSync(a.p).size);

console.log('待回填 ' + files.length + ' 份');
let added = 0;
for (const f of files) {
  const st = statSync(f.p);
  const date = st.mtime.toISOString().slice(0, 10);
  const slug = basename(f.p).replace(/\.(md|txt)$/i, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48).toLowerCase();
  const id = 'canon-source-' + slug;
  if (existingIds.has(id)) { console.log('  跳过（已存在）：' + id); continue; }
  const lines = readFileSync(f.p, 'utf8').split('\n');
  const title = (lines.find((l) => /^#\s+/.test(l)) || '# ' + basename(f.p)).replace(/^#\s+/, '').trim();
  const outline = lines.filter((l) => /^#{2,3}\s+/.test(l)).slice(0, 24).map((l) => l.trim());
  const prose = lines.filter((l) => l.trim() && !/^#{1,6}\s/.test(l) && !/^\|/.test(l) && !/^[-*]\s*$/.test(l)).slice(0, 12)
    .map((l) => l.trim().slice(0, 160)).join('\n');
  const claim = '**' + title + '（源头材料回填，' + date + '）**。**本条为骨架与摘录，非原文**；原文以 ref 为准。\n\n'
    + '**结构骨架**：\n' + (outline.length ? outline.join('\n') : '（无小标题）') + '\n\n'
    + '**要点摘录（前若干段）**：\n' + (prose || '（无正文摘录）') + '\n\n'
    + '**出处**：`' + f.rel + '`（' + Math.round(st.size / 1024) + ' KB，mtime ' + date + '）。**用途**：检索入口与漂移审计基准。';
  appendRecord('canon', {
    id, claim,
    source: { type: '复现', ref: f.rel },
    event_time: date, last_reviewed: '2026-10-11',
    tags: ['源头材料', '回填', ...title.split(/[·、（)）\s-]+/).filter((x) => x.length >= 2).slice(0, 4)],
  });
  added += 1;
  console.log('  + ' + id + '  ← ' + f.rel + '（' + Math.round(st.size / 1024) + ' KB）');
}
console.log('回填完成：新增 ' + added + ' 条');
