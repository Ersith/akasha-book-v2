// 终修（2026-10-11）：① 值侧 `\S+` ⇒ 窄字符集（根因）② 凭据回填改**结构化**（不再整行文本替换）
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { redact } from './lib.mjs';

// ── ① 修 lib.mjs 的值侧 ──
const LF = '<AKASHA_DIR>/lib.mjs';
let src = readFileSync(LF, 'utf8');
const OLD = "|\\d{1,4}\\b|-{1,3}\\s*$)(\\S+)/gi, '$1[redacted]'],";
const NEW = "|\\d{1,4}\\b|-{1,3}\\s*$)([A-Za-z0-9_\\-./+:=]{6,})/gi, '$1[redacted]'],";
if (src.includes(NEW)) console.log('① ✓ 已是窄字符集（幂等）');
else if (!src.includes(OLD)) console.log('① ✗ 锚点未找到，未改（需人工看）');
else {
  src = src.replace(OLD, NEW);
  src = src.replace('  //   ＋**纯短数字**（1–4 位）同样排除（2026-10-11 手检补）：实测 `token= 200` / `token=403` 是**状态码**，',
    '  //   ⚠️ **值侧必须是窄字符集**（2026-10-11 手检实证的**根因**）：原本写 `\\S+` ⇒ 它**假设"空白=边界"**，\n' +
    '  //     而 JSON / 代码文本里**没有空白** ⇒ 实测在一条 session.jsonl 记录里**吞掉了半行**（含 JSON 结构符）\n' +
    '  //     ⇒ **把派生索引改成坏行** ✗✗。修法＝只吃凭据字符（遇 \' " , } 即停）✓\n' +
    '  //   ＋**纯短数字**（1–4 位）同样排除（2026-10-11 手检补）：实测 `token= 200` / `token=403` 是**状态码**，');
  copyFileSync(LF, LF + '.bak-narrow-charset-20261011');
  writeFileSync(LF, src, 'utf8');
  console.log('① ✓ 已改值侧为窄字符集 · 备份 → lib.mjs.bak-narrow-charset-20261011');
}

// ── ② 结构化回填（重新导入改后的 lib）──
const lib = await import('file:///<AKASHA_DIR>/lib.mjs?v=narrow');
const TARGET = '<AKASHA_DIR>/data/session.jsonl';
const apply = process.argv.includes('--apply');
const lines = readFileSync(TARGET, 'utf8').split(/\r?\n/).filter(Boolean);

/** 结构化：解析 ⇒ 只洗**字符串字段的值** ⇒ 序列化（不动 JSON 结构） */
function migrateLine(line) {
  let rec;
  try { rec = JSON.parse(line); } catch { return { line, changed: false, bad: true }; }
  const walk = (v) => {
    if (typeof v === 'string') return lib.redact(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = walk(v[k]); return o; }
    return v;
  };
  const out = walk(rec);
  const s = JSON.stringify(out);
  return { line: s, changed: s !== line };
}

let changed = 0, bad = 0;
const outLines = lines.map((l) => { const r = migrateLine(l); if (r.changed) changed++; if (r.bad) bad++; return r.line; });
// 自检：① 每行仍须是合法 JSON ② 幂等
let stillBad = 0;
for (const l of outLines) { try { JSON.parse(l); } catch { stillBad++; } }
const again = outLines.reduce((n, l) => n + (migrateLine(l).changed ? 1 : 0), 0);

console.log('\n② 结构化回填 ' + (apply ? '（应用）' : '（干跑）'));
console.log('   总行 ' + lines.length + ' · 变更 ' + changed + ' 行 · 原坏行 ' + bad);
console.log('   自检①每行仍是合法 JSON：' + (stillBad === 0 ? '✓' : '✗ ' + stillBad + ' 坏行'));
console.log('   自检②幂等（再跑应 0）：' + (again === 0 ? '✓ 0 变更' : '✗ 还会改 ' + again + ' 行'));
if (stillBad || again) { console.log('   ⇒ 自检不过，**不写盘**'); process.exit(3); }
if (!apply) { console.log('   （未加 --apply ⇒ 只报告）'); process.exit(0); }

const trash = '<AKASHA_DIR>/data/_trash';
if (!existsSync(trash)) mkdirSync(trash, { recursive: true });
const bak = trash + '/session.jsonl.pre-credential-redact2-2026-10-11';
copyFileSync(TARGET, bak);
writeFileSync(TARGET, outLines.join('\n') + '\n', 'utf8');
console.log('   ✓ 已写盘 · 备份 → ' + bak);
