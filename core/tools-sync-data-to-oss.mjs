// sync-data-to-oss.mjs —— (a) 六库数据同步到 OSS（2026-10-11 用户裁定「a 也要做」：判断与教训可公开，无不可说隐私）。
//   **范围**：六库数据（canon/frontier/mirror/orphan/pricing/lexicon）→ OSS `core/data/`；
//            **排除会话层 `session.jsonl`**（那是原始对话 L0，体积大且含完整对话，不进 OSS）。
//   **两层控制（2026-10-19 重做；独立审核 F9 驱动）**：
//     ① 硬门禁＝密钥 / 令牌 / 密码 / 邮箱——**不可脱敏**，命中就拒绝同步；
//     ② 可脱敏面＝本机路径 / 用户名（含中文名与 JSON 转义形）——统一走 `./redaction.mjs`，
//        并在写盘前对**产物**复扫（residual 非空 ⇒ 拒绝写入）。「洗过」不等于「洗干净」。
//   旧版缺陷（为什么重做）：用户名判据 `[A-Za-z]:[\\/]Users[\\/][A-Za-z0-9._-]+` 对中文名与转义形
//     一律 null；且把这族判据塞进**硬门禁**——源数据是 append-only，永远过不了 ⇒ 同步被卡死而不是被保护。
//   用法：node tools/sync-data-to-oss.mjs [--dry]（dry：只报「会脱敏多少、产物是否干净」，不写盘）
import { readdirSync, readFileSync, writeFileSync, statSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 2026-10-19（审计 B）：出货副本不能依赖本机绝对路径——按本文件位置解析（活树/仓内两种布局都能找到）
const HERE = dirname(fileURLToPath(import.meta.url));
const pickDir = (...cands) => cands.find((p) => existsSync(p)) ?? cands[cands.length - 1];
import { scrub, residual, selfTest } from './tools-redaction.mjs';

const DRY = process.argv.includes('--dry');
const SRC = process.env.AKASHA_ROOT ? process.env.AKASHA_ROOT : pickDir(join(HERE, '..', 'data'), join(HERE, 'data'));
const DST = pickDir(join(HERE, '..', '..', 'dist', 'akasha-oss', 'core', 'data-snapshot'), join(HERE, '..', 'dist', 'akasha-oss', 'core', 'data-snapshot'));
const SKIP = new Set(['session.jsonl']);   // 会话层原文不进 OSS

// 判据实例（带 g，供 match 计量；.test 侧一律另建非 g 副本，见门禁循环）
const GIT_PREFIX = /(?:git|oauth2)@(?:github\.com|gitlab\.com)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// 只放**不可脱敏**的类别；路径/用户名改由 redaction.mjs 脱敏 + 产物复扫（2026-10-19）
const SECRET_PATTERNS = [
  ['API key（sk- 前缀）', /sk-[A-Za-z0-9]{16,}/g],
  ['令牌（Bearer / gh*_ / npm_）', /(Bearer\s+[A-Za-z0-9._-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{20,})/g],
  ['password/secret/token 赋值', /(?:password|passwd|secret|api[_-]?key|token)\s*[:=]\s*["'][^"']{6,}/gi],
  ['邮箱', EMAIL],
  // 2026-10-12 允许（用户裁定）：公开 git 主机前缀（git@github.com / oauth2@gitlab.com）不是邮箱，
  // 属 ssh URL / OAuth 的公开写法；本文件里它们出现在讲述「脱敏正则别误伤 git 前缀」的记录正文中，被判据自身误伤。
  // 判据收窄只放行这两个前缀 + 这两个主机，其余 `user@…` 形态照旧拦。
  ['公开 git 主机前缀（非邮箱）', GIT_PREFIX, 'strip'],
];

// —— 门禁自检（常量级，跑在扫描之前；2026-10-12 加）——
//   为什么：① strip 模式是「检查视图」手术，必须自证「剥离干净 + 真阳性仍拦」；
//   ② 教训——把「采样判据」放进逐文件循环当恒真自检用会**自检自爆**（库里真有邮箱是正常态，不是失败）。
//   三例：正例（真邮箱必拦）· 反例（git 前缀剥离后必不拦）· 侧例（a@b.com 形态仍拦，防剥离过宽）。
// 2026-10-14 · 第二例「判据被自己描述的对象误伤」（首次＝git 前缀，见上）：
//   canon-oss-data-sync-20261012 条目正文**引用了 `a@b.com` 这个占位示例**（它在讲本门禁的自检侧例）⇒ 门禁把
//   「描述门禁的文本」当成「真邮箱」拦下。**处置（不改原文、不放宽真邮箱）**：**占位示例邮箱在 OSS 副本里
//   替换为 `<EMAIL>` 并计数**——即「原样不放行」立场不变，它被**替换**而非放行。名单保守：只列实测命中串。
const PLACEHOLDER_EMAILS = ['a@b.com'];
function gateOn(text) {
  let scan = text;
  for (const [, re, mode] of SECRET_PATTERNS) if (mode === 'strip') scan = scan.split(new RegExp(re.source, re.flags)).join(' ');
  let replaced = 0;
  for (const e of PLACEHOLDER_EMAILS) { const n = scan.split(e).length - 1; if (n) { replaced += n; scan = scan.split(e).join('<EMAIL>'); } }
  const hits = [];
  for (const [name, re, mode] of SECRET_PATTERNS) {
    if (mode === 'strip') continue;
    const rx = new RegExp(re.source, re.flags.replace('g', ''));   // 非 g 新实例（g 复用会给 test 留下 lastIndex 残留）
    const m = scan.match(rx);
    if (m) hits.push({ name, n: m.length, eg: String(m[0]).slice(0, 40) });
  }
  return { scan, hits, replaced };
}
function assertGateSelfTest() {
  const bad = [];
  const pos = gateOn('联系人 real.person@corp.cn 在此');                        // 正：必须拦
  if (!pos.hits.some((h) => h.name === '邮箱')) bad.push('正例失败：真邮箱未被拦');
  const neg = gateOn('ssh://git@github.com 与 oauth2@gitlab.com 是公开写法');   // 反：剥离后不得拦
  if (neg.hits.length) bad.push('反例失败：git 前缀未被剥离（' + neg.hits.map((h) => h.name).join(',') + '）');
  const side = gateOn('顺手写个 a@b.com 形态');                                  // 侧：占位示例 ⇒ 替换、原样不放行
  if (side.hits.some((h) => h.name === '邮箱')) bad.push('侧例失败：占位邮箱未被替换（原样混过）');
  if (!(side.replaced >= 1) || !side.scan.includes('<EMAIL>')) bad.push('侧例失败：占位邮箱未计数替换');
  const side2 = gateOn('真地址 person@abc.cn 不得被占位规则放宽');               // 侧2：替换不得放宽真邮箱
  if (!side2.hits.some((h) => h.name === '邮箱')) bad.push('侧例2失败：占位替换规则放宽了真邮箱');
  if (bad.length) { console.log('✗ 门禁自检失败 ⇒ 拒绝同步：' + bad.join('；')); process.exit(3); }
  console.log('✓ 门禁自检通过（正例拦真邮箱 / 反例剥 git 前缀 / 侧例占位替换 / 侧例2不放宽真邮箱）');
}
assertGateSelfTest();

// —— 脱敏器自检（与 scrubber 共用同一张规则表；失败即拒绝同步）——
const st = selfTest();
if (!st.ok) { console.log('✗ 脱敏规则自检失败 ⇒ 拒绝同步：\n  - ' + st.bad.join('\n  - ')); process.exit(3); }
console.log('✓ 脱敏规则自检通过（' + st.cases + ' 类形态 + 反例/边界对照；用户名从环境派生）');

const files = readdirSync(SRC).filter((f) => f.endsWith('.jsonl') && !SKIP.has(f)).sort();
console.log('源目录 ' + SRC + '：' + files.length + ' 个库文件（排除 ' + [...SKIP].join(', ') + '）' + (DRY ? '｜dry：不写盘' : ''));
let totalHits = 0;
let totalRedactions = 0;
let totalResidual = 0;
const out = [];   // { f, text, hardHits, redactions }
for (const f of files) {
  const p = SRC + '/' + f;
  const text = readFileSync(p, 'utf8');
  const kb = Math.round(statSync(p).size / 1024);
  const { hits, replaced } = gateOn(text);
  if (hits.length) totalHits += hits.reduce((s, h) => s + h.n, 0);
  // 内容侧转换：占位邮箱 → <EMAIL>；再由统一规则表脱敏路径/用户名/端口
  // 同步的产物就是**数据面**（core/data）⇒ 始终开 genericPaths（任意盘符绝对路径 / 内网 IP /
  //   本地词表的昵称与路径片段）。代码与文档不走这条路径，示例路径不会被重写（2026-10-19 C）。
  let prepared = text;
  for (const e of PLACEHOLDER_EMAILS) prepared = prepared.split(e).join('<EMAIL>');
  const red = scrub(prepared, { genericPaths: true });
  // 2026-10-19（审计 B P1-3）：产物必须仍是合法 JSONL，否则拒绝整批写入
  let jsonBad = false;
  const jsonLines = red.text.split(String.fromCharCode(10)).map((l) => l.replace(String.fromCharCode(13), ''));
  for (const line of jsonLines) { if (!line.trim()) continue; try { JSON.parse(line); } catch { jsonBad = true; break; } }
  if (jsonBad) { console.log('  ' + f + '  ✗ 脱敏产物不是合法 JSONL'); totalResidual += 1; }
  totalRedactions += red.hits;
  const left = residual(red.text, { genericPaths: true });
  if (left.length) totalResidual += left.length;
  out.push({ f, text: red.text, redactions: red.hits, residual: left });
  console.log('  ' + f.padEnd(16) + String(kb).padStart(5) + ' KB'
    + (replaced ? '  ↺ 占位邮箱×' + replaced : '')
    + '  ↺ 脱敏×' + red.hits
    + (left.length ? '  ⚠ 残留：' + left.map((x) => x.kind).join('、') : '  ✓')
    + (hits.length ? '  ✗ 硬门禁：' + hits.map((h) => h.name + '×' + h.n).join('；') : ''));
}
if (totalHits > 0) {
  console.log('\n✗ 门禁未过：发现 ' + totalHits + ' 处**不可脱敏**的敏感串 ⇒ **拒绝同步**（先处置，再重跑）');
  process.exit(2);
}
if (totalResidual > 0) {
  console.log('\n✗ 产物复扫未过：脱敏后仍有 ' + totalResidual + ' 处敏感形态 ⇒ **拒绝写入**（规则缺口，先补规则）');
  for (const o of out) if (o.residual.length) for (const r of o.residual) console.log('  ' + o.f + ' ← ' + r.kind + '：' + r.sample);
  process.exit(2);
}
console.log('\n✓ 门禁通过（不可脱敏面 0 命中）+ 产物复扫 0 残留；本次共脱敏 ' + totalRedactions + ' 处');
if (DRY) { console.log('（dry：未写入；去掉 --dry 才落盘）'); process.exit(0); }

if (!existsSync(DST)) mkdirSync(DST, { recursive: true });
let written = 0, bytes = 0;
for (const o of out) {
  writeFileSync(DST + '/' + o.f, o.text, 'utf8');
  written++;
  bytes += Buffer.byteLength(o.text, 'utf8');
  console.log('  → core/data/' + o.f + '（' + Math.round(Buffer.byteLength(o.text, 'utf8') / 1024) + ' KB）');
}
console.log('✓ 已写入 ' + written + ' 个文件，共 ' + Math.round(bytes / 1024) + ' KB → ' + DST);
console.log('  注意：会话层 session.jsonl **未同步**（原始对话不进 OSS）。');
