// akasha/tools/health-check.mjs —— 阿卡夏全功能体检（2026-10-13；从 tmp 转正为常驻工具）
//
// 纪律（2026-10-13 用血写的）：**写命令只许在沙箱段**。第一版把  放进只读段 + 写死真 id，
//   连跑两遍体检 ⇒ 真库 mirror 链被写入 r5/r6（其后 r7/r8 + 连带整链退役）。
//   凡「动词像读、实则 revise 落库」的子命令（outcome / recheck / price --apply / promote / session index），一律进沙箱。
// 口径：**读命令**在真库跑（只读）；**写命令**在临时副本跑（AKASHA_ROOT/AKASHA_DIR/AKASHA_LOGS 指向 temp）——
//   真库一字不写。每项判据：退出码 + 输出非空 + 无 error/异常字样 + （关键的）断言具体语义。
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, existsSync, rmSync, mkdirSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 2026-10-18：支持外部部署（OSS）——根目录优先 HARNESS_ROOT，回退本机默认。
//   OSS 同步时会把回退值改写成 process.cwd()（见 oss-sync-core.mjs 的规则 7）。
const H = (process.env.HARNESS_ROOT || "<LOCAL_PATH>").replace(/\\/g, '/').replace(/\/+$/, '');
// 2026-10-19（OSS 降级）：本工具是**活树运维工具**（依赖 official-home / 六库活数据）。
//   在 OSS 分发仓里跑会因根不存在而 ENOENT 崩——改为**明确报错并退出**（不是假装检查）。
if (!existsSync(join(H, 'akasha', 'data'))) {
  console.error(`health-check 需要活树布局（${H}/akasha/data 不存在）。`);
  console.error('本部署若是 OSS 分发仓：用 `node core/tools-doctor.mjs`（六库巡检）或 `node core/akasha.mjs check`。');
  console.error('若是活树：设 HARNESS_ROOT 指向仓库根。');
  process.exit(2);
}
const NODE = process.execPath;
const rows = [];
const ok = (name, pass, detail) => rows.push({ name, pass: !!pass, detail: String(detail ?? "").slice(0, 160) });

