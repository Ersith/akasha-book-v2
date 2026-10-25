// route.test.mjs —— 每回合钩子的**路由契约**（2026-10-16 独立审 P1/P2/P4/P4b 的回归套件）
//
// 为什么存在（2026-10-16 审报告 `akasha/gate-out/gate-selffix/runs/audit-1016-batch5/seg-sleep/REPORT-S.md` §5）：
//   原套件没有任何断言盯着「钩子挂的事件宿主存不存在」⇒ `agent/turn-end`（宿主**不存在**该事件）的
//   死路由活了整整一版、四套用例全绿。本套件用**桩宿主**驱动：只发宿主真实会发的事件——
//   `session/event`（宿主按 **(session, event)** 两参发布；`turn/end` 的 data = { turn, reason }）。
//   注册面若退回死事件，A 段直接红；结果若退回**按会话分桶**，C/D 段（跨会话渲染）会红。
// 不碰真库：核心库（sleep.mjs / lib.mjs / json-redaction.mjs）拷进临时目录，插件只读写该目录；
//   review-lag 用**桩工具**（记数 + 打印 + 指定退出码），不调真工具。
// 运行：node route.test.mjs（退出码 0 = 全过）
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// F7（2026-10-16 batch8；依据 batch7 独立复核 VERIFY-S3 §5-F7）：**家目录零写入守卫** —— 模式照抄
//   gate/stateful/preflight 三套（它们早就有，route 此前没有）：
//   ① 装载 lib/index.js **之前**把 AKASHA_DIR 指到临时「陷阱目录」（DEFAULTS 在模块**求值时**读它
//      ⇒ 必须先设、后 import ⇒ 本套件改用动态 import）；
//   ② 末尾断言陷阱目录零写入：将来任一段漏 log/stateFile/inboxFile 会先落这里、被守卫抓住，而不是
//      又一次悄悄污染真家目录。batch8 复现（修前工作源 + 一段漏 `log:`）：套件仍打印 all assertions
//      passed，而家目录 `hooks.jsonl` 被追加 3 行 —— 见 landing/derived/run-f7-before。
const DEFAULT_TRAP = mkdtempSync(join(tmpdir(), 'route-default-trap-'));
process.env.AKASHA_DIR = DEFAULT_TRAP;
const { apply, reviewLagState, rawOfError } = await import('./lib/index.js');

const here = dirname(fileURLToPath(import.meta.url));
// 双布局（同 selftest）：oss 仓库 = <repo>/plugins/<pkg> ⇒ <repo>/core；工作源 = <LOCAL_PATH> ⇒ <LOCAL_PATH>
const CORE = existsSync(join(here, '..', '..', 'core', 'lib.mjs')) ? join(here, '..', '..', 'core') : join(here, '..', 'akasha');

const cleanupDirs = [];
process.on('exit', () => {
  for (const d of cleanupDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 兜底失败不遮错误 */ } }
});
// H4-E（2026-10-17 batch14）：DEFAULT_TRAP 此前**从未 push 进** cleanupDirs ⇒ 钩子在、陷阱目录照样漏。
//   守卫（末尾 F7）读完它就没用了 ⇒ 入清单，复用上面这条 exit 钩子清理。
cleanupDirs.push(DEFAULT_TRAP);

/** 桩目录：核心库三件 + 桩 review-lag 工具（counter 记次；exit=1 走"有滞后"预期路径）。 */
function mkStub(tag, { sessionLog = null, toolExit = 1, toolBody = null, toolBodyFn = null, noTool = false, invalidTool = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `sleep-route-${tag}-`));
  cleanupDirs.push(dir);
  mkdirSync(join(dir, 'logs'), { recursive: true });
  mkdirSync(join(dir, 'data'), { recursive: true });
  if (!(noTool && !invalidTool)) mkdirSync(join(dir, 'tools'), { recursive: true });   // noTool 且非 invalidTool 时故意不建
  for (const f of ['sleep.mjs', 'lib.mjs', 'json-redaction.mjs']) copyFileSync(join(CORE, f), join(dir, f));
  const counter = join(dir, 'ran.jsonl');
  const toolPath = join(dir, 'tools', 'review-lag.mjs');   // batch7-H：noTool / invalidTool 驱动换写入内容
  // invalidTool 优先：mkStub(..., { noTool: true, invalidTool: true }) 用来造「工具**文件不存在**」。
  //   ⚠ batch8·F3 更正措辞：这是**最贴近生产的「工具没装」形态**（node 起得来、在**模块解析**阶段失败
  //   ⇒ raw=1）；**不是** spawn 级失败——真 spawn 级要连可执行本体 / cwd 都找不到，本套件不造
  //   （本机也不可达：batch7 VERIFY-S3 §1.2 七种调用形态实测，`node <缺脚本>` 一律 status:1 / code=undefined）。
  if (invalidTool) {
    if (!noTool) writeFileSync(toolPath, 'this is not javascript (((\n', 'utf8');   // 语法错 => node 启动即失败
    // invalidTool 与 noTool 并存 => 不写任何文件（连 tools/ 目录都不建）：造「工具没装」形态（raw=1）
  } else if (!noTool) {
    // toolBodyFn(counter)：惰性构造（counter 已初始化）—— toolBody 字面量会在调用方**求值时机**引 counter 而 TDZ
    writeFileSync(toolPath, (toolBodyFn ? toolBodyFn(counter) : toolBody) || [
    "import { appendFileSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(counter)}, Date.now() + '\\n');`,
    "console.log('⚠ 审核面滞后：3 个面内核心件在审核戳之后被改过（REVIEW-STAMP.json（at=TEST））：');",
    "console.log('   · akasha/x.mjs —— 测试行');",
    `process.exit(${toolExit});`,
  ].join('\n'), 'utf8');
  }
  if (sessionLog) writeFileSync(join(dir, 'data', 'session.jsonl'), sessionLog, 'utf8');
  return { dir, counter, toolPath };
}

/** 桩宿主：捕获注册与 context 行（形状同 selftest 的桩 ctx）。 */
function mkHost() {
  const handlers = {}; const rows = [];
  const ctx = {
    on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); return () => {}; },
    effect(cb) { try { cb(); } catch { /* stub */ } return () => {}; },
    interval() { return () => {}; },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    systemPrompt: { context(c) { rows.push(c); return () => {}; } },
  };
  return { ctx, handlers, rows };
}

