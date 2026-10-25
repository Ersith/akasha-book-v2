// 退役"聚合型孤儿"（[inbox候选] …×N；只有计数、无样本 ⇒ 信息量 0；2026-10-13 已立规「aggregate 不转正」，
// 这些是规则生效前的存量）。软退役（墓碑，可 revoke），非 --hard 删除。
// 用法：node retire-aggregate-orphans.mjs [--apply]
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const APPLY = process.argv.includes('--apply');
const AK = '<AKASHA_DIR>';
const rows = readFileSync(`${AK}/data/orphan.jsonl`, 'utf8').split('\n').filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const cur = new Map();
for (const r of rows) cur.set(r.id, r);                       // 同 id 取最后版本
const targets = [...cur.values()].filter((r) => /^\[inbox候选\]/.test(String(r.summary ?? ''))
  && !/-r\d+$/.test(String(r.id)));          // 只退**基 id**：`-rN` 是同一条修订链的版本，退基即连带链条（退两次会重复立碑）
console.log(`聚合型孤儿（当前版本）：${targets.length} 条`);
for (const r of targets.slice(0, 5)) console.log('  ·', r.id, String(r.summary).slice(0, 48));
if (!APPLY) { console.log('\n[预演] 加 --apply 执行软退役。'); process.exit(0); }

let ok = 0; const fails = [];
for (const r of targets) {
  const p = spawnSync(process.execPath, ['akasha.mjs', 'retire', 'orphan', r.id, '--reason', '聚合型候选（只有计数无样本）——按 2026-10-13 规则「aggregate 不转正」，本批为规则生效前存量'],
    { cwd: AK, encoding: 'utf8', env: { ...process.env, AKASHA_QUERY_LOG: 'off' } });
  if (p.status === 0) ok += 1; else fails.push(`${r.id}: ${(p.stdout || p.stderr || '').trim().slice(0, 80)}`);
}
console.log(`已软退役 ${ok} 条${fails.length ? `，失败 ${fails.length}：` + fails.slice(0, 3).join(' | ') : ''}`);
