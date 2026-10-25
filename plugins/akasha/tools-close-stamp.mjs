#!/usr/bin/env node
// 写戳器（2026-10-18 从 tmp/close-stamp.mjs 搬入工具面，按 VERIFY-D §D6 建议；进 `akasha/tools/` 即自动入审核面）
//   · reviewed 由 `review-lag.mjs --face` 生成（不从源码猜白名单）
//   · at = 被审件最晚 mtime + 1ms（覆盖下界）
//   · 戳记 `chainLen`（写戳后戳链应有条数）＝链长度锚：删头/截断/只留尾 ⇒ 读端 `verifyStampChain` 报红
//   · `prev`/链尾 sha 由 `stamp-chain.jsonl` 维护（回滚/替换戳 ⇒ 报红）
// 已知弱项（如实）：同时改戳 + 追加匹配链（自洽重写）仍可绿——那需要外部锚，不在本工具职责内。
import { readFileSync, writeFileSync, appendFileSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..').replace(/\\/g, '/');   // <LOCAL_PATH>
const AK = ROOT + '/akasha';
const sha16 = (f) => createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16);
const G = AK + '/tools/gate.mjs';

// ① 面清单：问工具
const out = execFileSync(process.execPath, [AK + '/tools/review-lag.mjs', '--face'], { encoding: 'utf8', timeout: 60000 });
const face = out.split('\n').map((s) => s.trim()).filter((s) => /^(akasha|dsh[-])/.test(s));
if (face.length < 100) throw new Error('面清单异常（只拿到 ' + face.length + ' 条，疑似 --face 输出格式变了）');

// ② 全部收进 reviewed（戳的含义＝"这些件的这个 sha 是审过的"）
const reviewed = {};
const missing = [];
for (const rel of face) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) { missing.push(rel); continue; }
  reviewed[rel] = sha16(abs);
}

const STAMP_PATH = AK + '/gate-out/REVIEW-STAMP.json';
const CHAIN_PATH = AK + '/gate-out/stamp-chain.jsonl';
const prevRaw = readFileSync(STAMP_PATH);
const prevSha = createHash('sha256').update(prevRaw).digest('hex');
const prev = JSON.parse(prevRaw.toString('utf8'));

// ③ at = 面内件最晚 mtime + 1ms（覆盖下界；旧版误用 gate.mjs 的 mtime）
let maxMtime = 0;
for (const rel of Object.keys(reviewed)) {
  try { const m = statSync(join(ROOT, rel)).mtimeMs; if (m > maxMtime) maxMtime = m; } catch { /* skip */ }
}
const atMs = Math.max(maxMtime, statSync(G).mtimeMs) + 1;

// ④ 链长度锚：写戳后链应有条数 = 现有条数 + 本次追加
const chainLines = existsSync(CHAIN_PATH)
  ? readFileSync(CHAIN_PATH, 'utf8').split('\n').filter((l) => l.trim())
  : [];

const stamp = {
  at: new Date(atMs).toISOString(),
  writtenAt: new Date().toISOString(),
  by: '收口：戳面由 `node akasha/tools/review-lag.mjs --face` 生成（by 不写任何对象 sha，真值由 reviewed 承载）',
  note: 'at = 覆盖下界（被审件最晚 mtime +1ms）。reviewed 由 --face 生成。chainLen = 写戳后戳链应有条数（链长度锚，2026-10-18 VERIFY-D P1）。',
  prev: prevSha,
  chainLen: chainLines.length + 1,
  reviewed,
};
const stampText = JSON.stringify(stamp, null, 2);
if (process.argv.includes('--dry')) {
  console.log('[dry] 不写盘：face=' + face.length + ' 件 · reviewed=' + Object.keys(reviewed).length + ' 件 · at=' + stamp.at + ' · chainLen=' + stamp.chainLen + '（现有链 ' + chainLines.length + ' 条）');
  process.exit(0);
}
writeFileSync(STAMP_PATH, stampText, 'utf8');
{
  const sha = createHash('sha256').update(Buffer.from(stampText, 'utf8')).digest('hex');
  appendFileSync(CHAIN_PATH, JSON.stringify({
    at: stamp.at, writtenAt: stamp.writtenAt, sha, prev: prevSha, reviewed: Object.keys(reviewed).length,
  }) + '\n', 'utf8');
  console.log('戳链 +1（链尾 sha=' + sha.slice(0, 16) + '…，prev=' + prevSha.slice(0, 16) + '…，chainLen=' + stamp.chainLen + '）');
}
console.log('戳已重写：face=' + face.length + ' 件；reviewed=' + Object.keys(reviewed).length + ' 件' + (missing.length ? '；盘上缺失 ' + missing.length + ' 件' : ''));
if (missing.length) console.log('  缺失：' + missing.slice(0, 5).join(', '));
console.log('（对照：上一版 reviewed=' + Object.keys(prev.reviewed ?? {}).length + ' 件）');
