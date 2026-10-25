// backfill-audit.mjs —— 回填审计（2026-10-11）：**库建成前后的源头材料（research/、docs/ 的 .md/.txt），哪些已有 canon 出处、哪些还没回填**。
// 判据：条目 source.ref 里出现的文件路径（取 basename 或路径后缀）＝"已有出处"；否则＝未回填。
import { readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { currentRecords, loadStore } from 'file:///<AKASHA_DIR>/lib.mjs';

const refs = new Set();
for (const s of ['canon', 'frontier', 'orphan', 'mirror', 'pricing', 'lexicon']) {
  for (const r of currentRecords(loadStore(s).records)) {
    const ref = String((r.source && r.source.ref) || '');
    for (const m of ref.match(/[A-Za-z0-9_/.\-]+\.(md|mjs|json|txt)/g) || []) {
      refs.add(m.replace(/\\/g, '/').toLowerCase());
    }
  }
}

const walk = (dir) => {
  const out = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory()) { try { out.push(...walk(p)); } catch { /* skip */ } continue; }
    if (!/\.(md|txt)$/.test(d.name)) continue;
    try { out.push({ p, stat: statSync(p) }); } catch { /* skip */ }
  }
  return out;
};

// 排除非"我们的源头产出"（2026-10-11 修正）：第三方快照 / vendor / node_modules / 依赖内置文档。
// 范围（同日修正）：**只审阿卡夏/记忆架构相关的源头材料**——别的项目（dsh-tavern、plugin-top20 等）的文档不属本库回填对象。
const norm = (p) => String(p).replace(/\\/g, '/');
const EXCLUDE = /(node_modules|\/vendor\/|top20\/sources\/|awesome-|\/upstream\/|dsh-tavern|history\/AGENTS-|third[_-]?party|\.min\.)/i;
const IN_SCOPE = /(akasha|memory-architecture|session-layer|superpowers\/plans|history\/akasha|PROTOCOL|MEMORY-TEST|mirror|lexicon|frontier)/i;
const files = [...walk('<LOCAL_PATH>/research'), ...walk('<LOCAL_PATH>/docs')]
  .filter((x) => !EXCLUDE.test(norm(x.p)) && IN_SCOPE.test(norm(x.p)))
  .map(({ p, stat }) => {
    const rel = p.replace(/\\/g, '/').replace('<LOCAL_PATH>/', '');
    const name = basename(p).toLowerCase();
    const hit = [...refs].some((r) => r.endsWith(name) || rel.toLowerCase().endsWith(r) || r.endsWith(rel.toLowerCase()));
    return { rel, kb: Math.round(stat.size / 1024), ref: hit, mtime: stat.mtime.toISOString().slice(0, 10) };
  })
  .sort((a, b) => b.kb - a.kb);

const missing = files.filter((f) => !f.ref);
console.log('回填审计：research/ + docs/ 共 ' + files.length + ' 份 .md/.txt；已有 canon 出处 ' + (files.length - missing.length) + ' · **未回填 ' + missing.length + '**');
console.log('  ── 未回填（按体量前 15）：');
for (const f of missing.slice(0, 15)) console.log('   ' + String(f.kb).padStart(5) + ' KB  ' + f.mtime + '  ' + f.rel);
console.log('  ── 已有出处（前 8）：');
for (const f of files.filter((x) => x.ref).slice(0, 8)) console.log('   ' + String(f.kb).padStart(5) + ' KB  ' + f.rel);
