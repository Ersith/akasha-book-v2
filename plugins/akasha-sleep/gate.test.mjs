// gate.test.mjs —— 门档触发判据（2026-10-15 落地）
// 规矩同其它套件：只测**顶层导出的纯函数**；生产路径与测试用的是同一个函数（不存在"测试一份、生产另一份"）。
import assert from 'node:assert';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// F（2026-10-16 batch6 修复）：本套件原先只传 `akashaDir` ⇒ 插件 DEFAULTS 的 log/stateFile/inboxFile
//   全部落**真家目录**（~/.akasha/logs/hooks.jsonl）：实测三套（gate/stateful/preflight）每跑一轮就往里
//   追加 25 行 sleep-armed —— 那个文件 2377 行里 1777 行 sleep-armed 就是这么积出来的。
//   修法两件：① 下面所有桩 cfg 走 cfgOf()，给全三路径；② 装载 lib/index.js **之前**把 AKASHA_DIR 指到
//   临时「陷阱目录」——将来哪次调用再漏路径，会先落这里，并被末尾那条守卫断言抓住（而不是又悄悄污染家目录）。
//   ⚠ DEFAULTS 在模块**求值时**读 AKASHA_DIR ⇒ 必须先设、后 import ⇒ 本套件改用动态 import。
const DEFAULT_TRAP = mkdtempSync(join(tmpdir(), 'gate-default-trap-'));
process.env.AKASHA_DIR = DEFAULT_TRAP;
// H4-E（2026-10-17 batch14）：陷阱目录**用毕即弃**（末尾 F 守卫读完就没用了）⇒ 进程退出时兜底清掉。
//   此前每跑一轮就在 %TEMP% 留一个 `*-default-trap-*` 空目录（batch13 清单实测：存量 255、单日 +134）。
// F-14-S6-1（2026-10-17 batch15）：原实现**只**清 DEFAULT_TRAP；`mkFix` 的 `gate-reg-*` 仅走 happy path
//   显式 rmSync ⇒ 断言失败 / 中途抛错即永久残留（化石 3 个：10-15 的 gate-reg-6pKCGN/iakSvX/kKDMWs）。
//   改为共用一条 exit 兜底清单（本件结尾只设 `exitCode` ⇒ 钩子必跑，与 preflight/stateful 同形态）。
const cleanupDirs = [DEFAULT_TRAP];
process.on('exit', () => { for (const d of cleanupDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 兜底失败不遮错误 */ } } });
const { gateTriggerOf, GATE_TRIGGERS } = await import('./lib/index.js');

/** 桩 cfg（照 route.test.mjs 同款）：三路径必须显式给全——漏一项就落 DEFAULTS = 真家目录。 */
const cfgOf = (dir, over = {}) => ({
  akashaDir: dir, log: join(dir, 'logs', 'hooks.jsonl'),
  stateFile: join(dir, 'state.json'), inboxFile: join(dir, 'inbox.jsonl'), ...over,
});

const pos = [
  ['帮我修个 bug', '代码'],
  ['写个脚本把数据抓一下', '代码'],
  ['改一下这个函数', '代码'],
  ['实现一下这个想法', '代码'],
  ['重构这块', '代码'],
  ['审计一下这批改动', '审计'],
  ['做一次独立审核', '审计'],
  ['复核一遍', '审计'],
  ['找我上次那个 bug 的根因', '审计'],
  // 2026-10-15 补（门档自审发现的漏网：最该挂的场景原本挂不上）
  ['对阿卡夏做一次全量检查吧', '审计'],
  ['全量检查一下', '审计'],
  ['排查一下这个异常', '审计'],
  ['做个整体复检', '审计'],
  ['体检一次', '审计'],
  ['审一下这批改动', '审计'],
  ['核对一下这两个数', '审计'],
  ['重建索引顺带搞', '迁移/不可逆'],
  ['把库紧凑化', '迁移/不可逆'],
  ['迁移到新格式', '迁移/不可逆'],
  ['把这个目录删掉', '迁移/不可逆'],
];
const neg = [
  '查代码：谁在解析 seg- id',
  '看代码里怎么写的',
  '代码在哪',
  '搜代码看看',
  '代码风格统一一下',      // 「统一」不是本判据的三类动作
  '今天天气如何',
  '版本号是多少',
  '把这段总结成三条',
  '',
  null,
];