const cfgOf = (dir) => ({
  log: join(dir, 'logs', 'hooks.jsonl'), stateFile: join(dir, 'state.json'), inboxFile: join(dir, 'inbox.jsonl'),
  akashaDir: dir, minIntervalHours: 6, timerCheckMs: 3600000, contextOrder: 130, pulseOrder: 132,
});
const runs = (counter) => (existsSync(counter) ? readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean).length : 0);
// D（2026-10-16 batch6）：节流与结果提到**模块级**单例（真·进程级）⇒ 同一进程里多段用例会互相节流
//   （这不是缺陷，是单例本意）。测试复位让每段『立刻再触发一次』的断言仍有意义。
//   ⚠ batch8·F4 **钉死两个复位的用法**（依据 batch7 独立复核 VERIFY-S3 §5-F4）：
//     · `resetThrottle`（只复位 `at`）**只用于节流断言**（『节流期内同态不重复落线』那类）——
//       它**故意保留** `logged`；全复位会把那类断言变成『恒真』（值/logged 被清 ⇒ 必然再落一行）。
//     · 凡断言『**本段是否落线**』（rl.length / 首行内容）**一律用 `resetFull`** ——
//       否则本段的键若与前一段相同（两段都驱动「坏工具」⇒ 同为 `-1|1|`），本段会**零落线**、断言假红。
//       实测（batch8 landing/tools/probe-f4-detail.mjs）：同键前置 + 只复位 at ⇒ 0 行、`rl[0]` undefined
//       （读 `.code` 即 TypeError）；改 `resetFull` ⇒ 1 行。batch7 只改了 H 段（G 段仍只复位 at ⇒
//       段序耦合）；batch8·F4 把 A/B/C/D · F · G 三段『落线断言』前的复位一并改为 `resetFull`。
const resetThrottle = () => { reviewLagState.at = 0; };
const resetFull = () => { reviewLagState.at = 0; reviewLagState.value = null; reviewLagState.logged = null; reviewLagState.checkedAt = null; };
/** 宿主真实发布形状：**两参** (session, event)，event.type='turn/end'、data={turn,reason}。 */
const fireTurnEnd = (handlers, sid, turn) => {
  for (const fn of handlers['session/event'] || []) fn({ id: sid }, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
};
const hookLines = (dir, kind) => {
  const f = join(dir, 'logs', 'hooks.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter((l) => l.includes(`"kind":"${kind}"`)).map((l) => JSON.parse(l));
};
// F4（2026-10-17 batch18；依据 batch17 复核 VERIFY-S9 §6.1 F4）：**「工具没装」的 raw 判据按平台钉死**。
//   原来两处严格度不一：F8 那条（旧 :307，工具目录都不建）已 `win32 ? raw===1 : (1|'ENOENT')`；
//   而 2b 那条（旧 :340，工具目录在、脚本文件不在）**任何平台**都接受 `1 | 'ENOENT'` —— 同一个类
//   （node 起得来、模块解析阶段失败）两套标准 ⇒ 后者其实是**降级断言**（在 win32 上把"真因"放宽了）。
//   现在两处共用本判据；平台**可注入** ⇒ 可直测（`'ENOENT'` 只在 spawn 级出现，本机 win32 **运行时不可达**，
//   同 H+++ 对 `'-'` / `'SIG:x'` 的处理：不可达格只能直测分类器）。
//   齿（logs/b18-plates.json 的 M-F4）：删掉平台分支（`raw === 1 || raw === 'ENOENT'`）⇒ **只有**
//   `win32 + 'ENOENT'` 那格转红（.307/.340 的运行时断言仍绿 —— 本机 raw 本来就是 1 ⇒ 它们看不见这个变异）。
const rawIsToolMissing = (raw, platform = process.platform) =>
  (platform === 'win32' ? raw === 1 : (raw === 1 || raw === 'ENOENT'));
// batch8：pulse 取行/渲染两个小助手提到模块级（H 段与新 H+/H++ 段共用；渲染身份固定 session-H 与 H 段同款）
const pulseOf = (rows) => rows.find((r) => r.name === 'akasha:pulse');
const renderPulse = (rows) => String(pulseOf(rows).text({ agent: { session: { id: 'session-H' } } }));

// ══ A/B/C/D：注册面 + durable 路由 + 节流 + 显示行 + 状态变化观测线 ══════════════════════════
{
  const { dir, counter } = mkStub('ab');
  const { ctx, handlers, rows } = mkHost();
  resetFull();                             // F4：本段要断言『落了 1 行』（D 段 rl.length===1）⇒ 全复位
  apply(ctx, cfgOf(dir));

  // —— A. 注册面：死事件不得出现；durable 路由必须在 ——
  assert.ok(!Object.keys(handlers).includes('agent/turn-end'), '不得注册宿主不存在的事件 agent/turn-end（2026-10-16 死路由缺陷）');
  assert.ok((handlers['session/event'] || []).length >= 1, '必须注册 durable 路由 session/event');

  // —— C0（2026-10-16 batch6 补丁 C）：装载即查一次 ⇒ 重启后**第一回合**就带着结果 ——
  assert.equal(runs(counter), 1, '装载即查一次：apply() 返回时已跑过一次检查（否则要等第二回合才显示）');

  // —— B. 触发 + 60s 进程级节流（跨会话共享同一份） ——
  fireTurnEnd(handlers, 'session-A', 3);
  assert.equal(runs(counter), 1, '装载后 60s 内：turn/end 被节流挡住（不重复跑）');
  resetThrottle();                         // 复位节流，把"路由确实触发"与"节流确实挡住"分开断言
  fireTurnEnd(handlers, 'session-A', 3);
  assert.equal(runs(counter), 2, 'turn/end（durable 路由）必须触发一次检查');
  fireTurnEnd(handlers, 'session-A', 4);   // 同会话立刻再来 ⇒ 节流
  fireTurnEnd(handlers, 'session-B', 1);   // 另一会话立刻再来 ⇒ 同样节流（进程级单例）
  assert.equal(runs(counter), 2, '60s 节流必须挡住重复执行（跨会话也是同一份）');

  // 事件被真消费（不只"跑了个子进程"）：turn/end 的 data.turn 进轮次真值
  // F3（2026-10-17 batch18；依据 batch17 复核 VERIFY-S9 §6.1 F3）：**判据边界锚定**。
  //   渲染式是 `'轮=' + turn + ' 压缩='`（lib/index.js:917）⇒ 旧判据 `includes('轮=4')` 是**裸子串**，
  //   `轮=40…49` 一样通过（判据没锚在渲染式上 ⇒ 它证明的是"某个地方出现过 4"，不是"轮次=4"）。
  //   改为锚在**分隔空格**上的 `'轮=4 '`；并补紧邻的 `轮=40` 反格，要求**不**被命中。
  //   齿（本批 logs/b18-plates.json 的 M-F3）：把本判据改回 `'轮=4'` ⇒ **只有** `轮=40` 那格转红；
  //   M-F3p（产品侧：turn/end 不再写 obs.turn）⇒ 本行转红（正侧也有独立齿）。
  const TURN4 = '轮=4 ';                  // '轮=4' + 渲染式的分隔空格（' 压缩='）
  const ext = rows.find((r) => r.name === 'akasha:extreme');
  const extLine = String(ext && ext.text({ agent: { session: { id: 'session-A' } } }));
  assert.ok(extLine.includes(TURN4), 'turn/end 的 data.turn 必须进轮次真值（边界锚定 ' + JSON.stringify(TURN4) + '）：' + extLine);
  // F3 反格：同进程再发 turn=40 —— 轮次真值在**节流之前**更新（lib/index.js:545-546）⇒ obs.turn 照样进 40，
  //   而 review-lag 检查仍被 60s 节流挡住（下方 D 段 rl.length 不变，本格不制造新落线）。
  fireTurnEnd(handlers, 'session-A', 40);
  const ext40 = String(rows.find((r) => r.name === 'akasha:extreme').text({ agent: { session: { id: 'session-A' } } }));
  assert.ok(ext40.includes('轮=40 '), 'F3：turn=40 必须渲染成 `轮=40 `（分隔空格仍在）：' + ext40);
  assert.ok(!ext40.includes(TURN4), "F3 边界齿：`轮=40` **不得**被 `轮=4 ` 命中（旧 `includes('轮=4')` 在此为真 ⇒ 该格只咬边界宽度）：" + ext40);

  // —— C. 显示行：读**进程级单例**（渲染桶＝他会话也能显示）+ 去双前缀 + clip ——
  const pulse = rows.find((r) => r.name === 'akasha:pulse');
  const ptext = String(pulse.text({ agent: { session: { id: 'session-C' } } }));
  const lag = ptext.split('\n').find((l) => l.includes('审核面滞后'));
  // O1（2026-10-17 batch15）：显示行**前缀括号内**附检查时点「 · 检于 HH:MM」——判定/节流不变，只让"这结论是什么时候的"可见
  //   （原为精确相等断言，见 VERIFY-A4 §5-O1：60s 节流 + turn/end 驱动 ⇒ 旧结果会与实跑分歧；时点放头部⇒行尾 clip 截不掉）。
  // O1-b（2026-10-17 batch17；依据 VERIFY-S8 §7 O-1）：**把「日期可选」拆成两条严格正则** ——
  //   旧式 `/…检于 (?:\d{2}-\d{2} )?\d{2}:\d{2}）…/` 里日期是**可选**的 ⇒ 它自己**不带齿**
  //   （「恒带日期」的实现也能过），真正钉住「新鲜态不许带日期」的只剩下面 refStamp 等式，
  //   红点文案（"显示时点＝检查时点"）也看不出意图。现在两式各钉一侧 + 各配一条反向齿：
  //     · RE_FRESH：新鲜态 ⇒ 括号内**无**日期； · RE_DATED：跨日态 ⇒ 括号内**有**日期。
  //   齿（batch17 landing/logs/b17-plates.json 的 M0/M3）：stampOf 变异成「恒带日期」⇒ 本行 RE_FRESH 红；
  //   变异成「只给 HH:MM」⇒ 26h 那行 RE_DATED 红。
  const RE_FRESH = /^⚠ 审核面滞后（改了没审 · 检于 \d{2}:\d{2}）：3 件核心件在审核戳后被改$/;
  const RE_DATED = /^⚠ 审核面滞后（改了没审 · 检于 \d{2}-\d{2} \d{2}:\d{2}）：3 件核心件在审核戳后被改$/;
  assert.match(String(lag), RE_FRESH, '脉搏行（去双前缀 + 计数；新鲜态：括号内时点**不带日期**，渲染自他会话）：' + lag);
  assert.doesNotMatch(String(lag), RE_DATED, 'O1-b 反向齿（补 O-1 缺的那一侧）：新鲜态不得带日期：' + lag);
  assert.ok(lag.length <= 80, '行宽受 clip 约束（≤80 字）：' + lag.length);
  // 时点必须＝**检查时点**（不是渲染时点）：与单例同步、且为当天本地 HH:MM
  const cm = reviewLagState.checkedAt;
  assert.ok(Number.isFinite(cm) && Math.abs(Date.now() - cm) < 60000, 'O1：检查时点已随结果记录：' + cm);
  const pad2 = (x) => String(x).padStart(2, '0');
  // H4-D（2026-10-17 batch18；处置 VERIFY-S9 §6.2 的建议）：**测试侧 6h 常量收敛成一份**。
  //   原来有**两份**拷贝：refStamp 里的比较式（旧 :170）与 C2b 的格偏移（旧 :200 的 `SIX_H`）——
  //   同一个字面量两处写，改产品阈值时要想起来改三处。
  //   合并**不会**让格级探针失效（这是 §6.2 留的两选一里的"能安全合并"那一支），理由两条：
  //   ① 格级探针是**外部**脚本（`derived/*cells*`：直接 import 产品 lib/index.js、自造偏移），
  //      不读本常量 ⇒ 合并与它们无关；
  //   ② **本套件的齿来自 `RE_FRESH` / `RE_DATED` 两条语义锚定的格式正则**，不来自常量本身 ——
  //      把本常量改错时（logs/b18-plates.json 的 M-SIXH5 / M-SIXH7 两向实测）格点跟着常量一起移，
  //      移完的那一格就落在**另一侧**边界上 ⇒ 当场红（5h⇒C2b 首格红；7h⇒6h00m 格红），不是静默绿。
  //   反之，留两份的代价不是"多一层保护"，而是**误导性红点**：只改 refStamp 时红点落在 6h01m 格、
  //   文案指向"参考实现反算"，不指向真因（常量漂移）⇒ 交叉校验名义存在、指向错误。故合并。
  const SIX_H = 6 * 3600_000;             // 6h 显示阈值（与产品 lib/index.js:197 比较的是**同一个量**）
  // O1-b（2026-10-17 batch16）：参考实现独立于产品实现，规则同上（≥6h 补 MM-DD；严格 <6h 只给 HH:MM）。
  //   ⇒ 断言「显示串 ＝ 由 checkedAt 反算的串」在跨日时有齿：把 checkedAt 挪一天，期望串就变（见下 C2 段）。
  const refStamp = (ms) => {
    const d = new Date(ms);
    const t = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    return Date.now() - ms < SIX_H ? t : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${t}`;
  };
  assert.ok(lag.includes(` · 检于 ${refStamp(cm)}）`), 'O1：显示时点＝检查时点：' + lag);

  // —— D. P4b：状态变化落观测线（kind:'review-lag'），节流期内不重复 ——
  const rl = hookLines(dir, 'review-lag');
  assert.equal(rl.length, 1, '状态变化只落一行 review-lag 观测线：' + rl.length);
  assert.equal(rl[0].code, 1, '观测线带 code：' + JSON.stringify(rl[0]));
  assert.ok(String(rl[0].line).includes('审核面滞后'), '观测线带首行（截断）：' + JSON.stringify(rl[0]));

  // —— C2（2026-10-17 batch16 · O1-b）：**跨日时点必须带日期** ——
  //   把 checkedAt 挪到 26h 前（同一根因的最坏形态：今天 06:50 vs 明天 06:50 逐字相同）⇒ 渲染必须变 `MM-DD HH:MM`。
  //   断言有齿：① 格式正则**要求**日期；② 显示串＝参考实现反算；③ 再挪一天 ⇒ 期望串必不匹配（无齿会假绿）。
  const lagNow = String(pulse.text({ agent: { session: { id: 'session-C' } } })).split('\n').find((l) => l.includes('审核面滞后'));
  const cmDay = Date.now() - 26 * 3600_000;
  reviewLagState.checkedAt = cmDay;
  const lagDay = String(pulse.text({ agent: { session: { id: 'session-C' } } })).split('\n').find((l) => l.includes('审核面滞后'));
  assert.match(String(lagDay), RE_DATED, 'O1-b：跨日（26h 前）时点必须带日期：' + lagDay);
  assert.doesNotMatch(String(lagDay), RE_FRESH, 'O1-b 反向齿：跨日态不得只剩 HH:MM（旧可选式那一侧）：' + lagDay);
  assert.ok(lagDay.includes(` · 检于 ${refStamp(cmDay)}）`), 'O1-b：显示时点＝检查时点（跨日，参考实现反算）：' + lagDay);
  assert.ok(lagDay.length <= 80, 'O1-b：加日期后仍受 clip 约束（≤80）：' + lagDay.length);
  assert.ok(!lagDay.includes(` · 检于 ${refStamp(cmDay - 86400_000)}）`), 'O1-b：断言有齿（checkedAt 再挪一天 ⇒ 期望串不同）：' + lagDay);
  assert.ok(!/检于 \d{2}:\d{2}）/.test(lagDay), 'O1-b：跨日行不得只剩 HH:MM（旧格式必红）：' + lagDay);
  assert.ok(!!lagNow && lagNow.includes(` · 检于 ${refStamp(cm)}）`), 'O1-b：参照（新鲜 checkedAt）仍为 HH:MM：' + lagNow);

  // —— C2b（2026-10-17 batch17 · VERIFY-S8 §7 O-2）：**6h 阈值边界格**（此前套件只测 26h）——
  //   方向以**源码实际比较符**为准：`stampOf` 是 `Date.now() - ms < 6 * 3600_000 ? HH:MM : MM-DD HH:MM`
  //   （lib/index.js）⇒ **严格小于 6h 才无日期**，即「**≥ 6h 带日期**」——**6h00m 整归入带日期一侧**。
  //   齿（batch17 landing/logs/b17-plates.json 的 M5/M7 + 本批 b18-plates.json 的 M-6h00）：
  //   阈值改 5h ⇒ **只有** `5h59m` 格（C2b 首格）转红；阈值**放宽 30 s** ⇒ **只有** `6h00m` 格转红；
  //   阈值改 7h ⇒ **只有** `6h00m` 格转红（它现在排在 6h01m 之前；单独看 6h01m 同样咬阈值）。
  //   ⚠ 顺序说明（如实）：新增的 6h00m 格**前移**了 thr7 变异的红点（原 6h01m 格 → 现 6h00m 格）；
  //   两格对 thr7 都红，红点先后只由断言顺序决定，不影响任何一格自身的分辨力。
  //   `SIX_H` 见上方"6h 常量收敛"（唯一一份，refStamp 与 C2b 共用）。
  const lagAtMs = (ms) => {
    reviewLagState.checkedAt = ms;
    return String(pulse.text({ agent: { session: { id: 'session-C' } } })).split('\n').find((l) => l.includes('审核面滞后'));
  };
  const cm5h59 = Date.now() - (SIX_H - 60_000);          // 5h59m：阈值**内** 1 分钟 ⇒ 必须无日期
  const lag5h59 = lagAtMs(cm5h59);
  assert.match(String(lag5h59), RE_FRESH, 'C2b：5h59m（6h 阈值内 1 分钟）必须**无**日期：' + lag5h59);
  assert.ok(lag5h59.includes(` · 检于 ${refStamp(cm5h59)}）`), 'C2b：5h59m 显示时点＝参考实现反算：' + lag5h59);
  // F5（2026-10-17 batch18；依据 VERIFY-S9 §6.1 F5 + §3 格级矩阵）：**6h00m 整**独立成一格。
  //   复核的格级补测已确认它是「带日期」（产品 `<` ⇒ ≥6h 带日期），但套件此前只有 5h59m / 6h01m 两格，
  //   6h00m 整只由 6h01m **代表**（§6.1 F5 的点名缺口）。这一格把「比较符方向」与「整点归属」分开钉住：
  //   把阈值**放宽 30 s**（`6*3600_000 + 30_000` —— 很现实的"加个容差"改动）⇒ **只有本格**转红
  //   （5h59m 仍新鲜 ⇒ 首格绿；6h01m 仍 ≥ 阈值+30s ⇒ 带日期），见 logs/b18-plates.json 的 M-6h00。
  //   不抖动（构造法保证，不是"通常成立"）：`cm6h00 = Date.now() - SIX_H` ⇒ 渲染时产品**再取一次**
  //   `Date.now()`，elapsed = `SIX_H + δ`（δ ≥ 0，毫秒粒度下也可能正好 0）⇒ `elapsed < SIX_H` **恒假**
  //   ⇒ 恒带日期；参考实现用同一构造 ⇒ 期望串稳定。故不需要"毫秒级不可稳定构造"的豁免。
  const cm6h00 = Date.now() - SIX_H;                     // 6h00m 整：阈值**上**（≥ 侧）⇒ 必须带日期
  const lag6h00 = lagAtMs(cm6h00);
  assert.match(String(lag6h00), RE_DATED, 'C2b：6h00m 整（阈值边界上）必须带日期（源码是严格 <6h 才无日期）：' + lag6h00);
  assert.ok(lag6h00.includes(` · 检于 ${refStamp(cm6h00)}）`), 'C2b：6h00m 整 显示时点＝参考实现反算：' + lag6h00);
  const cm6h01 = Date.now() - (SIX_H + 60_000);          // 6h01m：阈值**外** 1 分钟 ⇒ 必须带日期
  const lag6h01 = lagAtMs(cm6h01);
  assert.match(String(lag6h01), RE_DATED, 'C2b：6h01m（6h 阈值外 1 分钟）必须带日期（方向：≥6h 带日期）：' + lag6h01);
  assert.ok(lag6h01.includes(` · 检于 ${refStamp(cm6h01)}）`), 'C2b：6h01m 显示时点＝参考实现反算：' + lag6h01);
  assert.ok(lag6h01.length <= 80, 'C2b：6h01m 加日期后仍受 clip 约束（≤80）：' + lag6h01.length);
  reviewLagState.checkedAt = cm;          // 复位：后续段各自 resetFull，别留脏值
}

// ══ E：gate-window-miss —— 10 分钟去重 + 真 size 字段 + unknown 闸 ══════════════════════════
{
  // 3000 行 ≈ 360 KB > 256 KiB 窗口；无任何 intent ⇒ 截断且未命中
  const line = JSON.stringify({ store: 'session', session: 'session-x', kind: 'tool', pad: 'y'.repeat(80) }) + '\n';
  const { dir } = mkStub('gate', { sessionLog: line.repeat(3000) });
  const { ctx, rows } = mkHost();
  apply(ctx, cfgOf(dir));
  const gate = rows.find((r) => r.name === 'akasha:gate');
  assert.ok(gate, 'akasha:gate 已注册');
  const ctxArg = { agent: { session: { id: 'session-TEST' } } };
  gate.text(ctxArg);
  gate.text(ctxArg);                                        // 立刻再渲染 ⇒ 10 分钟去重挡住
  gate.text({ agent: { session: { id: '(unknown)' } } });   // 未知身份 ⇒ 不落（V02 契约静默）
  const miss = hookLines(dir, 'gate-window-miss');
  assert.equal(miss.length, 1, '两次渲染 + 一次未知身份 ⇒ 只落 1 行（去重 + unknown 闸）：' + miss.length);
  const o = miss[0];
  assert.equal(o.windowBytes, 262144, '窗口字节数：' + o.windowBytes);
  assert.equal(o.fileBytes, statSync(join(dir, 'data', 'session.jsonl')).size, 'fileBytes 必须是**文件真大小**（不是读入字节数）：' + o.fileBytes);
  assert.ok(o.fileBytes > o.windowBytes, 'fileBytes 应大于窗口（真大小 > 256 KiB）：' + o.fileBytes);
  assert.equal(o.readBytes, 262144, 'readBytes 记读入字节数（截断时=窗口值）：' + o.readBytes);
}

// ══ F：“无滞后”也可见（P4b 的另一半：原实现成功/失败都不留痕）═══════════════════════════════
{
  const { dir, counter } = mkStub('ok', { toolExit: 0 });
  const { ctx, handlers, rows } = mkHost();
  resetFull();                             // F4：本段要断言『落了 1 行』（rl.length===1）⇒ 全复位
  apply(ctx, cfgOf(dir));
  assert.equal(runs(counter), 1, '装载即查一次（补丁 C）');
  resetThrottle();
  fireTurnEnd(handlers, 'session-A', 1);
  assert.equal(runs(counter), 2, 'durable 路由触发检查');
  const pulse = rows.find((r) => r.name === 'akasha:pulse');
  const ptext = String(pulse.text({ agent: { session: { id: 'session-A' } } }));
  assert.ok(!ptext.includes('审核面滞后'), '无滞后不得显示（exit 0 ⇒ 静默）：' + ptext);
  const rl = hookLines(dir, 'review-lag');
  assert.equal(rl.length, 1, '“无滞后”状态变化同样落一行（可事后核"它跑过"）：' + rl.length);
  assert.equal(rl[0].code, 0, '观测线 code=0：' + JSON.stringify(rl[0]));
}

// ══ G：“工具起不来”不得被当成「有滞后」（2026-10-16 复核 #4 / batch6 补丁 A）════════════════════
// 判据来源：`review-lag` 检查器**自身坏了**（脚本缺失 / 语法错 / 依赖缺失）时，node 的启动失败同样是
//   exit 1、且 **stdout 为空** —— 与"真有滞后"（工具**必打印首行** + exit 1）唯一干净的区分点就是
//   stdout 有无。修复前：这一路被显示成「⚠ 审核面滞后（改了没审）：有滞后（明细见 review-lag 输出）」
//   ⇒ 「检查器坏了」伪装成「检查发现有问题」。本段用**语法错的桩工具**把它钉住。
{
  const { dir, counter } = mkStub('broken', { toolExit: 1 });
  writeFileSync(join(dir, 'tools', 'review-lag.mjs'), 'this is not javascript (((\n', 'utf8');   // 语法错 ⇒ node 启动即 exit 1
  const { ctx, handlers, rows } = mkHost();
  resetFull();                         // F4（batch8）：本段要断言『落了 1 行』（rl.length===1）⇒ 全复位
  apply(ctx, cfgOf(dir));
  const pulse = rows.find((r) => r.name === 'akasha:pulse');
  const p1 = String(pulse.text({ agent: { session: { id: 'session-A' } } }));
  assert.ok(!p1.includes('审核面滞后'), '装载即查（坏工具）不得显示「有滞后」：' + p1);
  resetThrottle();                     // 这里只是**节流分离**（把路由触发与节流挡住分开断言）⇒ 保持只复位 at
  fireTurnEnd(handlers, 'session-A', 1);
  const p2 = String(pulse.text({ agent: { session: { id: 'session-A' } } }));
  assert.ok(!p2.includes('审核面滞后'), 'turn/end 路（坏工具）同样不得显示「有滞后」：' + p2);
  // 留痕仍在（可事后核"跑过"）：观测线 code:-1、line 空 —— 而不是伪装成 code:1 的"有滞后"
  const rl = hookLines(dir, 'review-lag');
  assert.equal(rl.length, 1, '坏工具只落一行观测线：' + rl.length);
  assert.equal(rl[0].code, -1, '起不来 ⇒ code:-1（不是 1）：' + JSON.stringify(rl[0]));
  assert.equal(rl[0].line, '', '起不来 ⇒ 显示面静默（line 空）：' + JSON.stringify(rl[0]));
  // batch7-D1（2026-10-16）：raw 记真因 —— 语法错 = node 语法检查失败 => 真实退出码 1（不再笼统记 -1）
  assert.equal(rl[0].raw, 1, 'D1：语法错的 raw = 真实退出码 1：' + JSON.stringify(rl[0]));
  // 对照：语法错的桩工具**根本没执行**（counter 不存在）⇒ 上两条不是"工具没被调用"造出来的假绿
  assert.equal(runs(counter), 0, '（对照）坏工具未被执行 ⇒ counter 无记录：' + runs(counter));
}

// H-D1-五驱动（2026-10-16 batch7；依据 batch6 复核 VERIFY-S2 section5 D1）------------
// 1.10.14 里 code:-1 同时承担「工具没装 / 语法错 / 超时 / 其它退出码」=> 事后审计无法区分。
//   batch7 给**非滞后态**加 raw（真因），code 仍只表达两态；去重键含 raw（原因不同各留一行）。
// 驱动：1 工具没装（文件不存在）2 语法错（node 启动即失败）3 超时（被杀）4 真滞后
//   5 其它退出码（exit 3，对照 —— 证明 raw 是**真退出码**而不是把一切压成 -1）。
//   batch8·F8：超时值已改为 **cfg 可注入**（`reviewLagTimeoutMs`，默认 5000）⇒ 本段用 1000 ms 实等，
//     语义不变（同一条 kill 路径），但不再让每次回归永久背 5 s（batch7 时 route 0.65 s → 6.4 s）。
{
  // 1) 工具没装（文件不存在、目录也不建）：**不是** spawn 级 ENOENT —— node 起得来、模块解析失败
  //    ⇒ status:1、stdout 空（batch8·F3 更正措辞 + batch7 VERIFY-S3 §1.2 实测：code=undefined）。
  {
    const { dir, counter } = mkStub('enoent', { noTool: true, invalidTool: true });   // 目录不建 ⇒ 最贴近生产的「没装」形态
    const { ctx, rows } = mkHost();
    resetFull();
    apply(ctx, cfgOf(dir));
    assert.ok(!renderPulse(rows).includes('审核面滞后'), '工具没装不得显示有滞后');
    const rl = hookLines(dir, 'review-lag');
    assert.equal(rl.length, 1, '工具没装只落一行：' + JSON.stringify(rl));
    assert.equal(rl[0].code, -1, '工具没装 => code:-1：' + JSON.stringify(rl[0]));
    // F8（batch8）：原断言 `raw !== -1` 恒真（code:-1 ⇒ raw 必带）= 等于没测。改为**按平台钉真值**：
    //   Windows 实测 raw=1（node 模块解析失败）；POSIX 未实测（若落 spawn 级字符串则接受 'ENOENT'）。
    // F4（batch18）：判据提到模块顶部 `rawIsToolMissing`（与 2b 那条共用一份，见其注释）。
    assert.ok(rawIsToolMissing(rl[0].raw),
      'D1：工具没装的真因进 raw —— Windows 实测=1（node 模块解析失败）；POSIX 未实测（或为 ENOENT 字符串）：' + JSON.stringify(rl[0]));
    assert.equal(rl[0].line, '', '工具没装 => line 空：' + JSON.stringify(rl[0]));
    assert.equal(runs(counter), 0, '（对照）工具文件不存在 => counter 无记录：' + runs(counter));
  }

  // 2) 语法错：node 启动即失败 => stdout 空（G 段同一路径；此处补 raw 以满足四驱动齐备）
  {
    const { dir } = mkStub('syntax', { invalidTool: true });
    const { ctx, rows } = mkHost();
    resetFull();
    apply(ctx, cfgOf(dir));
    assert.ok(!renderPulse(rows).includes('审核面滞后'), '语法错不得显示有滞后');
    const rl = hookLines(dir, 'review-lag');
    assert.equal(rl.length, 1, '语法错只落一行：' + JSON.stringify(rl));
    assert.equal(rl[0].raw, 1, 'D1：语法错的 raw = 真实退出码 1：' + JSON.stringify(rl[0]));
  }

  // 2b) 工具文件不存在、但目录在（最贴近生产的「工具没装」形态）：node 会**跑起来**，在模块解析阶段失败
  //     => status:1、stdout 空（**不是 spawn 级 ENOENT** —— batch7 VERIFY-S3 §1.2 七形态实测：
  //     error.code=undefined、status=1；'ENOENT' 只在**可执行本体 / cwd 找不到**时出现）。
  //     这条实证把 raw 的语义钉死：raw 数字 1 表示「工具被启动过但失败」，与 raw 字符串（spawn 级）不同。
  //     跨平台口径（如实，不写死）：Windows 实测 raw=1；POSIX 未实测（若为 spawn 级 ENOENT 字符串）
  //       => 判据 `rawIsToolMissing` 在 POSIX 侧接受两者（降级），**win32 侧只认 1**（F4，batch18）。
  {
    const { dir, counter } = mkStub('modmissing', { noTool: true });   // tools/ 目录在、文件不在
    const { ctx, rows } = mkHost();
    resetFull();
    apply(ctx, cfgOf(dir));
    assert.ok(!renderPulse(rows).includes('审核面滞后'), '工具没装不得显示有滞后');
    const rl = hookLines(dir, 'review-lag');
    assert.equal(rl.length, 1, '工具没装只落一行：' + JSON.stringify(rl));
    assert.equal(rl[0].code, -1, '工具没装 => code:-1：' + JSON.stringify(rl[0]));
    // F4（batch18）：本行此前"任何平台都接受两值"（比 1) 那条宽一档，同一个类两套标准）——
    //   现与 1) 共用 `rawIsToolMissing`（模块顶部）；该判据的 `win32 + 'ENOENT'` 格在 H+++ 段直测
    //   （本机运行时不可达：'ENOENT' 只在 spawn 级出现）。
    assert.ok(rawIsToolMissing(rl[0].raw), 'D1：工具没装的真因进 raw（win32 钉死 =1；POSIX 未实测，或为 ENOENT 字符串）：' + JSON.stringify(rl[0]));
    assert.equal(runs(counter), 0, '（对照）工具没被执行 => counter 无记录：' + runs(counter));
  }

  // 2c) 工具路径是**目录**（node 试图把目录当脚本读）：node 再次跑起来后失败（status:1 + stderr 有 ISDIR 类文本）
  //     —— 与 2b 同类（raw 数字 1），但显示面/判据必须同样静默。
  {
    const { dir, counter } = mkStub('isdir', { noTool: true });
    mkdirSync(join(dir, 'tools', 'review-lag.mjs'), { recursive: true });   // 同名**目录**占位
    const { ctx, rows } = mkHost();
    resetFull();
    apply(ctx, cfgOf(dir));
    assert.ok(!renderPulse(rows).includes('审核面滞后'), '目录占位不得显示有滞后');
    const rl = hookLines(dir, 'review-lag');
    assert.equal(rl.length, 1, '目录占位只落一行：' + JSON.stringify(rl));
    assert.equal(rl[0].code, -1, '目录占位 => code:-1：' + JSON.stringify(rl[0]));
    // 2026-10-17 复核（batch19 §6）：原句钉的是**平台特有值**——win32 下"同名目录占位"⇒ node 解析失败 ⇒ 退出码 1；
    //   POSIX 下同一场景 spawn 抛 EACCES（无退出码）⇒ raw 落 `-`。本机只有 win32，POSIX **未实测**。
    //   改法：断言**跨平台不变量**（绝不是 0＝不得被当成成功）+ **本平台精确值**；POSIX 侧只做形态断言并注明未实测。
    assert.notEqual(rl[0].raw, 0, '目录占位不得被当作成功（跨平台不变量；raw=0 才是"跑通了"）');
    if (process.platform === 'win32') {
      assert.equal(rl[0].raw, 1, 'WIN 实测：路径是目录 ⇒ 真实退出码 1：' + JSON.stringify(rl[0]));
    } else {
      // 2026-10-17 复核（VERIFY-PATCHES §③）：原来 else 分支写 `assert.equal(raw,'-')` —— **按 rawOfError 自己的
      //   优先级（status > code > signal > '-'）那格不可达**：POSIX 上"目录当工具路径"会让 node 起来后 exit 1；
      //   真 spawn 错误给的是 'EACCES' 而不是 '-'。⇒ 不产生假绿，但 POSIX 上**必假红**。
      //   改法：闭集形态断言（不猜具体值），并注明"本机未实测"。
      assert.ok([1, 'EACCES', 'ENOENT', '-'].includes(rl[0].raw), 'POSIX 未实测：只做闭集形态断言（可能是 1 或 EACCES）——' + JSON.stringify(rl[0]));
    }
    assert.equal(runs(counter), 0, '（对照）counter 无记录：' + runs(counter));
  }

  // 4) 真滞后：首行（stdout）+ exit 1 => code:1（显示面出话；D1 改动不得把它变静默）
  {
    const { dir, counter } = mkStub('lag', { toolExit: 1 });
    const { ctx, rows } = mkHost();
    resetFull();
    apply(ctx, cfgOf(dir));
    assert.ok(renderPulse(rows).includes('审核面滞后'), '真滞后必须显示（不能被 D1 改动吞掉）');
    const rl = hookLines(dir, 'review-lag');
    assert.equal(rl.length, 1, '真滞后只落一行：' + JSON.stringify(rl));
    assert.equal(rl[0].code, 1, '真滞后 => code:1：' + JSON.stringify(rl[0]));
    assert.equal(rl[0].raw, 1, 'D1：滞后态 raw 记真实退出码 1：' + JSON.stringify(rl[0]));
    assert.ok(String(rl[0].line).includes('审核面滞后'), '滞后态带首行：' + JSON.stringify(rl[0]));
    assert.equal(runs(counter), 1, '真滞后 => 工具确实执行过一次：' + runs(counter));
  }

  // 5) 其它退出码（exit 3）：raw 记 3 —— 修复前这一层信息被吞成 -1
  {
    const { dir, counter } = mkStub('exit3', { toolBodyFn: (c) => [
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync(" + JSON.stringify(c) + ", Date.now() + '\\n');",   // JSON.stringify：Windows 反斜杠路径必须转义
      'process.exit(3);',
    ].join('\n') });
    const { ctx, rows } = mkHost();
    resetFull();
    apply(ctx, cfgOf(dir));
    assert.ok(!renderPulse(rows).includes('审核面滞后'), 'exit 3 不得显示有滞后');
    const rl = hookLines(dir, 'review-lag');
    assert.equal(rl.length, 1, 'exit 3 只落一行：' + JSON.stringify(rl));
    assert.equal(rl[0].code, -1, 'exit 3 => code:-1：' + JSON.stringify(rl[0]));
    assert.equal(rl[0].raw, 3, 'D1：raw 记真实退出码 3：' + JSON.stringify(rl[0]));
    assert.equal(runs(counter), 1, '（对照）桩工具确实执行过：' + runs(counter));
  }

  // 3) 超时（**cfg 注入 1000 ms**，F8）：工具挂住 => execFileSync 在 timeout 处杀掉（status 为 null、error.code=ETIMEDOUT）
  {
    const { dir, counter } = mkStub('timeout', { toolBodyFn: (c) => [
      "import { appendFileSync } from 'node:fs';",
      "appendFileSync(" + JSON.stringify(c) + ", 'started\\n');",
      'const t0 = Date.now(); while (Date.now() - t0 < 30000) { /* 挂住 */ }',
    ].join('\n') });
    const { ctx, rows } = mkHost();
    resetFull();
    apply(ctx, { ...cfgOf(dir), reviewLagTimeoutMs: 1000 });   // F8：超时值可注入（默认 5000）——不再每次回归实等 5 s
    assert.ok(!renderPulse(rows).includes('审核面滞后'), '超时不得显示有滞后');
    const rl = hookLines(dir, 'review-lag');
    assert.equal(rl.length, 1, '超时只落一行：' + JSON.stringify(rl));
    assert.equal(rl[0].code, -1, '超时 => code:-1：' + JSON.stringify(rl[0]));
    assert.equal(rl[0].raw, 'ETIMEDOUT', 'D1：超时的真因进 raw：' + JSON.stringify(rl[0]));
    assert.equal(runs(counter), 1, '（对照）桩工具确实启动过（被杀前已写下 started）：' + runs(counter));
  }
}

// H+（2026-10-16 batch8 · F8；依据 batch7 独立复核 VERIFY-S3 §5-F8）：**把 D1 的收益钉住** ------------
// ① 键变更靶心：同一桩目录里驱动两个**不同 raw** 的状态（语法错 raw=1 → exit 3 raw=3；两者 code 与
//    line 完全相同：-1 / ''）⇒ 必须**各落一行**。中间**只复位 at**（保留 logged）⇒ 断言的正是「键含
//    raw」这件事本身（若把 raw 从键里去掉，本条立刻红；BEFORE 1.10.14 行为＝1 行，旧行被吞）。
// ② 同态重跑（仍只复位 at）⇒ 仍 2 行：键变更**不得**引入「同态重复落线」。
{
  const { dir, counter } = mkStub('keychange', { toolExit: 3 });
  const body3 = readFileSync(join(dir, 'tools', 'review-lag.mjs'), 'utf8');
  // 态 A：语法错（工具起不来 ⇒ raw=1、line 空）
  writeFileSync(join(dir, 'tools', 'review-lag.mjs'), 'this is not javascript (((\n', 'utf8');
  {
    const { ctx } = mkHost();
    resetFull();
    apply(ctx, cfgOf(dir));
    const rl = hookLines(dir, 'review-lag');
    assert.equal(rl.length, 1, '态A（语法错）落 1 行：' + JSON.stringify(rl));
    assert.equal(rl[0].raw, 1, '态A raw=1：' + JSON.stringify(rl[0]));
  }
  // 态 B：换回 exit 3（工具真跑过 ⇒ raw=3）——只复位 at ⇒ logged 仍是 `-1|1|`
  writeFileSync(join(dir, 'tools', 'review-lag.mjs'), body3, 'utf8');
  {
    const { ctx } = mkHost();
    resetThrottle();
    apply(ctx, cfgOf(dir));
    const rl = hookLines(dir, 'review-lag');
    assert.equal(rl.length, 2, 'F8 靶心：同 code 不同 raw ⇒ 各留一行（键含 raw）：' + JSON.stringify(rl));
    assert.deepEqual(rl.map((r) => r.raw), [1, 3], '两行 raw 依次 = 1 / 3：' + JSON.stringify(rl));
    assert.equal(runs(counter), 1, '（对照）exit 3 桩确实执行过一次：' + runs(counter));
  }
  // 态 B 重跑（仍只复位 at）⇒ 同键 ⇒ 不新增第三行
  {
    const { ctx } = mkHost();
    resetThrottle();
    apply(ctx, cfgOf(dir));
    const rl = hookLines(dir, 'review-lag');
    assert.equal(rl.length, 2, '同态重跑不得新增落线（键去重仍生效）：' + JSON.stringify(rl));
  }
}

// H++（batch8 · F8）：**stderr-滞后**（D3 契约破坏面）——判据只认 **stdout** 首条非空行。
//   真滞后若改走 stderr ⇒ 被判成「工具起不来」：显示面静默、观测线 code:-1 + line 空（raw 仍是真退出码 1）。
//   本条把「改输出通道＝改契约」钉死在测试里：将来谁把工具首行挪到 stderr，这里红 —— 那正是要**同批改判据**
//   的信号（不是本条错了）。现状符合契约：真工具 `akasha/tools/review-lag.mjs` 首行走 console.log。
{
  const { dir, counter } = mkStub('stderronly', { toolBodyFn: (c) => [
    "import { appendFileSync } from 'node:fs';",
    "appendFileSync(" + JSON.stringify(c) + ", Date.now() + '\\n');",
    "console.error('⚠ 审核面滞后：3 个面内核心件在审核戳之后被改过（REVIEW-STAMP.json（at=TEST））：');",
    'process.exit(1);',
  ].join('\n') });
  const { ctx, rows } = mkHost();
  resetFull();
  apply(ctx, cfgOf(dir));
  assert.ok(!renderPulse(rows).includes('审核面滞后'), 'stderr-滞后不得显示（判据只认 stdout；见 D3 契约）');
  const rl = hookLines(dir, 'review-lag');
  assert.equal(rl.length, 1, 'stderr-滞后只落一行：' + JSON.stringify(rl));
  assert.equal(rl[0].code, -1, 'stderr-滞后 ⇒ code:-1（被判成起不来）：' + JSON.stringify(rl[0]));
  assert.equal(rl[0].raw, 1, 'raw 仍是真退出码 1：' + JSON.stringify(rl[0]));
  assert.equal(rl[0].line, '', 'stderr-滞后 ⇒ line 空（显示面静默）：' + JSON.stringify(rl[0]));
  assert.equal(runs(counter), 1, '（对照）工具确实执行过一次：' + runs(counter));
}

// H+++（batch8 · F6/F8；batch10 · F-S4-2 去重）：**raw 分类格直测** —— 只留 H 段（集成路）**测不到**的格：
//   · 本机不可达格：`'-'` 兜底 / `'SIG:<name>'` / `'ENOENT'`（实测：SIGKILL 自尽落 status=1；脚本缺失落 status=1）；
//   · 类型守卫格：`status:0`（合法退出码，防真假陷阱）/ 非数字 status / 非字符串 code —— 集成路永远产不出这三种形状。
//   ⚠ F-S4-2 去掉了三条**与集成路重复**的断言（`{status:3}` / `{code:'ETIMEDOUT'}` / `{code:'ETIMEDOUT',signal:'SIGTERM'}`）：
//     它们分别由 H-5（exit 3 ⇒ raw 3）与 H-3（超时 ⇒ raw 'ETIMEDOUT'；超时真实形状同时带 code+signal）驱动；
//     实测「signal 提前于 code」的变异在 **H-3 处当场红**（batch10 landing/probe-F-S4-2-teeth.out.txt 状态 M0）
//     ⇒ 留着只增行数、不增分辨力。反之，新三条各能被一个**别处抓不到**的变异打红（同文件 M1/M2/M3）。
//   （`rawOfError` 是生产路径用的同一份实现；见 lib/index.js 注释。）
{
  // —— 类型守卫格（每条一个独立变异；集成路不产 status=0 / 非数字 status / 非字符串 code）——
  assert.equal(rawOfError({ status: 0 }), 0, 'F6：0 是合法退出码 —— 防真假陷阱（`e.status ? …` 会把 0 吃掉；集成路不产 status=0）');
  assert.equal(rawOfError({ status: '3' }), '-', "类型守卫严：字符串 status 不算数字退出码（`!= null` 判法会吐 '3'）");
  assert.equal(rawOfError({ code: 42, signal: 'SIGKILL' }), 'SIG:SIGKILL', '类型守卫严：非字符串 code 不得当原因 ⇒ 落 signal 格（`e.code ? …` 判法会吐 42）');
  // 2026-10-17 复核（VERIFY-PATCHES §③）补的直测：POSIX 上"目录当工具路径"更可能是 **spawn 错误 'EACCES'**
  //   （而不是 raw='-'）。上一格（:410 附近）的 else 分支原来等值断言 '-'，按 rawOfError 自己的优先级不可达 ⇒ 必假红。
  assert.equal(rawOfError({ status: null, code: 'EACCES' }), 'EACCES', "POSIX 真形状：spawn 错误落 code 格（'EACCES'），不是 '-'");
  assert.equal(rawOfError({}), '-', "兜底仍是 '-'（空 error）——与 'EACCES' 区分开");
  // —— F4（batch18）：**「工具没装」判据的平台钉死格**（平台注入 ⇒ 可直测；两处运行时断言在 win32 上
  //    都只能看到 raw=1，看不见"平台分支被删掉"这个变异 ⇒ 必须在这里直测。同 H+++ 对 '-' / 'SIG:x' 的处置）。
  assert.equal(rawIsToolMissing(1), true, 'F4：数字退出码 1 两平台都接受（node 模块解析失败的真实形状）');
  assert.equal(rawIsToolMissing('ENOENT', 'win32'), false, "F4 边界齿：**win32 上不得接受 'ENOENT'**（旧宽松式在此为真 ⇒ 该格只咬平台钉死）");
  assert.equal(rawIsToolMissing('ENOENT', 'linux'), true, "F4：POSIX 未实测 ⇒ 保留 'ENOENT' 兜底（如实标注为降级断言，不是钉死）");
  // —— 本机不可达格（产不出来，只能直测分类器）——
  assert.equal(rawOfError({ status: null, code: 'ENOENT' }), 'ENOENT', "spawn 级字符串格（'ENOENT'；本机不可达格）");
  assert.equal(rawOfError({ status: null, signal: 'SIGKILL' }), 'SIG:SIGKILL', 'F6：信号杀记 SIG:<name>（code 缺失时；POSIX；本机不可达格）');
  assert.equal(rawOfError({ status: 1, signal: 'SIGKILL' }), 1, '有数字退出码时仍以退出码为准（Windows 现状不变）');
  assert.equal(rawOfError({}), '-', "'-' 兜底格（本机不可达）");
}

// ── F 守卫（2026-10-16 batch8 · F7；依据 batch7 独立复核 VERIFY-S3 §5-F7）：**家目录零写入** ──────
// 5 套里 gate / stateful / preflight 早有这条（陷阱目录 + 末置零写入断言），route 此前没有 ⇒ 将来任一段
//   漏 `log:` 会**直写真家目录且无断言**（batch8 复现：漏 log 一段 + 修前工作源 ⇒ 套件仍打印
//   all assertions passed，而家目录 hooks.jsonl 被追加 3 行；见 landing/derived/run-f7-before）。
// 报红形态与另三套同款：`FAIL …` 行 + 末行汇总（不让守卫沉在未捕获的 assert 栈里）。
// ⚠ 计数只覆盖本守卫（T() + pass/fails）——本文件其余断言仍走 assert（不改既有语义）。
let pass = 0; const fails = [];
const T = (name, cond, extra = '') => { if (cond) { pass += 1; console.log('  PASS ' + name); } else { fails.push(name + (extra ? '  ' + extra : '')); console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); } };
{
  let trapped = [];
  try { trapped = readdirSync(DEFAULT_TRAP); } catch { /* 目录都建不出来＝零写入 */ }
  T('route 家目录零写入（DEFAULTS 陷阱目录零写入）', trapped.length === 0, JSON.stringify(trapped));
}
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f);
  console.log(`route.test.mjs：${pass} 通过 / ${fails.length} 失败（F7 零写入守卫）`);
  process.exitCode = 1;
} else {
  console.log('route.test.mjs: all assertions passed（含 F7 零写入守卫：陷阱目录零写入 ✓）');
}
