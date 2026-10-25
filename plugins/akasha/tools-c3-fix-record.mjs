// c3-fix-record.mjs —— 过滤规则修正记录 + canon
import { readFileSync, writeFileSync } from "node:fs";
import { loadStore, currentRecords, revise } from "./lib.mjs";

const OSS = "<LOCAL_PATH>\\dist\\akasha-oss";
const P = OSS + "\\docs\\c1-c3-schedule.md";
let doc = readFileSync(P, "utf8");
if (!doc.includes("### C3 过滤修正")) {
  doc += [
    "",
    "### C3 过滤修正（2026-10-10，生产核对发现）",
    "",
    "- **发现**：重启后核对 C3 实际读到的最近 intent 段，看到的是 `<openviking-context> Relevant memory from OpenViking…` ⇒ **除 runtime context 外，还有更多注入块被记成 intent**（OpenViking / Hindsight 等），原来的两字面量跳过规则**不够**，有误触发风险。",
    "- **修法（规则化）**：跳过 `以 < 开头` 或 `长度 > 800` 或 命中 `Current runtime context | Relevant memory from | Hindsight | openviking-context | 阿卡夏·` 的段。",
    "- **自测同步**：夹具换成**生产实际见过的注入形态**（XML 式块 + 900 字长块）——**用真实样本，不用自造样本**。",
    "- **验证**：C3 自测 **11/11**、C1 回归 **10/10**、语法 0 错、版本 `1.6.3-h1` 已打包并装入（restart-required）。",
    "- **教训**：这一处与 C1 的字段 bug 同类——**只有在真实数据上核对才发现得了**；自造夹具会一直放行。",
    "",
  ].join("\n");
  writeFileSync(P, doc, "utf8");
  writeFileSync("<LOCAL_PATH>\\docs\\c1-c3-schedule.md", doc, "utf8");
  console.log("  [plan] 过滤修正已记（双份）");
} else console.log("  [plan] already");

const recs = currentRecords(loadStore("canon").records);
const hit = recs.filter((r) => String(r.id).startsWith("canon-observation-ledger-20261010")).pop();
const marker = "**C3 过滤修正（2026-10-10）**";
if (String(hit.claim).includes(marker)) { console.log("  [canon] already"); process.exit(0); }
const add = " " + marker + "：重启后核对 C3 实际输入，发现最近的 intent 段是 `<openviking-context> Relevant memory from OpenViking…` ⇒ **除 runtime context 外还有更多注入块被记成 intent**（OpenViking/Hindsight 等），原两字面量跳过规则不够、有误触发风险。修法改成**规则化**：跳过以 < 开头、长度 > 800、或命中 Current runtime context / Relevant memory from / Hindsight / openviking-context / 阿卡夏· 的段；自测夹具换成**生产实际形态**（XML 式块 + 900 字长块）。验证：C3 自测 11/11、C1 回归 10/10、版本 1.6.3-h1 已装入。**教训（与 C1 字段 bug 同类）**：只有在真实数据上核对才发现得了，自造夹具会一直放行。";
const next = revise("canon", hit.id, { claim: hit.claim + add, last_reviewed: "2026-10-10" });
console.log("  [canon] " + hit.id + " → " + next.id);
