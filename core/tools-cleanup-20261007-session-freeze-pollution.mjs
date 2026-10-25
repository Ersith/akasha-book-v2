// akasha/tools/cleanup-20261007-session-freeze-pollution.mjs
// 缺陷修复清理（2026-10-07）：移除「以副本路径为会话键」的 2434 条污染记录（冻结副本幂等测试副产物）。
// 步骤：备份 → 过滤（只删 session===路径 的记录）→ 写回 → 校验。一次运行后幂等（无目标行则不动）。
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STORE = join(ROOT, 'data', 'session.jsonl');
const META = join(ROOT, 'data', 'session-meta.json');
const BAD_KEY = '<LOCAL_PATH>\\_scratch\\session-freeze-7fe8ec84\\session.v4.jsonl.zstd';
const TS = new Date().toISOString().replace(/[:.]/g, '-');
const BACKUP = '<LOCAL_PATH>\\_scratch\\session-cleanup-backup-' + TS + '.jsonl';

const lines = readFileSync(STORE, 'utf8').trim().split('\n');
const bad = lines.filter((l) => { try { return JSON.parse(l).session === BAD_KEY; } catch { return false; } });
console.log('总行数:', lines.length, '| 目标污染行:', bad.length);
if (!bad.length) { console.log('无目标行——已干净，跳过。'); process.exit(0); }

copyFileSync(STORE, BACKUP);
console.log('备份 →', BACKUP);
const kept = lines.filter((l) => { try { return JSON.parse(l).session !== BAD_KEY; } catch { return true; } });
writeFileSync(STORE, kept.join('\n') + '\n');

// meta：清掉伪会话键（如存在）
if (existsSync(META)) {
  const meta = JSON.parse(readFileSync(META, 'utf8'));
  const sessions = meta.sessions || meta;
  let touched = false;
  if (sessions && typeof sessions === 'object' && BAD_KEY in sessions) { delete sessions[BAD_KEY]; touched = true; }
  if (touched) { copyFileSync(META, META + '.bak-' + TS); writeFileSync(META, JSON.stringify(meta, null, 2)); console.log('meta 已清理伪键'); }
  else console.log('meta 无伪键');
}
const after = readFileSync(STORE, 'utf8').trim().split('\n').length;
console.log('清理后行数:', after, '（应等于 ' + (lines.length - bad.length) + '）', after === lines.length - bad.length ? '✓' : '✗ 不一致!');
