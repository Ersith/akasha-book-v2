#!/usr/bin/env node
// 交付包生成 + 自检（2026-10-15；GPT 第二份·优先⑥的教训项）
//
// 起因（两个真事故）：
//   ① 报告里写了「61 行 → 29 独立 → 17 升级」，而**交付包里实际是 85 → 30 → 17** ✗
//      —— 手写数字 = 时点值，交出去就是错的。⇒ **数字一律从产物重生成**，写进 PACK-MANIFEST.json，报告只许引用它。
//   ② 随包放了**旧件**：`escalate-fullcheck.json` 自身 `invalid-input` ✗（S6 的 status 用了早已修掉的非法值）
//      —— 打包时只是 cp 了当期目录里的存量。⇒ **每次重生成**：所有件从源重新拷贝 + 逐件自检。
//
// 用法：node akasha/tools/handover-pack.mjs [--dest <目录>] [--dry]
// 退出码：0 = 包内每件可解析、计数已重生成、无无效件；非零 = 自检失败（**不许把失败包交出去**）
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, basename } from 'node:path';

const AK = '<AKASHA_DIR>';
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const DRY = args.includes('--dry');
const DEST = flag('--dest', '<LOCAL_PATH>');

// ── 1. 计数：**从切片重生成**（不信任任何手写数字）────────────────────────────
const S = join(AK, 'gate-out/full-check-20261015/slices');
const SDIR = flag('--slices-dir', S);
const NEED = ['lead.jsonl', 'cli-mcp.jsonl', 'session-tools.jsonl', 'core.jsonl', 'plugins.jsonl'];
// 2026-10-18（GPT 第三轮 / ④）：**缺切片不许静默丢**（旧实现 filter(existsSync) ⇒ 少一个也照跑）。
const missingSlices = NEED.filter((f) => !existsSync(join(SDIR, f)));
if (missingSlices.length) { console.error('✗ 缺切片（不许静默丢文件）：' + missingSlices.join(', ')); process.exit(1); }
const FILES = NEED;
let recount = null;
{
  // 2026-10-18（GPT 第三轮 / ④）：用**本次新建**的输出目录（先清残留旧裁决），
  //   并读**新产物**的 verdict；旧实现只正则抠 stdout 数字、不查退出码、校验的是另一处旧文件 ⇒ 无效输入可出包。
  const OUT = join('D:/dsh-temp', 'handover-' + process.pid);
  rmSync(OUT, { recursive: true, force: true });
  const a = ['tools/gate.mjs', 'escalate', ...FILES.flatMap((f) => ['--slices', join(SDIR, f)]),
    '--task', 'handover-recount', '--out', OUT];
  const r = spawnSync(process.execPath, a, { cwd: AK, encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(/切片 (\d+) 行（(\d+) 文件）⇒ 去重后\*\*独立记录 (\d+) 条\*\*（重复填充 (\d+) 行）⇒ 升级 (\d+) 点（A1 (\d+) \/ A2 (\d+)）/);
  if (!m) { console.error('✗ 计数重生成失败（escalate 未产出可解析的三数）：\n' + out.slice(0, 500)); process.exit(1); }
  // 退出码与新鲜裁决才是"能不能出包"的判据：invalid-input / unverifiable ⇒ 退出码 3 ⇒ 拒绝出包。
  if (r.status !== 0) { console.error(`✗ escalate 退出码 ${r.status}（invalid-input/unverifiable 不得出包）：\n` + out.slice(0, 600)); process.exit(2); }
  const fresh = join(OUT, 'handover-recount', 'escalate.json');   // gate 的产物落在 <out>/<task>/ 下
  if (!existsSync(fresh)) { console.error('✗ escalate 未产出 escalate.json：' + fresh); process.exit(2); }
  let j;
  try { j = JSON.parse(readFileSync(fresh, 'utf8')); } catch (e) { console.error('✗ 新 escalate.json 不可解析：' + e.message); process.exit(2); }
  const v = String(j.verdict ?? '');
  if (!j.verdict || !j.certificate || v === 'invalid-input' || v === 'unverifiable') {
    console.error('✗ 新裁决不合格：verdict=' + (v || '(缺)') + '（缺证书 / invalid-input / unverifiable ⇒ 不许出包）'); process.exit(2);
  }
  recount = { rows: +m[1], files: +m[2], unique: +m[3], dups: +m[4], escalations: +m[5], a1: +m[6], a2: +m[7], verdict: v, at: new Date().toISOString() };
}

// ── 2. 包件清单：每次**从源重新拷贝**（防旧件 ✗）──────────────────────────────
const ITEMS = [
  ['gate-out/gate-selffix/HANDOVER-20261015.md', 'HANDOVER-20261015.md'],
  ['gate-out/gate-selffix/audit.md', 'audit.md'],
  ['gate-out/gate-selffix/audit-process.md', 'audit-process.md'],
  ['gate-out/gate-selffix/audit-gate-code.md', 'audit-gate-code.md'],
  ['gate-out/gate-selffix/audit-family-sweep.md', 'audit-family-sweep.md'],
  ['gate-out/gate-selffix/slices/lead-gate-selffix.jsonl', 'lead-gate-selffix.jsonl'],
  ['gate-out/gate-selffix/slices/process.jsonl', 'process.jsonl'],
  ['gate-out/gate-selffix/slices/gate-code.jsonl', 'gate-code.jsonl'],
  ['gate-out/gate-selffix/slices/family-sweep.jsonl', 'family-sweep.jsonl'],
  ['gate-out/gate-selffix/closure.md', 'closure-selffix.md'],
  ['gate-out/full-check-20261015/closeout-N.md', 'closeout-N.md'],
];

// 旧件禁令（2026-10-15）：escalate 的裁决已在上一步**从新产物**校验（④）；
//   这里不再校验 `gate-out/full-check-20261015/escalate.json` 那处旧源——那正是"验旧不验新"的 bug。

const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16);
const checkJson = (f) => {
  const txt = readFileSync(f, 'utf8');
  try { JSON.parse(txt); return { ok: true, kind: 'json' }; } catch { /* 试 jsonl */ }
  const lines = txt.split('\n').filter(Boolean);
  for (const [i, l] of lines.entries()) { try { JSON.parse(l); } catch { return { ok: false, kind: 'jsonl', why: `第 ${i + 1} 行不可解析` }; } }
  return { ok: true, kind: 'jsonl', rows: lines.length };
};

const manifest = { generatedAt: new Date().toISOString(), recount, items: [], problems: [] };
if (!DRY) mkdirSync(DEST, { recursive: true });

for (const [rel, name] of ITEMS) {
  const src = join(AK, rel);
  if (!existsSync(src)) { manifest.problems.push(`缺件（源不存在）：${rel}`); continue; }
  const dst = join(DEST, name);
  if (!DRY) copyFileSync(src, dst);
  const rec = { name, srcRel: rel, sha16: sha(src), bytes: statSync(src).size, mtime: statSync(src).mtime.toISOString() };
  if (/\.(json|jsonl)$/.test(name)) { const c = checkJson(src); rec.parse = c; if (!c.ok) manifest.problems.push(`不可解析：${name} —— ${c.why}`); }
  manifest.items.push(rec);
}

// 旧件禁令：已并入第 1 步——从**新产物**读 verdict（不再校验旧源文件，避免"验旧不验新"）。

// ── 3. 结论 ────────────────────────────────────────────────────────────────
if (!DRY) writeFileSync(join(DEST, 'PACK-MANIFEST.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.log(`计数（重生成）：${recount.rows} 行 → 独立 ${recount.unique} → 升级 ${recount.escalations}（A1 ${recount.a1} / A2 ${recount.a2}）`);
console.log(`包件 ${manifest.items.length} 件（${DRY ? 'dry：未写盘' : '已写 → ' + DEST}）`);
if (manifest.problems.length) {
  console.error(`⚠ 自检 ${manifest.problems.length} 项问题：`);
  for (const p of manifest.problems) console.error('   · ' + p);
  process.exit(2);
}
console.log('✓ 自检通过：每件可解析 · 计数已重生成 · 无旧件/无效件');