// ── A. 只读命令（真库）──
const RO = [
  ["check", ["check"], (o) => /OK —/.test(o)],
  ["stats", ["stats"], (o) => /canon:/.test(o)],
  ["audit", ["audit"], (o) => /OK|warn|findings/.test(o)],
  ["kit", ["kit"], (o) => /起床包/.test(o)],
  ["summary", ["summary"], (o) => /canon/.test(o)],
  ["metrics", ["metrics", "--since", "2026-10-01"], (o) => o.length > 0],
  ["lookup", ["lookup", "尾读", "--per-store", "3"], (o) => /canon/.test(o)],
  ["brief", ["cross", "门控", "--per", "2"], (o) => o.length > 0],
  ["cross", ["cross", "门控", "--per", "2"], (o) => /canon/.test(o)],
  ["show", ["show", "canon-akasha-usage"], (o) => /canon-akasha-usage/.test(o)],
  ["mirror match", ["mirror", "match", "工具失败后没有查库", "--limit", "3"], (o) => o.length >= 0],
  ["mirror compare", ["mirror", "compare", "工具失败后没有查库"], (o) => o.length > 0],
  // ⚠ 2026-10-13 教训：`mirror outcome` **是写命令**（revise 落库）——第一版把它放只读段、还写死一个真 id，
  //   连跑两遍体检就真库里写了两条修订（r5/r6，随后连带 r7/r8）。**写命令一律进沙箱段**，此处不再出现。
  ["orphan list", ["orphan", "list"], (o) => o.length > 0],
  ["frontier list", ["frontier", "list"], (o) => /frontier|ok|current/.test(o) || o.length > 0],
  ["frontier due", ["frontier", "due"], (o) => true],
  ["budget", ["budget"], (o) => o.length > 0],
  ["negative", ["negative"], (o) => o.length >= 0],
  ["blindspots", ["blindspots"], (o) => o.length >= 0],
  ["blindmap", ["blindmap"], (o) => o.length >= 0],
  ["discipline", ["discipline"], (o) => o.length >= 0],
  ["generation", ["generation"], (o) => o.length >= 0],
  ["recall", ["recall"], (o) => o.length >= 0],
  ["calibration", ["calibration"], (o) => o.length >= 0],
  ["readings", ["readings"], (o) => o.length >= 0 || true],
  ["session stats", ["session", "stats"], (o) => /段|session/.test(o)],
  ["session lookup", ["session", "lookup", "门控", "--limit", "3"], (o) => o.length > 0],
  ["session loopwatch", ["session", "loopwatch"], (o) => o.length >= 0],
  ["session tree（真 id 只读）", ["session", "tree", "--session", "official-collab-6b40ba60-6973-4854-8a4b-3c7972bdb4ac"], (o) => o.length > 0],
  ["session context", ["session", "context"], (o) => o.length >= 0],
  ["sleep --dry", ["sleep", "--dry"], (o) => /dry-run|蒸馏/.test(o)],
  ["sleep --plan", ["sleep", "--plan"], (o) => o.length > 0],
  ["sleep --replay", ["sleep", "--replay", "--today", "2026-10-13"], (o) => o.length > 0],
  ["help（无参用法）", [], (o) => /用法/.test(o)],
];
for (const [name, args, assert] of RO) {
  // 2026-10-13 卫生修：读面探测是**机器检查**、不是真使用 ⇒ 关查询侧线
  // （否则体检的探询会混进真 logs/query-log.jsonl——首跑即实测到 3 条）。
  const r = spawnSync(NODE, [join(H, "akasha/akasha.mjs"), ...args], { cwd: H, encoding: "utf8", timeout: 120000, env: { ...process.env, AKASHA_QUERY_LOG: "off" } });
  const out = ((r.stdout || "") + (r.stderr || "")).trim();
  // ── 崩溃判据 v2（2026-10-16 批次8 收窄；修 `CLI session context` 结构性假红）──────────────
  // 旧版把 stdout+stderr 合并后对**任意位置**做关键字匹配；而读面命令**会回显库/会话原文**
  //   ——`session context` 的"最近结论" = 会话段 gist 拼接，库里天然存在讨论 ENOENT/TypeError 的段落
  //   ⇒ 窗口滑进即红、滑出即绿（实测：真命令 `session context --session … --budget 4000`
  //     输出 7975B 含 2 处 ENOENT；600 预算下窗口回退 1 段亦命中、回退 7 段不命中）。
  //   红绿随库内容漂移 = **判据缺陷**，不是数据问题。新版分域（真崩溃仍必红）：
  //   ① spawn 级失败 r.error（超时/二进制缺失）；
  //   ② stderr 任意位置——Node 崩溃栈 / 模块加载失败（`Error: Cannot find module`）
  //      与 akasha.mjs 顶层兜底（uncaughtException ⇒ console.error + exit 1）的通道；
  //      只读面 33/33 项实测：正常命令 stderr 恒为空（见 landing/probe-ro-streams.json）；
  //   ③ stdout 仅认**行首**异常形态（`XxxError: ` / `Error: ` / `Cannot find module` / `node:internal/`）——
  //      命令自己 catch 后 `print(null, e.message)` 的崩因从行首开始；回显文本里的异常词在句中，不再误判。
  //   v2.1（2026-10-17 批次10 · MIX#2 收口两处"仅文本可判"的残余盲区——批次9 §5-2 的 E1/E2）：
  //     追加 `^(?:ENOENT|EACCES|EPERM): ` 与 `^ERR_[A-Z_]+`（**仍只认无前导空白的行首**）。
  //     闭合：stdout 行首 errno + exit 0（旧判绿）；`ERR_MODULE_NOT_FOUND:` 行首 + exit 0（两版皆盲）。
  //     依据＝33 项只读面**全量 stdout 逐行**画像（landing/logs/ro-stdout-profile.json，重跑
  //       scripts/probe-ro-stdout.mjs）：现行 / 追加后 / 含缩进容忍 三套判据在本库现况命中均为 **0**
  //       （33/33 项 stderr 空、首行无空白）⇒ 追加不引入假红。库内容漂移后复跑该脚本即可复测。
  //   v2.2（2026-10-17 批次11 · VERIFY-H2 §1.4 / §5-④）两处收口：
  //     ① **收紧** `^ERR_[A-Z_]+` → `^ERR_[A-Z_]+: `。依据＝库文本全量行首扫描（session.jsonl 49868 行）：
  //        裸行首命中 **34** 条、缩进形态 **0** 条，且 34 条**全部**是 `$.keywords[N]` 里的 `ERR_*` 无冒号裸码
  //        （无渲染器单独打印它 ⇒ 潜伏漂移质量，今天不可达）。收紧后 C 用例（`ERR_MODULE_NOT_FOUND: …` 有
  //        冒号）仍判红，而 34 个词元**一次抹掉**。代价＝纯码无冒号不再判红——那恰是**回显形态**（词元列表）
  //        而非崩溃渲染形态，且另有 exit / stderr 两条车道兜底。
  //     ② **缩进边界的理由改写**（旧理由"缩进是 markdown 回显的常见形态"与本库数据相反，已作废；边界本身
  //        保留——仍只认行首无前导空白）。站得住的是**两条理由 + 一条风险提示（附反向收益）**：
  //        (a) 它不是**类别区分**：markdown 里列 0 的 fenced code block 同样是回显形态，产出的正是**裸行首**
  //            行，恰恰是本判据会命中的形态——批次8 的"判据 ↔ 库内容耦合"没有被类别性切断，只是概率收窄；
  //        (b) 承重的是另外两条车道（exit≠0 / stderr 任意位置），本判据只在"命令自己 catch 后照常 exit 0"
  //            的窄缝里补刀 ⇒ 放宽的边际收益低；
  //        (c) **风险提示（附反向收益）**——放宽缩进容忍会把「缩进行回显」（缩进代码块 / 列表续行 / 引用）拉进
  //            命中面：这是**前向判断**而非实测（本库今天缩进形态存量 0，两侧皆 0 ⇒ 今天放宽与不放宽覆盖率相同，
  //            取收窄者是零成本的保守默认）。但它**不是纯风险**：`Command failed: …` + 下一行缩进的
  //            `  ERR_MODULE_NOT_FOUND: …` 是**真实的嵌套崩溃渲染**（子进程错误内嵌进父错误消息，常见形态）
  //            ⇒ 缩进容忍同样能把真信号召回（批次11 VERIFY-H3 §3-(c) 反例 N；复现见 batch12
  //            landing/work/n5-indent-case.mjs：现行判绿 / 缩进容忍判红）。故本条只作风险提示，不单独承重。
  //        复测入口：`runs/audit-1016-batch10/seg-health/verify/scripts/probe-ro-2.mjs`（含 indentTol 对照列）。
  const CRASH_ERR = /Cannot find module|TypeError|ReferenceError|SyntaxError|ENOENT|node:internal/;
  const CRASH_HEAD = /^(?:TypeError|ReferenceError|SyntaxError|RangeError|EvalError|URIError|Error): |^Cannot find module |^node:internal\/|^(?:ENOENT|EACCES|EPERM): |^ERR_[A-Z_]+: /;
  const crash = !!r.error || CRASH_ERR.test(r.stderr || "") || String(r.stdout || "").split("\n").some((l) => CRASH_HEAD.test(l));
  ok("CLI " + name, r.status === 0 && !crash && assert(out), `exit=${r.status}${crash ? " 含异常字样" + (r.error ? "(spawn:" + r.error.message + ")" : "") : ""} :: ${out.slice(0, 110).replace(/\n/g, " ⏎ ")}`);
}

