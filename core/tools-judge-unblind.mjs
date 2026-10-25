// judge-unblind.mjs —— 揭盲算分：把判卷书（按"解答1/解答2"写的档位）按 _mapping.json 折算回"每臂"总分。
// 为什么要脚本：列→臂映射是**逐案随机**的，列总分（13 vs 13）与臂总分**不是一回事**（本轮 v2 就是典型：列平、臂不平）。
// 用法：node tools/judge-unblind.mjs [--pack <目录>]
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const pi = args.indexOf('--pack');
const PACK = pi >= 0 ? args[pi + 1] : '<LOCAL_PATH>\\_ab\\review-pack-v2run';
const SCORE = { A: 2, B: 1, C: 0, D: -1 };

const mapping = JSON.parse(readFileSync(join(PACK, 'judge', '_mapping.json'), 'utf8'));
const verdict = readFileSync(join(PACK, 'judge', 'verdict.md'), 'utf8');

const perArm = { A: 0, B: 0 };
const perCase = [];
let scored = 0;
// 解析：宽容两种写法——
//   `case-01：解答1 = A（…）；解答2 = B（…）`
//   `case-01（说明…）：解答1 = A（…）；解答2 = B（…）`（v3 判卷书用了这种）
for (const line of verdict.split(/\r?\n/)) {
  const m = line.match(/^\s*(case-\d+)[^：:]*[：:][\s\S]*?解答1\s*=\s*([ABCD])[\s\S]*?解答2\s*=\s*([ABCD])/);
  if (!m) continue;
  const [, cid, s1, s2] = m;
  const order = mapping.order?.[cid];
  if (!order) { console.log('  ⚠ ' + cid + ' 无映射，跳过'); continue; }
  const aScore = SCORE[order[0] === 'A' ? s1 : s2];
  const bScore = SCORE[order[1] === 'A' ? s1 : s2];
  perArm.A += aScore; perArm.B += bScore; scored++;
  perCase.push({ cid, order: order.join('/'), s1, s2, A: aScore, B: bScore });
}

console.log('揭盲结果：' + PACK);
console.log('  规则版本：' + (mapping.ruleVersion ?? 'n/a') + '  计分案数：' + scored + '（满分 ' + scored * 2 + '）');
for (const c of perCase) {
  const mark = c.A === c.B ? '  ' : (c.A > c.B ? ' ← A 高' : ' ← B 高');
  console.log('   ' + c.cid + '  呈现=' + c.order + ' 档位=' + c.s1 + '/' + c.s2 + ' ⇒ A=' + c.A + ' B=' + c.B + mark);
}
const diff = perArm.A - perArm.B;
console.log('  ────────────────');
console.log('  臂 A 总分 = ' + perArm.A + '   臂 B 总分 = ' + perArm.B + '   差 = ' + diff + '（正=A高）');
console.log('  列总分（判卷书汇总，仅参考）= 解答1 与解答2 之和，与臂总分不可混用');
