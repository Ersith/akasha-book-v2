// 迁移脚本模板（约定 #20，2026-10-11 立）
//
// 用法：复制本文件为 `tools/migrate-<YYYYMMDD>-<主题>.mjs`，只改 `migrate()`，然后：
//   node tools/migrate-20261011-xxx.mjs          ← 干跑（默认，只报告不写盘）
//   node tools/migrate-20261011-xxx.mjs --apply   ← 真写（自动先备份）
//
// 四条硬规矩（来自 2026-10-11 那次成功的存量回填实战；违反任一条都出过事）：
//   ① **干跑默认**：不加 --apply 绝不写盘 —— 先看清"会改多少"，再决定改不改。
//   ② **先备份**：写盘前把原文件复制到 data/_trash/<name>.<原因>-<日期>。
//   ③ **幂等**：跑第二遍必须 0 变更 —— 否则它不是迁移，是"每次都在改"的定时炸弹。
//   ④ **只碰派生数据**：索引 / 缓存类可直接改；**六库原文（canon 等）与原始会话日志一律走修订链**，
//      不在这里改（迁移脚本改原文＝绕过审计，禁）。
//
// 退出码：0 = 正常（含"无事可做"）；非 0 = 拒绝执行（锚点缺失 / 备份失败 / 幂等自检不过）。

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');   // tools/ 的上一级 = akasha/（原写法在真实位置会解析成 tools/）
const apply = process.argv.includes('--apply');

// ── 配置：按需改这三行 ──
const TARGET = join(ROOT, 'data', 'session.jsonl');       // 要迁移的文件（派生物）
const REASON = 'template';                                 // 备份文件名里的原因标签
const DATE = new Date().toISOString().slice(0, 10);

/**
 * 纯函数：把一行记录迁到新形态。**不做 IO、不改全局**（便于幂等自检与单测）。
 * @returns {{line: string|null, changed: boolean}} line=null 表示丢弃该行（慎用，优先改写）
 */
function migrateLine(line) {
  let rec;
  try { rec = JSON.parse(line); } catch { return { line, changed: false }; }   // 坏行原样留（不吞）
  let changed = false;
  // ↓↓↓ 在这里写你的迁移动作（示例：给某类记录补一个显式标记，已补过的跳过 ⇒ 幂等）
  if (rec && rec.kind === 'EXAMPLE' && rec.migrated !== true) {
    rec.migrated = true;
    changed = true;
  }
  // ↑↑↑
  return { line: changed ? JSON.stringify(rec) : line, changed };
}

// ── 运行器（通常不用改）──
function run() {
  if (!existsSync(TARGET)) { console.error('✗ 目标不存在：' + TARGET); process.exit(2); }
  const raw = readFileSync(TARGET, 'utf8');
  const lines = raw.split(/\r?\n/).filter(Boolean);
  let changed = 0;
  const out = lines.map((l) => {
    const r = migrateLine(l);
    if (r.changed) changed++;
    return r.line;
  }).filter((x) => x !== null);

  console.log('══ 迁移 ' + (apply ? '（应用）' : '（干跑）') + ' ══');
  console.log('  目标：' + TARGET);
  console.log('  总行 ' + lines.length + ' · 变更 ' + changed + ' 行');

  if (!changed) { console.log('  ✓ 无事可做（幂等：已迁移过或没有匹配项）'); return; }
  if (!apply) { console.log('  （未加 --apply ⇒ 只报告，不写盘）'); return; }

  const trash = join(ROOT, 'data', '_trash');
  if (!existsSync(trash)) mkdirSync(trash, { recursive: true });
  const bak = join(trash, TARGET.split(/[\\/]/).pop() + '.' + REASON + '-' + DATE);
  copyFileSync(TARGET, bak);
  writeFileSync(TARGET, out.join('\n') + '\n', 'utf8');
  console.log('  ✓ 已写盘 · 备份 → ' + bak);

  // 幂等自检：立刻用同一函数再算一遍，必须是 0 变更
  const again = out.reduce((n, l) => n + (migrateLine(l).changed ? 1 : 0), 0);
  if (again !== 0) { console.error('✗ 幂等自检不过：再跑会再改 ' + again + ' 行 —— 请修 migrateLine 后重来（已留下备份）'); process.exit(3); }
  console.log('  ✓ 幂等自检通过（再跑为 0 变更）');
}

run();
