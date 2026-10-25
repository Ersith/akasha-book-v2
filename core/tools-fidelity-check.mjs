// fidelity-check.mjs —— 记忆的**保真度**量化（用户 2026-10-11 指定的检验：回答里有多少是库内原文）。
// 方法（写死，防事后调参）：
//   ① 切句：答案与库内条目原文各按「。；！？\n」切分，丢弃长度 < 6 的碎句；
//   ② 命中判据：答案句与**该案 rubric 条目原文**的最长公共子串(LCS) ≥ 10 个字符 ⇒ 记该句「源于库内原文」；
//   ③ 指标：命中句占比（句级）、命中字符占比（字符级）；另统计「库内特有串」（条目 id、原文里的数字+单位）出现次数。
// 用法：node tools/fidelity-check.mjs --pack <目录> [--rubric <pack.json 或 v2run/pack.json>]
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { currentRecords, loadStore } from './lib.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const PACK = flag('--pack');
const RUBRIC_SRC = flag('--rubric', '<LOCAL_PATH>\\_ab\\review-pack-v2run\\pack.json');
if (!PACK) { console.error('用法：--pack <目录>'); process.exit(2); }

const canon = currentRecords(loadStore('canon').records);
const byId = new Map(canon.map((r) => [String(r.id), String(r.claim ?? '')]));
const pack = JSON.parse(readFileSync(RUBRIC_SRC, 'utf8'));
const rubricOf = new Map(pack.cases.map((c) => [c.id, c.rubricRefs ?? []]));

const splitSent = (t) => String(t).split(/[。；！？\n]+/).map((s) => s.trim()).filter((s) => s.length >= 6);
function lcsLen(a, b) {                       // 朴素 LCS 长度（句长有限，够用）
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  let prev = new Array(n + 1).fill(0), best = 0;
  for (let i = 1; i <= m; i++) {
    const cur = new Array(n + 1).fill(0);
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) best = cur[j]; }
    }
    prev = cur;
  }
  return best;
}
function scoreAnswers(file, ids) {
  const text = readFileSync(file, 'utf8');
  // 取该文件里指定 case 的小节（## case-XX 到下一个 ##）
  const sections = new Map();
  for (const m of text.matchAll(/^##\s+(case-\d+)([\s\S]*?)(?=^##\s|\Z)/gm)) sections.set(m[1], m[2]);
  let hitSent = 0, allSent = 0, hitChars = 0, allChars = 0, noRubric = 0;
  const perCase = [];
  for (const [cid, body] of sections) {
    const refs = (rubricOf.get(cid) ?? []).filter((r) => byId.has(r));
    if (!refs.length) { noRubric++; perCase.push({ cid, skipped: true }); continue; }
    const src = refs.map((r) => byId.get(r)).join('\n');
    const srcSents = splitSent(src);
    const ansSents = splitSent(body);
    let h = 0, hc = 0;
    for (const s of ansSents) {
      allSent++;
      let best = 0;
      for (const t of srcSents) { const L = lcsLen(s, t); if (L > best) best = L; }
      if (best >= 10) { h++; hc += s.length; }
    }
    hitSent += h; allSent += ansSents.length - 0;
    hitChars += hc; allChars += ansSents.reduce((a, s) => a + s.length, 0);
    perCase.push({ cid, sent: h + '/' + ansSents.length, chars: Math.round(100 * hc / Math.max(1, ansSents.reduce((a, s) => a + s.length, 0))) + '%' });
  }
  // 修：allSent 已累加，减掉无 rubric 案（上面未累加，安全）
  return { perCase, hitSent, allSent, hitPercent: Math.round(100 * hitSent / Math.max(1, allSent)), charPercent: Math.round(100 * hitChars / Math.max(1, allChars)), noRubric };
}

const dirs = readdirSync(PACK).includes('answers') ? [join(PACK, 'answers')] : [];
if (!dirs.length) { console.error('找不到 answers/ 目录：' + PACK); process.exit(2); }
const files = readdirSync(dirs[0]).filter((f) => /^arm-.*\.md$/i.test(f)).sort();
console.log('保真度检验：' + PACK);
console.log('  rubric 来源：' + RUBRIC_SRC + '（库内条目原文）');
for (const f of files) {
  const r = scoreAnswers(join(dirs[0], f), null);
  console.log('  ' + f.padEnd(12) + '：句级命中 ' + r.hitSent + '/' + r.allSent + ' = ' + r.hitPercent + '%   字符级 ' + r.charPercent + '%' + (r.noRubric ? '   （无 rubric 案 ' + r.noRubric + ' 个，已排除）' : ''));
  console.log('      逐案：' + r.perCase.filter((c) => !c.skipped).map((c) => c.cid.replace('case-', '') + ':' + c.sent).join('  '));
}
