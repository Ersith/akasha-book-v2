// akasha/tools/recall-regression.mjs —— I-07 检索回归套件（影子集版；2026-10-13 批次 1）
//
// 用途：每次**库 / 检索侧改动**后跑一遍——检查「真实查法 → 该命中的条目」没有回退（ground-truth 对）。
// 口径：**影子集**＝自建 8 对（源自真实坑与真实事件；2026-10-13 立）；**正式 20–30 对等 Master 标完后扩**（标数据不阻塞本套件）。
// 纪律：只读；**不落查询侧线**（queryLog:false——机器检查不污染真日志，同 health-check 口径）。
// 用法：node akasha/tools/recall-regression.mjs [--top K] [--json] [--selftest]
// 退出码：0 = 全过；1 = 有回归（或 --selftest 未能证明「断言可红」）。
import { lookupDetailed } from './lib.mjs';

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : undefined; };
const TOP = Number(flag('--top')) > 0 ? Number(flag('--top')) : 10;
const AS_JSON = argv.includes('--json');
const SELFTEST = argv.includes('--selftest');

// 影子集：查询（真实查法口吻）→ 该命中的条目（按**链根**比对——命中当前版即可）
const SHADOW = [
  { q: 'edit 上下文失配', expect: 'canon-trap-edit-context-mismatch', why: '真实坑：edit old_string 对不上' },
  { q: 'read offset 越界', expect: 'canon-trap-read-offset-range', why: '真实坑：read offset 超出文件' },
  { q: 'pwsh 内联 javascript', expect: 'canon-trap-pwsh-inline-js', why: '真实坑：pwsh 塞内联 JS' },
  { q: '引号 转义 shell', expect: 'canon-trap-quoting-escapes', why: '真实坑：引号/转义' },
  { q: 'WSL 变量 前缀', expect: 'canon-trap-dsh-wsl-var-expansion', why: '真实坑：VAR= 前缀在 WSL 通道失效' },
  { q: 'JSON 双引号 claim', expect: 'canon-trap-json-ascii-quotes-in-claim', why: '真实坑：payload 里裸 ASCII 引号' },
  { q: '读取 二进制 utf16', expect: 'canon-trap-read-binary-utf16', why: '真实坑：二进制/UTF-16 被当文本读' },
  { q: '夹具 时间炸弹 当日', expect: 'canon-trap-fixture-today-timebomb-20261013', why: '2026-10-13 实发：夹具写死日期 vs 默认当日' },
];

// 链根归一：兼容 `-r1` 与 `-r2sr` 两种修订后缀（2026-10-13 首跑即踩：写窄成 `-r\\d+$` ⇒ sr 版认不出根）
const rootOf = (id) => String(id ?? '').replace(/-r\d+[a-z]*$/i, '');

function judge(pair) {
  const r = lookupDetailed(pair.q, { contextBudget: false, queryLog: false });
  const hits = Array.isArray(r.hits) ? r.hits : [];
  const idx = hits.findIndex((h) => rootOf(h.id) === pair.expect);
  const hit = idx >= 0 ? hits[idx] : null;
  return {
    q: pair.q, expect: pair.expect, why: pair.why,
    ok: idx >= 0 && idx < TOP,
    rank: idx >= 0 ? idx + 1 : null,
    score: hit ? hit.score : null,
    strong: hit ? !!hit.strong : null,
    missingReason: idx < 0 ? '未命中（不在结果集）' : (idx >= TOP ? `命中但排在 top${TOP} 之外（第 ${idx + 1}）` : null),
    topIds: hits.slice(0, 5).map((h) => h.id)
  };
}

const results = SHADOW.map(judge);
let failures = results.filter((x) => !x.ok).length;

let selftestOk = null;
if (SELFTEST) {
  // 「能红」自证：一条必定命不中的对子进同一判定器——若它被判 pass，说明套件根本不会红（失效）。
  const bogus = judge({ q: 'zzzz-不存在主题-9f3a', expect: 'canon-does-not-exist-9f3a', why: '自证：该对必须红' });
  selftestOk = bogus.ok === false;
  if (!selftestOk) failures += 1;
}

if (AS_JSON) {
  console.log(JSON.stringify({ top: TOP, total: results.length, failures, selftest: selftestOk, results }, null, 2));
} else {
  console.log(`检索回归（影子集，top${TOP}；正式 20 对等 Master 标后扩）`);
  for (const r of results) {
    const tag = r.ok ? '✓' : '✗';
    const where = r.ok ? `第 ${r.rank} 位 · score ${r.score}${r.strong ? ' · 强命中' : ''}` : (r.missingReason ?? '未过');
    console.log(`  ${tag} 「${r.q}」→ ${r.expect}  — ${where}`);
  }
  if (SELFTEST) console.log(`  ${selftestOk ? '✓' : '✗'} 自证「断言可红」：构造对子${selftestOk ? '被正确判红' : '竟然判过——套件失效'}`);
  console.log(`结论：${results.length - failures >= 0 ? results.filter((x) => x.ok).length : 0}/${results.length} 过` + (failures ? `——**${failures} 项回归**` : '（全过）'));
}
process.exit(failures ? 1 : 0);
