// 限定范围补丁：只改 `audit` / `summary` / `stats` 三个函数体内**不带路径**的 loadStore 调用，
// 让它们真正吃 `opts.files` 注入（2026-10-15 全量检查 S-core-1：声称支持注入却真读真库）
// 用法：node patch-injection.mjs [--apply]
import { readFileSync, writeFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const F = '<AKASHA_DIR>/lib.mjs';
const src = readFileSync(F, 'utf8');
const lines = src.split('\n');

// 找三个函数的行范围（从 `export function X(` 到下一个 `export function` 之前）
const targets = ['audit', 'summary', 'stats'];
const ranges = [];
for (const name of targets) {
  const start = lines.findIndex((l) => l.startsWith(`export function ${name}(`));
  if (start < 0) { console.log(`· 未找到 ${name}（跳过）`); continue; }
  let end = lines.findIndex((l, i) => i > start && l.startsWith('export function '));
  if (end < 0) end = lines.length;
  ranges.push({ name, start, end });
}
console.log('函数范围：', ranges.map((r) => `${r.name}[${r.start + 1}..${r.end}]`).join(' '));

let changed = 0;
for (const { name, start, end } of ranges) {
  // 已经注入过的就不再插 helper
  const body = lines.slice(start, end).join('\n');
  const hasHelper = /const L = \(n\) =>/.test(body);
  for (let i = start; i < end; i += 1) {
    const m = lines[i].match(/loadStore\('([a-z]+)'\)/);
    if (m) { lines[i] = lines[i].replace(/loadStore\('([a-z]+)'\)/g, "L('$1')"); changed += 1; }
  }
  if (!hasHelper) {
    // 在函数体第一个 `{` 之后插 helper（缩进 2 空格）
    for (let i = start; i < end; i += 1) {
      if (lines[i].includes('{') && lines[i].includes(')')) {
        lines.splice(i + 1, 0,
          `  // 2026-10-15 全量检查（S-core-1）：本函数声称支持 \`opts.files\` 数据面注入，实际不带路径读真库 ⇒ 接上注入`,
          `  const L = (n) => loadStore(n, (opts.files && opts.files[n]) || storePath(n));`);
        changed += 1;
        break;
      }
    }
  }
}
console.log(`改动点：${changed}`);
if (!APPLY) { console.log('[预演] 加 --apply 写入'); process.exit(0); }
writeFileSync(F, lines.join('\n'), 'utf8');
console.log('已写入');
