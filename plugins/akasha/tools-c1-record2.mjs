// c1-record2.mjs —— §8 实施记录 + canon（修正引号后重跑）
import { readFileSync, writeFileSync } from "node:fs";
import { loadStore, currentRecords, revise } from "./lib.mjs";

const OSS = "<LOCAL_PATH>\\dist\\akasha-oss";
const P = OSS + "\\docs\\c1-c3-schedule.md";
let doc = readFileSync(P, "utf8");
if (!doc.includes("## 8. 实施记录")) {
  const block = [
    "",
    "## 8. 实施记录（C1 · 2026-10-10，解冻后）",
    "",
    "- **实现**：sleep 插件新增 context 行 `akasha:preflight`（order 135）——取**近 30 分钟最近失败的工具**，若其在 `RECALL_TRAP_MAP` 内 ⇒ 渲染一行 ≤80 字：`[坑前提示] <工具> 前：<动作> —— 条目 <id>`；**同工具 30 分钟去重 · 每回合 ≤1 条 · 只提示不阻断**；`preflightHints:false` ⇒ **提示与事件双停**（不写假触发）；事件 `kind=preflight` 落 `logs/hooks.jsonl`。",
    "- **如实标注的近似**：context 行在**回合开始**渲染，此刻不知道本回合会调用什么工具 ⇒ v1 用“最近失败的工具”作**预提示**；“本回合尚未查库”这一前置在渲染时不可判定（弱化为去重 + 上限）。",
    "- **验证（本轮）**：双树语法 ✓ · sleep 自测 exit=0 · 核心套件 **140/140** · 版本 `1.5.5-h1 → 1.6.0-h1`（仓 1.6.0）· tgz 已打包 · **install_bundle 成功（restart-required）**。",
    "- **待办（不得省）**：① **C1 自测断言**（去重 / 映射表外不提示 / 关闭双停）——本轮未补，**列为下一步第一件**；② 重启后**端到端验证**（下一回合若近 30 分钟有失败，应见 `[坑前提示] …` 行）；③ **C3** 紧随。",
    "",
  ].join("\n");
  writeFileSync(P, doc + block, "utf8");
  writeFileSync("<LOCAL_PATH>\\docs\\c1-c3-schedule.md", doc + block, "utf8");
  console.log("  [plan] §8 已追加（双份）");
} else console.log("  [plan] already");

const recs = currentRecords(loadStore("canon").records);
const hit = recs.filter((r) => String(r.id).startsWith("canon-observation-ledger-20261010")).pop();
const marker = "**C1 落地（2026-10-10）**";
if (String(hit.claim).includes(marker)) { console.log("  [canon] already"); process.exit(0); }
const add = " " + marker + "：解冻后实现 **C1｜易错点前置**——sleep 新增 context 行 `akasha:preflight`（order 135）：取近 30 分钟最近失败的工具，若在 `RECALL_TRAP_MAP` 内则渲染一行 ≤80 字（`[坑前提示] <工具> 前：<动作> —— 条目 <id>`），**同工具 30 分钟去重 · 每回合 ≤1 条 · 只提示不阻断 · preflightHints:false 则提示与事件双停**（不写假触发）；事件 kind=preflight 落 hooks。**如实标注近似**：该行在回合开始渲染、不知道本回合将调用何工具 ⇒ v1 用“最近失败工具”作预提示，“本回合尚未查库”前置不可判定（弱化为去重+上限）。**验证**：双树语法 ✓ · sleep 自测 exit=0 · 核心 **140/140** · 版本 1.6.0-h1 已打包并装入（restart-required）。**待办（不省）**：① C1 自测断言（去重/映射表外不提示/关闭双停）=下一步第一件；② 重启后端到端验证；③ C3 紧随。";
const next = revise("canon", hit.id, { claim: hit.claim + add, last_reviewed: "2026-10-10" });
console.log("  [canon] " + hit.id + " → " + next.id);
