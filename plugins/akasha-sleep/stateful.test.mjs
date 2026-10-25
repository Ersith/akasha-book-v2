// stateful.test.mjs —— C3 自测：正向 / 跳过注入段 / 去重 / 关闭双停 / 与 C1 优先级联动
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// F（2026-10-16 batch6 修复）：本套件原先只传 `akashaDir` ⇒ 插件 DEFAULTS 的 log/stateFile/inboxFile
//   落**真家目录**（~/.akasha/logs/hooks.jsonl——实测三套每跑一轮就往里追加 sleep-armed 行）。
//   修法两件：① 桩 cfg 走 cfgOf() 给全三路径；② 装载 lib/index.js **之前**把 AKASHA_DIR 指到临时
//   「陷阱目录」，末尾断言它零写入——将来哪次漏路径会先落这里并被守卫抓住（DEFAULTS 在模块求值时读
//   AKASHA_DIR ⇒ 必须先设、后 import ⇒ 本套件改用动态 import）。
const DEFAULT_TRAP = mkdtempSync(join(tmpdir(), "stateful-default-trap-"));
process.env.AKASHA_DIR = DEFAULT_TRAP;
// H4-E（2026-10-17 batch14）：陷阱目录**用毕即弃**（末尾 F 守卫读完就没用了）⇒ 进程退出时兜底清掉。
//   此前每跑一轮就在 %TEMP% 留一个 `*-default-trap-*` 空目录（batch13 清单实测：存量 255、单日 +134）。
process.on("exit", () => { try { rmSync(DEFAULT_TRAP, { recursive: true, force: true }); } catch { /* 兜底失败不遮错误 */ } });
const { apply } = await import("./lib/index.js");

const FIX = "<LOCAL_PATH>\\_ab\\stateful-fixture";

/** 桩 cfg（照 route.test.mjs 同款）：三路径必须显式给全——漏一项就落 DEFAULTS = 真家目录。 */
const cfgOf = (dir, over = {}) => ({
  akashaDir: dir, log: join(dir, "logs", "hooks.jsonl"),
  stateFile: join(dir, "state.json"), inboxFile: join(dir, "inbox.jsonl"), ...over,
});

function makeFixture(intentGists) {
  rmSync(FIX, { recursive: true, force: true });
  mkdirSync(join(FIX, "data"), { recursive: true });
  mkdirSync(join(FIX, "logs"), { recursive: true });
  writeFileSync(join(FIX, "lib.mjs"),
    "export const RECALL_TRAP_MAP = { edit: [\"canon-trap-edit-context-mismatch\"], read: [\"canon-trap-read-offset-range\"] };\n", "utf8");
  const lines = intentGists.map((g, i) => JSON.stringify({ store: "session", session: "s1", seq: i + 1, time: new Date().toISOString(), kind: "intent", gist: g }));
  writeFileSync(join(FIX, "data", "session.jsonl"), lines.join("\n") + "\n", "utf8");
}

function run(cfg, failures = []) {
  const rows = [];
  const handlers = {};
  const ctx = {
    systemPrompt: { context: (r) => rows.push(r) },
    tools: { register() {}, guard() {} },
    on(n, fn) { (handlers[n] ||= []).push(fn); },
    logger: { info() {} },
    config: cfg,
  };
  apply(ctx, cfg);
  for (const t of failures) for (const fn of handlers["tools/result"] || []) fn({ name: t }, { isError: true });
  return { rows, row: (n) => rows.find((r) => r.name === n) };
}

let pass = 0, fail = 0;
const T = (n, c, extra = "") => { if (c) { pass++; console.log("  PASS " + n); } else { fail++; console.log("  FAIL " + n + (extra ? "  " + extra : "")); } };

