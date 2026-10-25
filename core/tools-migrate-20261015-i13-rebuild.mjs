// 一次性：I-13 修复后的会话层索引全量重建（2026-10-15）
// 背景：V1（completedCallSeqs 未按会话过滤）+ V2（sid8 撞号）已造成历史段静默丢失/跳过；
//       修好后需 `--full` 重扫全部会话，把可恢复的段补回（靠 (seq,kind,gist,why,tools) 内容键去重，不产生重复）。
// 纪律：① 先备份 store + meta（只搬不删）；② 只动派生索引 session.jsonl / session-meta.json，原始档案一字不动；③ 打印前后对照。
// 用法：node tools/migrate-20261015-i13-rebuild.mjs [--apply]     （不带 --apply 只预演）
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as s from './session.mjs';

const ROOT = '<AKASHA_DIR>';
const STORE = join(ROOT, 'data', 'session.jsonl');
const META = join(ROOT, 'data', 'session-meta.json');
const BAK = '<LOCAL_PATH>/_rollback-20261015-i13';
const APPLY = process.argv.includes('--apply');

const meta = JSON.parse(readFileSync(META, 'utf8'));
const sids = Object.keys(meta.sessions ?? {});
const before = readFileSync(STORE, 'utf8').split('\n').filter(Boolean);
const beforeIds = new Set(before.map((l) => { try { return JSON.parse(l).id; } catch { return null; } }));
const beforeBySid = {};
for (const l of before) {
  try { const r = JSON.parse(l); if (r.session) beforeBySid[r.session] = (beforeBySid[r.session] ?? 0) + 1; } catch { /* 坏行跳过 */ }
}
console.log(`重建前：${before.length} 行 / ${beforeIds.size} 唯一 id / ${sids.length} 个会话`);
const prefixed = sids.filter((x) => x.startsWith('session-'));
console.log(`前缀会话（V2 受灾面）：${prefixed.length} 个 → ${prefixed.map((x) => `${x}(${beforeBySid[x] ?? 0})`).join(', ')}`);

if (!APPLY) {
  console.log('\n[预演] 加 --apply 才执行。备份目标：' + BAK);
  process.exit(0);
}

mkdirSync(BAK, { recursive: true });
copyFileSync(STORE, join(BAK, 'session.jsonl.pre-i13'));
copyFileSync(META, join(BAK, 'session-meta.json.pre-i13'));
console.log('已备份 →', BAK);

let added = 0; let skipped = 0; const perSid = [];
for (const sid of sids) {
  // P1 审计修正（2026-10-15）：本模块导出的是 `SESSION_DEFAULTS`（不是 DEFAULTS）；原 `s.DEFAULTS?.sessionsRoot`
  // 恒为 undefined ⇒ 一直靠硬编码兜底（假兜底）。
  const file = s.resolveSessionFile(s.SESSION_DEFAULTS.sessionsRoot, sid);
  if (!file) { perSid.push(`${sid}: 档案未找到`); continue; }
  const r = s.indexSession({ file, session: sid, full: true });
  added += r.added ?? 0; skipped += r.skipped ?? 0;
  perSid.push(`${sid}: +${r.added} / skip ${r.skipped}`);
}
console.log('\n逐会话：');
for (const line of perSid) console.log('  ' + line);

const after = readFileSync(STORE, 'utf8').split('\n').filter(Boolean);
const afterIds = after.map((l) => { try { return JSON.parse(l).id; } catch { return null; } });
const dup = afterIds.length - new Set(afterIds).size;
const afterBySid = {};
for (const l of after) {
  try { const r = JSON.parse(l); if (r.session) afterBySid[r.session] = (afterBySid[r.session] ?? 0) + 1; } catch { /* 坏行 */ }
}
console.log(`\n重建后：${after.length} 行 / ${new Set(afterIds).size} 唯一 id / 重复 id ${dup}`);
console.log(`本次新增段 ${added}（skip ${skipped}）`);
// 自检补强（2026-10-15，P1 审计 P1-4）：只查 id 唯一性不够——**必须查内容重复与跨键孪生**，否则「重复 id 0」是假安心。
const norm = (s) => String(s ?? '').replace(/^session-/, '');
const ckey = (r) => JSON.stringify([norm(r.session), r.seq, r.kind, r.gist, r.why ?? '', Array.isArray(r.tools) ? r.tools : String(r.tools ?? '')]);
const cseen = new Map();
for (const l of after) { try { const r = JSON.parse(l); const k = ckey(r); cseen.set(k, (cseen.get(k) ?? 0) + 1); } catch { /* 坏行 */ } }
const contentDup = [...cseen.values()].filter((n) => n > 1).reduce((a, b) => a + b - 1, 0);
const sidsNorm = new Set(after.map((l) => { try { return norm(JSON.parse(l).session); } catch { return null; } }).filter(Boolean));
console.log(`内容键重复行数（跨形态归一后）：${contentDup}`);
console.log(`活体会话键数（归一后）：${sidsNorm.size}（原 ${new Set(after.map((l) => { try { return JSON.parse(l).session; } catch { return null; } }).filter(Boolean)).size}）`);
for (const x of prefixed) console.log(`  前缀会话 ${x}：${beforeBySid[x] ?? 0} → ${afterBySid[x] ?? 0}`);
