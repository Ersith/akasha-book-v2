// review-pack-harden.mjs —— 由 pack-v2 产出「硬化题面」：只给工具 + 一行报错（**路径/时间/上下文全剥**），
// 用于第二次盲评（v2 协议：提高难度、避免天花板）。rubric 映射沿用 pack-v2（已修好配对）。
// 用法：node tools/review-pack-harden.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = '<LOCAL_PATH>\\_ab\\review-pack-v2';
const OUT = '<LOCAL_PATH>\\_ab\\review-pack-v2run';
const packJson = JSON.parse(readFileSync(join(SRC, 'pack.json'), 'utf8'));

// 剥路径：Windows 路径 / 盘符 / 反引号内路径 / 文件名；并去掉时间戳
function sanitize(msg) {
  let s = String(msg ?? '');
  s = s.replace(/[A-Za-z]:\\[^\s"']+/g, '<path>');
  s = s.replace(/(^|\s)\/[\w.\-/]+/g, '$1<path>');
  s = s.replace(/\b[\w.-]+\.(mjs|js|jsonl|json|md|ps1|cmd|log|txt)\b/gi, '<file>');
  s = s.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '');
  s = s.replace(/\s{2,}/g, ' ').trim();
  return s;
}

mkdirSync(join(OUT, 'cases'), { recursive: true });
const cases = [];
const seenKey = new Set();   // 去重：硬化后题面相同的案例只保留第一个（否则重复题会制造噪声）
let dropped = 0;
for (const c of packJson.cases) {
  const line = sanitize(c.message);
  const key = c.tool + '|' + line;
  if (seenKey.has(key)) { dropped++; continue; }
  seenKey.add(key);
  const body = [
    '# 案例 ' + c.id + '（硬化题面 · 盲评用）',
    '',
    '## 唯一给定的信息',
    '- 工具：`' + c.tool + '`',
    '- 报错（一行）：',
    '',
    '```',
    line,
    '```',
    '',
    '## 你要回答的三个问题',
    '1. 这次失败**本可以避免吗**？如果可以，**在动手之前做什么**就能避免？',
    '2. 如果避免不了，说清**为什么它不可避免**。',
    '3. 你会怎么改自己的做法，使同类失败**不再出现**？',
    '',
    '（只依据上面这一行信息 + 你的通用工程经验作答；路径与上下文已被刻意剥离。）'
  ].join('\n');
  writeFileSync(join(OUT, 'cases', c.id + '.md'), body, 'utf8');
  cases.push({ ...c, hardened: line });
}

// JUDGE：沿用 pack-v2 的 rubric（配对已修）
const judgeSrc = readFileSync(join(SRC, 'JUDGE.md'), 'utf8');
writeFileSync(join(OUT, 'JUDGE.md'), '# 盲评评分表（v2 硬化轮 · 判卷者用）\n\n' + judgeSrc.split('\n').slice(1).join('\n'), 'utf8');

writeFileSync(join(OUT, 'README.md'), [
  '# review-pack v2 硬化轮（第二次盲评）',
  '',
  '## 与第一轮的差别（修掉三条有效性威胁）',
  '1. **三套记忆全封**：无库臂**不得**使用 `akasha_*`、`hindsight_*`、`mcp__openviking__*`，不得读 `<AKASHA_DIR>`、`<LOCAL_PATH>\\docs`，不得访问 `viking://`；',
  '2. **题面硬化**：只给「工具 + 一行报错」，**路径/时间/上下文已剥离**（抬高难度，消除天花板）；',
  '3. **包元信息不入库**：本轮不把 case→rubric 映射写入记忆库（避免对有库臂泄露难度）；',
  '4. **判卷者独立审计**：判卷者对 rubric 对齐与两列差异给独立意见（第一轮它抓出了配题缺陷）。',
  '',
  '## 计分',
  '与第一轮同：A=2 / B=1 / C=0 / D=-1；`JUDGE.md` 中标注「库内无对应条目」的案例**不计分**。',
  ''
].join('\n'), 'utf8');
writeFileSync(join(OUT, 'pack.json'), JSON.stringify({ generated: new Date().toISOString(), source: 'pack-v2', cases }, null, 1), 'utf8');

console.log('硬化轮题面已生成：' + OUT);
console.log('  案例数：' + cases.length + '（有 rubric 的：' + cases.filter((c) => c.rubricRefs.length).length + '）');
console.log('  样例（case-01 报错行）：' + cases[0].hardened.slice(0, 90));
