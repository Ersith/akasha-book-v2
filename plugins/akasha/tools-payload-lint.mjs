// payload-lint.mjs —— 库 payload（canon/orphan/mirror…）投稿前 lint：
//   ① 解析：JSON 不合法时报告**偏移量 + 上下文**（照 canon-trap-json-ascii-quotes-in-claim 的定位法）
//   ② 归因：把「正文里的成对齐 ASCII 引号」挑出来（判据＝引号外侧是中文/全角字符；结构引号外侧是 : , { [ } ] 等）
//   ③ 可选 --fix：**只**把正文内成对 ASCII 引号换成「」，然后复 parse 验证（不碰结构引号）
// 用法：
//   node tools/payload-lint.mjs <payload.json>            # 只检
//   node tools/payload-lint.mjs <payload.json> --fix      # 就地修（改前自动备份 .bak-lint）
// 退出码：0=通过（含已修好）｜3=不合法且未修
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';

const file = process.argv[2];
const doFix = process.argv.includes('--fix');
if (!file || !existsSync(file)) { console.log('用法：node tools/payload-lint.mjs <payload.json> [--fix]'); process.exit(2); }
let t = readFileSync(file, 'utf8');

const parse = (s) => { try { JSON.parse(s); return null; } catch (e) { return e; } };
const ctxOf = (s, p, n = 70) => JSON.stringify(s.slice(Math.max(0, p - n), p + n));

/** 找「正文内成对 ASCII 引号」：开引号前是中文/全角标点或中文引号内容的延续 */
function findClaimsQuotes(s) {
  const hits = [];
  const CJK_LIKE = /[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '"') continue;
    const prev = s[i - 1] ?? '';
    // 结构引号的特征：前面是 : , { [ 空格+结构 或行首；正文引号的特征：前面是中文/全角
    if (!CJK_LIKE.test(prev)) continue;
    // 找它的闭引号（下一个 ASCII 引号）
    const close = s.indexOf('"', i + 1);
    if (close < 0) continue;
    const inner = s.slice(i + 1, close);
    if (inner.includes('\n')) continue;               // 跨行不像正文引号
    if (inner.length === 0 || inner.length > 40) continue; // 太长多半不是这一对
    const after = s[close + 1] ?? '';
    if (/[:,\]\}\[]/.test(after)) continue;           // 闭引号后面是结构符 ⇒ 可能是真结构引号
    hits.push({ open: i, close, text: inner });
    i = close;
  }
  return hits;
}

const err = parse(t);
if (!err) {
  console.log('  ✓ 合法 JSON：' + file);
  process.exit(0);
}
const m = /position (\d+)/.exec(err.message);
const pos = m ? +m[1] : -1;
console.log('  ✗ 不合法：' + err.message);
if (pos >= 0) console.log('     偏移 ' + pos + ' 上下文：…' + ctxOf(t, pos) + '…');

const hits = findClaimsQuotes(t);
console.log('  归因：正文内成对 ASCII 引号 ' + hits.length + ' 处');
for (const h of hits.slice(0, 8)) console.log('     · [' + h.open + '] 「' + h.text.slice(0, 30) + '」');

if (!doFix) { console.log('  （加 --fix 可只把上述成对引号换成「」，再复 parse 验证）'); process.exit(3); }

copyFileSync(file, file + '.bak-lint');
let out = '';
let last = 0;
for (const h of hits) { out += t.slice(last, h.open) + '「' + h.text + '」'; last = h.close + 1; }
out += t.slice(last);
let err2 = parse(out);
for (let pass = 0; pass < 4 && err2; pass++) {
  const more = findClaimsQuotes(out);
  if (!more.length) break;
  let o2 = ''; let l2 = 0;
  for (const h of more) { o2 += out.slice(l2, h.open) + '「' + h.text + '」'; l2 = h.close + 1; }
  o2 += out.slice(l2);
  out = o2; err2 = parse(out);
  console.log('  · 第 ' + (pass + 2) + ' 轮再修 ' + more.length + ' 处');
}

if (err2) {
  console.log('  ✗ 只换成对引号后仍不合法：' + err2.message);
  console.log('     （说明还有别的问题；备份在 ' + file + '.bak-lint，未覆盖原文）');
  process.exit(3);
}
writeFileSync(file, out, 'utf8');
console.log('  ✓ 已修 ' + hits.length + ' 处并复 parse 通过（备份 ' + file + '.bak-lint）');
