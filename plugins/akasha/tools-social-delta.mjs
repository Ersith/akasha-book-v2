// akasha/tools/social-delta.mjs —— 社会学习 v1 最小仪器（prediction-delta 协议）
// 纯 Node、零依赖、append-only；数据落 logs/social-deltas.jsonl；刻意不碰六库。
// 用法：
//   node social-delta.mjs predict --target <名> --task <要做的事> --expect <结构级预测>
//   node social-delta.mjs observe --id <pd-…> --delta <差异> --magnitude <0-5> --verdict <confirmed|refuted|not-yet|transferable> [--why <她为什么这么做>] [--recoveries <坑→思考→动作→结果>] [--lesson <教训>]
//   node social-delta.mjs study --target <名> --goal <达成的目的> --path <达成路径> [--why <理由提取>] [--recoveries <坑与恢复>] [--lesson <教训>]
//   node social-delta.mjs list [--target <名>]
//   node social-delta.mjs stats
// 口径（2026-10-09 用户修正）：坑只是过程的一部分；过程＝正确推理 ＋ 遇坑并解决。
// 学三件：成功案例的「达成路径」、她「为什么这么推理」（取自工件里的公开理由——设计稿 / commit 的 Rules / 自定口径 / CHECKS 记录，不是私密 CoT）、「遇坑如何思考与解决」。
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const LOG = join(ROOT, '..', 'logs', 'social-deltas.jsonl');

function readAll() {
  try {
    return readFileSync(LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
}
function append(rec) {
  mkdirSync(dirname(LOG), { recursive: true });
  appendFileSync(LOG, JSON.stringify(rec) + '\n', 'utf8');
}
function argsOf(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
    else out._.push(a);
  }
  return out;
}
const ts = () => new Date().toISOString();
const id36 = () => 'pd-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const VERDICTS = ['confirmed', 'refuted', 'not-yet', 'transferable'];

const cmd = process.argv[2];
const a = argsOf(process.argv.slice(3));

try {
  if (cmd === 'predict') {
    if (!a.target || !a.task || !a.expect) throw new Error('predict 需要 --target --task --expect');
    const rec = { kind: 'prediction', id: id36(), ts: ts(), target: String(a.target), task: String(a.task), expect: String(a.expect) };
    append(rec);
    console.log('已落预测 ' + rec.id + '  target=' + rec.target);
  } else if (cmd === 'observe') {
    if (!a.id || !a.delta || a.magnitude === undefined || !a.verdict) throw new Error('observe 需要 --id --delta --magnitude --verdict');
    const mag = Number(a.magnitude);
    if (!(mag >= 0 && mag <= 5 && Number.isInteger(mag))) throw new Error('--magnitude 须为 0..5 整数');
    if (!VERDICTS.includes(a.verdict)) throw new Error('--verdict 须为 ' + VERDICTS.join('/'));
    const all = readAll();
    const pred = all.find((r) => r.kind === 'prediction' && r.id === a.id);
    if (!pred) throw new Error('找不到预测：' + a.id);
    const rec = { kind: 'observation', id: a.id, ts: ts(), delta: String(a.delta), magnitude: mag, verdict: String(a.verdict), why: a.why ? String(a.why) : '', recoveries: a.recoveries ? String(a.recoveries) : '', lesson: a.lesson ? String(a.lesson) : '' };
    append(rec);
    console.log('已落观测 ' + a.id + '  Δ=' + mag + '  verdict=' + a.verdict);
  } else if (cmd === 'study') {
    if (!a.target || !a.goal || !a.path) throw new Error('study 需要 --target --goal --path（成功案例：达成的目的 + 达成路径）');
    const rec = { kind: 'study', id: id36(), ts: ts(), target: String(a.target), goal: String(a.goal), path: String(a.path), why: a.why ? String(a.why) : '', recoveries: a.recoveries ? String(a.recoveries) : '', lesson: a.lesson ? String(a.lesson) : '' };
    append(rec);
    console.log('已落学习 ' + rec.id + '  target=' + rec.target + '  goal=' + rec.goal.slice(0, 40));
  } else if (cmd === 'list') {
    const all = readAll();
    const obs = new Map();
    for (const r of all) if (r.kind === 'observation') obs.set(r.id, r);
    for (const p of all.filter((r) => r.kind === 'prediction' && (!a.target || r.target === a.target))) {
      const o = obs.get(p.id);
      console.log('· ' + p.id + ' [' + p.target + '] ' + (o ? 'Δ=' + o.magnitude + '/' + o.verdict : '待观测') + '  — ' + p.task);
    }
    for (const s of all.filter((r) => r.kind === 'study' && (!a.target || r.target === a.target))) {
      console.log('★ ' + s.id + ' [' + s.target + '] 达成：' + s.goal);
    }
  } else if (cmd === 'stats') {
    const all = readAll();
    const preds = all.filter((r) => r.kind === 'prediction');
    const obs = new Map(all.filter((r) => r.kind === 'observation').map((r) => [r.id, r]));
    const done = preds.filter((p) => obs.has(p.id));
    const mags = done.map((p) => obs.get(p.id).magnitude);
    const avg = mags.length ? (mags.reduce((x, y) => x + y, 0) / mags.length).toFixed(2) : '—';
    const byVerdict = {};
    for (const p of done) byVerdict[obs.get(p.id).verdict] = (byVerdict[obs.get(p.id).verdict] ?? 0) + 1;
    const byTarget = {};
    for (const p of preds) { const t = byTarget[p.target] ?? (byTarget[p.target] = { preds: 0, obs: 0 }); t.preds++; if (obs.has(p.id)) t.obs++; }
    console.log('社会学习账本：预测 ' + preds.length + ' / 已观测 ' + done.length + ' / 待观测 ' + (preds.length - done.length) + ' / 成功案例学习 ' + all.filter((r) => r.kind === 'study').length);
    console.log('  平均 |Δ| = ' + avg + '   verdict: ' + (Object.keys(byVerdict).length ? JSON.stringify(byVerdict) : '—'));
    for (const t of Object.keys(byTarget)) console.log('  target ' + t + '：' + byTarget[t].preds + ' 预测 / ' + byTarget[t].obs + ' 观测');
  } else {
    console.log('用法：social-delta.mjs <predict|observe|list|stats> [--flags]（见文件头注释）');
  }
} catch (e) {
  console.error('social-delta: ' + String(e?.message ?? e));
  process.exit(1);
}
