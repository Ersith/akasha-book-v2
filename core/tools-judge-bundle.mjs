// judge-bundle.mjs —— 把两臂答案**打乱编号**，生成盲评判卷（判卷者看不到哪份来自哪臂）。
// 铁律：映射表写到单独的 _mapping.json，**不交给判卷者**；题面/评卷分离。
// 用法：node tools/judge-bundle.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const pi = args.indexOf('--pack');
const PACK = pi >= 0 ? args[pi + 1] : '<LOCAL_PATH>\\_ab\\review-pack';
const si = args.indexOf('--seed');
const SEED = si >= 0 ? Number(args[si + 1]) : 20261011;
const A = join(PACK, 'answers', 'arm-A.md');
const B = join(PACK, 'answers', 'arm-B.md');

function parseArm(text) {
  const out = new Map();
  const parts = String(text).split(/^##\s+/m).slice(1);
  for (const p of parts) {
    const nl = p.indexOf('\n');
    const id = p.slice(0, nl).trim();
    out.set(id, p.slice(nl + 1).trim());
  }
  return out;
}

const a = parseArm(readFileSync(A, 'utf8'));
const b = parseArm(readFileSync(B, 'utf8'));
const ids = [...a.keys()].filter((k) => b.has(k)).sort();
if (!ids.length) { console.error('两臂没有可对齐的 case 小节，检查 answers/*.md 格式'); process.exit(2); }

// 逐案掷硬币决定呈现顺序；映射另存。seed 可传（v4 起）——换种子=换顺序，避免复现同一顺序效应。
let seed = SEED;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

mkdirSync(join(PACK, 'judge'), { recursive: true });
const mapping = { generated: new Date().toISOString(), seed: 20261011, order: {}, cases: ids };
const lines = [
  '# 盲评判卷（判卷者用）',
  '',
  '说明：每案给出**两份解答**（编号 1/2，顺序随机）。请按 `JUDGE.md` 的四档标准**分别打分**，并给出理由。',
  '你**不知道**哪份来自哪一臂（这正是盲评的意义）；不要尝试猜测来源，只按质量与 rubric 对齐度评分。',
  ''
];
for (const id of ids) {
  const flip = rnd() < 0.5;
  const first = flip ? b.get(id) : a.get(id);
  const second = flip ? a.get(id) : b.get(id);
  mapping.order[id] = flip ? ['B', 'A'] : ['A', 'B'];   // 呈现顺序 → 实际臂
  lines.push('## ' + id);
  lines.push('');
  lines.push('### 解答 1');
  lines.push(first);
  lines.push('');
  lines.push('### 解答 2');
  lines.push(second);
  lines.push('');
}
lines.push('---');
lines.push('评分输出格式（每案）：`case-XX：解答1 = A/B/C/D（理由一句）；解答2 = A/B/C/D（理由一句）`');
writeFileSync(join(PACK, 'judge', 'bundle.md'), lines.join('\n'), 'utf8');
writeFileSync(join(PACK, 'judge', '_mapping.json'), JSON.stringify(mapping, null, 1), 'utf8');

console.log('盲评判卷已生成：' + join(PACK, 'judge', 'bundle.md'));
console.log('  案例数：' + ids.length + '（顺序随机化，映射存 judge/_mapping.json，判卷者不得见）');
console.log('  呈现顺序抽样：' + ids.slice(0, 3).map((i) => i + '=' + mapping.order[i].join('/')).join('  '));