let pass = 0; const fails = [];
// D7（2026-10-16 batch7，VERIFY-S2 §5-D7）：报红形态统一 —— 与 stateful `⑦` / preflight `F` 同款自建计数，
//   PASS/FAIL 行 + 末行汇总；不再用会盖掉汇总的裸 assert（详情见下方 F 守卫处的注释）。
const T = (name, cond, extra = '') => { if (cond) { pass += 1; console.log('  PASS ' + name); } else { fails.push(name + (extra ? '  ' + extra : '')); console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); } };
for (const [t, want] of pos) {
  const got = gateTriggerOf(t);
  if (got && got.cat === want) pass += 1; else fails.push(`正例「${t}」期望 ${want}，实得 ${JSON.stringify(got)}`);
}
for (const t of neg) {
  const got = gateTriggerOf(t);
  if (got === null) pass += 1; else fails.push(`负例「${t}」应不触发，实得 ${JSON.stringify(got)}`);
}
// 2026-10-15（GPT 复核 plugins N4/S3）：删除原**无条件** `pass += 2` —— 它虚增计数（打印 37，真实 35）；
// 后续每段均按实际断言数显式 +N ⇒ 现在打印值 = 实际断言数。

// ── 注册面（2026-10-15 补；plugins 单元指出：原先只测纯函数 gateTriggerOf ⇒ 对 context 注册面零覆盖，
//    这正是「哨兵传 null 导致本行永不出话」能长期活着的根因）────────────────────────────
{
  const { apply } = await import('./lib/index.js');

  const mkFix = (intentGists) => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-reg-'));
    cleanupDirs.push(dir);   // F-14-S6-1：失败/早退也清（下方 happy path 仍显式清，force ⇒ 幂等）
    mkdirSync(join(dir, 'data'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'data', 'session.jsonl'),
      intentGists.map((g, i) => JSON.stringify({ store: 'session', session: 's1', seq: i + 1, time: new Date().toISOString(), kind: 'intent', gist: g })).join('\n') + '\n', 'utf8');
    return dir;
  };
  const run = (cfg) => {
    const rows = [];
    const ctx = { systemPrompt: { context: (r) => rows.push(r) }, tools: { register() {}, guard() {} }, on() {}, logger: { info() {} }, config: cfg };
    apply(ctx, cfg);
    return { rows, row: (n) => rows.find((r) => r.name === n) };
  };

  // ① 命中"审计类"意图时，gate 行**必须出话**（未知会话 id ⇒ 走哨兵路径）
  const FIX1 = mkFix(['对系统做一次全量检查']);
  const r1 = run(cfgOf(FIX1, { gateHints: true }));
  const g1 = r1.row('akasha:gate');
  assert.ok(g1, '应注册 akasha:gate 行（已注册：' + r1.rows.map((r) => r.name).join(',') + '）');
  const t1 = g1 && g1.text();
  // 2026-10-15 契约改正（GPT 复核 plugins 段第 4 条；板上第 8 条）：**身份未知 ⇒ 不出话**。
  // 原断言写的是"未知会话 id 时也必须出话"✗——那会让哨兵落进"任意会话"分支，**被他会话的 intent 触发**。
  assert.equal(t1, '', '身份未知时不得出话（不得读他会话 intent）：' + String(t1));

  // ①b 2026-10-18（GPT③ ⑨）：**已知身份必须出话**。旧用例把 g1.text() 不带 context（＝未知身份）
  //   并断言静默 ⇒ 把生产回调改成"恒定不出话"仍 42/0（计数真实、错误未被拒绝）。
  const t1b = g1.text({ session: { id: 's1' } });
  assert.ok(typeof t1b === 'string' && t1b.includes('[门档]'), '已知会话命中触发词必须出话（不得恒定静默）：' + String(t1b));
  const hooksTxt = readFileSync(join(FIX1, 'logs', 'hooks.jsonl'), 'utf8');
  assert.ok(hooksTxt.includes('gate-reminder'), '出话同时必须落 gate-reminder 线：' + hooksTxt.slice(-120));

  // ② 同类 30 分钟去抖：第二次必须为 null
  const t2 = g1.text();
  assert.equal(t2, '', '同类 30 分钟内只提醒一次：' + String(t2));

  // ③ 不命中意图时静默
  const FIX2 = mkFix(['今天天气不错']);
  const r2 = run(cfgOf(FIX2, { gateHints: true }));
  assert.equal(r2.row('akasha:gate').text(), '', '非触发意图必须静默（不制造噪音）');

  // ④ gateHints:false ⇒ 不注册（提示与事件双停）
  const r3 = run(cfgOf(FIX1, { gateHints: false }));
  assert.ok(!r3.rows.some((r) => r.name === 'akasha:gate'), 'gateHints:false 时不得注册');

  for (const d of [FIX1, FIX2]) rmSync(d, { recursive: true, force: true });
  pass += 5;   // 2026-10-15 修正（plugins S3）：本段实为 5 条断言，原写 +4 ⇒ 自报少 1
}

