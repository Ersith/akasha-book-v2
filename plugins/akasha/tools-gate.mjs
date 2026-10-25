#!/usr/bin/env node
// 门档（gate）v1 · 机械执行器 —— 2026-10-15 落地
// 依据：canon-thinkloop-gate-20261015（规程）+ gate-speed 设计 v2（A/C 两臂合并）
// 定位：**只做确定性的记账与判据**，不做判断——判断交给快层工人（P1）与慢层（P2）。
//
// 用法：
//   node tools/gate.mjs p0 [--task NAME] [--check FILE ...] [--out DIR]
//       跑机检（主套件 / check / health / family-sweep / node --check / 六库快照哈希），产出 <out>/<task>/p0.md
//   node tools/gate.mjs escalate --slices FILE [--out DIR] [--task NAME]
//       读 slices.jsonl，按 A1/A2 判升级，产出 escalate.json
//   node tools/gate.mjs slices-template [--out DIR] [--task NAME]
//       产一份 slices.jsonl 空模板（含闭词表，防各臂字段名漂移）
//   node tools/gate.mjs selftest
//       自带夹具自测（不碰真库）
//
// 铁律：本脚本**不写** akasha/data/*；p0 只在 <out> 下写产物；escalate 只读切片、不写库。
//
// 【批次10 · G3-4 兼容面（一行入档）】批次8 起 `close` 会拦**无 `countsReconcile` 的旧产物**（本仓 1517 个
//   `escalate.json` 中 1471 个无该字段）⇒ 旧 task 目录**再走 `close` 一律被拦**（设计口径："缺失不是静默"）。
//   处置：对该目录**重跑 `escalate`** 产出新产物后再收口；或按 close 的 blocker 文案逐条处置。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
// 2026-10-17（用户「门控太慢」）：p0 的并行 + 输入哈希缓存放独立模块——本文件有冻结的"比较面"计数，
// 在这里加 `===` 会让 ⑮ 断言的站点数变动 ⇒ 新逻辑出文件，本文件只多一行 import 与一次调用。
import { runChecks } from './p0-checks.mjs';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = dirname(fileURLToPath(import.meta.url));
const AKASHA = resolve(TOOLS, '..');

// ── 闭词表（C 臂：严重度不属快层；快层只出这三类受控字段） ──────────────────
export const RISK_CLASSES = ['dataloss', 'silent-skip', 'false-green', 'coverage-gap', 'false-fix', 'crash', 'perf', 'docs', 'other'];
export const STATUSES = ['实证', '推测', '未决'];
export const REALITY = ['theoretical', 'observed', 'reproduced'];

const args = process.argv.slice(2);
const cmd = args[0] || 'help';
const flag = (name, dflt = undefined) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const flagAll = (name) => {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--' + name) { let j = i + 1; while (j < args.length && !args[j].startsWith('--')) { out.push(args[j]); j += 1; } }
  }
  return out;
};

function run(cmdline, cwd, timeoutMs = 900000) {
  const t0 = Date.now();
  let ok = false; let out = '';
  try {
    out = execFileSync(cmdline[0], cmdline.slice(1), { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, maxBuffer: 1 << 26 });
    ok = true;
  } catch (e) {
    out = String((e.stdout || '') + (e.stderr || '') || e.message);
    ok = false;
  }
  return { ok, out, ms: Date.now() - t0 };
}

/** 六库快照哈希（A 臂 R7：本仓零 git ⇒ 用哈希对照替代 git diff 判据） */
function snapshotStores(dataDir) {
  const stores = ['canon', 'mirror', 'orphan', 'pricing', 'lexicon', 'frontier'];
  const lines = [];
  for (const s of stores) {
    const f = join(dataDir, `${s}.jsonl`);
    if (!existsSync(f)) { lines.push(`${s}: (missing)`); continue; }
    const h = createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 12);
    lines.push(`${s}: ${h} (${statSync(f).size}B)`);
  }
  return lines;
}