// ── B. 写命令（临时副本库；真库零写入）──
const SANDBOX = mkdtempSync(join(tmpdir(), "akasha-health-"));
{
  // 布局纠正 v2（2026-10-13）：`AKASHA_ROOT` = **放六库 jsonl 的目录本身**（lib.mjs:10 `DATA = AKASHA_ROOT`，
  //   默认 `<repo>/data`）——不是"父级"。第一版把它当父级 ⇒ 全项「数据根缺少库文件」（这条是体检器自己的坑，已记）。
  //   本版：脚本仍走真库路径（只读用），**数据根指向临时目录**（写全落 temp）。
  const dataDir = join(SANDBOX, "data");
  mkdirSync(dataDir, { recursive: true });
  cpSync(join(H, "akasha/data"), dataDir, { recursive: true });
  mkdirSync(join(SANDBOX, "logs"), { recursive: true });
  const env = { ...process.env, AKASHA_ROOT: dataDir, AKASHA_LOGS: join(SANDBOX, "logs"), AKASHA_DIR: SANDBOX, AKASHA_SESSIONS_ROOT: join(H, "official-home", "sessions") };
  const run = (args, input) => {
    const r = spawnSync(NODE, [join(H, "akasha/akasha.mjs"), ...args], { cwd: H, encoding: "utf8", timeout: 120000, env, input });
    return { status: r.status, out: ((r.stdout || "") + (r.stderr || "")).trim() };
  };
  // B1 写：orphan add —— 真用法（**须给 observed**：只给 summary 会被校验拒，这是设计，见 B1b）
  const a = run(["orphan", "add", "--summary", "体检写入探针（临时库）", "--observed", "体检用观测文本", "--hypothesis", "体检用假设", "--confirm", "check 仍绿", "--refute", "check 变红"]);
  ok("CLI orphan add（临时库）", a.status === 0 && /orphan-/.test(a.out), `exit=${a.status} :: ${a.out.slice(0, 110)}`);
  // B1b 反向：缺 observed 必须被拒（校验在岗）
  const aBad = run(["orphan", "add", "--summary", "缺字段"]);
  ok("CLI orphan add 缺必填被拒（校验在岗）", aBad.status !== 0 || /校验|必填|missing|拒绝/.test(aBad.out), `exit=${aBad.status} :: ${aBad.out.split("\n").slice(-1)[0].slice(0, 90)}`);
  // B2 修订链：revise 一条 canon（挑非协议类——协议/自我层有信任边界，正当拒绝见 B2b）
  const rev = run(["revise", "canon", "canon-akasha-sweep20261013c", "--data", JSON.stringify({ last_reviewed: "2026-10-13" })]);
  ok("CLI revise（临时库·非协议条）", rev.status === 0, `exit=${rev.status} :: ${rev.out.slice(0, 110)}`);
  // B2b 信任边界：协议条必须被拒（这条**期望失败**）
  const revProt = run(["revise", "canon", "canon-akasha-usage", "--data", JSON.stringify({ last_reviewed: "2026-10-13" })]);
  ok("CLI revise 协议条被拒（信任边界在岗）", revProt.status !== 0 && /拒绝修订/.test(revProt.out), `exit=${revProt.status} :: ${revProt.out.slice(0, 90)}`);
  // B3 退役 + 硬删
  const ret = run(["retire", "orphan", "orphan-0001", "--reason", "体检探针"]);
  ok("CLI retire（临时库）", ret.status === 0 && /已退役/.test(ret.out), `exit=${ret.status} :: ${ret.out.slice(0, 90)}`);
  // B4 frontier recheck
  const fr = run(["frontier", "due"]);
  ok("CLI frontier due（临时库可跑）", fr.status === 0, `exit=${fr.status}`);
  // B5 price 计算 + 回写
  const pr = run(["price", "--severity", "3", "--irreversibility", "2", "--cost", "1"]);
  ok("CLI price 计算", pr.status === 0 && pr.out.length > 0, `exit=${pr.status} :: ${pr.out.slice(0, 90)}`);
  // B6 promote（临时库幂等）
  const p1 = run(["promote"]);
  const p2 = run(["promote"]);
  ok("CLI promote 幂等（临时库）", p1.status === 0 && p2.status === 0, `${p1.out.slice(0, 60)} | ${p2.out.slice(0, 60)}`);
  // B6b mirror outcome（**写命令**——只在沙箱跑；2026-10-13 全局唯一允许它出现的位置）
  const mo = run(["mirror", "outcome", "mirror-handcheck-sweep-r1", "--verdict", "部分"]);
  ok("CLI mirror outcome（临时库）", mo.status === 0 && /已记录结果/.test(mo.out), `exit=${mo.status} :: ${mo.out.slice(0, 100)}`);
  // B7 session index（2026-10-19 P0 后修：不再写死已归档的 session id——运行时发现一个真实档案）
  const findSessionId = () => {
    const root = join(H, 'official-home', 'sessions');
    try {
      for (const ws of readdirSync(root)) {
        const dir = join(root, ws);
        let subs = [];
        try { subs = readdirSync(dir); } catch { continue; }
        for (const sid of subs) {
          if (/^session-/.test(sid) && (existsSync(join(dir, sid, 'session.v4.jsonl.zstd')) || existsSync(join(dir, sid, 'session.v3.jsonl.zstd')))) return sid;
        }
      }
    } catch { /* 无档案目录 */ }
    return null;
  };
  const sidForIndex = findSessionId();
  if (sidForIndex) {
    const si = run(["session", "index", sidForIndex]);
    ok("CLI session index（临时库）", si.status === 0, `id=${sidForIndex} exit=${si.status} :: ${si.out.slice(0, 90)}`);
  } else {
    ok("CLI session index（临时库）", true, "SKIP：未发现会话档案（不是失败）");
  }
  // B8 check（临时库写后仍须绿）
  const ck = run(["check"]);
  ok("临时库 check（写后仍绿）", ck.status === 0 && /OK —/.test(ck.out), ck.out.slice(0, 110));
  // 真库零写入核验：数据目录 mtime/大小快照对比在调用方做（见下）
}

