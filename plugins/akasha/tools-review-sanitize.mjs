// review-sanitize.mjs —— v4 去盲化：把两臂答案里的「身份线索」剥掉，避免判卷者反推臂归属。
// 要剥的（v3 实测暴露）：① 显式引用行（`→ 参考条目 …` / `→ 参考资料…` / `（参考条目 xx）`）；
//   ② 臂签名/尾部行（`—— 臂 A 完`、`（9/9 案）` 之类）；③ 直接点名库内条目 id 的行（`canon-…`）；
//   ④ "我查了库/库里没有"这类自述（会暴露是否收到材料）。
// 用法：node tools/review-sanitize.mjs --in <dir> --out <dir>
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const IN = flag('--in');
const OUT = flag('--out');
if (!IN || !OUT) { console.error('用法：--in <dir> --out <dir>'); process.exit(2); }

const PATTERNS = [
  /参考条目/, /参考资料/, /→\s*参考/, /（参考/, /\(参考/,
  /——\s*臂\s*[AB]/, /臂\s*[AB]\s*(完|交卷)/, /\(9\/9\s*案\)/,
  /\bcanon-[a-z0-9-]+/i, /\borphan-[a-z0-9-]+/i, /viking:\/\//,
  /库里(没有|无|未检索到|查不到)/, /库内(没有|无|未检索)/,
  /按通用工程经验作答/, /无对应条目/
];

mkdirSync(OUT, { recursive: true });
let files = 0, stripped = 0;
for (const name of readdirSync(IN)) {
  if (!/\.md$/i.test(name)) continue;
  const src = join(IN, name);
  const lines = readFileSync(src, 'utf8').split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    if (PATTERNS.some((re) => re.test(line))) { stripped++; continue; }
    kept.push(line);
  }
  writeFileSync(join(OUT, name), kept.join('\n'), 'utf8');
  files++;
}
console.log('去盲化完成：' + files + ' 个文件 → ' + OUT + '（剥掉 ' + stripped + ' 行）');
if (existsSync(OUT)) {
  const left = readdirSync(OUT).map((f) => readFileSync(join(OUT, f), 'utf8')).join('\n');
  const leak = PATTERNS.filter((re) => re.test(left)).map(String);
  console.log('  残留检查：' + (leak.length ? '⚠ 仍有线索 → ' + leak.join(' | ') : '✓ 无线索残留'));
  console.log('  （注：若某行被剥掉后造成语义断裂，判卷时按"信息不足"计，不补写）');
}
