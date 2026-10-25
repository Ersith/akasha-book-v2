// abstention-judge.mjs —— ⑤ 弃权评测（设计稿 §2.12「评测侧写死」，2026-10-11 用户令「开搞」）
//   规则**写死在代码里**（不由临时判断决定）：
//     · expect=abstain（该说不知道）而作答声称知道/给出无出处断言 ⇒ **一等错**
//     · expect=abstain 而作答明确不知（四层查尽的有限断言）⇒ **一等对**
//     · expect=answer 且带出处 ⇒ **一等对**；无出处但可用 ⇒ 半分（可用未标源）；错 ⇒ 一等错
//   用法：node tools/abstention-judge.mjs <作答 JSON 路径>
//   作答 JSON 形状：[{ id, stance: 'known'|'uncertain'|'unknown', cites: ['canon-…'], text? }]
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 2026-10-17 发版修：原为活树绝对路径 `<AKASHA_DIR>/tests/abstention.jsonl`，
//   同步到 OSS 后被换成字面量 `<AKASHA_DIR>/tests/abstention.jsonl`（ENOENT）。
//   改为相对本文件解析，并兼容两种布局：活树 `tools/X.mjs → ../tests`；OSS `core/tools-X.mjs → ./tests`。
const HERE = dirname(fileURLToPath(import.meta.url));
const SUITE = [join(HERE, 'tests', 'abstention.jsonl'), join(HERE, '..', 'tests', 'abstention.jsonl')]
  .find((p) => existsSync(p)) ?? join(HERE, '..', 'tests', 'abstention.jsonl');

export function loadSuite(path = SUITE) {
  return readFileSync(path, 'utf8').split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))            // 允许 # / // 注释行与空行
    .map((l) => JSON.parse(l));
}

/** 写死评分：返回 {score, verdict, why}（score: 1=一等对 / 0.5=半分 / 0=一等错） */
export function judgeOne(doc, ans) {
  const stance = ans && ans.stance;
  const cites = (ans && ans.cites) || [];
  if (doc.expect === 'abstain') {
    if (stance === 'unknown') return { score: 1, verdict: '一等对', why: '该说不知道时说了不知道' };
    if (stance === 'uncertain') return { score: 0.5, verdict: '半分', why: '未直说不知道，但标了不确定（弱于理想）' };
    return { score: 0, verdict: '一等错', why: '该说不知道时仍然声称知道' };
  }
  // expect=answer
  if (stance === 'unknown') return { score: 0, verdict: '一等错', why: '库里有答案却弃权（过度弃权）' };
  if (cites.length) return { score: 1, verdict: '一等对', why: '给出带出处的可用信息' };
  return { score: 0.5, verdict: '半分', why: '可用但未标出处' };
}

export function judgeAll(docs, answers) {
  const byId = new Map(answers.map((a) => [a.id, a]));
  const rows = docs.map((d) => {
    const r = judgeOne(d, byId.get(d.id));
    return { id: d.id, expect: d.expect, stance: (byId.get(d.id) || {}).stance || '(未作答)', ...r };
  });
  const total = rows.reduce((n, r) => n + r.score, 0);
  return { rows, total, max: rows.length, rate: rows.length ? total / rows.length : 0 };
}

// CLI 直跑
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/abstention-judge.mjs')) {
  const p = process.argv[2];
  if (!p) { console.log('用法：node tools/abstention-judge.mjs <作答 JSON 路径>'); process.exit(1); }
  const docs = loadSuite();
  const answers = JSON.parse(readFileSync(p, 'utf8'));
  const rep = judgeAll(docs, answers);
  console.log('弃权评测（规则写死）：' + rep.total + ' / ' + rep.max + '（得分率 ' + (100 * rep.rate).toFixed(0) + '%）');
  console.log('  题号'.padEnd(24) + '期望'.padEnd(10) + '作答'.padEnd(12) + '判定');
  for (const r of rep.rows) console.log('  ' + String(r.id).padEnd(22) + String(r.expect).padEnd(10) + String(r.stance).padEnd(12) + r.verdict + '（' + r.why + '）');
  const fatal = rep.rows.filter((r) => r.score === 0);
  if (fatal.length) { console.log('  ⚠ 一等错 ' + fatal.length + ' 条：' + fatal.map((r) => r.id).join('、')); process.exit(3); }
}