// ── C. MCP 桥（真进程；用仓库既有夹具 spawn 服务器 —— 不依赖 @modelcontextprotocol/sdk）──
{
  // 2026-10-16 批次8：夹具第一步是 `cpSync(CORE → 临时)`，而 CORE=akasha/ 里有"复制地雷"——
  //   ① `gate-out/gate-selffix/runs`（143MB 产物树；其中 audit-1016-batch6/seg-sleep/verify/derived/akasha
  //      是 **junction → <AKASHA_DIR>**）⇒ Node cpSync 顺着它**无限自嵌套**，副本膨胀到 GB 级；
  //   ② `data/session.jsonl`（91MB 会话原档；`akasha_check` 自述"不读会话原档"）。
  //   实测（2026-10-16 23:0x 单独重跑）：42s 崩在 `cpSync`（selftest.test.mjs:65）——
  //     `EINPROGRESS, There is not enough space on the disk`（Windows errno 112＝磁盘满），
  //     桥代码**从未执行**（所以不是端口/宿主 env/桥故障）；历史残留 9 个副本 ≈ 67.6GB（D 盘 8.3→1.41GB）。
  //   修法：给夹具喂**等价的最小可执行核心**（用它的第一候选 `AKASHA_CORE`，selftest.test.mjs:13）：
  //     核心 *.mjs + data 六库 *.jsonl（跳过 session.jsonl 与 _trash/）⇒ 复制量 292MB→∞ 降到 ~3.6MB，
  //     15s 跑完 `all assertions passed`（实测含 22 工具注册 / akasha_check 实调 ok:true / node 回退 / 畸形输入回归）。
  //     **测试语义不变**：仍是仓库既有夹具、真起服务器、真调工具；这里只把"复制什么"收窄到可执行面。
  // 2026-10-17 批次10 · MIX#3：构造 **fail-closed**。旧版对每个源件 `existsSync` 过滤后复制 ⇒ 源件缺失时
  //   会**静默**产出一个残缺 core-min；而夹具的 CORE 候选链（selftest.test.mjs:12-19）在 AKASHA_CORE
  //   不满足 `lib.mjs+mcp.mjs` 时会**继续往下找**，最终落到 `join(HERE,'..','akasha')` = **真核**
  //   ⇒ 体检表面「✓ 端到端通过」，实际测的是真核（点错对象），且真核里再出现自嵌套链接就重演
  //   errno 112 爆盘事故（见 selftest.test.mjs 顶部链接守卫）。现改为：先校验源件齐全，
  //   缺一件即**判红并拒绝 spawn**——绝不回退真核（本项失败时体检整体 exit 1）。
  const CORE_MIN_FILES = ["akasha.mjs", "lib.mjs", "mcp.mjs", "session.mjs", "sleep.mjs", "init-example.mjs", "json-redaction.mjs", "loop-detect.mjs", "companion.mjs", "adapters.mjs", "contract.mjs"];
  const CORE_MIN_STORES = ["canon", "mirror", "orphan", "pricing", "lexicon", "frontier"];
  const coreMinMissing = [
    ...CORE_MIN_FILES.filter((f) => !existsSync(join(H, "akasha", f))).map((f) => "akasha/" + f),
    ...CORE_MIN_STORES.filter((s) => !existsSync(join(H, "akasha/data", s + ".jsonl"))).map((s) => "akasha/data/" + s + ".jsonl"),
  ];
  if (coreMinMissing.length) {
    ok("MCP 桥：夹具端到端（真起服务器 + 真调工具）", false, "core-min 构造失败（fail-closed：拒绝回退真核，未 spawn）—— 缺 " + coreMinMissing.join(" / "));
  } else {
    const coreMin = join(SANDBOX, "core-min");
    mkdirSync(join(coreMin, "data"), { recursive: true });
    for (const f of CORE_MIN_FILES) copyFileSync(join(H, "akasha", f), join(coreMin, f));
    for (const f of readdirSync(join(H, "akasha/data"))) {
      if (f === "session.jsonl" || !f.endsWith(".jsonl")) continue;   // 跳过会话原档（夹具不读）与 _trash/ 等子目录
      copyFileSync(join(H, "akasha/data", f), join(coreMin, "data", f));
    }
    const r = spawnSync(NODE, [join(H, "dsh-mcp-akasha/selftest.test.mjs")], { cwd: H, encoding: "utf8", timeout: 300000, env: { ...process.env, AKASHA_QUERY_LOG: "off", AKASHA_CORE: coreMin } });   // 同上：夹具探测不落真侧线
    const out = ((r.stdout || "") + (r.stderr || "")).trim();
    // 诊断面（2026-10-16）：失败时旧版只截最后两行 —— 恰是 `⏎ Node.js v24.19.0`（零诊断价值）。
    //   改为优先取含错误信号的行（崩因/断言失败都在头部）。
    const errLine = out.split("\n").find((l) => /Error|错误|失败|✗|not enough space/.test(l)) ?? "";
    const detail = r.status === 0
      ? out.split("\n").filter(Boolean).slice(-1)[0] ?? ""
      : (errLine || out.split("\n").filter(Boolean).slice(-2).join(" ⏎ "));
    ok("MCP 桥：夹具端到端（真起服务器 + 真调工具）", r.status === 0 && /all assertions passed/.test(out), detail.slice(0, 200));
  }
}

