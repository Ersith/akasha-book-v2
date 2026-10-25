// c3-recon2.mjs —— C3 触发源侦察：修正引号（全部用「」替代内嵌双引号）
import { readFileSync, writeFileSync } from "node:fs";
import { loadStore, currentRecords, revise } from "./lib.mjs";

const OSS = "<LOCAL_PATH>\\dist\\akasha-oss";
const P = OSS + "\\docs\\c1-c3-schedule.md";
let doc = readFileSync(P, "utf8");
if (!doc.includes("## 9. C3 触发源侦察")) {
  const block = [
    "",
    "## 9. C3 触发源侦察（2026-10-10，实现前先查事实）",
    "",
    "**结论：按原设计（扫描回复文本）不可实现**，原因：",
    "1. context 行在**回合开始**渲染，**回复尚未产生** ⇒ 扫不到回复文本；",
    "2. sleep 的 context 行 `text()` **无入参**；插件只订阅 `agent/created` / `tools/result` / `agent/error` / `agent/status`（`lib/index.js:135/166/167/248`）⇒ **用户消息同样不可见**。",
    "",
    "**已验证的替代源**：会话层有 **intent 段**（用户消息，当前 2270 条）——存在性已核，可用。",
    "",
    "**C3 v1 定稿（触发改到提问侧）**：",
    "- **触发**：当前会话**最近的 intent 段**文本命中 6 类状态性关键词之一；",
    "- **输出**：`[断言提醒] 状态性事实——先查再答（例：versions + dist-tags 两处核对）`，≤80 字；",
    "- **开关/去重/上限**：`statefulGate:false` 双停；同类关键词 30 分钟去重；每回合 ≤1 条；",
    "- **优先级**：与 C1 同时命中 ⇒ **只出 C3**（C1 顺延）：C3 行 order 134 先渲染并置位，C1 行检测该位后返回 null；",
    "- **v1 不含**「上次结论 + 出处」（需按主题检索库，列 v2）。",
    "",
    "**诚实说明**：这是**降级但仍有效**的版本——它管「用户问了状态性事实」，而非「我准备断言状态性事实」；**回复侧**那一半留待确认宿主是否有回复前钩子。",
    "",
    "**流程教训（本轮第 5 次）**：多行脚本**运行前必须先 `node --check`**——今天的语法错误全部能在解析期拦下；另：串内禁止内嵌同类引号（用「」）。",
    "",
  ].join("\n");
  writeFileSync(P, doc + block, "utf8");
  writeFileSync("<LOCAL_PATH>\\docs\\c1-c3-schedule.md", doc + block, "utf8");
  console.log("  [plan] §9 已写（双份）");
} else console.log("  [plan] already");

const recs = currentRecords(loadStore("canon").records);
const hit = recs.filter((r) => String(r.id).startsWith("canon-observation-ledger-20261010")).pop();
const marker = "**C3 触发源侦察（2026-10-10）**";
if (String(hit.claim).includes(marker)) { console.log("  [canon] already"); process.exit(0); }
const add = " " + marker + "：按原设计（扫回复文本）不可实现——① context 行在回合开始渲染、回复尚未产生；② sleep 的 context 行 text() 无入参，且插件只订阅 agent/created、tools/result、agent/error、agent/status 四事件（lib/index.js:135/166/167/248）⇒ 用户消息亦不可见。已验证替代源：会话层 intent 段（用户消息，2270 条）。**C3 v1 触发改到提问侧**（读当前会话最近 intent 段做 6 类关键词判定），输出 ≤80 字、statefulGate:false 双停、同类 30 分钟去重、每回合 ≤1 条、与 C1 同命中时只出 C3（C3 行 order 134 先渲染置位，C1 检测后返回 null）；v1 不含「上次结论+出处」（列 v2）。回复侧那一半待确认宿主有无回复前钩子。**流程教训**：多行脚本运行前必须先 node --check（今日 5 次语法错全可在解析期拦下）；串内禁止内嵌同类引号。";
const next = revise("canon", hit.id, { claim: hit.claim + add, last_reviewed: "2026-10-10" });
console.log("  [canon] " + hit.id + " → " + next.id);
