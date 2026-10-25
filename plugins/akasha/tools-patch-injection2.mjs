// 补丁 2（限定范围）：把 audit/summary/stats 三个函数体**变量形** `loadStore(name)` 接到注入，
// 并修 `audit` 内部 `stats()` 不转发 files 的断链（2026-10-15 全量检查 S-core-1 的完整修）
// 用法：node patch-injection2.mjs [--apply]
import { readFileSync, writeFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const F = '<AKASHA_DIR>/lib.mjs';
const lines = readFileSync(F, 'utf8').split('\n');
const targets = ['audit', 'summary', 'stats'];
let changed = 0;

for (const name of targets) {
  const start = lines.findIndex((l) => l.startsWith(`export function ${name}(`));
  if (start < 0) continue;
  let end = lines.findIndex((l, i) => i > start && l.startsWith('export function '));
  if (end < 0) end = lines.length;
  for (let i = start; i < end; i += 1) {
    if (/loadStore\(name\)/.test(lines[i])) { lines[i] = lines[i].replace(/loadStore\(name\)/g, 'L(name)'); changed += 1; }
    // audit 内部交接：`stats()` 无参 ⇒ 注入断链；补上 files/today
    if (name === 'audit' && /summary: stats\(\),/.test(lines[i])) { lines[i] = lines[i].replace('summary: stats(),', 'summary: stats({ files: opts.files, today }),'); changed += 1; }
  }
}
console.log(`变量形/交接改动点：${changed}`);
if (!APPLY) { console.log('[预演] 加 --apply 写入'); process.exit(0); }
writeFileSync(F, lines.join('\n'), 'utf8');
console.log('已写入');