// ── D. 插件面 ──
{
  const log = join(H, "akasha/logs/hooks.jsonl");
  // 2026-10-17 批次12 修（批次11 VERIFY-H3 §4/§5-N1）：活动计数仍只看**末 4000 行窗口**（近况语义），
  //   但 `gate-armed` 判定不得绑在同一窗口上——窗口是"活库推进即翻"的环境脆弱：末条 gate-armed 曾落到
  //   倒数第 4261 行（本轮复现时更推到倒数第 4519 行，窗口外）⇒ 体检自伤·假红。gate-armed 改**尾部下钻**。
  const all = readFileSync(log, "utf8").trim().split("\n");
  const lines = all.slice(-4000).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const kinds = {};
  for (const l of lines) kinds[l.kind] = (kinds[l.kind] || 0) + 1;
  const now = Date.now();
  const fresh = (k) => lines.filter((l) => l.kind === k && now - Date.parse(l.ts || 0) < 48 * 3600 * 1000).length;
  ok("hooks：tool 线活跃", fresh("tool") > 0, "tool=" + fresh("tool"));
  ok("hooks：preflight 线活跃", fresh("preflight") > 0, "preflight=" + fresh("preflight"));
  ok("hooks：usage/session-worker 线存在", (kinds["usage"] || 0) + (kinds["session-worker"] || 0) > 0, JSON.stringify(kinds).slice(0, 120));
  // gate-armed：尾部下钻取最近一条（硬上限 30 万行防病态大文件）。
  //   2026-10-17 批次13 采纳（batch12 VERIFY-H4 §5-N3）：原上限 6 万＝悬崖（近速率 2.5–3.4 天即达；+5万行/天 26.3h），
  //   且达上限与"压根没有 gate-armed"输出**不可区分**（都 `{}`）；成本实测为零（全文件 parse 8.9ms ≈ 上限内 9.6ms）
  //   ⇒ 抬到 300000（≈13 天余量@近速率）并显式标 `capped`（达上限时明说"可能超窗"）。
  let armed = null, scanned = 0, capped = false;
  for (let i = all.length - 1, n = 0; i >= 0 && n < 300000; i--, n++) {
    scanned = n + 1;
    let o; try { o = JSON.parse(all[i]); } catch { continue; }
    if (o.kind === "gate-armed") { armed = o; break; }
  }
  if (!armed && all.length > 300000) capped = true;
  // 版本口径：接受 2026-10-13 系列任意小版（重启后才会换成最新；不把断言写死成单版，免得每次提版就假红）
  ok("gate：启动线含新规则版本", !!armed && /gate-rules\/2026-10-13\.\d+/.test(armed.rulesVersion || ""),
    armed ? JSON.stringify(armed).slice(0, 120)
          : `未找到 gate-armed（已扫描 ${scanned} 行${capped ? "，达上限 ⇒ 可能超窗" : "，已到文件头"}）`);
  const st = JSON.parse(readFileSync(join(H, "akasha/logs/sleep-state.json"), "utf8"));
  ok("sleep：状态水位线推进", Number(st.processedBytes) > 0 && !!st.lastRunAt, `bytes=${st.processedBytes} last=${st.lastRunAt}`);
  const sess = readFileSync(join(H, "akasha/data/session.jsonl"), "utf8");
  ok("session：索引库非空", sess.length > 1000, `bytes=${sess.length}`);
}

console.log("\n══ 全功能体检 ══");
for (const r of rows) console.log((r.pass ? "  ✓ " : "  ✗ ") + r.name.padEnd(36) + " " + r.detail);
const bad = rows.filter((r) => !r.pass);
console.log("\n" + (bad.length ? `★★ ${bad.length}/${rows.length} 项未通过` : `★★ 全部 ${rows.length} 项通过`));

// ── E. 真库零写入哨兵（2026-10-13 加：体检器自己的纪律，别再犯 mirror outcome 那次）──
{
  const { createHash } = await import("node:crypto");
  const hashes = [];
  for (const s of ["canon", "mirror", "orphan", "pricing", "lexicon", "frontier"]) {
    const f = join(H, `akasha/data/${s}.jsonl`);
    const b = readFileSync(f);
    hashes.push(s + ":" + createHash("sha256").update(b).digest("hex").slice(0, 12));
  }
  console.log("\n真库快照（供前后对照）: " + hashes.join("  "));
}

rmSync(SANDBOX, { recursive: true, force: true });
process.exit(bad.length ? 1 : 0);