function outDir(task, outFlag) {
  // 2026-10-15（P3 审核反例）：原只拒 `/ \ ..`，**宣称的字符集没真执行** ⇒ `名字 with space` 被接受、`x:y` 直接崩在 mkdirSync 吐 Node 栈 ✗。
  // 现按宣称字符集真执行（含空格、冒号、中文一律拒，且**给友好消息**而不是崩栈）。
  // 2026-10-15（GPT 第二份·优先③）：字符集闸**漏了纯点号** ✗ —— `..` / `.` / `...` 都能通过 `[A-Za-z0-9._-]+`，
  // 而 `..` 会让产物落到输出目录的**父目录**（她实测 ✗）。⇒ 额外两条：不能是"全是点"，且不得含 `..`。
  const t = String(task);
  if (!/^[A-Za-z0-9._-]+$/.test(t) || /^\.+$/.test(t) || t.includes('..')) {
    console.error(`任务名只允许 [A-Za-z0-9._-]+ 且不得是纯点号或含 ..（它是目录名）：${JSON.stringify(t).slice(0, 60)}`);
    process.exit(2);
  }
  const base = outFlag ? resolve(outFlag) : join(process.cwd(), 'gate-out');
  const dir = join(base, task);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── p0：机检层（零模型） ────────────────────────────────────────────────────
async function doP0() {
  const task = flag('task', 'task');
  const dir = outDir(task, flag('out'));
  const dataDir = process.env.AKASHA_ROOT ? String(process.env.AKASHA_ROOT) : join(AKASHA, 'data');
  // 可移植性（2026-10-15，为开源）：**本仓没有的检查优雅跳过**（标 SKIP，不算 FAIL）——
  // 不同布局（如 OSS 仓的 plugins/lib 结构、或只带核心库的精简版）照样能跑出有用的 P0。
  const CANDIDATES = [
    ['主套件 test.mjs', 'test.mjs', [process.execPath, 'test.mjs'], 900000],
    ['库校验 check', 'akasha.mjs', [process.execPath, 'akasha.mjs', 'check'], 300000],
    ['体检 health-check', join('tools', 'health-check.mjs'), [process.execPath, 'tools/health-check.mjs'], 300000],
    ['全家扫描 family-sweep', join('tools', 'family-sweep.mjs'), [process.execPath, 'tools/family-sweep.mjs', '--no-tests', '--quiet'], 600000],
    // 2026-10-16（用户裁定「不能完全靠关键词检索……你得自己触发」）：把"该开审核"从**用户的关键词**改成**自己的行为面**——
    // 改了核心件而独立审核面没跟上 ⇒ FAIL。这是事件/实体钩子的机械版（判据与用法见 tools/review-lag.mjs 顶部注释）。
    // 2026-10-16（独立审计 N10）：**⑪ 守卫原先不在任何自动链上**（p0 五项不含 selftest）⇒ 只在手敲时才跑。
    // 自己给自己设的守卫却不设防——挂进 p0，让它每轮机检都跑。
    ['判据自测 selftest', join('tools', 'gate.mjs'), [process.execPath, 'tools/gate.mjs', 'selftest'], 300000],
    ['审核面滞后 review-lag', join('tools', 'review-lag.mjs'), [process.execPath, 'tools/review-lag.mjs'], 60000],
  ];
  const skipped = [];
  const specs = [];
  for (const [name, probe, cmdline, tmo] of CANDIDATES) {
    if (!existsSync(join(AKASHA, probe))) { skipped.push(`${name}（未找到 ${probe}）`); continue; }
    specs.push({ name, cmdline, timeoutMs: tmo });
  }
  // 六项并行（最慢 104s 的 test.mjs 与 48s 的 health-check 重叠）+ 输入哈希缓存（TTL 6h，--no-cache 强制全跑）。
  // 缓存键是**内容哈希**（核心库/工具/六库/已装版本/node 版本），命中时报告明写 `PASS(cached)`——不静默。
  const p0cache = join(AKASHA, 'gate-out', 'cache', 'p0-cache.json');
  const results = await runChecks({ specs, cwd: AKASHA, cacheFile: p0cache, allowCache: !args.includes('--no-cache'), ttlMs: 6 * 3600 * 1000 });
  const checks = results.map((r) => [r.name, r]);
  const changed = flagAll('check');
  for (const f of changed) checks.push([`语法 node --check ${f}`, run([process.execPath, '--check', resolve(f)], AKASHA, 60000)]);

  const tail = (s, n = 4) => s.trim().split(/\r?\n/).slice(-n).join(' / ').slice(0, 400);
  const body = [
    `# P0 机检报告 · 任务 ${task}`,
    `生成：${new Date().toISOString()}　数据根：${dataDir}`,
    '',
    `| 检查 | 结果 | 耗时 | 关键行 |`,
    `|---|---|---|---|`,
    ...checks.map(([name, r]) => `| ${name} | ${r.ok ? (r.cached ? 'PASS(cached)' : 'PASS') : 'FAIL'} | ${(r.ms / 1000).toFixed(1)}s | ${tail(r.out).replace(/\|/g, '\\|')} |`),
    ...skipped.map((s) => `| ${s} | SKIP | – | 本仓无该项（可移植模式） |`),
    '',
    `## 六库快照（供前后对照）`,
    ...snapshotStores(dataDir).map((l) => `- ${l}`),
    '',
    `## 待机器判定面（供 P1 定位用）`,
    ...(changed.length ? changed.map((f) => `- 改动文件：${f}`) : ['- （未提供 --check 文件；P1 需自报改动面）']),
    '',
  ].join('\n');
  const p = join(dir, 'p0.md');
  writeFileSync(p, body, 'utf8');
  // 2026-10-15（GPT 复核§4-4）：**让"跑没跑"可证** —— 起点落**只读快照**：六库哈希 + 被审文件哈希 + 被审文件副本。
  // 目的：① 没有它就无法证明三趟/独审在哪个修订上跑过；② 有它就能在 close 时检出"审计面在跑期间漂移"（＝我上轮犯的错）。
  try {
    const snapDir = join(dir, 'snap');
    mkdirSync(join(snapDir, 'files'), { recursive: true });
    const shaOf = (f) => { try { return createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16); } catch { return null; } };
    const manifest = {
      task, at: new Date().toISOString(), dataDir,
      stores: Object.fromEntries(['canon', 'mirror', 'orphan', 'pricing', 'lexicon', 'frontier'].map((s) => [`${s}.jsonl`, shaOf(join(dataDir, `${s}.jsonl`))])),
      checks: changed.map((f) => ({ file: resolve(f), sha256: shaOf(resolve(f)) })),
    };
    for (const c of manifest.checks) {
      if (!c.sha256) continue;
      try { writeFileSync(join(snapDir, 'files', c.file.split(/[/\\]/).pop()), readFileSync(c.file)); c.copied = true; } catch { /* 副本失败不致命，哈希仍在 */ }
    }
    writeFileSync(join(snapDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
    console.log(`起点快照：snap/manifest.json（六库 ${Object.values(manifest.stores).filter(Boolean).length} + 被审文件 ${manifest.checks.filter((c) => c.copied).length} 份副本）`);
  } catch (e) { console.log(`⚠ 起点快照写入失败：${String(e?.message ?? e).slice(0, 80)}`); }
  const fails = checks.filter(([, r]) => !r.ok).map(([n]) => n);
  const cachedN = checks.filter(([, r]) => r.cached).length;
  console.log(`P0 完成：${checks.length} 项检查，${fails.length} 项 FAIL${fails.length ? '（' + fails.join('、') + '）' : ''}${skipped.length ? `，${skipped.length} 项 SKIP` : ''}${cachedN ? `（其中 ${cachedN} 项命中缓存；--no-cache 强制全跑）` : ''}`);
  console.log(`产物：${p}`);
  process.exitCode = fails.length ? 1 : 0;
}

// ── escalate：升级判据执行器（A1 立即 / A2 趟末） ────────────────────────────
// **2026-10-15 独立审核修正（关键）**：
//   ① A2 原实现按 `status==='未决'` 判 ⇒ **语义写反**——"已实证的假修复"永不升级，而"没把握的未决"反而升级。
//      按 C 臂原文与常识校正：**实证 ∧ open** 才升（证明了的假修复/崩溃＝必须处理），"未决"不升（那是待查，不是结论）。
//   ② `false-fix` 实证并入 A1（"证明修错了"与"静默丢数据"同级危险）；`crash` 实证同样 A1。
//   ③ 三条"防不可判定"机制（审核提的、三臂都没提）：闭词表**零容忍**校验 / 坏行计数与 0 切片**禁止报绿** /
//      每次运行强制产**判别式自证包**（成果面 vs 能力面），把"没发现"与"没能力发现"分开。
/** 入口可序列化校验（2026-10-16 批次5 · 补丁3 的**更简做法**，替换批次4 段B 的逐字段 `safeVal` 方案）：
 *  不可 JSON 序列化的记录（BigInt / 循环引用 / 抛错的 toJSON）**不得进切片，也就不得进键**——
 *  `judgeKey` 用 `JSON.stringify` ⇒ 直接抛；`keyIntegrityGaps` 同样（VERIFY-B `3.6`/`3.7` 实测嵌套 BigInt
 *  会**静默撞键吞记录**）。一处入口拦、**键函数保持原样**（不引入任何新碰撞面），比逐字段 safeVal 更全更简。 */
export const serializable = (s) => { try { JSON.stringify(s); return true; } catch { return false; } };

export function validateSlices(slices) {
  const problems = [];
  slices.forEach((s, i) => {
    const at = s && s.id ? `#${s.id}` : `#${i + 1}`;
    if (!s || typeof s !== 'object') { problems.push(`${at}: 不是对象`); return; }
    // 2026-10-16（批次5 · 补丁3）：不可序列化即报 invalid-input，且**该行不进键**（doEscalate 用它过滤后再去重）。
    if (!serializable(s)) { problems.push(`${at}: 记录不可 JSON 序列化（BigInt/循环引用/抛错的 toJSON）⇒ 不得进切片、不得进键`); return; }
    if (!s.id) problems.push(`${at}: 缺 id`);
    if (!s.claim) problems.push(`${at}: 缺 claim`);
    if (!s.anchor) problems.push(`${at}: 缺 anchor（行号/文件）`);
    if (!RISK_CLASSES.includes(String(s.risk_class))) problems.push(`${at}: risk_class 非法或缺失（"${s.risk_class}"）——闭词表：${RISK_CLASSES.join('/')}`);
    if (!STATUSES.includes(String(s.status))) problems.push(`${at}: status 非法或缺失（"${s.status}"）——闭词表：${STATUSES.join('/')}`);
    if (!REALITY.includes(String(s.reality_entry))) problems.push(`${at}: reality_entry 非法或缺失（"${s.reality_entry}"）——闭词表：${REALITY.join('/')}`);
    if (s.falsifier !== undefined && typeof s.falsifier !== 'string') problems.push(`${at}: falsifier 须为字符串`);
    // 2026-10-16（独立审计 N2）：`data_critical:"true"` / `1` 原先被静默当 false ⇒ coverage-gap+实证**不升级**、
    // verdict=pass（同语义布尔则 needs-slow）。布尔字段必须**只有真布尔**才算（字符串/数字一律报错，不猜）。
    if (s.data_critical !== undefined && typeof s.data_critical !== 'boolean') problems.push(`${at}: data_critical 须为布尔（收到 ${typeof s.data_critical}："${s.data_critical}"）——不得用字符串/数字代替`);
  });
  return problems;
}

/** 问题串的行标识（`#<id>` / `#<行号>`）——**展示用**（批次5 patch-phys 之后，坏行数不再由它折叠得出，
 *  见 doEscalate 的 physicalBadRows：id 含 `:` 时两个不同 id 会切出同一个 `#x`，按它折会计错）。
 *  无冒号时整体退化为字符串本身（防御式：格式变化时不静默错切）。 */
export const problemRowOf = (p) => { const t = String(p); const i = t.indexOf(':'); return i < 0 ? t : t.slice(0, i); };

const A1_CLASSES = ['dataloss', 'silent-skip', 'false-green', 'false-fix', 'crash'];
// 2026-10-16（A3 反模板红线测，**打红了我自己的声称**）：原先"去重键与判据同一来源"只是**人工对齐**——
// 副本实验：给判据加一个新字段（quote）后，键**不跟着扩** ⇒ 两行"除 quote 外相同"被并成 1 条（实测独立 1 条 / 期望 2 条）。
// 2026-10-16（独立审核 B 推翻后**反转**）：原先 JUDGE_FIELDS 是**白名单**（"哪些字段进键"）——
// 漏一个就吞升级项：14 个变体里 11 个绕过、两条端到端把真升级项吞成 pass ✗。
// ⇒ 改为**黑名单**：**默认全字段进键**，只排除"明确与判定无关"的字段。加新字段默认进键，
// 方向从"漏"变成"宁可多计、绝不吞升级"（与全局 fail-closed 一致）。
// 2026-10-16（独立审计 N1）：黑名单里**删掉 `falsifier` 与 `unit`** —— `buildCertificate` 要读这两个字段
// （falsifier 决定"带证伪器"计数、unit 决定单元统计）⇒ 它们**参与判定** ⇒ 不该被排除出键；
// 否则"同锚点、只差 falsifier"的两行会被合并 ⇒ 合并顺序决定 pass / unverifiable ✗（审计 fx1/fx2/fx3 实测）。
const JUDGE_IRRELEVANT = ['id', 'rev', 'quote', 'why', 'reason', 'created', 'time'];
const judgeKey = (s) => JSON.stringify(
  Object.keys(s).filter((k) => !JUDGE_IRRELEVANT.includes(k)).sort().map((k) => [k, s[k] ?? null]));

// 2026-10-16（批次3 落地）：豁免只留"判据确实会读、且只用于输出"的字段（当前仅 id——judgeEscalation 读它写进
// esc.id，但"换了 id"不改变任何判定）⇒ 不进键是设计。
// 2026-10-16（批次5 落地 patch-OF）：**把"只用于输出"从"信"改成"验"** —— 原实现把它当"免测"（`if (OUTPUT_FIELDS.includes(f)) continue`），
// 于是只要某字段**同时**被写进 JUDGE_IRRELEVANT 与 OUTPUT_FIELDS（两处各一行，看起来都像"无害豁免"）：键漏掉它、
// 守卫也不再测它 ⇒ 两条记录静默合并、真升级项被吞、产物全绿（批次4 段A 复核 F-A2 实测的**逃逸门**：`gaps=[]`/exit 0）。
// 现改为**判定面投影**：不再跳过这些字段，而是把"输出副本"从判定面里剥掉再比。
//   **判定面（judged face）＝产物里"参与判定/审计结论"的部位**（写清在此，加部位时必须同步改 judgedFace）：
//     ① `escalations`：每条升级的判据字段（reason/risk_class/status/reality_entry/data_critical/anchor/why），
//        **剥掉其中的输出副本**（OUTPUT_FIELDS：id——它只是把 id 搬运到升级行上，去掉它判定结论不变）；
//     ② `counts`：三数（slices/a1/a2）；
//     ③ `certificate`：自证包（complete / withFalsifier / untranslatable / units …）；
//     ④ **聚合面**（批次6 · 段A-A 补丁①）：单记录面恒为 1/1/0（slices/units/withFalsifier/a2 都要 ≥2 条记录才动）⇒
//        「**只有聚合量才看得见**」的字段在单记录面下不可见（批次5 段A §3.1 实测 `unit`：同形双豁免后
//        `certificate.units` 2→1、静默合并、exit 0、全场零拦截）。⇒ 比较面并入 `aggFace`（probe × **冻结孪生**，
//        孪生恒取自 base 记录、只改 id ⇒ 差异只可能来自 probe 自己；第一版把孪生取自被翻记录 ⇒ 翻转在孪生上自消、
//        实测抓不到，见 runs/audit-1016-batch5/segA §3.1）。
//   ⇒ 规则：某记录改一个字段后**判定面变** ⇒ 生产去重键必须能分开它；只在副本里变（id）⇒ 不要求进键。
//   ⚠ 残留边界（批次4 段A 复核 §2.3 / 批次6 · 段A-B，勿当"已封死"）：
//     ① **剥区不可验**：本投影剥的是 **escalations 里的副本**，验证方式是"剥完之后再问翻这个字段判定面变不变"
//        ⇒ 对"敏感性落在剥区里"的字段，答案**恒为"不变"**（重言）。`id` 与 `anchor` 在机器面上**完全同形**
//        （都只是"输入字段被原样搬进升级行"），差别只在审计语义（id＝标签 / anchor＝证据位置）——批次5 段A §3.2
//        实测：把 anchor 同时写进 JUDGE_IRRELEVANT 与 OUTPUT_FIELDS ⇒ 升级行证据被吞、且**随行序改写产物**、全场无拦截。
//        ⇒ 所以上面那句"把'只用于输出'从信改成验"**只在剥区之外成立**；剥区只能做到 **ack + 空转自检**：
//        `OUTPUT_FIELDS` 的每个成员必须同时在 `OUTPUT_FIELDS_ACK` 里（写明理由），否则 `keyIntegrityGaps` 会把
//        它报进 `vacuous` ⇒ 生产接线 wiringProblems + selftest 断言 + close fail-closed（批次6 · 段A-B 补丁②）。
//     ② 判定面新增部位而 judgedFace 没同步时，新部位又会退回"信而不验"。
const OUTPUT_FIELDS = ['id'];
/** 剥区（`OUTPUT_FIELDS`）的**显式承认清单**：对这里的字段，"只用于输出"这句话在本框架里**不可验证**（重言，见上方
 *  残留边界①）⇒ 必须逐字段 ack + 写理由；未 ack 的字段一旦"原始输出变了而判定面没变"（＝敏感性落在剥区），
 *  `keyIntegrityGaps` 报进 `vacuous`。ack 不是"批准"而是**留痕的信**：它把不可验的那半个区域显式化、可审计。
 *  ⚠ 知情项（2026-10-16 批次7 · D-3，**选定"=信"而非加固**——理由写在此处，替代 README 残差清单）：ack **可自签**——
 *  伪造一行"理由"即可注销该字段的 `vacuous`。精确的运行时静默边界＝「伪造 ack ∧ **语料无 provenHard（crash/false-fix ∧
 *  实证）行**」两者同时成立（批次6 复核 §2.2/§3-D-3 实测：`fx-anchor` 上静默；真 85 行因语料含 provenHard 行，
 *  仍由 `gaps=["anchor"]` 拦下）。选择不加固的理由：① ack 与被 ack 的 `OUTPUT_FIELDS` 同处本文件 ⇒ 能自签的手同样能改掉
 *  任何"文件内加固"（含删掉判定行）——文件内加固只抬高改法成本、不改变信任边界；② 复核评估过的"剥区逐位置 diff"
 *  升级只挡结构性效应（那已被 aggFace 抓）、挡不住纯 cosmetic 自签，收益有限；③ 本仓既定口径＝工具完整性靠**外锚**
 *  （`tools/review-lag.mjs` × `REVIEW-STAMP.json`），本文件自己的链不承担防伪（见 doEscalate 产物 keyIntegrity 注释）。
 *  兜底链（照旧）：selftest ⑪（恒红）+ 真语料 `gaps` + 外锚。 */
const OUTPUT_FIELDS_ACK = {
  id: '纯行标识（审计只当标签；批次3 已裁定不进键）——判据只把它搬进 esc.id / 副产品，换 id 不改任何判定',
};

/** 剥掉输出副本（判定面投影的一半，见上方"判定面＝哪些部位"）。 */
const stripOutputCopies = (escalations) => (escalations ?? []).map((e) => {
  if (!e || typeof e !== 'object') return e;
  const o = {};
  for (const k of Object.keys(e)) if (!OUTPUT_FIELDS.includes(k)) o[k] = e[k];
  return o;
});

/** 判定面（judged face）的规范串：单记录 r "会被判定/审计到的那部分输出"。 */
const judgedFace = (r) => {
  const j = judgeEscalation([r]);
  return JSON.stringify([stripOutputCopies(j.escalations), j.counts, buildCertificate([r])]);
};

/** 【批次6 · 段A-A 补丁①】**聚合面**的孪生：**恒取自 base 记录、只改 id**（id ∈ 剥区 ⇒ 不引入额外敏感面）。
 *  ⚠ 必须取自 **base**：第一版取自"被翻记录"时，翻转会在孪生上自消（probe 与孪生一起变）⇒ 实测抓不到 `unit`
 *  （批次5 段A §3.1 踩过并已改）。 */
const twinOf = (base) => ({ ...base, id: String(base.id ?? '') + '\u0000twin' });

/** 【批次6 · 段A-A 补丁①】**聚合面**（judged face 的第 ④ 部位）：`[probe, twin(base)]` 两条记录的判定输出。
 *  动机：单记录面恒为 slices=1 / units=1 / withFalsifier≤1 / a2=0 ⇒ "只在 ≥2 条记录时才可见"的字段
 *  （典型：`unit` 影响 certificate.units 数、`falsifier` 影响 withFalsifier、A2 趟末）在单记录面下**不可见**
 *  ⇒ 它们若被同形双豁免，两条记录会**静默合并**（批次5 段A §3.1：`certificate.units` 2→1、exit 0）。 */
const aggFace = (base, probe) => {
  const rows2 = [probe, twinOf(base)];
  const j = judgeEscalation(rows2);
  return JSON.stringify([stripOutputCopies(j.escalations), j.counts, buildCertificate(rows2)]);
};

/** 【批次6 · 段A-B 补丁②】**未剥**的原始输出面（stripping 之前的 escalations + counts + certificate）——
 *  只用来回答一个问题："这个字段影响了原始输出、却不影响（含聚合面的）判定面吗？" ⇒ 若是且该字段不在
 *  `OUTPUT_FIELDS_ACK` 里，说明它的"只用于输出"验证落在**剥区**（重言、不可验）⇒ 记进 `vacuous`。 */
const rawFace = (r) => { const j = judgeEscalation([r]); return JSON.stringify([j.escalations, j.counts, buildCertificate([r])]); };

// == 接线级键完整性（2026-10-16 批次3 v2；REPORT §5 D2/D3 + VERIFY §3.1/§3.2/§6 合并落地） ==============
// 不变量：**两条被判据/自证包区别对待的记录，生产去重键必须能分开**（否则调换证据顺序即可吞升级项）。
// 为什么不靠读面探针（代理口径）：① 自指盲区——同手段包 judgeKey 必然红（ownKeys 把样本上所有黑名单键记进
// reads），正确实现与回归实现同为红 ⇒ 对"键"零分辨力；② 探的是"夹具构造的调用"，生产与探针在 参数(opts 形参)/
// 环境(GATE_TRACE)/数据(值域分支) 任一维分叉即整体失效（D3 三形态实测）；③ 无开关的排查日志误红 ⇒ 倒逼删证据（D5）。行为级没有这三面。

/** 生产去重（**单一收口点**）：键完整性的唯一生产路径 —— `doEscalate` 与检查（keyIntegrityGaps / 一致性
 *  对照）**共用它**。动机（VERIFY §3.1 漏项 A："守卫测函数、生产用调用点"）：把键回退写进函数内或内联在
 *  调用点，都应在同一处暴露 ⇒ 收口成一个函数后，函数内的键回退改的就是它，调用点若绕开它则由一致性对照抓。
 *  键语义史（2026-10-15/16，两轮复核两次打红）：原键 `(claim.slice(0,120), anchor)`——①前 120 字相同即误并；
 *  ②同 (claim,anchor) 一行良性 + 一行 `实证+false-green` 时只留首行 ⇒ 真升级项被吞；③键仍漏判据字段
 *  （`data_critical` ⇒ coverage-gap∧dc 也算 A1）⇒ 调换证据顺序即可 needs-slow→pass。⇒ 现为**黑名单模式**：
 *  默认全字段进键，只排除 JUDGE_IRRELEVANT（理由见 A1_CLASSES 上方注释）。 */
export function dedupByKey(arr) {
  const seen = new Map(); const dupIds = []; const drift = []; const out = [];
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue;   // P6：非对象行不进键（judgeKey 会对 null 崩）
    const k = judgeKey(s);
    if (seen.has(k)) {
      // 2026-10-16（批次5 · 段D 复核 §4.4 根因补强）：碰撞处**顺手比一次全内容** —— 同键但内容有别 ＝
      // "键外字段漂移"（差异只落在 id/rev/quote/why/reason/created/time 里）：保留哪一条取决于**证据顺序**，
      // 换序即可改写产物（批次4 段D 实测：仅 id 不同 ⇒ escalations 连集合都不相等，而"集合同"只是数据性质）。
      // ⇒ 把该性质变成**机检**：记进 drift（**非阻断**，先可见；下一批可升 fail-closed）。真 85 行 8 组重复
      // 内容逐字全同 ⇒ drift=[]。
      // 2026-10-16（批次6 · 段C-N2 / P2）：**规范签名 + 三档**。原实现用整行 `JSON.stringify` 比 ⇒ 两个**假差异**：
      //   ① **键序**（内容逐字相同、只是键的书写顺序不同 ⇒ 报漂移，kept==dropped 都是同一 id）；② **null vs 缺省**
      //   （judgeKey 早已用 `?? null` 归一，drift 没归一）。⇒ 比较改**规范签名**（键排序 + `?? null`，键集取两者并集）；
      //   分档（全部**非阻断**，只做可见性与归因）：① `only-id`＝键外差异只有 id（R1 明确合法：跨单元重复填报）；
      //   ② `meta`＝差异只落在 rev/quote/why/reason/created/time（措辞/时间戳族）且判定面相同 ⇒ 仍合法面；
      //   ③ `judge-visible`＝两条**判定面不同**（现实里不可达——黑名单若忠实即不可能；留作安全网）。
      //   是否升 fail-closed 见批次5 汇总 U1（建议先开观察窗统计 tier 分布；若升只允许 judgeVisible===true）。
      const prev = seen.get(k);
      const ksAll = [...new Set([...Object.keys(prev), ...Object.keys(s)])].sort();
      const canon = (o) => JSON.stringify(ksAll.map((kk) => [kk, o[kk] ?? null]));
      if (canon(prev) !== canon(s)) {
        const ks = ksAll.filter((kk) => JSON.stringify([prev[kk] ?? null]) !== JSON.stringify([s[kk] ?? null]));
        const tier = ks.every((kk) => kk === 'id') ? 'only-id'
          : ks.every((kk) => JUDGE_IRRELEVANT.includes(kk)) ? 'meta'
            : 'judge-visible';
        drift.push({ kept: String(prev.id ?? '?'), dropped: String(s.id ?? '?'), tier, fields: ks, judgeVisible: judgedFace(prev) !== judgedFace(s) });
      }
      dupIds.push(s.id ?? '?'); continue;
    }
    seen.set(k, s); out.push(s);
  }
  return { unique: out, dupIds, drift };
}

/** 合并组检查（批次5 落地；形态＝批次4 段B 复核 §6.2 的 vc 版，两处修正均在此）：
 *  动机：`keyIntegrityGaps` 只看"敏感字段的单步邻域"——**局部单射、远程碰撞**（等长/等桶的分桶键）与
 *  **跨记录判据**（A2 的 byFile）它都看不见（段B §4.1 的四重反例：闭词表内等长异值对 ⇒ 门禁全绿却吞升级项）。
 *  本检查从**后果面**兜：同一生产键下的记录若被判据区别对待 ⇒ 该键一定在吞东西。
 *  ① 组内签名**剥 id**（id ∈ JUDGE_IRRELEVANT ⇒ 仅 id 差异的合并无害；不剥则对"跨单元重复填报"出噪音）；
 *  ② **仅 id 差异**的组 ⇒ info（不阻塞，对应 R1「内容级去重/重复填报」合法面）；
 *  ③ **判据输出不一致** ⇒ bad（合并改变了判据可见后果 ⇒ 调换证据顺序即可吞升级项）；
 *  ④ **A2 对账**：组内"逐字去重后展开"存在趟末升级、而组代表集没有 ⇒ bad（a2-collapse）——差异只在黑名单
 *     字段时单记录翻转框架原理上看不见，只能这样对账（段B §5.2 的"仅 claim 不同"绕过）。
 *  ⚠ **入参必须是"去重前的原始行"**（doEscalate 传 `slices`/`usable`）。**传 `unique` 则每组恰剩 1 条 ⇒
 *   `arr.length < 2` 恒真 ⇒ 恒绿失效**（段B §5.1 点名的"最危险落地坑"）。
 *  残留（如实标注，不为此再加复杂度）：同一键组内**判据面相同**、只有展开集计数不同的合并，由下面的 counts 对账覆盖；
 *  跨组（两组各自保留了自己的证据）天然无感——那也确实没被合并吞掉。
 *  【批次6 · 段C-N1 / P3】`keyFn` 可注入（默认＝生产键 `judgeKey`）：生产调用点零改动；注入"丢 claim 的弱键"后
 *  本检查**必须**报出塌陷 ⇒ selftest ⑬ 用它把"检查还在干活"变成可断言的正例对照（此前本函数无任何守护：
 *  selftest 不调它、close 只看字段在不在 ⇒ 被摘平后全链静默，批次5 段C §4 实测）。 */
export function mergeGroupGaps(rows, keyFn = judgeKey) {
  const groups = new Map();
  for (const r of rows ?? []) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    const k = keyFn(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const bad = []; const info = [];
  for (const [k, arr] of groups) {
    if (arr.length < 2) continue;
    const base = judgedFace(arr[0]);
    if (arr.some((r) => judgedFace(r) !== base)) bad.push({ key: k, ids: arr.map((x) => String(x.id ?? '?')) });
    else if (new Set(arr.map((x) => String(x.id ?? '?'))).size > 1) info.push({ key: k, ids: arr.map((x) => String(x.id ?? '?')) });
  }
  // 【批次6 · 段B-D3（P-d）】**展开集按"剥黑名单字段后的内容"判重** —— 原实现用**逐字** `JSON.stringify` 判重，
  //  把"仅 id/措辞不同"的**同一处证据**算成两条 ⇒ A2 对账对"仅 id 不同"的合法重复**误红**（段B §7 D3 端到端实测：
  //  `A-onlyid ⇒ invalid-input / exit 3`，而同一性质在 drift / info 里都是非阻断）。修法与 ① 剥 id、drift 的
  //  "键外差异"同源：**身份 = 内容（摸掉黑名单字段）**。抓力不缩：真会被吞的差异（claim 等非黑名单字段）仍算两条
  //  ⇒ `D-claim-only`（弱键）照样由 counts 对账抓住（见下）。 */
  const stripBL = (r) => { const o = {}; for (const kk of Object.keys(r)) if (!JUDGE_IRRELEVANT.includes(kk)) o[kk] = r[kk]; return o; };
  const deepUniq = (a) => { const seen = new Set(); const o = []; for (const r of a) { const kk = JSON.stringify(stripBL(r)); if (seen.has(kk)) continue; seen.add(kk); o.push(r); } return o; };
  const reps = [...groups.values()].map((a) => a[0]);
  const expanded = [...groups.values()].flatMap(deepUniq);
  // 【批次6 · 段B-D4（P-e）】**counts 完整对账**（a1 与 a2 都比）—— 原只对 A2 面，对 A1 类合并（dataloss/silent-skip/
  //  false-green 被弱键并成 1 条 ⇒ A1 证据 2→1）**零分辨力**（段B §7 D4 实测 exit 0）。
  //  ⚠ 与 P-d 必须同时在场：没有 P-d 时"仅 id 不同"的重复填报会在 a1 面上重演同一类误红。
  const cReps = judgeEscalation(reps).counts;
  const cExp = judgeEscalation(expanded).counts;
  if (cExp.a2 > cReps.a2) bad.push({ kind: 'a2-collapse', a2Before: cExp.a2, a2After: cReps.a2, ids: reps.map((x) => String(x.id ?? '?')) });
  if (cExp.a1 > cReps.a1) bad.push({ kind: 'a1-collapse', a1Before: cExp.a1, a1After: cReps.a1, ids: reps.map((x) => String(x.id ?? '?')) });
  // 【批次6 · 段B-D1】**有效性两个数**（产物侧承载 + close 交叉核对）：`pairGroups`/`scanned` 让"检查跑过且输入面
  //  正确"可核 —— 原实现下把整个检查换成常量 `{bad:[],info:[]}` 的产物与"干净跑"**结构上不可区分**（段B §2b/§2c）。
  return { bad, info, pairGroups: [...groups.values()].filter((a) => a.length > 1).length, scanned: (rows ?? []).length };
}

/** 【批次7 · D-1 重级】**组内展开计数对账的独立实现** —— 与 `mergeGroupGaps` 内的同名对账互为对照（比较点见 doEscalate）。
 *  动机（批次6 复核 §2.4 反例 `weakkey-partial`）：只把 `mergeGroupGaps` 里两行 counts 对账 `0 &&` 掉，生产面即
 *  **全静默**（bad=[]、info 满足旧绊线、exit 0）——对账只存在于一处 ⇒ 削平一处即得手。⇒ 在此**独立再算一份**：
 *  doEscalate 比较两处结果（碰撞组数 / 塌陷种类），不一致 ⇒ wiring fail-closed。
 *  ⚠ 边界（如实）：两处共享判据原语（judgeKey / judgeEscalation）与"剥黑名单内容判重"语义 ⇒ **同改两处**仍可静默
 *  （"两处一致"不是防伪签名——与 close 侧 keyIntegrity 注释同一口径）；抓力目标＝"削平一处不再够"。
 *  ⚠ 边界②（批次8 · G2-4 落地）：若 `JUDGE_IRRELEVANT` 与 `judgeKey` 被同向改动（`stripD` 跟着变），组内展开与
 *  被代表集退化为同一集合 ⇒ 塌陷面消失；该格的兜底是 `keyIntegrityGaps`（键漏字段），两者互补。
 *  入参＝去重前的 `usable`（与 `mergeGroupGaps` 同为原始行）；`keyFn` 可注入**只**为 selftest ⑭ 的正例对照（生产零改动）。
 *  返回 `{ pairGroups, collapseKinds, scanned }`——`scanned`＝扫过的原始行数（批次8 · G2-1：产物落痕 × close 对账用）。 */
export function countsReconcileIndep(rows, keyFn = judgeKey) {
  const groups = new Map();
  for (const r of rows ?? []) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    const k = keyFn(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const scanned = (rows ?? []).length;
  const collide = [...groups.values()].filter((a) => a.length > 1);
  if (!collide.length) return { pairGroups: 0, collapseKinds: [], scanned };
  const repsD = collide.map((a) => a[0]);
  const stripD = (r) => { const o = {}; for (const kk of Object.keys(r)) if (!JUDGE_IRRELEVANT.includes(kk)) o[kk] = r[kk]; return o; };
  const expD = collide.flatMap((a) => {
    const seen = new Set(); const o = [];
    for (const r of a) { const sk = JSON.stringify(stripD(r)); if (seen.has(sk)) continue; seen.add(sk); o.push(r); }
    return o;
  });
  const cRepsD = judgeEscalation(repsD).counts;
  const cExpD = judgeEscalation(expD).counts;
  const collapseKinds = [];
  if (cExpD.a2 > cRepsD.a2) collapseKinds.push('a2-collapse');
  if (cExpD.a1 > cRepsD.a1) collapseKinds.push('a1-collapse');
  return { pairGroups: collide.length, collapseKinds, scanned };
}

/** 【批次8 · G2-1】**重级"接线层"的比较逻辑（纯函数）** —— 批次7 复核 §3.1 指出的病：比较块本身可被**单点拆线**
 *  （`if (false)`）或**镜像**（把独立重算喂成 mg 自己的值），当时 selftest 与产物都无痕。⇒ ① 比较逻辑抽到本题为
 *  纯函数，正反例由 selftest ⑮ 直测；② doEscalate 只负责调用 ＋ 落痕（产物 `keyIntegrity.countsReconcile`），
 *  close 侧 fail-closed 读产物（缺失/未跑、`problems>0`、产物内两处记录不一致 ⇒ 比较被换弱/被跳过）。
 *  ⚠ 残余（如实，不宣称封死）：**完整镜像**（把 mg 的 pairGroups/collapseKinds/scanned 全抄进 indep）自洽可过 ——
 *  文件内不可判；该格靠可观测性 + 外锚（`tools/review-lag.mjs` × `REVIEW-STAMP.json`），与 close 侧同口径。 */
/** 【批次13 · G6-2/A7】**导出重绑计数（模块级）** —— 批次12 复核 §6 实测：⑮ 的**委派锚**（下方"prob 文本命中 1 处且窗口须含生产函数名"，批次14 已回退含词版）
 *  只看**文本**（不解析语义、不判活体绑定），于是"窗口里放字符串字面量"与"把活体换成**语句式/影子声明**（regex 不认）+ 别处补一处装饰"
 *  两类形态可**全绿**（复核造 3 类真洞）。⇒ 补一路**运行时**判别：把**导出件**重绑成计数包装器（见 ⑮ 组前的重绑行），
 *  ⑮ 组尾断"生产比较函数真跑次数"——文本像委派、运行时没跑到生产件 ⇒ 红。**任何正确委派都会经过包装器**（它接下的是导出绑定本身）。
 *  计数口径：包装器是**唯一**计数点 ⇒ 读数**恰为真跑次数**。
 *  ⚠ 与复核探针的**编码差异（如实登记）**：探针把计数自增写在**函数体内**、重绑行留在**组尾（未激活）**；本落地**只保留包装器一路**并移到组前**激活**。
 *  ⚠ **订正（批次14 · YG-7-1 / 补丁 P7-1，逐字落 `VERIFY-G7` §6/§7）**：这里披露的是**文本布局的双计数陷阱**，**不是**"复核探针有 bug"——
 *  **批12 探针文件**的组尾重绑是 **no-op（不计数）**、唯一计数点在**函数体内** ⇒ 照抄该**文件**仍是单路，P-partial-2real 实测 **红 2/4（阈值精确）**；
 *  "**两路同活 ⇒ 阈值被降成 ≥2 次真跑**"只在**按 `VERIFY-G6` §6 文本布局**（②把重绑换成**计数**包装器**并激活到 ⑮ 组前** ＋ ③体内自增**保留**）时成立
 *  ——`VERIFY-G7` 实测：该布局零变异读数 **4/4**、**2 次真跑即绿**（1 次真跑则红 2/4）。本件取"**单路包装器 ＋ 组前激活**"正是为避开该歧义。
 *  自保护：删重绑行 ⇒ 诚实件读数 0 ⇒ 当场红；删 ⑮ 组内的计数断言 ⇒ **计数断面**（`n` 与 `EXPECT_N_MIN`）当场红 ⇒ 两处须同改。
 *  如实（不宣称封死）：本计数只证"**真跑过**"，**不证"返回值被用"** ⇒ "真函数被调、结果被丢"（复核 E3 格）仍绿；"同步改写本检查区"仍是对称残余。 */
let g6wrapCalls = 0;
export function countsReconcileProblems(indep, mergeGroups) {
  // 【批次10 · G3-3】**开头 3 行形状闸（fail-closed）** —— 批次8 复核 §3.1 实测：本函数（比较逻辑的唯一实现）
  //   ① `({}, {})`（两边都缺字段）判"一致"＝ **fail-open**；② `collapseKinds` 非数组 / `bad` 非数组时**抛
  //   TypeError**（非全函数）。生产当前不可达（两个调用点都供同形对象），但它一旦被别处复用就是静默放行面。
  //   注：`scanned` 差异**不在**本函数比较面（由产物落痕 + close 侧对账兜）；若要把 `scanned` 纳入比较，
  //   须同时补 selftest ⑮ 的同构字段（批次10 已补，见 ⑮ 注释），勿只改一处。
  if (typeof indep?.pairGroups !== 'number' || !Array.isArray(indep?.collapseKinds)
    || typeof mergeGroups?.pairGroups !== 'number' || !Array.isArray(mergeGroups?.bad)) {
    return ['合并组检查/独立重算的记录形状不合法（缺失或非数组）⇒ fail-closed'];
  }
  const declared = (mergeGroups?.bad ?? [])
    .filter((b) => b && (b.kind === 'a1-collapse' || b.kind === 'a2-collapse')).map((b) => b.kind).sort();
  const indepColl = (indep?.collapseKinds ?? []).slice().sort();
  const out = [];
  if (indep?.pairGroups !== mergeGroups?.pairGroups || indepColl.join(',') !== declared.join(',')) {
    out.push(`合并组检查与独立重算不一致：碰撞组 ${indep?.pairGroups} vs ${mergeGroups?.pairGroups}；塌陷 ${JSON.stringify(indepColl)} vs ${JSON.stringify(declared)} ⇒ counts 对账（或检查输入面）被削平/被绕 ⇒ fail-closed`);
  }
  return out;
}

/** 字段 f 在记录 r 上的"翻转候选"：值翻转 + **存在性翻转**（'' / 缺省）。
 *  只翻 x→xZ 会漏"存在性敏感"字段（VERIFY §3.2 漏项 B：`falsifier` 的 '' 与 'x' 是两种东西，'x' 与 'xZ' 不是）。 */
function flipCandidates(r, f) {
  const a = r[f]; const out = [];
  if (typeof a === 'boolean') out.push({ ...r, [f]: !a });
  else if (typeof a === 'string') {
    out.push({ ...r, [f]: a + 'Z' }); if (a !== '') out.push({ ...r, [f]: '' });
    // 2026-10-16（批次5 · 落地清单第 11 项，可选/边际）：**远距离候选** —— 分桶/阈值类键只对"远值"敏感
    //（段B §6.3：对行号/远端阈值敏感的判据有效；对"任意桶函数"原理上仍不可穷尽 ⇒ 收口责任在 mergeGroupGaps 的后果面）。
    out.push({ ...r, [f]: a + '::9999' });
    const m = a.match(/^(.*?)(\d+)$/); if (m) out.push({ ...r, [f]: m[1] + String(Number(m[2]) + 1000) });
  }
  else if (typeof a === 'number') { out.push({ ...r, [f]: a + 1 }); out.push({ ...r, [f]: a + 1000 }); }
  const bare = { ...r }; delete bare[f]; out.push(bare);   // 缺省翻转（存在性敏感的另一半）
  return out;
}

/** 键完整性缺口（**行为级**）：判据/自证包对某字段敏感 ⇒ 生产去重键（经 dedupByKey）必须能分开它。
 *  - 不依赖代理、不受调用形态影响；无"旁观式读取"误红面（不影响输出 ⇒ 不要求进键）；
 *  - 检查**直接调用生产收口函数 dedupByKey** ⇒ 键回退（函数内）与内联弱键（调用点）同被覆盖；
 *  - 生产侧跑在**真实 unique 切片**上（doEscalate 接线），selftest 跑在同一实现上（夹具只是它的一处调用）。 */
export function keyIntegrityGaps(records) {
  const rows = (records ?? []).filter((x) => x && typeof x === 'object' && !Array.isArray(x));
  const fields = new Set(rows.flatMap((x) => Object.keys(x)));
  const gaps = []; const seenVal = new Set(); let pairs = 0;
  const vacuous = [];
  for (const r of rows) {
    for (const f of Object.keys(r)) {
      if (gaps.includes(f) || vacuous.includes(f)) continue;
      const vk = f + '\u0000' + JSON.stringify(r[f] ?? null);
      if (seenVal.has(vk)) continue;               // 同一 (字段,值) 只测一遍：成本 ∝ 去重记录数×字段数（85 行实测 ≈ +2ms）
      seenVal.add(vk);
      // 基侧输出每个（字段@值）只算一次，变体逐翻（性能：真切片 85 行进程内实测 ≈ +2ms，见 landing 证据）
      // 2026-10-16（批次5 · patch-OF）：比较面从"escalations + certificate 原文"换成**判定面投影**
      //（= 上面 judgedFace：剥掉输出副本、并入 counts）——OUTPUT_FIELDS 里的字段**不再免测**。
      // 2026-10-16（批次6 · 段A-A 补丁①）：比较面**再并入聚合面**（aggFace，probe × 冻结孪生）——
      // "只有聚合量才看得见"的字段（unit / withFalsifier 族）此前在单记录面下不可见，会静默合并。
      const faceBase = judgedFace(r); const rawBase = rawFace(r); const aggBase = aggFace(r, r);
      for (const variant of flipCandidates(r, f)) {
        pairs += 1;
        const sensitive = faceBase !== judgedFace(variant) || aggBase !== aggFace(r, variant);
        // 2026-10-16（批次6 · 段A-B 补丁②）**剥区灵敏度自检**：原始输出变了、判定面（含聚合面）**没变**、
        // 又不是已 ack 的输出副本 ⇒ 该字段的敏感性**落在剥区**（`stripOutputCopies` 之后才比较 ⇒ 答案恒为"不变"）
        // ⇒ 这条字段的"只用于输出"验证在本框架里是**重言**（不可验）⇒ 必须显式 ack（OUTPUT_FIELDS_ACK）或移出
        // OUTPUT_FIELDS。批次5 段A §3.2 实测的 `anchor` 误用（升级行证据被吞 + 随行序改写产物）就靠这一条变红。
        if (rawBase !== rawFace(variant) && !sensitive && !Object.prototype.hasOwnProperty.call(OUTPUT_FIELDS_ACK, f)) { vacuous.push(f); break; }
        if (sensitive && dedupByKey([r, variant]).unique.length !== 2) { gaps.push(f); break; }
      }
    }
  }
  return { gaps, vacuous, rows: rows.length, fields: fields.size, pairs };
}

export function judgeEscalation(slices) {
  const esc = [];
  for (const s of slices) {
    const rc = String(s.risk_class ?? '');
    const st = String(s.status ?? '');
    const re = String(s.reality_entry ?? '');
    const a1 = st === '实证' && re !== 'theoretical'
      && (A1_CLASSES.includes(rc) || (rc === 'coverage-gap' && s.data_critical === true));
    if (a1) esc.push({
      id: s.id ?? '(no id)', reason: 'A1', risk_class: rc, why: '已实证且非理论 ⇒ 立即升级',
      // 2026-10-15（交付纪律连带；交付包自检抓出）：升级行原先**把判据字段丢了** ✗ ——
      // 于是重生成的 `escalate.json` 里每条升级都缺 `status`/`reality_entry` ⇒ 下游（含 close 的 fail-closed 与交付包自检）
      // 无法核对"凭什么是升级" ✗。判据字段原样带出去（**不新增判断，只搬运证据** ✓）。
      status: st, reality_entry: re, data_critical: s.data_critical === true, anchor: String(s.anchor ?? ''),
    });
  }
  // A2（趟末）：**实证 ∧ open** 的 false-fix/crash —— 证明了的假修复/崩溃成批出现时升级（≥2 单元 或 同文件 ≥2 处）
  // 2026-10-16（批次6 · 段A-C 裁定，主会话口径）：**证据身份 = (unit, anchor)** —— A2 要的是"同一文件内**两处证据**"，
  //   而"仅 id 不同"（或措辞/时间戳不同）的重复填报是**同一处证据的多次申报**，本就不该算"两处"（批次5 段A §3.5
  //   的 `a2-collapse` 误红即此）。⇒ 计数按"**每单元每锚点一次**"归并。
  //   与"在 `usable` 上按 **(unit,anchor)** 计数"**等价**（**证据集**口径）：`dedupByKey` 只并"非黑名单字段全同"的行
  //   ⇒ 被并的行 unit/anchor 必然相同 ⇒ 两种口径给出同一证据集；这里选前者（不改变本函数对入参的契约）。
  //   ⚠ **逐行计数的字面版不等价**（批次6 复核 §2.3 实测 `lit-usable-base`：A1/A2＝2/1 且 `a2-collapse` 仍报）——
  //   "对 `unique`/`usable` 同结果"只指**本函数产出的 A2 证据集**，不是整个函数输出的等价（措辞收紧自批次7 · D-4）。
  //   ⚠ 遗留边界（如实标注）：同一 (unit,anchor) 上不同 claim 的两条 provenHard **不再**双计 ⇒ 弱键吞掉其中一条时
  //   A2 面看不见——那条由 `mergeGroupGaps` 的 **counts 对账（a1 面）** 兜（真 A1 证据被吞 ⇒ a1-collapse）。
  const provenHard = slices.filter((s) => ['false-fix', 'crash'].includes(String(s.risk_class ?? '')) && String(s.status ?? '') === '实证');
  const byEvidence = new Map();      // (unit, anchor) ⇒ 条数（同一处证据被多次申报只算一处）
  for (const s of provenHard) {
    const ek = `${String(s.unit ?? '(未标单元)')}\u0000${String(s.anchor ?? '')}`;
    byEvidence.set(ek, (byEvidence.get(ek) ?? 0) + 1);
  }
  const byFile = new Map();
  for (const ek of byEvidence.keys()) { const f = ek.split('\u0000')[1].split(':')[0]; byFile.set(f, (byFile.get(f) ?? 0) + 1); }
  const a2ev = byEvidence.size;      // 证据**处数**（不是行数：同处多次申报折叠）
  const a2hit = a2ev >= 2 || [...byFile.values()].some((n) => n >= 2);
  if (a2hit && provenHard.length) esc.push({ id: '(趟末)', reason: 'A2', risk_class: 'false-fix/crash（实证）', why: `已实证 ${a2ev} 条（同文件 ≥2 或总量 ≥2）` });
  return { escalations: esc, escalate: esc.length > 0, counts: { slices: slices.length, a1: esc.filter((e) => e.reason === 'A1').length, a2: esc.filter((e) => e.reason === 'A2').length } };
}

/** 判别式自证包：把"没发现"与"没能力发现"分开（审核主建议） */
export function buildCertificate(slices, extra = {}) {
  const units = new Map();
  for (const s of slices) { const u = String(s.unit ?? '(未标单元)'); units.set(u, (units.get(u) ?? 0) + 1); }
  const zeroUnits = [...units.entries()].filter(([, n]) => n === 0).map(([u]) => u);
  const withFalsifier = slices.filter((s) => typeof s.falsifier === 'string' && s.falsifier.trim()).length;
  return {
    slices: slices.length,
    units: units.size,
    unitsWithoutSlices: zeroUnits,
    withFalsifier,
    withoutFalsifier: slices.length - withFalsifier,
    untranslatable: extra.untranslatable ?? 0,     // 声称里"写不出判别式"的条数（自报，不许隐去）
    claimsSeen: extra.claimsSeen ?? null,
    complete: slices.length > 0 && withFalsifier === slices.length && (extra.untranslatable ?? 0) === 0,
  };
}

function doEscalate() {
  const files = flagAll('slices').length ? flagAll('slices') : (flag('slices') ? [flag('slices')] : []);
  if (!files.length) { console.error('用法：gate.mjs escalate --slices A.jsonl [--slices B.jsonl …] [--task NAME] [--out DIR]'); process.exitCode = 2; return; }
  const slices = [];
  const badLines = [];
  let filesRead = 0;
  for (const f of files) {
    if (!existsSync(f)) { badLines.push(`${f}: 文件不存在`); continue; }
    filesRead += 1;
    readFileSync(f, 'utf8').split(/\r?\n/).forEach((l, i) => {
      if (!l.trim()) return;
      try { slices.push(JSON.parse(l)); } catch { badLines.push(`${f}:${i + 1}`); }
    });
  }
  // R1（2026-10-15，GPT 复核§1 触发）：**切片行数 ≠ 独立问题数**——同一 (claim,anchor) 会被多单元逐字重复填充
  // （实测 61 行里 session-tools 的 8 条重复了 5 遍 ⇒ 把行数当问题数就报成 29）。
  // ⇒ 先做**内容级去重**，校验 / 判据 / 自证包一律跑在**独立记录**上，并**三数分报**（行数 / 独立记录 / 升级点）。
  // （JUDGE_IRRELEVANT / judgeKey 在模块顶层——黑名单模式，见 A1_CLASSES 下方的注释与第 ⑪ 组 lint）

  // 2026-10-16（批次2 落地 P6 / 审核 N-D5）：**校验前移** —— 原先 validateSlices 在去重**之后**才跑，而 `null` 行
  // 会让去重循环里的 judgeKey(s) 先抛 TypeError（崩在写产物之前、无产物）⇒「全量校验」只换了输入集、没越过崩溃点。
  // 现 problems 先算；去重循环跳过非对象行（非对象行交 problems 报 invalid-input，不进键、不进判据）。
  const rawInputProblems = validateSlices(slices);   // **输入侧**问题（逐条；含"不可 JSON 序列化"）
  // 2026-10-16（批次5 落地 patch-phys）：**坏行＝输入侧物理行** —— 逐行单独校验，不再"把问题串按 `#行标识` 折叠"
  //（批次4 段A 复核 F-A1 三处失配：① 折叠把"2 行同 id 同缺"少计成 1；② id 含 `:` 时两个不同 id 都切成 `#x` 碰撞；
  //  ③ **接线级**问题被误算成"输入坏行"）。逐行口径一并免疫这三处：一行多问题只算一行、与 id 内容无关。
  // 2026-10-16（批次6 · 段A-E 注记，非缺陷）：本计数由 `slices.filter(s => validateSlices([s]).length > 0)` **再算一遍**
  //  得出（不是"单遍派生态"）⇒ 若将来允许带 getter/`toJSON` 的**程序化**输入，两次计算可能不一致、出现
  //  "validationProblemRows>0 而 verdict 不拦"的裂口。**当前 CLI 路径不可达**（入口一律 `JSON.parse`）。
  //  一行修法（若将来需要）：`const badRowFlags = slices.map(...)` 后**同一份**结果同时喂两处。
  const physicalBadRows = slices.filter((s) => validateSlices([s]).length > 0).length;
  // 去重前的可用行：不可序列化的行已由 validateSlices 报错（必 invalid-input）⇒ 不进键（防 judgeKey 抛）。
  const usable = slices.filter(serializable);
  // 2026-10-16（批次3 落地）：去重**收口为单一函数** dedupByKey——键语义与实现只见一处，检查与生产共享它。
  // （键语义史见 dedupByKey 上方注释：原 `(claim.slice(0,120), anchor)` 两轮复核两次打红 ⇒ 黑名单模式全字段进键。）
  const { unique, dupIds, drift } = dedupByKey(usable);
  // ── 接线级键完整性（批次3 v2）：跑在**真实生产数据**上（非夹具），且与单一收口函数逐条对照 ────────────
  // 动机（VERIFY 漏项 A/B）：夹具级 keycov 测不到 ①生产键回退/内联弱键（守卫测函数、生产用调用点）；
  // ②"存在性敏感"字段（只翻 x→xZ 漏 falsifier 类）。此处两个检查都用生产同一实现；任一不过 ⇒ 进
  // wiringProblems ⇒ verdict=invalid-input（fail-closed），并把结论写进产物 keyIntegrity 供 close 复读。
  // 2026-10-16（批次5 落地 patch-phys 的第二半）：接线级问题**另立一栏**（wiringProblems）——它们不是
  // "输入坏了"而是"守卫自己发现的问题"⇒ **计数面分离**；但**拦断面不变**：仍进 problems ⇒ 仍 invalid-input。
  const wiringProblems = [];
  const ki = keyIntegrityGaps(unique);
  const ref = dedupByKey(usable);
  const dedupConsistent = ref.unique.length === unique.length && ref.unique.every((x, i) => x === unique[i]);
  // 2026-10-16（批次5 · 落地清单第 4 项）：**合并组检查从后果面兜**（弱键/分桶键与 A2 塌陷）。
  // ⚠ 入参是 `usable`（去重前的原始行，＝ slices 去掉不可序列化行）——**传 `unique` 则恒绿失效**（见函数注释）。
  const mergeGroups = mergeGroupGaps(usable);
  // 2026-10-16（批次6 · 段C-N1 / P1）：**合并组检查的生产侧绊线**（此前该检查零守护：selftest 不调它、
  //   close 只看字段在不在、生产随它自报 ⇒ 被摘平后真 A2 塌陷只剩一条明确声明"非阻断"的 drift，批次5 段C §4 实测）。
  //   单向可证：检查完好时该蕴含恒成立——存在"同键且内容有别、两条 id 不同"的碰撞（`dedupByKey.drift` 已记录）
  //   ⇒ `mergeGroupGaps` **必须**至少给出一条（全 face 相同 ⇒ info；否则 ⇒ bad）。给不出 ⇒ 检查被削平/被绕 ⇒ fail-closed。
  //   镜像方向**不成立**（A2 塌陷的差异在键外字段上 ⇒ 若不产生碰撞就不产生 drift 条目），故只做这一向。
  //   误报面（段C 实测）：逐字重复（G）0 红、同 id 只差 quote（E）0 红、真 85 行 0 红；"仅 id"（A）在 mg 被摘时**应当**红。
  // 2026-10-16（批次7 · D-1 **轻级**）：把"零产出检测器"升级为**逐对覆盖检查** —— 批次6 复核 §2.4 实测：旧绊线只看
  //   "bad+info 全空"，于是部分削平（`weakkey-partial`：两行 counts 对账被 `0 &&` 掉、本对仍产出 info）时**全静默**、
  //   exit 0；"只报别组"式粗削平同理。现在：每个"同键但 id 不同"的漂移对必须被 bad/info 的**某条**覆盖（该条 ids 同含
  //   两 id）；旧条件是现在的特例（bad+info 全空 ⇒ 每个漂移对都无覆盖）⇒ 直接替换、不叠加。
  // 2026-10-16（批次7 · D-1 **重级**）：`countsReconcileIndep`（上方函数）在生产侧**独立重算**碰撞组的展开计数对账，
  //   与 `mergeGroupGaps` 的产物对照：碰撞组数 / 塌陷种类任一不一致 ⇒ fail-closed ⇒ 削平一处（mg 的两行对账）不再够。
  //   ⚠ 残余（如实）：两处共享判据原语与判重语义 ⇒ **同改两处**仍可静默（"两处一致"不是防伪签名，与 close 侧同口径）。
  // 2026-10-16（批次8 · G2-1 落地）：**接线层加固 —— 防线实为"两面（⑬/⑭ 函数级）＋ 一层只到接线（产物字段 + close）"，
  //   原"三面"表述高估了第三面**（批次7 复核 §3.1：⑭ 只验函数本体、不验它在生产上是否还被接上）。加固：
  //   ① 比较逻辑抽成纯函数 `countsReconcileProblems`（selftest ⑮ 正反例直测）；
  //   ② 产物落痕 `keyIntegrity.countsReconcile`（ran / scanned / pairGroups / collapseKinds / declared* / problems）；
  //   ③ close 侧 fail-closed 读它（缺字段·未跑 / problems>0 / 产物内两处记录不一致 / 逐字镜像缺 scanned ⇒ 拦）。
  //   残余①（原文档已列）：函数本体 + 检查**同改两处** ⇒ 生产静默（selftest ⑬/⑭ 会红——可见）。
  //   残余②（**原文档未列的最便宜那条**）：**拆/镜像接线（1 处编辑）＋ 1 处 mg 半摘** ⇒ 批次8 前生产 exit 0 全静默、
  //     产物与诚实跑逐字节相同（复核 §3.1 实测；本批复现见 landing/logs/two-state-prev.md）；批次8 起拆线与**逐字**
  //     镜像被产物痕迹 + close 拦，但**完整镜像**（补齐字段、自洽）仍可在文件内通过 ⇒ **文件内上限**，靠可观测性 +
  //     外锚（`tools/review-lag.mjs` × `REVIEW-STAMP.json`）兜 —— 不宣称封死（同 close 侧 keyIntegrity 口径）。
  //     （附注·批次8 实测更正：wk 型半摘本身会打红 selftest ⑬，"selftest 全绿"只对不带 wk 的**单独**拆线/镜像成立。）
  {
    const mgAll = [...mergeGroups.bad, ...mergeGroups.info];
    const uncovered = drift.filter((d) => d.kept !== d.dropped
      && !mgAll.some((e) => Array.isArray(e.ids) && e.ids.includes(d.kept) && e.ids.includes(d.dropped)));
    if (uncovered.length) {
      wiringProblems.push(`合并组检查覆盖缺口：${uncovered.length} 个同键漂移对（id 不同）未被 bad/info 任何条目覆盖（零产出或"只报别组"）⇒ 该检查被削平/被绕 ⇒ fail-closed`);
    }
  }
  let countsReconcileRec = null;   // 批次8 · G2-1②：接线实跑记录（进产物 + close 复读；范围＝本函数体）
  {
    const indep = countsReconcileIndep(usable);
    const declaredColl = mergeGroups.bad
      .filter((b) => b && (b.kind === 'a1-collapse' || b.kind === 'a2-collapse')).map((b) => b.kind).sort();
    const recProblems = countsReconcileProblems(indep, mergeGroups);
    if (recProblems.length) wiringProblems.push(...recProblems);
    countsReconcileRec = {
      ran: true, scanned: indep.scanned, pairGroups: indep.pairGroups, collapseKinds: indep.collapseKinds,
      declaredPairGroups: mergeGroups.pairGroups, declaredCollapseKinds: declaredColl,
      problems: recProblems.length,
    };
  }
  if (ki.gaps.length) wiringProblems.push(`接线级键完整性（生产数据）：${JSON.stringify(ki.gaps)}——这些字段一变、判据输出就变，但生产去重键分不开 ⇒ 调换证据顺序即可吞升级项`);
  if (ki.vacuous?.length) wiringProblems.push(`剥区灵敏度空转（OUTPUT_FIELDS 未 ack）：${JSON.stringify(ki.vacuous)} —— "只用于输出"的验证对这些字段是**重言**（敏感性落在被剥区域）⇒ 必须显式 ack（OUTPUT_FIELDS_ACK，写明理由）或移出 OUTPUT_FIELDS`);
  if (!dedupConsistent) wiringProblems.push(`接线级键完整性（生产数据）：去重未走单一收口函数（生产 ${unique.length} 条 vs dedupByKey ${ref.unique.length} 条）⇒ 键回退/内联弱键 ⇒ 生产与受检路径分家`);
  if (mergeGroups.bad.length) wiringProblems.push(`合并组检查：${JSON.stringify(mergeGroups.bad)}——同一生产键下的记录被判据区别对待（或 A2 趟末升级证据被合并吞掉）⇒ 该键吞升级项`);
  // 2026-10-16（独立审计·A1 结构性漏项）：**校验原先跑在去重后的集合上** ⇒ "id 缺失 / falsifier 非字符串"的坏行
  // 会被"同内容"合并吞掉 ⇒ 顺序决定 pass ↔ invalid-input（P1+P2 都治不了 id 例）。⇒ 改为对**全量**校验；
  // 问题文本去重，避免"同一坏行被复制 5 遍"变成 5 条噪声。
  // 2026-10-16（批次2 落地 P7 / 审核 N-D6）：Set 折叠会丢「同一坏行复制 N 遍」的数量证据（5 行同 id ⇒ 上报 1 条）⇒
  // 去重仅用于展示；**原始条数**另报（validationProblemCountRaw）。
  // 2026-10-16（批次3 D1 订正）：原文案称"证据面可复原其实坏了几行"——**不成立**（该字段数的是问题条数，
  // 一行可产多条、多条同 id 又会被折叠）⇒ 坏行数**另立字段** validationProblemRows（见下行）。
  // 2026-10-16（批次5 落地）：`problems` 仍是**去重后的并集**（输入 + 接线级；close 只读它的长度，保持兼容），
  // 但坏行数改由 physicalBadRows 给（**输入侧物理行**），接线级问题另有 wiringProblems 一栏 ⇒ 两个面分开可核。
  const problems = [...new Set([...rawInputProblems, ...wiringProblems])];
  const r = judgeEscalation(unique);
  const cert = buildCertificate(unique);
  const dir = outDir(flag('task', 'task'), flag('out'));
  const out = {
    ...r, certificate: cert, files: filesRead, badLines,
    validationProblems: problems,
    wiringProblems,                                  // 批次5：接线级问题**另立一栏**（不计入坏行；仍然拦）
    validationProblemRows: physicalBadRows,          // 批次5 patch-phys：坏行＝**输入侧物理行**（逐行校验；免疫折叠/id 碰撞/接线级误算）
    validationProblemCountRaw: rawInputProblems.length,  // P7：原始**输入**问题条数（Set 折叠前；不是坏行数）
    // 2026-10-16（批次3 · 接线级 v2；与未决 U3 合并）：键完整性写进产物 —— close 的 fail-closed 链读它，
    // 缺字段（＝检查被删/未跑）/ 缺口 / 收口失效一律拦（防"删掉守卫就当通过"：⑪ 自身无守护的产物侧落点）。
    // 2026-10-16（批次5 · 落地清单第 8 项：**定位改述**）：本栏证明的是「**产物 × 当前工具一致**」——
    //  它防的是"手滑削平 / 删掉检查当通过"这类**漂移**，**不覆盖"工具本体被改"**：把键与守卫一起改在函数
    //  本体里时，重算与产物**同源同错**（批次4 段C 复核 N3/D2 的反例）。⇒ 它**不是防伪签名**；
    //  工具完整性靠**外锚**（tools/review-lag.mjs × REVIEW-STAMP.json 的审核戳链），不压在本文件自己的链上。
    keyIntegrity: { ran: true, rows: ki.rows, fields: ki.fields, pairs: ki.pairs, gaps: ki.gaps, dedupConsistent,
      // 批次6 · 段A-B：**剥区灵敏度空转**（原始输出变了而判定面没变且未 ack 的 OUTPUT_FIELDS 字段）——
      //   close 侧 fail-closed 读它（否则"把 anchor 混进 OUTPUT_FIELDS"这类误用又变成无声）。
      vacuous: ki.vacuous,
      // 批次5 第 4 项：合并组检查结果（close 侧 fail-closed 读 mergeGroups——否则新检查可被静默删）
      mergeGroups: mergeGroups.bad, mergeGroupsInfo: mergeGroups.info,
      // 批次6 · 段B-D1：**检查有效性**两个数（close 侧交叉核对：有重复行却零并组 ⇒ 检查输入面错了/被删）
      mergeGroupsPairs: mergeGroups.pairGroups, scannedRows: mergeGroups.scanned, dupCount: dupIds.length,
      // 批次5 第 10 项（段D §4.4 根因补强）：**键外字段漂移**（同键但全内容不同 ⇒ 保留哪条取决于证据顺序）
      // 批次6 · 段C-N2（P2）：每条带 `tier`/`fields`/`judgeVisible` 三档（仍**非阻断**）
      drift,
      // 批次8 · G2-1②：**重级接线实跑记录**（独立重算实值 × mg 声明快照 × 接线自查结论 problems）——close 侧读它
      //   （拆线 / 逐字镜像不再全链无痕；**完整镜像**仍为文件内上限，见 doEscalate 重级注释与函数注释）。
      countsReconcile: countsReconcileRec },
    // 放行＝双条件（审核 patch ③）：无升级项 ∧ 自证包完整；否则明说"不可判定"，不许报绿
    verdict: problems.length || badLines.length ? 'invalid-input'
      : slices.length === 0 ? 'unverifiable'
        : r.escalate ? 'needs-slow'
          : cert.complete ? 'pass' : 'unverifiable',
  };
  const p = join(dir, 'escalate.json');
  writeFileSync(p, JSON.stringify(out, null, 2), 'utf8');
  console.log(`切片 ${slices.length} 行（${filesRead} 文件）⇒ 去重后**独立记录 ${unique.length} 条**（重复填充 ${dupIds.length} 行）⇒ 升级 ${r.counts.a1 + r.counts.a2} 点（A1 ${r.counts.a1} / A2 ${r.counts.a2}）`);
  if (dupIds.length) console.log(`⚠ 重复填充：${dupIds.slice(0, 8).join(', ')}${dupIds.length > 8 ? ` …共 ${dupIds.length}` : ''}（已按内容级去重，计数以独立记录为准）`);
  if (drift.length) console.log(`⚠ 键外字段漂移 ${drift.length} 处（同键但全内容不同 ⇒ 保留哪条取决于证据顺序；全部**非阻断**）：${JSON.stringify(drift.slice(0, 4))}${drift.length > 4 ? ` …共 ${drift.length}` : ''}　分档统计 ${JSON.stringify(drift.reduce((a, d) => { a[d.tier] = (a[d.tier] ?? 0) + 1; return a; }, {}))}`);
  if (badLines.length) console.log(`⚠ 坏行/缺失 ${badLines.length} 处（不得静默）：${badLines.slice(0, 5).join(', ')}`);
  // 2026-10-16（批次6 · 段A-D console 三处小瑕疵）：① 接线级问题原先**打两遍**（`problems` 是并集 ⇒ 首行已含其文本，
  //   第二行又逐字重打）；② 首行标题"校验问题 N 条"数的是**并集**，括号里却报"原始输入 0" ⇒ 易读成"输入问题 1 条"；
  //   ③ 接线级一行没给行数（只给条数）。现：首行标题**点明含接线级 N 条**、明细只列**输入侧**问题；接线级独立一行。
  if (problems.length) console.log(`⚠ 校验问题 ${problems.length} 条（含接线级 ${wiringProblems.length} 条；原始输入问题 ${rawInputProblems.length} 条 / **输入侧物理坏行 ${physicalBadRows} 行**；闭词表零容忍）${rawInputProblems.length ? `：${rawInputProblems.slice(0, 5).join('；')}` : ''}`);
  if (wiringProblems.length) console.log(`⚠ 接线级问题 ${wiringProblems.length} 条（键完整性/收口/合并组/剥区——**不计入坏行**，但同样拦）：${wiringProblems.slice(0, 3).join('；')}`);
  console.log(`自证包：切片 ${cert.slices} / 带证伪器 ${cert.withFalsifier} / 不可翻译 ${cert.untranslatable} / 完整=${cert.complete}`);
  console.log(`判定：**${out.verdict}**${out.verdict === 'pass' ? '（可收）' : out.verdict === 'needs-slow' ? '（进慢层）' : '（**不得报绿**）'}`);
  console.log(`产物：${p}`);
  process.exitCode = ['invalid-input', 'unverifiable'].includes(out.verdict) ? 3 : 0;
}

function doTemplate() {
  const dir = outDir(flag('task', 'task'), flag('out'));
  const p = join(dir, 'slices.jsonl');
  const sample = {
    id: '<单元>-1', unit: 'unit-A', claim: '（一条可证伪的指控）', quote: '（逐字原句，禁止转述）',   // R1：id 必须带单元前缀（跨文件永不重号；同一 (claim,anchor) 会被内容级去重）
    anchor: 'src/x.mjs:123', rev: 'sha256:（文件哈希前 12）', risk_class: RISK_CLASSES[0],
    status: STATUSES[0], reality_entry: REALITY[0], data_critical: false,
    falsifier: '（≤1 个探针：什么最小实验能让这条主张挂掉）'
  };
  writeFileSync(p, JSON.stringify(sample) + '\n', 'utf8');
  console.log(`闭词表：risk_class ∈ ${RISK_CLASSES.join('/')}`);
  console.log(`　　　　status ∈ ${STATUSES.join('/')}　reality_entry ∈ ${REALITY.join('/')}`);
  console.log(`模板：${p}`);
}

// ── selftest：夹具自测（不碰真库；2026-10-15 按独立审核的对抗用例重写） ────────
function doSelftest() {
  // 【批次10 · G3-1】**运行时自计数**（原为死字符串）——批次8 复核 §3.2/§4 实测：原实现下把 ⑮ 整组删掉、或把
  //   断言语句换成字面量 `true`（调用消失），selftest **仍 exit 0 且照旧打印「15 组断言全过」**（打印行是硬编码
  //   字面量，整组被吞无任何自动反应）。现：`G()` 逐组计数、`assert()` 逐条计数，末尾**自计数断言**把关
  //   （组≠15 或断言<37 ⇒ 红），打印行也改成**数出来的**。
  //   ⚠ 边界（如实，与 ⑪ 同口径）：计数只挡**结构性删/吞**；"保留调用、把条件改写成恒真"的**故意**形态在文件内
  //   不可判（外锚仍是 review-lag × REVIEW-STAMP）——⑮ 另有"用例执行见证"把最省事的那种改写变红（见 ⑮ 注释）。
  let g = 0; let n = 0;
  // 【批次11 · G4-1】**期望基线冻结（常量集中 + 与硬字面量对拍）** —— 批次10 复核 §4 实测（B3 格）：旧形态
  //   `assert(g === 15 && n >= 37, …)` 是**单点可改**的——把 `37` 改成 `35`（1 处）＋删掉 ⑮ 的 4 条比较断言
  //   （另 1 处）＝ **exit 0 / 15 组 / 36 条全绿，而比较能力归零**。现：期望值集中到一处，且与**硬字面量**对拍
  //   ⇒ "降下界"必须**同时**改第二处，而第二处**报错指着它**（报文字面可见"降下界＝拆闸门"）。
  //   如实：这是**维护者纪律**型机制（增/删断言须两处同改），不是自动收敛——红会指着你说。
  //   断面推导（**口径**：`EXPECT_N_MIN` ＝ 自计数断言**求值时**的 n ＝ 总断言数 − 1）：⑮ 的用例执行见证是第 40 条 ⇒ 判据求值时 n=39；
  //   自计数断言是第 41 条 ⇒ 求值时 n=40。批次13 · A7 在 ⑮ 组内新插一条"生产件真跑"断言（第 39 条）⇒ 上述两条各后移一位、常量 39→40。
  const EXPECT_G = 15; const EXPECT_N_MIN = 40; const EXPECT_CMP = 4; const EXPECT_CALLS = 4;
  if (EXPECT_G !== 15 || EXPECT_N_MIN !== 40 || EXPECT_CMP !== 4 || EXPECT_CALLS !== 4) {
    // 【批次12 · G5-2①】**报文分区**（批次11 复核 §5 已自测）：原报文把四个常量一股脑打印（`应为 15 / 39 / 4 / 4`）
    //   ⇒ 读不出**哪个**常量漂移。现按项列出漂移项；四项全自洽而来（＝冻结句自身被改写）时给出显式说明。
    const g5drift = [EXPECT_G !== 15 && `EXPECT_G=${EXPECT_G}≠15`, EXPECT_N_MIN !== 40 && `EXPECT_N_MIN=${EXPECT_N_MIN}≠40`, EXPECT_CMP !== 4 && `EXPECT_CMP=${EXPECT_CMP}≠4`, EXPECT_CALLS !== 4 && `EXPECT_CALLS=${EXPECT_CALLS}≠4`].filter(Boolean);
    throw new Error(`FAIL: selftest 期望基线被改动（漂移项：${g5drift.join(' / ') || '（常量与硬字面量自洽——即冻结句本身被改写）'}）——降下界＝拆闸门 ⇒ 红`);
  }
  const assert = (c, m) => { n += 1; if (!c) throw new Error('FAIL: ' + m); };
  const G = (f) => { g += 1; return f(); };
  const s = (o) => ({ id: o.id, unit: o.unit ?? 'u1', claim: 'c', anchor: o.anchor ?? 'a.mjs:1', risk_class: o.rc, status: o.st, reality_entry: o.re, data_critical: o.dc === true, falsifier: o.fx === false ? '' : 'x' });
  // ① 假绿 1 条即升（A1）
  G(() => {
    assert(judgeEscalation([s({ id: 'x1', rc: 'false-green', st: '实证', re: 'reproduced' })]).counts.a1 === 1, '假绿必须立即升级');
  });
  // ② 低危不升
  G(() => {
    assert(!judgeEscalation([s({ id: 'x2', rc: 'docs', st: '实证', re: 'reproduced' })]).escalate, 'docs 不得升级');
  });
  // ③ 理论举证不升
  G(() => {
    assert(!judgeEscalation([s({ id: 'x3', rc: 'dataloss', st: '实证', re: 'theoretical' })]).escalate, '理论性举证不得触发 A1');
  });
  // ④ silent-skip 实证非理论 ⇒ 升
  G(() => {
    assert(judgeEscalation([s({ id: 'x4', rc: 'silent-skip', st: '实证', re: 'observed' })]).escalate, 'silent-skip 应升级');
  });
  // ⑤ coverage-gap 仅在 data_critical 时升
  G(() => {
    assert(!judgeEscalation([s({ id: 'x5', rc: 'coverage-gap', st: '实证', re: 'observed' })]).escalate, '非关键覆盖缺口不得升级');
    assert(judgeEscalation([s({ id: 'x6', rc: 'coverage-gap', st: '实证', re: 'observed', dc: true })]).escalate, '关键覆盖缺口应升级');
  });
  // ⑥【审核修正】false-fix / crash **已实证** ⇒ A1 立即升（证明了的假修复与静默丢数据同级危险）
  G(() => {
    assert(judgeEscalation([s({ id: 'x7', rc: 'false-fix', st: '实证', re: 'reproduced' })]).counts.a1 === 1, '已实证的假修复必须 A1 升');
    assert(judgeEscalation([s({ id: 'x8', rc: 'crash', st: '实证', re: 'observed' })]).counts.a1 === 1, '已实证的崩溃必须 A1 升');
  });
  // ⑦【审核修正】A2 语义＝**实证 ∧ open**；"未决"**不**升级（这是原实现写反的地方，固化为反向用例）
  G(() => {
    const a2 = judgeEscalation([s({ id: 'y1', rc: 'false-fix', st: '实证', re: 'reproduced' }), s({ id: 'y2', rc: 'crash', st: '实证', re: 'reproduced', anchor: 'b.mjs:9' })]);
    assert(a2.escalate, '实证的 false-fix/crash ×2 应触发 A2');
    const undecided = judgeEscalation([s({ id: 'z1', rc: 'false-fix', st: '未决', re: 'theoretical' }), s({ id: 'z2', rc: 'false-fix', st: '未决', re: 'theoretical', anchor: 'b.mjs:9' })]);
    assert(!undecided.escalate, '「未决」不得升级（未决＝待查，不是结论）——防语义再次写反');
  });
  // ⑧ 闭词表零容忍：拼错/越界必须被 validateSlices 拦下（不得静默"可收"）
  G(() => {
    assert(validateSlices([s({ id: 'w1', rc: 'bogus', st: '实证', re: 'observed' })]).length >= 1, '未知 risk_class 必须报错');
    assert(validateSlices([s({ id: 'w2', rc: 'dataloss', st: '搞定了', re: 'observed' })]).length >= 1, '未知 status 必须报错');
    assert(validateSlices([s({ id: 'w3', rc: 'dataloss', st: '实证', re: 'maybe' })]).length >= 1, '未知 reality_entry 必须报错');
    assert(validateSlices([{ rc: 'dataloss', status: '实证', reality_entry: 'observed' }]).length >= 1, '缺 id/claim/anchor 必须报错');
    // 2026-10-16（批次3 落地 pE / 审核 D6）：`data_critical` 布尔锁是**该类校验的唯一防线**——删掉 validateSlices
    // 里的布尔校验后 11 组断言仍全绿，而真跑副作用是 coverage-gap + 实证 从「A1 立即升」静默退成「不升 ⇒ verdict=pass」。
    assert(validateSlices([{ ...s({ id: 'w4', rc: 'coverage-gap', st: '实证', re: 'observed' }), data_critical: 'true' }]).length >= 1,
      'data_critical 字符串必须报错（否则 coverage-gap 实证静默不升级 ⇒ 报 pass）');
    assert(validateSlices([{ ...s({ id: 'w5', rc: 'coverage-gap', st: '实证', re: 'observed' }), data_critical: 1 }]).length >= 1,
      'data_critical 数字必须报错（同上）');
  });
  // ⑨ 自证包：无证伪器 ⇒ 不完整；全带 ⇒ 完整
  G(() => {
    assert(buildCertificate([s({ id: 'v1', rc: 'docs', st: '实证', re: 'observed', fx: false })]).complete === false, '缺证伪器不得自证完整');
    assert(buildCertificate([s({ id: 'v2', rc: 'docs', st: '实证', re: 'observed' })]).complete === true, '齐备时应自证完整');
  });
  // ⑩ R1（2026-10-15 GPT 复核§1）：内容级去重必须让"行数"与"独立记录数"分家——重复行不得虚增问题数
  G(() => {
    const one = s({ id: 'd1', rc: 'dataloss', st: '实证', re: 'reproduced', anchor: 'x.mjs:1' });
    const dup = [one, one, one, one, one, s({ id: 'd2', rc: 'silent-skip', st: '实证', re: 'observed', anchor: 'y.mjs:2' })];
    // 2026-10-16（批次5 · 落地清单第 3 项／批次4 段A 复核 F-A5）：**自测里不得再放"另一个实现"** ——
    // 原内联键 `${String(x.claim).slice(0,120)}|${x.anchor}` 是 2026-10-15 的**弱键历史实现**，与生产键语义
    // 已经分叉（段A 实测：同一夹具上内联键给 uniq=1 / A1=0，生产键给 uniq=2 / A1=1）⇒ 未来读者照抄即踩坑。
    // 现直接调生产收口函数 `dedupByKey`（键语义唯一定义处），并锁住 dupIds 的**逐行**计数（段A §5.6 建议）。
    const { unique: uniq, dupIds: dupIds10 } = dedupByKey(dup);
    assert(dup.length === 6 && uniq.length === 2, `行数与独立记录必须分家：${dup.length} vs ${uniq.length}`);
    assert(dupIds10.length === 4, `重复填充必须逐行记（6 行里 5 份同内容 ⇒ 4 条重复）：${dupIds10.length}`);
    const r6 = judgeEscalation(dup); const r2 = judgeEscalation(uniq);
    assert(r2.counts.a1 === 2, `独立记录 ⇒ A1 应为 2：${r2.counts.a1}`);
    assert(r6.counts.a1 > r2.counts.a1, `未去重时重复行会虚增 A1（${r6.counts.a1} vs ${r2.counts.a1}）——这正是"行数≠问题数"的机制`);
    assert(buildCertificate([], {}).complete === false, '零切片不得自证完整（应落 unverifiable）');
  });
  // ⑪（2026-10-16 批次3 重写：**读面探针退役为诊断；键完整性走行为级 + 接线级**）
  // 历史：白名单版→名义守卫（B 证明 14 变体 11 绕过）；黑名单+正则版→仍漏（三趟审 m01–m09：解构/方括号/可选链/
  // 别名/entries/截断/注释诱饵 7 写法全绿）→ 运行时读面探针（四陷阱，写法无关）。**批次3 复核裁定其不可作门禁**：
  //   ① 自指盲区（D2 根因）：同手段包 judgeKey **必然红**（ownKeys 把样本上所有黑名单键记进 reads）——正确实现与
  //      回归实现在读面口径下同为红 ⇒ 对"键"零分辨力；而键正是最该守的东西；
  //   ② 三形态绕过（D3，复核实测）：探的是"夹具构造的调用"——生产与探针在 参数(opts 形参)/环境(GATE_TRACE)/
  //      数据(值域分支) 任一维分叉即整体失效且**静默绿**；
  //   ③ 误红倒逼删证据（D5 / 复核 §2a）：判据里加一行无开关的排查日志（Object.keys 列键）即红，而"正例②（用未
  //      代理来源）"对判据函数体**不可照做**（入参就是被代理对象）⇒ 只剩"删掉日志"一条路。
  // ⇒ 主会话裁定（2026-10-16）：**读面探针退役为诊断**——代码与输出保留（见下方 console 诊断行），**不再作断言**；
  //    **键完整性改走行为级**：判据/自证包对某字段敏感 ⇒ 生产键必须能分开它（不依赖代理、不受调用形态影响、
  //    无"旁观式读取"误红面）。selftest 与生产接线（doEscalate 对真实 unique）**共用同一实现 keyIntegrityGaps**；
  //    ⑪ 自身"无守护"（整组可删无报警）落为产物字段 keyIntegrity + close 的 fail-closed 链（批次3 U3 合并）。
  G(() => {
    const samples = [
      s({ id: 'p1', rc: 'false-green', st: '实证', re: 'reproduced', unit: 'cli-mcp' }),   // A1 主路径；【批次6 · 段C-N3/P4】首行用**生产单元名**（⑪ 的 (字段,值) 见证在非 u1 值域上做 ⇒ unit 门控无处可藏）
      s({ id: 'p2', rc: 'false-fix', st: '实证', re: 'reproduced' }),                // A1 + provenHard（A2 路径）
      s({ id: 'p3', rc: 'coverage-gap', st: '实证', re: 'observed', dc: true }),     // coverage-gap ∧ data_critical
      s({ id: 'p4', rc: 'perf', st: '推测', re: 'theoretical', fx: false }),         // 低危 + 无证伪器（自证包路径）
      // 2026-10-16（批次2 落地 P1）：三条扩容——让判据走得到「未决」与 A2 命中分支（实测 v1/v3 盲区：
      // 分支不可达时，在那里读黑名单字段 selftest 也全绿）。
      s({ id: 'p5', rc: 'docs', st: '未决', re: 'theoretical' }),                    // 覆盖「未决」分支（v1 盲区）
      s({ id: 'p6', rc: 'crash', st: '实证', re: 'reproduced', anchor: 'b.mjs:9' }), // 第二条 provenHard ⇒ a2hit=true，走通 A2 命中分支（v3 盲区）
      // 2026-10-16（批次2 落地 P3）：枚举读取可见——样本行必须**自带黑名单字段**（否则 entries/values/JSON.stringify
      // 永远枚举不到它们）。注意：必须是**裸对象**——`s()` 帮手不做 extra 展开，经它写会把 quote 等静默吞掉；
      // 下面的泄漏守卫断言把这种退化变自证红。
      // 【批次6 · 段C-N3/P4】再来一条**新判据值 + 长 claim**：`keyIntegrityGaps` 的 (字段,值) 见证是"首个算"的
      // ⇒ 样本的值域**必须覆盖生产形状**（单元名 / claim 长度），否则"只在样本值域外生效"的门控削弱会整组失明。
      { ...s({ id: 'p9', rc: 'dataloss', st: '实证', re: 'reproduced' }), claim: 'y'.repeat(140) },
      { id: 'p7', unit: 'u1', claim: 'c', anchor: 'a.mjs:7', risk_class: 'other',
        status: '推测', reality_entry: 'theoretical', data_critical: false, falsifier: 'x',
        quote: 'Q', rev: 'sha256:x', why: 'w', reason: 'r', created: '2026-01-01', time: 'T' },
    ];
    // 夹具完整性（**门禁**）：黑名单字段必须在样本上真实存在——守卫**跟随 JUDGE_IRRELEVANT**，不写死 'quote'
    //（2026-10-16 批次3 D4：写死时，一旦 quote 合法移出黑名单，守卫前提静默过期却仍然绿）。作用：枚举类
    // **诊断**靠它才有分辨率（p7 退化 / 被 s() 吞掉 ⇒ 枚举类读取永远看不到黑名单键）。只查夹具自身，误红面为零。
    const missingF = JUDGE_IRRELEVANT.filter((f) => !samples.some((x) => Object.prototype.hasOwnProperty.call(x, f)));
    assert(missingF.length === 0,
      `lint：样本未覆盖黑名单字段 ${JSON.stringify(missingF)}（p7 退化 / 被 s() 吞掉）⇒ 枚举类诊断等于没测 ⇒ 必须红`);
    const reads = new Set();
    // 四陷阱（get/has/gOPD/ownKeys）——**诊断用**：写法无关地记录"判据运行时读了哪些字段"（口径同批次2：值读取/
    // 命名探测/全键枚举四面；`void ('quote' in s)` 与 `Object.keys(s).length` 都会记）。
    // **历史代价（降级后不再判红，但读者仍需知道）**：陷阱**无法区分**"读值参与判定"与"旁观式读取"——两者在
    // 代理里逐字同形（曾一律判红 ⇒ 误红倒逼删证据）。
    // **正例（改法）**：
    //   ① 字段**确实参与判定** ⇒ 把它移出 JUDGE_IRRELEVANT（键含它；语义正确）——改完由 keyIntegrityGaps 复验；
    //   ② 纯旁观（日志/列键）⇒ **一律移出判据函数**：判据只做判定，日志/列键在**调用方**用未代理的 unique 做。
    //      （判据函数体内**没有**非代理句柄可达——入参就是被代理对象。批次3 D5：旧文案让读者以为判据内部还有
    //      别的来源可用，实际不可执行，已删除该表述。）
    const wrap = (o) => new Proxy(o, {
      get(t, k) { if (typeof k === 'string') reads.add(k); return t[k]; },
      has(t, k) { if (typeof k === 'string') reads.add(k); return k in t; },                                                        // `'quote' in s` / Reflect.has / Object.hasOwn
      getOwnPropertyDescriptor(t, k) { if (typeof k === 'string') reads.add(k); return Object.getOwnPropertyDescriptor(t, k); },    // gOPD / gOPDs / Object.keys、for..in 的逐键路径
      ownKeys(t) { for (const k of Reflect.ownKeys(t)) if (typeof k === 'string') reads.add(k); return Reflect.ownKeys(t); },       // getOwnPropertyNames / Reflect.ownKeys / JSON.stringify 路径
    });
    judgeEscalation(samples.map(wrap));
    // 直白检验（**门禁**，不靠读面推理）：调用结果必须是 {complete:boolean}——删掉调用 ⇒ 直接红、不被枚举遮蔽（P4）。
    const cert = buildCertificate(samples.map(wrap), {});
    assert(cert && typeof cert === 'object' && typeof cert.complete === 'boolean',
      'lint：buildCertificate 调用缺失或返回值退化（直白检验：调用结果必须是 {complete:boolean}——不靠读面推理）⇒ 必须红');
    // 读面探针输出（**诊断用，非门禁**）：命中黑名单只说明"有观察面"——可能是旁观式读取（日志/列键），不判红。
    const hits = [...reads].filter((f) => JUDGE_IRRELEVANT.includes(f) && !OUTPUT_FIELDS.includes(f)).sort();
    const covMiss = ['unit', 'falsifier', 'risk_class', 'status', 'reality_entry'].filter((f) => !reads.has(f));
    console.log(`⑪ 读面诊断（**非门禁**）：判据读了 ${reads.size} 个字段；黑名单命中 ${hits.length ? JSON.stringify(hits) : '无'}${covMiss.length ? `；覆盖缺口 ${JSON.stringify(covMiss)}（样本/调用面退化？）` : ''}`);
    // 键完整性（**门禁**·行为级·与生产接线同一实现）：判据/自证包对某字段敏感 ⇒ 生产去重键（经 dedupByKey）
    // 必须能分开它；翻转含**存在性翻转**（''/缺省）——只翻 x→xZ 会漏 falsifier 类"存在性敏感"字段（D2 + 复核漏项 B）。
    const ki = keyIntegrityGaps(samples);
    // 2026-10-16（批次5 · 落地清单第 5 项，附加同目的一条）：**守卫有效性** —— 把 keyIntegrityGaps 换成恒空
    // stub / 直接早返回（批次4 段C 的 C1/D2 削平形态）时，旧断言 `gaps.length === 0` **照样绿**（"什么都不检查"
    // 与"检查了没问题"不可区分）⇒ 这里要求它必须真跑出非零计数。
    // 【批次6 · 段C-N4/P5】计数改"**样本可推导**"：`fields === 样本字段并集 ∧ pairs ≥ 行数` —— 把"算得对"的
    //   伪造成本从 0 抬到"必须真读样本"（`fields:1/pairs:1` 的手写 stub 由**绿**变**红**）；**仍非防伪**
    //   （算对再伪造仍可过）——这条边界如实保留（批次5 段C §5 N4）。
    assert(ki.rows === samples.length
      && ki.fields === new Set(samples.flatMap((x) => Object.keys(x))).size
      && ki.pairs >= samples.length,
      `守卫有效性：键完整性检查必须在样本上真跑出非零计数（rows=${ki.rows}/fields=${ki.fields}/pairs=${ki.pairs}）——stub/早返回的实现必须红（计数须由**样本**可推导：fields＝样本字段并集、pairs≥行数）`);
    assert(ki.gaps.length === 0,
      `lint：键漏了判据依赖的字段 ${JSON.stringify(ki.gaps)}——这些字段一变、判据输出就变，但生产去重键分不开两条记录 ⇒ 调整证据顺序即可吞升级项 ⇒ 把它们从 JUDGE_IRRELEVANT 移出（或修 judgeKey）`);
    // 【批次6 · 段A-B 补丁②】剥区（OUTPUT_FIELDS）**必须逐字段 ack**：未 ack 的字段一旦"原始输出变了而判定面
    //   没变"（＝敏感性落在剥区、验证是重言）就进 vacuous ⇒ 这里把"混进 OUTPUT_FIELDS 的误用"变成自测红。
    //   与 ⑫ 的分工：⑫ 管**生产键**（键被削平 ⇒ 红）；本断言管**剥区声明**（未 ack 的误用 ⇒ 红）。
    assert((ki.vacuous ?? []).length === 0,
      `lint：OUTPUT_FIELDS 里有未 ack 的字段 ${JSON.stringify(ki.vacuous ?? [])} ⇒ 这些字段的"只用于输出"验证落在**剥区**（重言、不可验）⇒ 要么写进 OUTPUT_FIELDS_ACK 并写明理由，要么不要放进 OUTPUT_FIELDS`);
  });
  // ⑫（2026-10-16 批次5 落地；依据批次4 段C 复核 §3.4「层 1-2」/ N4）：**守卫有效性断言** ——
  // 旧 selftest 全是"守卫别误报"（gaps.length===0 / !escalate / complete===false…），**没有一条"守卫必须抓得住"**，
  // 于是把键削平（D2 形态：弱键改在 dedupByKey **函数本体**里）后 11 组断言仍全绿 ⇒ "唯一自动线"对本批最关心的
  // 类别零反应。本组把两类**历史弱键一定并**的对喂给生产键，要求必须分开（键被削平 ⇒ 立即红）。
  // 【批次6 · 段C-N5 文案互指】⑫ 与 ⑪ 的 count 断言互为对方的必要件：⑫ 只管**生产键**（键完好 ⇒ 它恒绿，对
  //  "键完好 + 守卫被 stub"结构上不可能开火）；"键完好 + 守卫被 stub"那一格**只有 ⑪ 的 count 断言**看得见
  //  ⇒ 删 count 后 ⑫ 才首发火、删 ⑫ 后 count 板住（两条都在，才是"键侧 + 守卫侧"双面）。
  G(() => {
    const long = 'x'.repeat(140);
    const w1 = { ...s({ id: 'g1', rc: 'silent-skip', st: '实证', re: 'reproduced' }), claim: long, anchor: 'g.mjs:1' };
    const w2 = { ...s({ id: 'g2', rc: 'docs', st: '推测', re: 'theoretical' }), claim: long, anchor: 'g.mjs:1' };
    // 历史弱键 `(claim 前 120 字 | anchor)` 在这两行上完全相同 ⇒ 旧实现并成 1 条并保留首条（**真 A1 被吞、可假绿**）
    assert(dedupByKey([w1, w2]).unique.length === 2,
      '守卫有效性①：弱键会并的一对（同 claim 前 120 字、同 anchor，但判据字段不同）必须被生产键分开——键被削平 ⇒ 立即红');
    // 只差 status 的一对：status 进键是"合并顺序不得决定升不升级"的前提（同 claim 前缀同 anchor ⇒ 弱键必并）
    const t1 = { ...s({ id: 'g3', rc: 'false-fix', st: '实证', re: 'reproduced' }), claim: long + 'A', anchor: 'h.mjs:1' };
    const t2 = { ...t1, id: 'g4', status: '未决' };
    assert(dedupByKey([t1, t2]).unique.length === 2,
      '守卫有效性②：仅 status 不同的一对不得被并（否则"实证⇒升 / 未决⇒不升"两条记录合并后，升不升级取决于证据顺序）');
  });
  // ⑬（2026-10-16 批次6 落地；依据批次5 段C §4 N1"`mergeGroupGaps` 无任何守护" + P3）：**合并组检查的有效性断言**——
  //   把"丢 claim 的弱键"**注入**该检查：它必须报出塌陷（**正例对照**）；不报 ⇒ 检查被削平/被绕 ⇒ 立即红。
  //   与 ⑫ 的分工：⑫ 断言的是**生产键**（键完好时恒绿、对本格无分辨力）；⑬ 断言的是**检查本身**（与键无关，键是注入件）。
  //   健在性证据：末次调用 `mergeGroupGaps(rows)`（**生产默认签名**）在真键下不得误红——生产调用点零改动。
  G(() => {
    const rows = [
      { ...s({ id: 'z1', rc: 'crash', st: '实证', re: 'observed' }), claim: 'c-one', anchor: 'z.mjs:1' },
      { ...s({ id: 'z2', rc: 'crash', st: '实证', re: 'observed' }), claim: 'c-two', anchor: 'z.mjs:1' },
    ];
    const weakKey = (x) => JSON.stringify(Object.keys(x)
      .filter((k) => !JUDGE_IRRELEVANT.includes(k) && k !== 'claim').sort().map((k) => [k, x[k] ?? null]));
    const mg = mergeGroupGaps(rows, weakKey);
    assert(mg.bad.length > 0,
      `守卫有效性③：注入"丢 claim 的弱键"后，合并组检查必须报出塌陷（实测 bad=${JSON.stringify(mg.bad)}）——检查被削平/被绕 ⇒ 红`);
    assert(mergeGroupGaps(rows).bad.length === 0,
      '守卫有效性③（反向）：真键下同一对不得误红（claim 不同 ⇒ 键分开、组内只剩 1 条）');
  });
  // ⑭（2026-10-16 批次7 · D-1 重级）：**独立重算的有效性断言** —— 与 ⑬ 同构（正例对照：注入"丢 claim 的弱键"后必须
  //   报出塌陷），防的是新机制"被摘平成恒空"自身无守护（⑬ 对 mergeGroupGaps 的同款病，批次5 段C §4 的历史教训）。
  //   健在性证据：末次调用 `countsReconcileIndep(rows)`（生产默认签名）在真键下不得误报——生产调用点零改动。
  G(() => {
    const rows = [
      { ...s({ id: 'q1', rc: 'crash', st: '实证', re: 'observed' }), claim: 'c-one', anchor: 'q.mjs:1' },
      { ...s({ id: 'q2', rc: 'crash', st: '实证', re: 'observed' }), claim: 'c-two', anchor: 'q.mjs:1' },
    ];
    const weakKey = (x) => JSON.stringify(Object.keys(x)
      .filter((k) => !JUDGE_IRRELEVANT.includes(k) && k !== 'claim').sort().map((k) => [k, x[k] ?? null]));
    const rec = countsReconcileIndep(rows, weakKey);
    assert(rec.pairGroups === 1 && rec.collapseKinds.length > 0,
      `守卫有效性④：注入"丢 claim 的弱键"后，独立重算必须报出计数塌陷（实测 ${JSON.stringify(rec)}）——独立重算被削平/被绕 ⇒ 红`);
    assert(countsReconcileIndep(rows).collapseKinds.length === 0,
      '守卫有效性④（反向）：真键下同一对不得误报（claim 不同 ⇒ 键分开 ⇒ 无碰撞组）');
  });
  // ⑮（2026-10-16 批次8 · G2-1）：**重级"接线层"的比较逻辑直测** —— 批次7 复核 §3.1 实测：比较块可被单点拆线
  //   （`if (false)`）或镜像而不触发 ⑭（⑭ 只管 `countsReconcileIndep` 函数本体）。⇒ 把比较抽成纯函数
  //   `countsReconcileProblems` 后，正反例可直接打在它身上：两处一致 ⇒ 不报；任一维不一致 ⇒ 必报（"比较被换成
  //   更弱谓词/恒空"⇒ 立即红）。接线在生产上"跑没跑"另由产物 countsReconcile 痕迹 + close fail-closed 承载。
  // 【批次10 · G3-2】两条加固（批次8 复核 §3.2/§4 实测：旧夹具与产物**不同构** ⇒ "把比较扩展到 `scanned`"这类
  //   合理加固会**误红**；且三例不覆盖"同长度、异种类" ⇒ 把比较换成**按长度**比较的弱谓词时 15 组全绿）：
  //   ① 入参补 `scanned` / `declaredPairGroups` / `declaredCollapseKinds` 同构字段（与生产产物落痕同形）；
  //   ② 第 4 例＝"同长度、异种类"（弱谓词 ⇒ 红）。两态实测：`lenonly` 红 / 诚实绿；`scanned` 加固不再误红。
  // 【批次10 · G3-1 加固】**用例执行见证**：把断言条件改写成恒真（`assert(true, …)`）会让 `prob(…)` 的**调用
  //   消失** ⇒ 末条 `probCalls === 4` 当场红（这正是复核 `s15-asserts-gut` 那一格的形态）；整组被删/被吞由
  //   g/n 自计数挡（见函数头）。
  // 【批次11 · G4-2】**见证绑断面**：上面那条见证改绑 `n === EXPECT_N_MIN - 1`（进入本组的条数断面）⇒
  //   "删掉比较断言、只留裸调用"（批次10 复核 §2.1 的 B2 格）当场红；而"保留调用、只把比较改弱"（B1 格，
  //   如 `.length >= 0`）本组看不出（**值面不可判**：弱化不改任何值）——由函数尾的**比较面冻结**（文本面）
  //   判红。两条机制互补，均为"提高协同成本"，不是防伪。仍有"保留调用、丢弃比较"的故意形态在文件内不可判——如实登记，不宣称封死。
  // 【批次13 · G6-2/A7】**导出重绑计数（在 ⑮ 组**之前**激活）** —— 批次12 复核 §6：委派锚（文本面）挡不住"字符串诱饵/影子声明"，
  //   故把导出件重绑成计数包装器；本组 4 次比较调用必须**真跑到生产件**（详见 `g6wrapCalls` 声明处注释）。位置在组前 ⇒
  //   本组内任何走导出绑定的调用（含日后新增的）都经过包装器。**只此一路计数**（口径＝真跑次数，见上注"编码差异"）。
  countsReconcileProblems = ((_f) => (...a) => { g6wrapCalls += 1; return _f(...a); })(countsReconcileProblems);
  G(() => {
    const mg = { pairGroups: 2, bad: [{ kind: 'a1-collapse' }], scanned: 2, declaredPairGroups: 2, declaredCollapseKinds: ['a1-collapse'] };
    const indep = { pairGroups: 2, collapseKinds: ['a1-collapse'], scanned: 2 };
    let probCalls = 0;
    const prob = (i, m) => { probCalls += 1; return countsReconcileProblems(i, m); };
    assert(prob(indep, mg).length === 0,
      '守卫有效性⑤（反向）：两处一致时不得报问题');
    assert(prob({ ...indep, collapseKinds: [] }, mg).length === 1,
      '守卫有效性⑤：独立重算与声明不一致时必须报出问题——接线被拆/被镜像 ⇒ 红');
    assert(prob({ ...indep, pairGroups: 1 }, mg).length === 1,
      '守卫有效性⑤：碰撞组数不一致时必须报出问题');
    assert(prob({ ...indep, collapseKinds: ['a2-collapse'] }, mg).length === 1,
      '守卫有效性⑤④：塌陷种类【同长度、异种类】时必须报出问题（按长度比较的弱谓词 ⇒ 红）');
    // 【批次13 · G6-2/A7】**生产件真跑计数**（导出重绑计数）：上面 4 条比较若被"字符串诱饵/影子声明"接管，本组断言与断面**全部照旧**，
    //   但生产比较函数**一次也没跑到** ⇒ 本读数 0/4 当场红。**只证真跑过**，不证返回值被用（E3 格仍绿，如实登记）。
    assert(g6wrapCalls >= EXPECT_CALLS, `⑮ [A7] 生产比较函数真跑次数 ${g6wrapCalls}/${EXPECT_CALLS}（导出重绑计数）——比较面在而比较不在 ⇒ 红`);
    assert(probCalls === EXPECT_CALLS && n === EXPECT_N_MIN - 1,
      `守卫有效性⑤：用例未真跑（实跑 ${probCalls}/${EXPECT_CALLS} · 本组断言断面 ${n}/${EXPECT_N_MIN - 1}）——断言被删/条件被换成恒真（调用消失）/整组被吞 ⇒ 红`);
  });
  // 【批次10 · G3-1】**自计数断言（在打印之前** ⇒ 计数不符时既不打印"全过"、也不给 exit 0）：
  //   整组被删 ⇒ g=14 ⇒ 红；断言语句被字面量 `true` 吞掉（调用消失）⇒ n 掉 ⇒ 红。下界 37＝批次8 复核给的基线
  //   断言数（实测现值 41＝基线 37 + G3-2 第 4 例 + ⑮ 用例执行见证 + 本自计数断言 + 批次13 A7 生产件真跑计数）。
  assert(g === EXPECT_G && n === EXPECT_N_MIN, `selftest 自计数不符（组 ${g} / 断言 ${n}）——整组被删/被吞 ⇒ 红（期望 ${EXPECT_G} 组 / ${EXPECT_N_MIN} 条）`);
  // 【批次11 · G4-2】**比较面冻结（文本面）** —— 批次10 复核 §2.1 实测（B1 格）：把 ⑮ 的 4 条比较改成恒真谓词
  //   （`.length >= 0`），**调用与实参全留** ⇒ 旧件 **exit 0 / 15 组 / 40 条全绿，而比较能力归零**
  //   （⑮ 的用例执行见证只数调用、不校谓词；弱化不改任何值 ⇒ 值面不可判）。⇒ 把 ⑮ 的"**显式期望值的严格比较**"
  //   站点数当常量冻结（EXPECT_CMP）：比较被改弱 / 被搬走 / 调用被丢弃 / 被搬到死代码里凑数，只要计数 ≠
  //   EXPECT_CMP ⇒ 红。位置上放在自计数断言**之后**（既有红格的消息面保持原样，见 README §2）。
  //   如实（与 ⑪/⑮ 同口径，**不宣称封死**）：这是**文本面**耦合检查——**同步改写本检查区**（改 EXPECT_CMP
  //   或这段文本）仍是"两处协同"，文件内不可判；外锚仍是 review-lag × REVIEW-STAMP。它只把"一改一处、不动
  //   检查区"的最省事形态变成红（两态实测：B1 红 / 同族的"void 丢弃比较"形态亦红 / 诚实零误红）。
  //
  //   【批次12 · 文档三条（人读口径更正；载体＝本段注释，与判据同页）】
  //   ① **协同成本更正（批次11 复核 §2.2 实测）**：README §4.1 的"1 处 → **3 处**"**低估**——B3 型（降下界静默）的第三处是
  //      **⑮ 见证断面**（`probCalls === EXPECT_CALLS && n === EXPECT_N_MIN - 1`），**不是**冻结句：coop2 与 F1 两格都是 ⑮ 先报
  //      （删掉冻结句照样红）。把这一处显式入账后，**"四处同改才绿"**：⑮ 见证断面 + 常量行 + 冻结硬字面量 + 4 条比较站点。
  //      ⇒ 这道机制承担了比 §4.1 记载**更多**的拦截。
  //   ② **记功归错（同 §4.1 / L1 实测）**："把 4 条严格比较**搬进从不执行的函数**（⑮ 里只留裸调用、文本同形补齐计数）"虽然
  //      **是红**，但**是 ⑮ 见证断面接住的**（实测报 `实跑 4/4 · 本组断言断面 34/38`），**不是**比较面冻结 ⇒ 维护者若据此以为
  //      "冻结能挡死代码搬运"会被引偏；两类机制**各挡各的**（冻结＝站点形态被改/被搬；见证断面＝调用在而断言不在）。
  //   ③ **形态耦合（非语义）判据（同 §4 观察表 L2′/L3）**：本冻结数的是 `assert(prob(X).length === K, …)` 这一**写法**的站点数
  //      ⇒ **等值重构也会红**（实测：`const r = prob(X); assert(r.length === k, …)` 与 `>= k && <= k`、整段搬进块注释/死代码
  //      **均红**）。这是**有意**的**文本面**取舍（弱化不改值 ⇒ 值面不可判），**不是**"机制坏了"：合法重构请**同步改
  //      EXPECT_CMP 或把站点写回原形态**，别当 bug 修掉本段。
  //      ⚠ **归因（批次13 · G6-3；逐字落批次12 复核 §6 的补丁 A3）**：`>= k && <= k` 这一族的红点**不是**本冻结，而是
  //      **⑮ 见证断面**（表达式内两次调用把调用数从 4 抬到 5 ⇒ 实测报 `实跑 5/4`）——它**先于**冻结报；本冻结只接住
  //      "**调用次数不变、站点写法改变**"的形态（如 `const r = prob(X)`，实测报"严格比较点 3/4"）。维护者若只按
  //      "冻结报 3/4"去找问题会被引偏（与上面 ② 的"记功归错"同族：红是真红，报点不是你以为的那处）。
  {
    const SELF_SRC = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const i15 = SELF_SRC.indexOf('// ⑮（2026-10-16 批次8 · G2-1）');
    const iTail = SELF_SRC.indexOf('// 【批次11 · G4-2】**比较面冻结');
    // 【批次12 · G5-3b】**委派锚**（批次11 复核 §5，**自匹配安全版**）——补 G5-1：4 条比较站点**文本一字不动**、
    //   只把 `prob` 定义体换成"预算保持型"假体（按调用序恰好给 [0,1,1,1]：第 1 条假绿、第 2~4 条假红）
    //   ⇒ 站点计数、调用见证、断面**全部照旧**，而生产比较函数 `countsReconcileProblems` **一次也没跑**（原机制全绿）。
    //   判据：源码里 `prob` 的**委托定义行**须**恰好 1 处**（即 regex `g5delRe` 的命中数），且该处起 **220
    //   字**内出现生产比较函数名（＝"⑮ 的探针真委派到生产件"，而不是本地假体）。**判据只看命中数，不要求行数**。
    //   ⚠ **自匹配坑**（批次11 已钉；批次12 落地时**又踩一次**）：第一版写成 `indexOf('const prob = (i, m) =>')` + 计数 ⇒ **把自己那行也数进去**
    //   ⇒ 诚实件**误红**。此处 regex 要求定义行**以 `{` 收尾**，而本行下方 block 内**不得出现该锚的字面串**（凡在注释/字符串里
    //   **逐字写出该锚**，会被算成第 2 处定义点 ⇒ 诚实件误红——要改本锚时，请改 `g5delRe` 自身或**用字符拼接描述它**，别把锚写进注释）。
    //   如实（与 ⑪/⑮/冻结同口径，**不宣称封死**）：这是**文本面**锚——"把真委派搬到 ⑮ 区间外、区间内只留假体"会
    //   使定义点数 ≠ 1 而红（实测）；"同步改写本检查区"仍是对称残余（外锚仍是 review-lag × REVIEW-STAMP）。
    // 【批次13 · G6-1/G6-4；**批次14 · G7-2 回退**】**"含调用"→回退"含词"** + **口径更正**（批次12 复核 §5/§6、批次13 复核 §3 实测）：
    //   · G6-1（高）：旧子判据只要求窗口里**出现**生产函数名 ⇒ 假体里放**字符串字面量**（`void ('名')`）即可骗过
    //     （复核 W2b 格：全绿 ⇒ 真洞）。批次13 曾收窄为**调用语法**（名字后跟 `(`）；**批次14 实测回退为含词版**（一行）：
    //     **拦截由 A7 承重**（⑮ 组内"生产件真跑次数"断言先于本锚执行，接住全部"活体不委派"形态——S1/S2/H/P2real 回退后**仍全红**、报点均 A7），
    //     **含词版仅作文本面兜底**（仍挡"定义点数≠1"与最直白的空窗口——⚠ 实测（VERIFY-G8）：这两类**全是诚实形态**（表达式体探针 / 死块同名定义 / 注释逐字引用锚：三格运行时断言全过、仅本锚红）⇒ 与 R3 同族，请按"误红面"读，不按"兜底面"读）。
    //   · 回退理由（`VERIFY-G7` §3 实测）：调用语法版**唯一能先于 A7 报的场景** ＝"真委派但窗口内缺 `名(`"——那正是**诚实**件
    //     （实测格 `R4-alias-name-in-comment`：prev12 绿 / landed13 红；`R4b` 只差一个括号即绿）⇒ **A1 边际拦截力 ＝ 0、边际误红 ＝ R4 族**。
    //   · **残余（如实，不宣称封死）**：字面量里写出"名"（更不用说"名 + `(`"）都能骗过**本锚**——那一族由 **A7 运行时计数**接住，两判据互补；
    //     `R3`（窗口内连名字都没有）仍红＝**预存在**的文本面约束（G5-3b 起的已知代价）。
    //   · G6-4（低）：`N` ＝ **纯文本命中数**（下方 regex 的 matchAll 计数）——**不解析语义**、不判活体绑定/可达性。
    //     ⇒ 注释/字符串里**逐字写出该锚**会骗**高**（诚实件误红）；**语句式声明 / 改名 / 影子**会骗**低**。报文已按此改名。
    const g5delRe = /const prob = \(i, m\) => \{/g;
    const g5delSites = [...SELF_SRC.matchAll(g5delRe)];
    if (g5delSites.length !== 1 || !/countsReconcileProblems/.test(SELF_SRC.slice(g5delSites[0].index, g5delSites[0].index + 220))) {
      throw new Error(`FAIL: ⑮ 委派锚（**文本面**）未通过：prob 定义点文本命中 ${g5delSites.length} 处（须恰 1）且其 220 字窗口须含生产函数名——**本锚不判活体委派**（"探针未委派/假体/影子"由 ⑮ 组内「真跑计数」断言先报；实测四形态全过本锚（VERIFY-G8））——比较面在而比较不在＝拆闸门 ⇒ 红`);
    }
    const scope = i15 >= 0 && iTail > i15 ? SELF_SRC.slice(i15, iTail) : SELF_SRC;
    const cmpSites = (scope.match(/assert\(\s*prob\([^;]*?\)\s*\.length === \d+\s*,/g) || []).length;
    if (cmpSites !== EXPECT_CMP) {
      throw new Error(`FAIL: ⑮ 比较面被拆（严格比较点 ${cmpSites}/${EXPECT_CMP}）——比较被改弱（如 .length >= 0）/被搬走/调用被丢 ⇒ 拆比较面＝拆闸门 ⇒ 红`);
    }
  }
  console.log(`gate.mjs selftest：${g} 组断言全过 ✓（**运行时计数**：${g} 组 / ${n} 条断言；含 4 条反向用例 + ⑫ 守卫有效性 ×2 + ⑬ 合并组检查有效性 ×2 + ⑭ 独立重算有效性 ×2 + ⑮ 重级接线有效性 ×4 + ⑮ 用例执行见证 ×1 + ⑮ 生产件真跑计数 ×1 + ⑪ 附加守卫有效性 ×1 + ⑪ 剥区 ack ×1；⑧ 含 data_critical 布尔锁；键完整性＝行为级（存在性翻转 + 聚合面）且与生产接线同实现；读面探针＝诊断·非门禁）`);
}

// ── run：批量探针执行器（B 臂 W1 的正解件：把 N 次往返压成 1 次） ─────────────
function discoverProbes(paths) {
  const out = [];
  for (const p of paths) {
    const abs = resolve(p);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) {
      for (const f of readdirSync(abs).filter((x) => x.endsWith('.mjs')).sort()) out.push(join(abs, f));
    } else out.push(abs);
  }
  return out;
}

function doRun() {
  // 2026-10-15（GPT 复核❼）：原先只滤掉 `--flag` 本身，**标志的取值会被当作探针路径**（`run <dir> --out <dir2>` ⇒ dir2 也会被执行 ✗）。
  // ⇒ 显式声明"带值标志"，整对跳过；再把解析出来的输出目录从探针面剔除；被剔除者要点名（不静默）。
  // 2026-10-15（P3 审核反例）：原只跳过白名单里的带值标志 ⇒ **未知标志的取值会漏成路径**并被真执行 ✗
  // （`run ok.mjs --waive 'x=理由'` ⇒ `x=理由/evil.mjs` 进了 probes 并被运行）。现：run 只认白名单标志，**其余一律拒**。
  const VERDICT = ['--out', '--task', '--timeout', '--units', '--changed'];
  const paths = [];
  for (let i = 1; i < args.length; i += 1) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (!VERDICT.includes(a)) { console.error(`run 不认识的标志：${a}（run 只接受 ${VERDICT.join(' / ')}；未知标志一律拒，防其取值被当探针路径执行 ✗）`); process.exit(2); }
      // 2026-10-15（GPT 第二份·优先③）：**白名单标志的"取值"若本身是另一个标志** ⇒ 那是缺值，必须报错 ✗
      // （原实现 `--timeout --waive <目录>` ⇒ 把 `--waive` 当 timeout 的值吞掉，`<目录>` 就漏成了探针路径并被执行 ✗✗）。
      const val = args[i + 1];
      if (val === undefined || val.startsWith('--')) { console.error(`标志 ${a} 缺取值（下一个词是 ${val === undefined ? '行尾' : `另一个标志 ${val}`}）——不吞、不猜，直接拒`); process.exit(2); }
      i += 1;   // 跳过标志与其取值
      continue;
    }
    paths.push(a);
  }
  const dir = outDir(flag('task', 'task'), flag('out'));
  const outAbs = resolve(dir);
  const discovered = discoverProbes(paths.length ? paths : ['.']);
  const skipped = discovered.filter((p) => resolve(p).startsWith(outAbs));
  const probes = discovered.filter((p) => !skipped.includes(p));
  if (skipped.length) console.log(`⚠ 已剔除输出目录内的路径 ${skipped.length} 个（输出目录不得当探针）：${skipped.slice(0, 3).join(', ')}`);
  if (!probes.length) { console.error('用法：gate.mjs run <目录或文件…> [--out DIR] [--task NAME] [--timeout MS]'); process.exitCode = 2; return; }
  const timeoutMs = Number(flag('timeout', '120000'));
  const results = [];
  for (const f of probes) {
    const r = run([process.execPath, f], dirname(f), timeoutMs);
    const line = (s) => String(s ?? '').trim().split(/\r?\n/).filter(Boolean);
    results.push({
      file: f, ok: r.ok, ms: r.ms,
      exit: r.ok ? 0 : 1,
      stdout: line(r.out).slice(0, 40),
      tail: line(r.out).slice(-3),
    });
    process.stdout.write(`· ${f.split(/[\\/]/).pop()} ${r.ok ? 'PASS' : 'FAIL'} ${(r.ms / 1000).toFixed(1)}s\n`);
  }
  const failed = results.filter((x) => !x.ok);
  const body = [
    `# 批量探针结果 · ${results.length} 个（失败 ${failed.length}）`,
    `生成：${new Date().toISOString()}`,
    '',
    '| 探针 | 结果 | 耗时 | 末 3 行 |',
    '|---|---|---|---|',
    ...results.map((x) => `| ${x.file.split(/[\\/]/).pop()} | ${x.ok ? 'PASS' : 'FAIL'} | ${(x.ms / 1000).toFixed(1)}s | ${x.tail.join(' \\\\ ').replace(/\|/g, '\\|').slice(0, 300)} |`),
    '',
    '## 全量输出（按探针）',
    ...results.flatMap((x) => [`### ${x.file}（${x.ok ? 'PASS' : 'FAIL'} / ${(x.ms / 1000).toFixed(1)}s）`, '```', ...x.stdout, '```', '']),
  ].join('\n');
  writeFileSync(join(dir, 'probes.md'), body, 'utf8');
  writeFileSync(join(dir, 'probes.json'), JSON.stringify(results, null, 2), 'utf8');
  console.log(`批量完成：${results.length} 个探针，${failed.length} 失败（1 次往返）`);
  console.log(`产物：${join(dir, 'probes.md')} / probes.json`);
  process.exitCode = failed.length ? 1 : 0;
}

// ── fixture：探针模板（B 臂 W2：别再重敲沙箱咒语；test.mjs 里已有 20+ 处同款） ──
const FIXTURES = {
  'temp-store': `// 夹具：临时库（会话层）；只写 tmp，不碰真库
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as s from '${AKASHA.replace(/\\/g, '/')}/session.mjs';
const dir = mkdtempSync(join(tmpdir(), 'gate-fx-'));
const store = join(dir, 'session.jsonl'); const meta = join(dir, 'meta.json');
const rows = [{ id: 'seg-a-1-x', store: 'session', session: 'a', seq: 1, kind: 'conclusion', gist: '夹具', time: new Date().toISOString(), turn: 1, step: 1, keywords: [], tools: [], ptr: {}, logged_at: 'x' }];
writeFileSync(store, rows.map((r) => JSON.stringify(r)).join('\\n') + '\\n');
console.log('夹具就绪', store, typeof s.indexSession);
`,
  'mcp-probe': `// 夹具：MCP stdio 探针；env 里关掉 query-log
import { spawnSync } from 'node:child_process';
const ROOT = '${AKASHA.replace(/\\/g, '/')}';
const probe = [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })].join('\\n') + '\\n';
const r = spawnSync(process.execPath, [ROOT + '/mcp.mjs'], { cwd: ROOT, encoding: 'utf8', input: probe, maxBuffer: 1 << 26, env: { ...process.env, AKASHA_QUERY_LOG: 'off' } });
const tools = JSON.parse((r.stdout || '').trim().split(/\\r?\\n/)[0]).result.tools;
console.log('工具数', tools.length);
`,
  'cli-call': `// 夹具：CLI 只读调用（走真根；注意：空 AKASHA_ROOT 会被**有意拒绝**——「拒绝静默建空库」）
// 若你要测写命令：先在 tmp 下用 \`node akasha.mjs init\`（或复制六库空文件）建出合法根，再指 AKASHA_ROOT。
import { spawnSync } from 'node:child_process';
const r = spawnSync(process.execPath, ['${AKASHA.replace(/\\/g, '/')}/akasha.mjs', 'stats', '--json'], { encoding: 'utf8', maxBuffer: 1 << 26, env: { ...process.env, AKASHA_QUERY_LOG: 'off' } });
const out = (r.stdout || '').trim();
console.log('exit', r.status, out.slice(0, 120).replace(/\\n/g, ' '));
`,
};

function doFixture() {
  const kind = flag('kind');
  const dest = flag('file');
  if (!kind && !dest) {
    console.log('可用夹具种类：' + Object.keys(FIXTURES).join(' / '));
    console.log('用法：gate.mjs fixture --kind <kind> [--file 输出路径]');
    return;
  }
  if (!FIXTURES[kind]) { console.error('未知夹具：' + kind + '（可用：' + Object.keys(FIXTURES).join('/') + '）'); process.exitCode = 2; return; }
  const target = dest ? resolve(dest) : join(outDir(flag('task', 'task'), flag('out')), `probe-${kind}.mjs`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, FIXTURES[kind], 'utf8');
  console.log(`夹具已写：${target}（直接 node 跑，或用 gate.mjs run 批量跑）`);
}

// ── close：运行收口（把一次门档跑成"canon 就绪"的一段 + summary.md）────────────────
// 口径（2026-10-15 定，回应"状态进会话层段"这条待办）：**切片与运行态不入库**——会话层是对话的派生索引，
// 塞运行态会污染检索；设计只把**里程碑**落 canon（DESIGN-v2 §7）。故本命令只做"收口"：
// 读本次跑的产物 → 产 summary.md → 打印一段可直接喂 `akasha.mjs add --store canon` 的声明文本。
function doClose() {
  const task = flag('task', 'task');
  const dir = outDir(task, flag('out'));
  const rd = (f) => { try { return readFileSync(join(dir, f), 'utf8'); } catch { return null; } };
  const p0 = rd('p0.md');
  const esc = (() => { try { return JSON.parse(rd('escalate.json') ?? 'null'); } catch { return null; } })();
  const probesRaw = rd('probes.json');
  let probes = null;
  let probesBad = null;
  if (probesRaw !== null) {
    // 2026-10-18（GPT③ ② / 损坏 probes）：**存在但坏**不能退化成"没跑过"（旧实现 catch→null ⇒ 检查被跳过）。
    try { probes = JSON.parse(probesRaw); } catch { probesBad = '不可解析'; }
    if (probes !== null && !Array.isArray(probes)) { probesBad = '不是数组'; probes = null; }
  }

  // 2026-10-18（GPT③ ② / 格式化 FAIL）：旧实现只认字面 `| FAIL |` ⇒ `| **FAIL** |`、`|FAIL|`、
  //   `| FAIL（…） |` 都不计数（0 FAIL 假绿）。改为**按表格单元格取结果列**。
  const p0Cells = (p0 ?? '').split(/\r?\n/).filter((l) => l.startsWith('|')).map((l) => l.split('|').map((c) => c.trim()));
  const p0VerdictOf = (cells) => {
    const v = cells.slice(1).find((c) => /^\**\s*(PASS|FAIL|SKIP)\b/i.test(c));
    return v ? v.replace(/\*/g, '').trim() : '';
  };
  const p0VerdictRows = p0Cells.filter((cells) => p0VerdictOf(cells) !== '');
  const p0FailsN = p0 ? p0VerdictRows.filter((cells) => /^FAIL\b/i.test(p0VerdictOf(cells))).length : null;
  const p0Checks = p0 ? p0VerdictRows.length : null;
  // 2026-10-16（批次5 · 落地清单第 7 项 / 批次4 段C 复核 N1）：**豁免真落 summary** —— 原实现把"已记入 summary"
  // 提示打在 writeFileSync(summary) **之后** ⇒ summary.md 与本行下方"canon 就绪文本"里都 **0 命中**（"声称留痕"
  // 落空，唯留痕是终端 stdout）。现在先收集、写进 parts（⇒ 同时进 summary.md 与 canon 就绪文本），再打印。
  const waived = ['--no-audit', '--no-closure'].filter((f) => args.includes(f));
  const parts = [];
  parts.push(`任务 ${task}`);
  if (waived.length) parts.push(`⚠ 本次显式豁免：${waived.join(' / ')}（对应的检查**未做** ⇒ 不得当作"独立审核已做"/"同类站点已判定"）`);
  parts.push(p0 ? `P0 机检：${p0Checks ?? '?'} 项，${p0FailsN ?? '?'} 项 FAIL` : 'P0：未跑');
  if (probes) parts.push(`批量探针：${probes.length} 个，${probes.filter((x) => !x.ok).length} 个 FAIL`);
  if (esc) {
    parts.push(`升级判定：${esc.verdict}（A1 ${esc.counts?.a1 ?? 0} / A2 ${esc.counts?.a2 ?? 0}，切片 ${esc.counts?.slices ?? 0}）`);
    if (esc.certificate) parts.push(`自证包：完整=${esc.certificate.complete}（带证伪器 ${esc.certificate.withFalsifier}/${esc.certificate.slices}）`);
    if (esc.keyIntegrity) parts.push(`键完整性：rows ${esc.keyIntegrity.rows ?? '?'} / gaps ${Array.isArray(esc.keyIntegrity.gaps) ? esc.keyIntegrity.gaps.length : '?'} / 剥区空转 ${Array.isArray(esc.keyIntegrity.vacuous) ? esc.keyIntegrity.vacuous.length : '?'} / 收口一致=${esc.keyIntegrity.dedupConsistent} / 合并组 ${Array.isArray(esc.keyIntegrity.mergeGroups) ? esc.keyIntegrity.mergeGroups.length : '?'} 处（并组 ${esc.keyIntegrity.mergeGroupsPairs ?? '?'} / 重复行 ${esc.keyIntegrity.dupCount ?? '?'}） / 键外漂移 ${Array.isArray(esc.keyIntegrity.drift) ? esc.keyIntegrity.drift.length : '?'} 处`);
    if (esc.badLines?.length || esc.validationProblems?.length || esc.wiringProblems?.length) parts.push(`⚠ 输入问题：坏行（文件级）${esc.badLines?.length ?? 0} / 校验 ${esc.validationProblems?.length ?? 0} / 物理坏行 ${esc.validationProblemRows ?? '?'} / **接线级** ${esc.wiringProblems?.length ?? 0}`);
  }
  const summary = [
    `# 门档收口 · ${task}`,
    `生成：${new Date().toISOString()}`,
    '',
    ...parts.map((p) => `- ${p}`),
    '',
    '## 判据提醒',
    '- 放行＝无升级项 ∧ 自证包完整；否则 `invalid-input` / `unverifiable`（退出码 3）**不得报绿**。',
    '- 里程碑落 canon；**切片与运行态不入库**（见 DESIGN-v2 §7）。',
    '',
  ].join('\n');
  writeFileSync(join(dir, 'summary.md'), summary, 'utf8');
  const claim = `**门档跑（${task}，2026-10-15）**：${parts.slice(1).join('；')}。` +
    `判据与口径见 canon-thinkloop-gate-20261015 / canon-gate-v2-20261015；本次产物在 ${dir}（p0.md / escalate.json / summary.md）。`;
  console.log(summary);
  console.log('—'.repeat(60));
  // 2026-10-15（GPT 复核❼）：原先**无论 P0 是否 FAIL、输入是否 invalid、自证包是否完整，一律 exit 0 并照吐"canon 就绪文本"** ✗。
  // 现在先算"不得报绿"条件：P0 未跑 / P0 有 FAIL / escalate 判 invalid-input 或 unverifiable / 自证包不完整。（退出码：3＝不得报绿，1＝P0 FAIL，0＝可收口）
  const p0FailsN2 = p0FailsN ?? 0;
  const blockers = [];
  if (p0 === null) blockers.push('P0 未跑（无 p0.md ⇒ 没有任何已证事实）');
  else if (p0.trim() === '') blockers.push('P0 报告是**空文件**（＝P0 确实没跑；P3 审核反例：0 字节原判 exit 0 ✗）');
  else if (p0FailsN2) blockers.push(`P0 有 ${p0FailsN2} 项 FAIL`);
  // 2026-10-15（GPT 复核§4-4）：轨迹三件套——① 先反查起点快照是否存在（无它 ⇒ "三趟+独审跑没跑"不可证）；
  // ② 若在跑期间被审面/库发生漂移 ⇒ 单独点名（裁决绑定的是旧修订，这正是上轮我犯的错）；③ 独立审核结论 audit.md 必须存在（确无独审要用 --no-audit 显式声明）。
  const dataDir = process.env.AKASHA_ROOT ? String(process.env.AKASHA_ROOT) : join(AKASHA, 'data');
  const shaOf = (f) => { try { return createHash('sha256').update(readFileSync(f)).digest('hex').slice(0, 16); } catch { return null; } };
  let snap = null;
  try { snap = JSON.parse(readFileSync(join(dir, 'snap', 'manifest.json'), 'utf8')); } catch { snap = null; }
  if (!snap) blockers.push('缺 snap/manifest.json（起点只读快照 ⇒ 「三趟+独立审核到底跑没跑」无法证）');
  else {
    // 2026-10-18（GPT③ ② / 快照数据根）：p0 记了 dataDir，close 却用**当前** dataDir 去比对 ⇒ 换根后哈希不可比。
    if (snap.dataDir && resolve(String(snap.dataDir)) !== resolve(dataDir)) {
      blockers.push(`快照数据根与本次 close 不同源：snap=${snap.dataDir} / close=${dataDir}（库哈希对照不可比 ⇒ fail-closed）`);
    }
    const srcDrift = (snap.checks ?? []).filter((c) => c.sha256 && shaOf(c.file) !== c.sha256);
    const storeDrift = Object.entries(snap.stores ?? {}).filter(([n, h]) => h && shaOf(join(dataDir, n)) !== h);
    if (srcDrift.length || storeDrift.length) blockers.push(`审计面在跑期间**漂移**：源 ${srcDrift.length} / 库 ${storeDrift.length} 个（裁决绑定的是旧修订 ⇒ 该批结论需重跑）`);
  }
  const auditDoc = rd('audit.md');
  if (!auditDoc && !args.includes('--no-audit')) blockers.push('缺 audit.md（独立审核结论；确无独立审核时须用 --no-audit 显式声明）');
  else if (auditDoc) {
    // 2026-10-18（GPT③ ② / 占位文本）：只查"文件在"不够——空壳/TODO 也算没审。
    //   ⚠ 只用长度判据：占位**字面量**规则会误伤"描述该规则本身"的文档（本批 audit.md 实测被自己拦下 ✗）。
    if (auditDoc.trim().length < 200) blockers.push('audit.md 过短（<200 字符）⇒ 疑似占位，不构成独立审核结论');
  }
  // R2（2026-10-15）：**缺同类站点枚举表即判未收口**——治"改半边"。确有把握无需枚举时用 --no-closure 显式声明。
  const closureDoc = rd('closure.md');
  if (!closureDoc && !args.includes('--no-closure')) blockers.push('缺 closure.md（同类站点枚举表 ⇒ 无法证明"同类站点都已判定"，这正是"改半边"的入口）');
  else if (closureDoc && /未收口/.test(closureDoc)) blockers.push('closure.md 结论为**未收口**（仍有同类站点未判定）');
  else if (closureDoc && /未覆盖/.test(closureDoc)) blockers.push('closure.md 结论为**未覆盖**（0 个同类站点 ⇒ 模式/扫描根可疑，不构成收口）');
  // 2026-10-15（GPT 第二份复核·优先①）：**`probes.json` 明确失败时原先照样"✓ 可收口"** ✗ ——探针是"已跑过的事实"，
  // 有失败就等于有反例 ⇒ 必须拦（此前只在 escalate 里看升级项，探针结果被读了却没用 ✗）。
  if (Array.isArray(probes)) {
    const bad = probes.filter((p) => p && p.ok === false);
    if (bad.length) blockers.push(`probes.json 报 ${bad.length} 个探针失败（${bad.slice(0, 3).map((p) => String(p.file ?? p.cmd ?? '?')).join(', ')}${bad.length > 3 ? ' …' : ''}）⇒ 有失败探针不得报可收口`);
  }
  // 2026-10-18（GPT③ ② / 损坏 probes）：存在但坏 ≠ 没跑过——旧实现 catch→null 把这条检查整块跳过。
  if (probesBad) blockers.push(`probes.json 存在但${probesBad}（损坏/畸形 ⇒ fail-closed：不得当作"没有探针"跳过）`);
  // 2026-10-15（P3 审核 gate-code 最重一条）：原先**只拦 invalid-input/unverifiable**，对真实裁决 `needs-slow`（含真 A1 升级点）
  // **毫无约束** ⇒ 带升级点的批次照样 exit 0 + 吐 canon 文本，与它自己打印的「放行＝无升级项 ∧ 自证包完整」自相矛盾 ✗。
  // 现改 **fail-closed**：只有"无升级项 ∧ 自证完整"才算绿；缺字段/空对象/非绿态/自相矛盾 一律拦。
  const GREEN = new Set(['pass', 'green', 'ok']);
  if (!esc || typeof esc !== 'object' || Array.isArray(esc) || Object.keys(esc).length === 0) blockers.push('escalate 未跑或为空对象（无升级裁决 ⇒ fail-closed）');
  else {
    const v = String(esc.verdict ?? '');
    if (!v) blockers.push('escalate 缺 verdict 字段（fail-closed）');
    else if (!GREEN.has(v)) blockers.push(`escalate 判定 **${v}**（≠ 无升级项 ⇒ 该批不得报绿；needs-slow 须先走完慢层与独立审核）`);
    if (!esc.certificate || typeof esc.certificate !== 'object') blockers.push('escalate 缺 certificate（自证包完整性不可知 ⇒ fail-closed）');
    else if (esc.certificate.complete === false) blockers.push('自证包不完整（成果面 − 能力面未分离）');
    else if (esc.certificate.complete !== true) blockers.push('certificate.complete 非真值（fail-closed）');
    const nEsc = Array.isArray(esc.escalations) ? esc.escalations.length : 0;
    if (nEsc > 0 && GREEN.has(v)) blockers.push(`escalate 报 ${nEsc} 个升级项却判绿（自相矛盾 ⇒ fail-closed）`);
    // 2026-10-16（批次3 · 接线级 v2 的产物侧；与未决 U3「⑪ 自身无守护」合并）：**键完整性 fail-closed**——
    // 缺字段（＝检查被删/未跑）即拦；缺口或去重收口失效即拦。防"删掉守卫就当通过"：守卫的存在性由产物字段承载。
    if (!esc.keyIntegrity || typeof esc.keyIntegrity !== 'object' || esc.keyIntegrity.ran !== true) {
      blockers.push('escalate 缺 keyIntegrity.ran（接线级键完整性检查未跑或产物为旧版本 ⇒ fail-closed：不得"删掉检查当通过"）');
    } else {
      if (!Array.isArray(esc.keyIntegrity.gaps)) blockers.push('keyIntegrity.gaps 非数组（fail-closed）');
      else if (esc.keyIntegrity.gaps.length) blockers.push(`键完整性缺口 ${JSON.stringify(esc.keyIntegrity.gaps)}（判据敏感字段与生产键分不开 ⇒ 调换证据顺序即可吞升级项）`);
      if (esc.keyIntegrity.dedupConsistent !== true) blockers.push('去重未走单一收口函数（keyIntegrity.dedupConsistent≠true ⇒ 键回退/内联弱键 ⇒ fail-closed）');
      // 2026-10-16（批次6 · 段A-B）：**剥区灵敏度 fail-closed** —— `vacuous` 缺字段（＝自检未跑/旧产物）/ 非数组 /
      // 非空（有未 ack 的输出副本字段，其"只用于输出"验证是重言）一律拦。
      if (!Array.isArray(esc.keyIntegrity.vacuous)) blockers.push('keyIntegrity.vacuous 非数组（剥区灵敏度自检缺字段/未跑 ⇒ fail-closed：不得"删掉自检当通过"）');
      else if (esc.keyIntegrity.vacuous.length) blockers.push(`剥区灵敏度空转 ${JSON.stringify(esc.keyIntegrity.vacuous)}（"只用于输出"的验证对这些字段是重言 ⇒ 要么 ack + 写理由、要么移出 OUTPUT_FIELDS ⇒ fail-closed）`);
      // 2026-10-16（批次5 · 落地清单第 4 项 close 侧同步；批次4 段B 复核 §5.4）：**合并组检查 fail-closed** ——
      // 不加这三行，新检查就是"无守护"的：把调用或字段删掉，close 照旧放行 ⇒ 静默回到旧世界。
      if (!Array.isArray(esc.keyIntegrity.mergeGroups)) blockers.push('keyIntegrity.mergeGroups 非数组（合并组检查缺字段/未跑 ⇒ fail-closed：不得"删掉检查当通过"）');
      else if (esc.keyIntegrity.mergeGroups.length) blockers.push(`合并组判据不一致 ${JSON.stringify(esc.keyIntegrity.mergeGroups)}（同一生产键下的记录被判据区别对待 ⇒ 该键吞升级项）`);
      // 2026-10-16（批次6 · 段B-D5 / C-infoaudit）：**info 栏形态审计** —— bad 被写进 info 栏（换实现/手滑/伪装）
      // 原先即通过（close 只认 bad 栏，段B §3a `mgshift` 实测 exit 0）⇒ 这里要求 info 栏条目**不得含 `kind`**。
      // 2026-10-16（批次7 · D-2）：**info 栏缺失/非数组 ⇒ 拦** —— 批次6 复核 §2.5 实测：删 `mergeGroupsInfo` 或把它
      // 写成非数组时（`info-drop` / `info-nonarray` 格）D5 形态审计**静默**（0/绿；对照 `mergeGroups` 非数组＝拦）。
      // 与同批其它检查对齐：**缺失不是静默**（fail-closed，"删掉检查当通过"不成立）。
      if (!Array.isArray(esc.keyIntegrity.mergeGroupsInfo)) blockers.push('keyIntegrity.mergeGroupsInfo 非数组（info 栏缺失/被删 ⇒ fail-closed：不得"删掉检查当通过"）');
      else {
        const mis = esc.keyIntegrity.mergeGroupsInfo.filter((x) => x && typeof x === 'object' && ('kind' in x));
        if (mis.length) blockers.push(`keyIntegrity.mergeGroupsInfo 含"非 info 形态"条目（含 kind ⇒ bad 被写进 info 栏）⇒ 语义错位 ⇒ fail-closed`);
      }
      // 2026-10-16（批次6 · 段B-D1）：**检查有效性交叉核对** —— 有重复行（dupCount>0，说明去重真跑过、键真碰撞过）
      // 却没有任何并组（mergeGroupsPairs=0）⇒ 合并组检查的输入面错了（例如被改成传 `unique`）或被整块删掉。
      // 对照实测：段B `W-uiq/uniqstat`（传 unique）只由 needs-slow 拦；补上本行后多一条"合并组检查有效性"（正交）。
      if (Number(esc.keyIntegrity.dupCount) > 0 && !(Number(esc.keyIntegrity.mergeGroupsPairs) > 0)) {
        blockers.push('合并组检查有效性：存在重复行（dupCount>0）却没有任何并组（mergeGroupsPairs=0）⇒ 检查输入面错误/被删 ⇒ fail-closed');
      }
      // 2026-10-16（批次5 · 落地清单第 6 项；批次4 段C 复核 N5）：**3 行合理性不变量**（rows>0 ⇒ fields>0 ∧ pairs>0）——
      // 拦"半吊子削平"：守卫被换成恒空/早返回实现后，产物仍自称 ran:true 且 gaps:[]（C1 实测 rows=1/fields=0/pairs=0 全绿）。
      // 实测拦 C1 产物、对干净产物零误红（段C §3.4）。边界：**只防手滑，不防伪造**（深削平见产物侧 keyIntegrity 的注释）。
      if (Number(esc.keyIntegrity.rows) > 0 && (!(Number(esc.keyIntegrity.fields) > 0) || !(Number(esc.keyIntegrity.pairs) > 0))) {
        blockers.push(`keyIntegrity 计数不自洽（rows=${esc.keyIntegrity.rows} > 0 但 fields=${esc.keyIntegrity.fields} / pairs=${esc.keyIntegrity.pairs} ⇒ 守卫被削平成空壳 ⇒ fail-closed）`);
      }
      // 2026-10-16（批次6 · 段B-D2 / C-4）：**三数非负有限 + rows 与 counts.slices 一致** —— 上面的 3 行不变量入口是
      // `rows>0`，于是两个逃逸口漏过：`miss3`（三数**全缺** ⇒ 不进不变量 ⇒ exit 0）与 `zero0`（`rows=0, fields=9,
      // pairs=37, counts.slices=29` ⇒ 同样放行，连 C-3 都拦不住）。与同段其它检查的"非数组即拦"口径对齐：**缺失不是静默**。
      // 2026-10-16（批次7 · D-2）：**两个"检查有效性"计数同锁** —— 批次6 复核 §2.5 实测：删 `dupCount`（或 NaN/负）时
      // D1 交叉核对静默（`dup-drop` / `dup+pairs-drop` 两格 0/绿；对照 `dupCount=56 ∧ pairs=0` 拦）。计数缺失＝
      // "检查有效性"这层不可核 ⇒ fail-closed（与上面三数同口径，`dupCount=0` 合法、照过）。
      // 2026-10-16（批次8 · G2-2）：**五数并轨 + 严格类型** —— 批次7 复核 §4 实测：`Number(null)=0`、`Number('')=0`
      // ⇒ `dupCount:null ∧ mergeGroupsPairs:null`（或 `'0'` / `''`）可绕过上面两段（"缺失不是静默"被强转吃掉）。
      // 现口径统一：`typeof v === 'number' ∧ Number.isFinite(v) ∧ v ≥ 0`（合法产物两侧都是 JS number ⇒ 零误红；
      // `ok-clean`/`ok-zero` 实测不受影响）。
      for (const f of ['rows', 'fields', 'pairs', 'mergeGroupsPairs', 'dupCount']) {
        const v = esc.keyIntegrity[f];
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) blockers.push(`keyIntegrity.${f} 非非负有限数（=${String(v)} ⇒ 检查有效性计数缺失/被削平 ⇒ fail-closed）`);
      }
      // 2026-10-16（批次8 · G2-1③）：**重级接线的产物侧 fail-closed** —— 拆线（比较块恒假）在 escalate 面收不到
      // wiringProblems（因此产物 verdict 可以照旧 needs-slow），但产物字段仍带痕 ⇒ 这里拦：① 字段缺失/未跑（＝接线被整块
      // 摘掉）；② `problems>0`（接线自己算出的不一致没进 problems ⇒ 比较被绕）；③ **产物内两处记录互相矛盾**（独立实测值
      // vs mg 声明快照不一致 ⇒ 比较被换弱/被跳过）；④ 逐字镜像的典型形态＝`scanned` 缺失/与被扫面不符（"缺失不是静默"）。
      // ⚠ 残余（如实，不宣称封死）：**完整镜像**（把 mg 的 pairGroups/collapseKinds/scanned 全抄进 indep）自洽可过 ——
      //   文件内不可判；该格靠可观测性 + 外锚（`tools/review-lag.mjs` × `REVIEW-STAMP.json`）。
      {
        const cr = esc.keyIntegrity.countsReconcile;
        const num = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
        const arr = (v) => (Array.isArray(v) ? v.slice().sort().join(',') : null);
        if (!cr || typeof cr !== 'object' || cr.ran !== true) {
          blockers.push('keyIntegrity.countsReconcile 缺失/未跑（重级独立重算未接线 ⇒ fail-closed：不得"拆掉接线当通过"）');
        } else {
          if (!num(cr.problems)) blockers.push(`keyIntegrity.countsReconcile.problems 非非负有限数（=${String(cr.problems)} ⇒ 接线自查结论缺失/被削平 ⇒ fail-closed）`);
          else if (cr.problems > 0) blockers.push(`重级接线自报不一致 ${cr.problems} 条（keyIntegrity.countsReconcile.problems>0 却未进 wiringProblems ⇒ 比较被绕过 ⇒ fail-closed）`);
          if (!num(cr.pairGroups) || !num(cr.declaredPairGroups) || cr.pairGroups !== cr.declaredPairGroups) {
            blockers.push(`keyIntegrity.countsReconcile 碰撞组两处记录不一致（独立 ${String(cr.pairGroups)} vs 声明 ${String(cr.declaredPairGroups)} ⇒ 比较被换弱/被跳过 ⇒ fail-closed）`);
          }
          const ca = arr(cr.collapseKinds); const cd = arr(cr.declaredCollapseKinds);
          if (ca === null || cd === null) blockers.push('keyIntegrity.countsReconcile.collapseKinds/declaredCollapseKinds 非数组（塌陷种类两处记录缺失 ⇒ fail-closed）');
          else if (ca !== cd) blockers.push(`keyIntegrity.countsReconcile 塌陷种类两处记录不一致（独立 ${JSON.stringify(cr.collapseKinds)} vs 声明 ${JSON.stringify(cr.declaredCollapseKinds)} ⇒ fail-closed）`);
          if (!num(cr.scanned)) blockers.push(`keyIntegrity.countsReconcile.scanned 非非负有限数（=${String(cr.scanned)} ⇒ 独立重算的扫描面不可核（逐字镜像的典型形态）⇒ fail-closed）`);
          else if (cr.scanned !== esc.keyIntegrity.scannedRows) blockers.push(`keyIntegrity.countsReconcile.scanned=${cr.scanned} 与 keyIntegrity.scannedRows=${String(esc.keyIntegrity.scannedRows)} 不一致（同一输入面的两次扫描数必须相同）⇒ fail-closed`);
        }
      }
      if (Number(esc.counts?.slices) > 0 && !(Number(esc.keyIntegrity.rows) > 0)) {
        blockers.push(`keyIntegrity.rows=0 与 counts.slices=${esc.counts?.slices} 矛盾（去重后有记录却报 0 行 ⇒ 守卫被归零 ⇒ fail-closed）`);
      }
    }
  }
  // 豁免留痕（P3 审核触发；批次5 第 7 项修实现）：**已在上方写进 parts** ⇒ summary.md 与 canon 就绪文本都真含此行。
  if (waived.length) console.log(`⚠ 本次显式豁免：${waived.join(' / ')}（已记入 summary.md 与 canon 就绪文本，不得当作"独立审核已做"）`);
  if (blockers.length) {
    console.log(`⚠ **不得报绿**（${blockers.length} 条）：${blockers.join('；')}`);
    console.log('⇒ 下面的"canon 就绪文本"仅供参考，**不得当作里程碑落库**。');
    process.exitCode = p0FailsN ? 1 : 3;
  } else {
    console.log('✓ 可收口（P0 无 FAIL ∧ 自证包完整）');
  }
  console.log('canon 就绪文本（可直接：node akasha.mjs add --store canon --data \'{"id":"canon-gate-run-<日期>","claim":"…","source":{"type":"复现","ref":"…"}}\'）：');
  console.log(claim);
  console.log(`产物：${join(dir, 'summary.md')}`);
}

// ── briefs：生成 P1/P2/P3 的派单文本（趟级编排里"机械可做"的那一环）────────────────
// 口径（2026-10-15）：工具**不替宿主跑 agent**（各宿主能力不同）；它把"该怎么派"变成**现成文本**——
// 每个正交单元一份 P1 brief、升级项一份 P2 brief、一份 P3 独立审核 brief；判据/闭词表/锚点纪律全写进去，
// 使产出的 slices.jsonl 天然可被 `escalate` 机检。
function doBriefs() {
  const task = flag('task', 'task');
  const dir = outDir(task, flag('out'));
  const bdir = join(dir, 'briefs');
  mkdirSync(bdir, { recursive: true });
  const units = (flag('units') ? flag('units').split(',') : []).map((s) => s.trim()).filter(Boolean);
  const changed = flagAll('changed');
  const esc = (() => { try { return JSON.parse(readFileSync(join(dir, 'escalate.json'), 'utf8')); } catch { return null; } })();

  const common = [
    `## 铁律（每条都是踩过的）`,
    `- **只读被审对象**：绝不改它、绝不对真库写入（要试写入就用沙箱环境变量指向自己的临时目录）。`,
    `- 你的脚本只写在 \`${join(dir, 'runs')}\`；产物写在 \`${join(dir, 'slices')}\`。`,
    `- 每条结论**必须有你自己跑出来的证据**（复算/复跑/构造输入），不接受"读起来觉得"。`,
    `- 每条切片标 \`status\`（实证/推测/未决）与 \`reality_entry\`（theoretical/observed/reproduced）。`,
    `- **锚点必须带修订**：\`anchor\` 写文件:行，\`rev\` 写该文件 sha256 前 12 位——"审计→修复"一个来回后行号就会失效。`,
    ``,
    `## 切片格式（写成一行的 JSON，追加到 \`slices/<你的单元名>.jsonl\`）`,
    '```json',
    `{"id":"S1","unit":"<单元名>","claim":"（一条可证伪的指控）","quote":"（逐字原句，禁止转述）","anchor":"src/x.mjs:123","rev":"sha256:前12位","risk_class":"dataloss","status":"实证","reality_entry":"reproduced","data_critical":false,"falsifier":"（≤1 个探针：什么最小实验能让这条主张挂掉）"}`,
    '```',
    `- \`risk_class ∈\` **dataloss / silent-skip / false-green / coverage-gap / false-fix / crash / perf / docs / other**`,
    `- 闭词表**零容忍**：未知取值/缺字段会让裁决判 \`invalid-input\`（退出码 3，不得报绿）。`,
    `- **升级判据（供你自查，不必自己升级）**：实证 ∧ 非理论 ∧ (dataloss|silent-skip|false-green|false-fix|crash 或 coverage-gap∧data_critical) ⇒ 立即升级；**假绿一条即升**。`,
    `- 严重度不归你：你只出 \`risk_class\`。`,
  ].join('\n');

  const mk = (name, body) => { writeFileSync(join(bdir, name), body, 'utf8'); return name; };
  const made = [];

  // P1：每个正交单元一份
  const unitList = units.length ? units : ['unit-A', 'unit-B', 'unit-C'];
  for (const u of unitList) {
    made.push(mk(`p1-${u}.md`, [
      `# P1 快层派单 · ${task} · 单元 ${u}`,
      ``,
      `**预算 ≤3 分钟。** 你只负责**一个正交单元**（一个观察面），不要越界去查别的单元。`,
      ``,
      `## 你要做的`,
      `1. 读 \`${join(dir, 'p0.md')}\`（机检层给了：套件/校验/体检/扫描结果 + 六库快照 + 改动文件清单）；`,
      `2. 只读 P0 点名的那部分，**不要整仓通读**；`,
      `3. 对本单元负责的面，逐条产出**判别式**：一条"新代码 PASS ∧ 旧代码 FAIL"的**双向检查**（这是抓"假修复/假绿"的主力），`,
      `   或一条"改动面 × 覆盖面"的**差集检查**（抓零用例/漏测）；`,
      `4. 每条判据都要能**被一条命令跑出来**（写进 \`${join(dir, 'runs')}\`，用批量跑：\`node tools/gate.mjs run <你的目录>\`）。`,
      changed.length ? `\n## 本批改动文件\n${changed.map((f) => '- ' + f).join('\n')}` : '',
      ``,
      common,
      ``,
      `## 输出`,
      `- 切片 → \`${join(dir, 'slices', u + '.jsonl')}\``,
      `- 一句话小结（≤5 行）→ 你的回复`,
    ].join('\n')));
  }

  // P2：仅升级项
  made.push(mk('p2.md', [
    `# P2 慢层派单 · ${task}`,
    ``,
    `**只处理升级项**（不要重查全量）。`,
    esc && esc.escalations && esc.escalations.length
      ? `\n## 升级项（来自 \`escalate.json\`）\n${esc.escalations.map((e) => `- ${e.id}（${e.reason}）：${e.risk_class} — ${e.why}`).join('\n')}`
      : `\n## 升级项\n（\`escalate.json\` 尚未生成或为空——先跑：\`node tools/gate.mjs escalate --slices <你的 slices 目录>/*.jsonl --task ${task} --out <out>\`）`,
    ``,
    `## 你要做的`,
    `1. 对每个升级项**深挖到根因**（写探针、复现、重算、读全调用链——这一层允许慢）；`,
    `2. 同时做**对抗性复核**：主动去**证伪** P1 的每一条结论；`,
    `3. 结论落 \`${join(dir, 'verdict.json')}\`：\`{id, verdict: 确认|部分确认|证伪|无法判定, severity, evidence, fix}\`。`,
    ``,
    common,
  ].join('\n')));

  // P3：独立审核（只审判别式）
  made.push(mk('p3.md', [
    `# P3 独立审核派单 · ${task}`,
    ``,
    `**你是全新上下文、只读。你不为任何作者背书（包括 Lead）。**`,
    ``,
    `## 你要做的`,
    `1. **抽查 ≥20% 的双向检查**：亲跑它们，看是否真的"新 PASS ∧ 旧 FAIL"；`,
    `2. 只**审判别式**——**不要重做结论**；`,
    `3. 用**对抗性输入**试能不能骗过升级判据（例：把 \`dataloss\` 伪装成 \`perf\`、\`status=实证\` 但 \`reality_entry=theoretical\`、缺字段、闭词表外的取值）；`,
    `4. 给出"被推翻 / 降级"的结论清单，以及**你认为是漏项的**一条。`,
    ``,
    `## 工具`,
    `- \`node tools/gate.mjs selftest\`（判据自测）、\`node tools/gate.mjs escalate --slices …\`（复算升级裁决）`,
    ``,
    `## 输出`,
    `- 判定表 → \`${join(dir, 'audit.md')}\`（每条：结论 / 证据 / 判定）`,
    `- 被推翻清单 → 你的回复`,
  ].join('\n')));

  console.log(`已生成 ${made.length} 份派单文本 → ${bdir}`);
  for (const m of made) console.log('  ·', m);
}

// ── closure：同类站点枚举表（R2；2026-10-15 GPT 复核"已修只覆盖部分路径"触发）────────────────────
// 治的病：我的修法一直是"**按 grep 命中点改**"，而不是"枚举全部同类站点 → 逐个判定"⇒ "改半边"复发 6 次。
// 口径：本命令**不做判定**（判定权在人），只机械化**记账**——把同类站点全列出来，每个站点必须具备
// 「改了（--done）」或「明确不改 + 理由（--waive）」；**缺一项即判未收口**（退出码 3）。
// 用法：gate.mjs closure --task T --pattern <正则> [--pattern …] [--root DIR] [--done file.mjs:12] [--done file.mjs:30-44] [--waive "file.mjs:99=理由"]
function doClosure() {
  const task = flag('task', 'task');
  const dir = outDir(task, flag('out'));
  const root = resolve(flag('root', '.'));
  const patterns = flagAll('pattern').map((p) => new RegExp(p));
  const doneSites = flagAll('done').map(parseSite);
  const waives = new Map(flagAll('waive').map((w) => { const [site, why] = String(w).split('='); return [normSite(parseSite(site)), why || '（未写理由）']; }));
  // 批量豁免（2026-10-15 实测补）：整仓扫描会命中数百站点（426 个 ✗）⇒ 逐条 waive 不可用。
  // `--waive-pattern "<站点正则>=理由"` 按站点路径批量豁免，**理由必填**（豁免也要留痕，否则等于没判）。
  const waivePatterns = flagAll('waive-pattern').map((w) => {
    const i = String(w).indexOf('=');
    const src = String(w).slice(0, i);
    const why = String(w).slice(i + 1);
    if (!why) { console.error(`--waive-pattern 必须带理由（"路径正则=理由"）：${w}`); process.exit(1); }
    // 2026-10-15（P3 审核反例）：`.` / `.*` 这类模式会**一次豁免 100% 站点** ⇒ 等于没判 ✗。宁可拒绝，不要假收口。
    if (['.', '.*', '^.*$', '.+', '^.$'].includes(src.trim())) {
      console.error(`--waive-pattern 不得用"匹配全部"的模式（${src}）——那等于没判；要批量豁免请写具体的路径前缀正则`);
      process.exit(1);
    }
    return { re: new RegExp(src), why };
  });
  if (!patterns.length) { console.error('用法：gate.mjs closure --task T --pattern <正则> [--pattern …] [--root DIR] [--done file:line|file:a-b] [--waive "file:line=理由"]'); process.exitCode = 2; return; }

  const files = [];
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    // 2026-10-15（P3 审核同族）：扫错根原先直接抛 Node 栈 ✗ ⇒ 友好报错并要求显式确认（0 命中不得被当收口）。
    console.error(`--root 不是已存在的目录：${root}（扫错根会得到"0 命中"，那不是收口而是没覆盖）`);
    process.exit(2);
  }
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', 'gate-out', 'snap', '_rollback', '_scratch', '.git'].some((x) => e.name.includes(x))) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(mjs|js|ts)$/.test(e.name)) files.push(p);
    }
  })(root);

  // 2026-10-18（GPT③ ② / 全匹配豁免）：黑名单只挡了 5 个字面模式；`^`、`[a-z]`、`x*` 等同样能 100% 命中。
  //   改为**实测覆盖**：某条批量豁免若匹配扫描到的全部文件 ⇒ 等于没判，直接拒。
  const relOf = (f) => f.slice(root.length + 1).replace(/\\/g, '/');
  for (const w of waivePatterns) {
    if (files.length && files.every((f) => { w.re.lastIndex = 0; return w.re.test(relOf(f)); })) {
      console.error(`--waive-pattern 匹配了**全部 ${files.length} 个文件**（＝等于没判）：${w.re}`);
      process.exit(1);
    }
  }

  const rows = [];
  for (const f of files) {
    let text = '';
    try { text = readFileSync(f, 'utf8'); } catch { continue; }
    text.split(/\r?\n/).forEach((line, i) => {
      if (!patterns.some((re) => { re.lastIndex = 0; return re.test(line); })) return;
      const n = i + 1;
      const rel = relOf(f);
      // 2026-10-15（P3 审核反例，Lead 二次自查）：`endsWith` 两个版本都不够——`b/lib.mjs` 会命中 `lib.mjs`，
      // 连 `a/lib.mjs` 与 `b/lib.mjs` 也会互相命中 ✗。⇒ **只认精确相对路径**（调用方请写全 `tools/gate.mjs:12`）。
      const isDone = doneSites.some((s) => s.file && rel === s.file.replace(/\\/g, '/') && n >= s.from && n <= s.to);
      const waived = waives.get(`${rel}:${n}`) || waives.get(`${rel}:${n}-${n}`);
      const bulk = waivePatterns.find((w) => w.re.test(rel));
      rows.push({ site: `${rel}:${n}`, verdict: isDone ? '改了' : waived ? '明确不改' : bulk ? '明确不改' : '**未判定**', why: waived ?? (bulk ? `[批量] ${bulk.why}` : ''), code: line.trim().slice(0, 100) });
    });
  }
  const undecided = rows.filter((r) => r.verdict === '**未判定**');
  // 2026-10-15（P3 审核反例）：**0 命中不等于收口** ✗ —— 模式写错/扫错根都会"0 命中 ⇒ 已收口"，
  // 而 close 会采信它 ⇒ 假收口。现把 0 命中单列为「未覆盖」。
  const coverageEmpty = rows.length === 0;
  const verdictLine = coverageEmpty
    ? '## 结论：**未覆盖**（0 个同类站点——模式或扫描根可能写错；0 命中**不构成收口**）'
    : (undecided.length
      ? `## 结论：**未收口**（${undecided.length} 个同类站点未判定）\n每个站点必须给出「改了」或「明确不改+理由」——这正是"改半边"的机械拦断面。`
      : '## 结论：**已收口**（每个同类站点都有判定）');
  const body = [
    `# 同类站点枚举表（R2）· 任务 ${task}`,
    `生成：${new Date().toISOString()}　扫描根：${root}　模式：${flagAll('pattern').map((p) => '`' + p + '`').join(' / ')}`,
    '',
    `命中 **${rows.length}** 个同类站点：改了 ${rows.filter((r) => r.verdict === '改了').length} · 明确不改 ${rows.filter((r) => r.verdict === '明确不改').length} · **未判定 ${undecided.length}**`,
    '',
    '| 站点 | 判定 | 理由 | 代码 |',
    '|---|---|---|---|',
    ...rows.map((r) => `| ${r.site} | ${r.verdict} | ${r.why} | \`${String(r.code).replace(/\|/g, '\\|')}\` |`),
    '',
    verdictLine,
    '',
  ].join('\n');
  writeFileSync(join(dir, 'closure.md'), body, 'utf8');
  console.log(`同类站点 ${rows.length} 个（改了 ${rows.filter((r) => r.verdict === '改了').length} · 明确不改 ${rows.filter((r) => r.verdict === '明确不改').length} · 未判定 ${undecided.length}）`);
  // 2026-10-15（P3 审核同族·Lead 残留自查）：文档结论已改三态，但**控制台与退出码没跟着改** ✗ ——
  // 一次 0 命中运行里文档写「未覆盖」而终端仍打「✓ 已收口」、exit 0 ⇒ close 若读终端/退出码就被骗。
  // 此处与 verdictLine **同一判据**（三态），保证"文档 / 终端 / 退出码"三处一致。
  if (coverageEmpty) {
    console.log('⚠ **未覆盖**：0 个同类站点——模式或扫描根可能写错；0 命中**不构成收口**（不得据此报"已收口"）');
  } else if (undecided.length) {
    console.log(`⚠ **未收口**：${undecided.slice(0, 6).map((r) => r.site).join(', ')}${undecided.length > 6 ? ` …共 ${undecided.length}` : ''}`);
  } else {
    console.log('✓ 已收口');
  }
  console.log(`产物：${join(dir, 'closure.md')}`);
  if (coverageEmpty || undecided.length) process.exitCode = 3;
}
function parseSite(s) {
  const m = String(s).match(/^(.+?):(\d+)(?:-(\d+))?$/);
  return m ? { file: m[1], from: Number(m[2]), to: Number(m[3] ?? m[2]) } : { file: null, from: 0, to: 0 };
}
function normSite(s) { return `${s.file}:${s.from}${s.to !== s.from ? '-' + s.to : ''}`; }