// ① 正向：用户问"1.2.3 是否已发布" ⇒ C3 应触发
// 2026-10-15 V02 契约（GPT N2 收尾）：**身份未知 ⇒ 静默**——正向用例必须显式给会话身份（{id:'s1'} 与夹具行 session:"s1" 对齐），
// 否则测到的是"未知身份被静默"而不是"命中该提醒"（此前无参调用＝unknown，6 条红即此因）。
makeFixture(["Current runtime context. 阿卡夏·睡眠：...", "demo-pkg 的 1.2.3 是否已发布？给依据"]);
let { rows, row } = run(cfgOf(FIX, { statefulGate: true, preflightHints: true }));
let c3 = row("akasha:stateful");
T("① 注册 akasha:stateful", !!c3, JSON.stringify(rows.map((r) => r.name)));
T("① order=134（先于 C1 的 135）", c3 && c3.order === 134, String(c3 && c3.order));
const line = c3 && c3.text({ id: "s1" });
T("① 渲染出提醒行", typeof line === "string" && line.includes("[断言提醒]"), String(line));
T("① ≤80 字", !!line && line.length <= 80, String(line && line.length));
T("② 同类 30 分钟去重（二次返回空串 ''）", typeof line === "string" && c3.text({ id: "s1" }) === '');

// ③ 只有注入样式段 ⇒ 不触发
makeFixture([
  "Current runtime context. 阿卡夏·库脉搏：canon 124",
  "<openviking-context> Relevant memory from OpenViking. Use the search/read MCP tools to expand URIs.",
  "<hindsight_knowledge> This repository has a Hindsight memory + knowledge base.",
  "阿卡夏·称呼：① Master——用户要求模型对其使用的称呼；",
  "x".repeat(900),
]);
({ rows, row } = run(cfgOf(FIX, { statefulGate: true })));
c3 = row("akasha:stateful");
T("③ 注入样式段不触发", !!c3 && c3.text({ id: "s1" }) === '', String(c3 && c3.text({ id: "s1" })));

// ④ 关闭 ⇒ 不注册、无事件
makeFixture(["demo-pkg 是否已发布"]);
({ rows, row } = run(cfgOf(FIX, { statefulGate: false })));
T("④ 关闭时不注册 akasha:stateful", !rows.some((r) => r.name === "akasha:stateful"));
let hooksTxt = ""; try { hooksTxt = readFileSync(join(FIX, "logs", "hooks.jsonl"), "utf8"); } catch { /* 文件不存在＝无事件 */ }
T("④ 关闭时无 stateful-reminder 事件", !hooksTxt.includes("stateful-reminder"));

// ⑤ 优先级联动：C3 命中时 C1 让位（即便有近期失败）
makeFixture(["1.2.3 是否已发布"]);
({ rows, row } = run(cfgOf(FIX, { statefulGate: true, preflightHints: true }), ["edit"]));
const l3 = row("akasha:stateful").text({ id: "s1" });
const l1 = row("akasha:preflight").text({ id: "s1" });
T("⑤ C3 命中时有提醒行", typeof l3 === "string", String(l3));
T("⑤ 同回合 C1 让位（返回空串 ''）", l1 === '', String(l1));
let hooksTxt2 = ""; try { hooksTxt2 = readFileSync(join(FIX, "logs", "hooks.jsonl"), "utf8"); } catch { /* 同上 */ }
T("⑤ 开启了 stateful-reminder 事件", hooksTxt2.includes("stateful-reminder"));

// ⑥ V02 哨兵契约对照（2026-10-15 GPT N2）：同一 fixture —— 无身份 ⇒ 静默；给身份 ⇒ 正常出话
makeFixture(["demo-pkg 的 1.2.3 是否已发布？给依据"]);
({ rows, row } = run(cfgOf(FIX, { statefulGate: true })));
const l6u = row("akasha:stateful").text();
T("⑥ 身份未知 ⇒ 静默（V02）", l6u === '', String(l6u));
const l6k = row("akasha:stateful").text({ id: "s1" });
T("⑥ 同 fixture 给身份 ⇒ 出话（对照）", typeof l6k === "string" && l6k.includes("[断言提醒]"), String(l6k));

// ⑦ F 守卫（2026-10-16 batch6）：家目录零写入——本套件所有 apply() 已跑完，陷阱目录必须**空**。
//   非空 = 有调用漏了 log/stateFile/inboxFile（＝老毛病复发，会去写 ~/.akasha）。
let trapped = [];
try { trapped = readdirSync(DEFAULT_TRAP); } catch { /* 目录都建不出来＝零写入 */ }
T("⑦ 家目录零写入（DEFAULTS 陷阱目录零写入）", trapped.length === 0, JSON.stringify(trapped));

console.log("\n  " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
