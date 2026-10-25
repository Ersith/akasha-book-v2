// payload-fix.mjs —— 修 payload 里的「ASCII 引号混进 JSON 字符串值」问题（本会话已重复 3+ 次的老毛病）。
// 原理：JSON 的字符串值内部不允许裸 ASCII 双引号；我们本意都是中文引号。本工具把它们换成「」。
// 用法：
//   node tools/payload-fix.mjs <file.json>            # 只诊断（打印问题位置与上下文，不改文件）
//   node tools/payload-fix.mjs --apply <file.json>    # 就地替换（先写 .bak 备份）
// 退出码：0 = 已合法 / 已修好 · 2 = 参数或读取问题
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const file = args.find((a) => !a.startsWith('--'));
if (!file || !existsSync(file)) { console.error('用法：node tools/payload-fix.mjs [--apply] <file.json>'); process.exit(2); }

let text = readFileSync(file, 'utf8');

function diag() {
  try { JSON.parse(text); return null; } catch (e) { return e.message; }
}

const before = diag();
if (!before) { console.log('  ✓ JSON 合法，无需处理：' + file); process.exit(0); }

console.log('  原始错误：' + before);
// 定位：逐字符扫描，找出「处在字符串值内部」的裸双引号（其后不是 : , } ] 等结构字符）
const issues = [];
let inStr = false, esc = false;
for (let i = 0; i < text.length; i++) {
  const c = text[i];
  if (esc) { esc = false; continue; }
  if (c === '\\') { esc = true; continue; }
  if (c === '"') {
    if (!inStr) { inStr = true; continue; }
    // 可能是收尾引号，也可能是"混入的"引号：看后面第一个非空白字符
    let j = i + 1;
    while (j < text.length && /\s/.test(text[j])) j++;
    const nxt = text[j];
    if (nxt === ':' || nxt === ',' || nxt === '}' || nxt === ']' || nxt === '') { inStr = false; continue; }
    issues.push(i);
  }
}
console.log('  疑似字符串值内的裸双引号：' + issues.length + ' 处');
for (const i of issues.slice(0, 8)) {
  console.log('    偏移 ' + i + '：…' + text.slice(Math.max(0, i - 30), i + 30).replace(/\n/g, ' ') + '…');
}
if (!apply) { console.log('  （加 --apply 就地替换为「」；会先写 .bak 备份）'); process.exit(before ? 0 : 2); }

// 替换：按奇偶成对处理 —— 取第 1、3、5… 处为左引号，第 2、4、6… 处为右引号
copyFileSync(file, file + '.bak');
const chars = [...text];
issues.forEach((pos, idx) => { chars[pos] = (idx % 2 === 0) ? '「' : '」'; });
text = chars.join('');
writeFileSync(file, text, 'utf8');

const after = diag();
if (after) { console.log('  ✗ 替换后仍非法：' + after + '（备份在 ' + file + '.bak）'); process.exit(2); }
console.log('  ✓ 已修好并写回（备份：' + file + '.bak）');
