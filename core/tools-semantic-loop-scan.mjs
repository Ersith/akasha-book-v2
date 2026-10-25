// akasha/tools/semantic-loop-scan.mjs
// 语义级空转/思考环基线扫描（2026-10-07）：读会话档案的 reasoning / 正文流 → detectLoops 全量扫。
// 用法：node tools\semantic-loop-scan.mjs [--session <id>] [--json <out>]
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadStore } from './lib.mjs';
import { resolveSessionFile, readSessionArchive, SESSION_DEFAULTS } from './session.mjs';
import { detectLoops } from './loop-detect.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const only = args.includes('--session') ? args[args.indexOf('--session') + 1] : null;
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : join(HERE, '..', '..', 'research', 'semantic-loop-baseline-20261007.json');

const sessions = [...new Set(loadStore('session').records.filter((r) => r.kind !== 'node').map((r) => r.session))].filter((s) => !only || s === only);
const report = { at: new Date().toISOString(), sessions: {} };

for (const sid of sessions) {
  const file = resolveSessionFile(SESSION_DEFAULTS.sessionsRoot, sid);
  if (!file) { report.sessions[sid] = { error: '未找到档案' }; continue; }
  const { text, frames, frameFails } = readSessionArchive(file);
  const records = text.split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const agg = { frames, frameFails, records: records.length, messages: 0, exact: 0, variant: 0, punctRunMessages: 0, punctFillerMessages: 0, exactTop: [], variantTop: [], punctTop: [] };
  for (const rec of records) {
    if (rec.type !== 'assistant/message') continue;
    const parts = rec.data?.message?.content ?? [];
    let any = false;
    for (const part of parts) {
      const stream = part?.type === 'reasoning' ? 'reasoning' : part?.type === 'text' ? 'text' : null;
      if (!stream || !part.text || part.text.length < 60) continue;
      any = true;
      const r = detectLoops(part.text);
      if (r.exact.length) { agg.exact += 1; agg.exactTop.push({ seq: rec.seq, turn: rec.data?.turn ?? null, stream, excerpt: r.exact[0].excerpt }); }
      if (r.variant.length) { agg.variant += 1; agg.variantTop.push({ seq: rec.seq, turn: rec.data?.turn ?? null, stream, atA: r.variant[0].atA, atB: r.variant[0].atB, excerpt: r.variant[0].excerpt }); }
      if (r.punctRuns.length) {
        agg.punctRunMessages += 1;
        const filler = r.punctRuns.filter((x) => ((x.match(/[：:—–－]/g) ?? []).length >= 3 && x.length >= 8));
        if (filler.length) { agg.punctFillerMessages += 1; agg.punctTop.push({ seq: rec.seq, turn: rec.data?.turn ?? null, stream, run: filler[0].slice(0, 24) }); }
      }
    }
    if (any) agg.messages += 1;
  }
  agg.exactTop = agg.exactTop.slice(0, 8);
  agg.variantTop = agg.variantTop.slice(0, 8);
  agg.punctTop = agg.punctTop.slice(0, 8);
  report.sessions[sid] = agg;
  console.log(`—— ${sid.slice(0, 8)} —— 消息 ${agg.messages} / 块重复 ${agg.exact} / 变体重复 ${agg.variant} / 标点串 ${agg.punctRunMessages}（帧 ${frames}，坏帧 ${frameFails}）`);
  for (const t of agg.exactTop.slice(0, 3)) console.log(`  [exact] seq ${t.seq} turn ${t.turn} ${t.stream}：${t.excerpt}`);
  for (const t of agg.variantTop.slice(0, 3)) console.log(`  [variant] seq ${t.seq} turn ${t.turn} ${t.stream}：${t.excerpt}`);
  for (const t of agg.punctTop.slice(0, 3)) console.log(`  [punct] seq ${t.seq} turn ${t.turn} ${t.stream}：${t.run}`);
}

try { writeFileSync(jsonOut, JSON.stringify(report, null, 2) + '\n', 'utf8'); console.log('report → ' + jsonOut); }
catch (e) { console.log('报告写入失败（不影响扫描）：' + e.message); }
