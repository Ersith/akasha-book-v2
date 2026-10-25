// 迁移：把会话层派生索引里残留的明文凭据洗掉（2026-10-11；#20 模板的首个真实用例）
// 出处：手检发现 `npm_Dc0z…` 明文落在 data/session.jsonl（3 条记录：intent / process / action）
// 规矩（§八）：干跑默认 · 先备份 · 幂等 · **只碰派生数据**（会话原档与六库原文一律不动）✓
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { redact } from './lib.mjs';   // ⚠️ 脚本在 tools/ 下 ⇒ 核心库是上一级 ../lib.mjs（本行踩过一次）

const TARGET = '<AKASHA_DIR>/data/session.jsonl';
const REASON = 'pre-credential-redact';
const DATE = new Date().toISOString().slice(0, 10);
const apply = process.argv.includes('--apply');

function migrateLine(line) {
  const out = redact(line);            // 整行过一遍脱敏（含 gist / keywords / 命令文本）
  return { line: out, changed: out !== line };
}

if (!existsSync(TARGET)) { console.error('✗ 目标不存在'); process.exit(2); }
const lines = readFileSync(TARGET, 'utf8').split(/\r?\n/).filter(Boolean);
let changed = 0;
const out = lines.map((l) => { const r = migrateLine(l); if (r.changed) changed++; return r.line; });

console.log('══ 凭据回填 ' + (apply ? '（应用）' : '（干跑）') + ' ══');
console.log('  总行 ' + lines.length + ' · 变更 ' + changed + ' 行');
if (!changed) { console.log('  ✓ 无事可做（幂等）'); process.exit(0); }
if (!apply) { console.log('  （未加 --apply ⇒ 只报告，不写盘）'); process.exit(0); }

const trash = '<AKASHA_DIR>/data/_trash';
if (!existsSync(trash)) mkdirSync(trash, { recursive: true });
const bak = trash + '/session.jsonl.' + REASON + '-' + DATE;
copyFileSync(TARGET, bak);
writeFileSync(TARGET, out.join('\n') + '\n', 'utf8');
console.log('  ✓ 已写盘 · 备份 → ' + bak);

const again = out.reduce((n, l) => n + (migrateLine(l).changed ? 1 : 0), 0);
if (again !== 0) { console.error('✗ 幂等自检不过：再跑还会改 ' + again + ' 行'); process.exit(3); }
console.log('  ✓ 幂等自检通过（再跑为 0 变更）');