// ── 跨组件 ID 约定（2026-10-15 · GPT 复核"带前缀会话下 gate/stateful 同时静默"；板上第 7 条）──
{
  const { latestIntentGist } = await import('./lib/index.js');
  const uuid = 'abcd1234-0000-1111-2222-333333333333';
  const mkText = (storedSession) => JSON.stringify({
    store: 'session', session: storedSession, seq: 1, kind: 'intent',
    gist: '把这批改动做一次全量检查', time: new Date().toISOString(),
  }) + '\n';
  // ① 核心存**裸** uuid（现行写入侧口径）＋宿主给**完整** ID ⇒ 必须命中（修前恒 null ✗）
  assert.ok(latestIntentGist(mkText(uuid), 'session-' + uuid), '裸存储 + 前缀查询 必须命中（跨组件 ID 约定）');
  // ② 反向：存完整、查裸 ⇒ 也必须命中
  assert.ok(latestIntentGist(mkText('session-' + uuid), uuid), '前缀存储 + 裸查询 必须命中');
  // ③ 精确优先不受影响（两边都完整时照旧）
  assert.equal(latestIntentGist(mkText('session-' + uuid), 'session-' + uuid), '把这批改动做一次全量检查', '精确匹配仍优先');
  // ④ 不得跨会话误配（Q06 语义必须保住）
  assert.equal(latestIntentGist(mkText('session-' + uuid), 'session-ffffffff-0000-0000-0000-000000000000'), null, '不同会话不得命中');
  pass += 4;
}

// ── 未知身份的哨兵契约（2026-10-15 · GPT 复核 plugins 段第 4 条）──────────────────────────
// 契约：**身份未知 ⇒ 不读任何会话的 intent、不出话**（宁缺勿错）；不得读"全库最后一条 intent"（会被他会话触发），
// 也不得让 unknown 与真实身份共用去抖桶。修前：哨兵传 `undefined` ⇒ `latestIntentGist` 走"任意会话"分支 ✗。
{
  const { latestIntentGist } = await import('./lib/index.js');
  const other = JSON.stringify({ store: 'session', session: 'other-session-uuid', seq: 1, kind: 'intent', gist: '把这份代码改一下', time: new Date().toISOString() }) + '\n';
  assert.equal(latestIntentGist(other, '(unknown)'), null, '未知身份不得读到他会话的 intent');
  assert.equal(latestIntentGist(other, undefined), '把这份代码改一下', '（对照）任意会话分支本身是合法能力，只许显式传入时使用');
  pass += 2;
}

// ── F 守卫（2026-10-16 batch6；2026-10-16 batch7 统一报红形态）：家目录零写入 ─────────────
// 本套件所有 apply() 都已跑完 ⇒ 陷阱目录必须**空**。非空 = 有调用漏了 log/stateFile/inboxFile（＝老毛病复发）。
// D7（batch7 · VERIFY-S2 §5-D7）：原为一条**裸 `assert.equal`**，在本文件自建计数之外 ⇒ 触发时是未捕获
//   AssertionError（带栈、盖掉末行汇总），与 stateful `⑦` / preflight `F` 的形态不一致。现改用本文件
//   T()（条件＝「陷阱目录条目数 === 0」；readdirSync 抛错＝目录都没建出来＝零写入）。
{
  let trapped = [];
  try { trapped = readdirSync(DEFAULT_TRAP); } catch { /* 目录都建不出来＝零写入 */ }
  T('F 家目录零写入（DEFAULTS 陷阱目录零写入）', trapped.length === 0, JSON.stringify(trapped));
}

console.log(`gate.test.mjs：${pass} 通过 / ${fails.length} 失败`);
if (fails.length) { for (const f of fails) console.log('  ✗ ' + f); process.exitCode = 1; }