if (cmd === 'p0') await doP0();
else if (cmd === 'escalate') doEscalate();
else if (cmd === 'slices-template') doTemplate();
else if (cmd === 'run') doRun();
else if (cmd === 'fixture') doFixture();
else if (cmd === 'briefs') doBriefs();
else if (cmd === 'closure') doClosure();
else if (cmd === 'close') doClose();
else if (cmd === 'selftest') doSelftest();
else {
  console.log('门档机械执行器（v1）。子命令：');
  console.log('  p0 [--task NAME] [--check FILE ...] [--out DIR]   机检：主套件/check/health/family-sweep/语法/六库快照');
  console.log('  escalate --slices FILE [--task NAME] [--out DIR]  升级判据 A1/A2 ⇒ escalate.json（可多文件）');
  console.log('  slices-template [--task NAME] [--out DIR]         切片空模板（含闭词表）');
  console.log('  run <目录或文件…> [--out DIR] [--timeout MS]      批量跑探针 ⇒ probes.md/json（1 次往返）');
  console.log('  fixture --kind <kind> [--file PATH]               夹具模板：' + Object.keys(FIXTURES).join('/'));
  console.log('  briefs --task NAME [--units a,b] [--changed F]     生成 P1/P2/P3 派单文本 ⇒ briefs/*.md');
  console.log('  close --task NAME [--out DIR]                     收口：summary.md + canon 就绪文本');
  console.log('  selftest                                          夹具自测（不碰真库）');
}
