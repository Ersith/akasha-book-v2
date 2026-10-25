// c3-record.mjs —— C3 v1 实施记录 + canon（含会话层布局事实）
import { readFileSync, writeFileSync } from "node:fs";
import { loadStore, currentRecords, revise } from "./lib.mjs";

const OSS = "<LOCAL_PATH>\\dist\\akasha-oss";
const P = OSS + "\\docs\\c1-c3-schedule.md";
let doc = readFileSync(P, "utf8");
if (!doc.includes("## 10. C3 v1 实施记录")) {
  const block = [
    "",
    "## 10. C3 v1 实施记录（2026-10-10）",
    "",
    "**实现**：sleep 新增 context 行 `akasha:stateful`（order **134**，先于 C1 的 135）：",
    "- 触发＝读 `<akashaDir>/data/session.jsonl` 尾部 200 行，取**最近一条 intent 段**，命中 5 类关键词（发布 / 安装 / 版本 / 开关 / 存在）；",
    "- **跳过注入样式段**（`gist` 以 `Current runtime context` 开头或含「阿卡夏·」）——否则每回合必误触发；",
    "- 输出 ≤80 字：`[断言提醒] 状态性事实——先查再答（例：versions + dist-tags 两处核对）`；",
    "- `statefulGate:false` ⇒ **提示与事件双停**；同类 30 分钟去重；每回合 ≤1 条；",
    "- **优先级联动**：C3 命中 ⇒ 置位 `gateState.c3Fired` ⇒ **同回合 C1 返回 null**（只出一条）。",
    "",
    "**验证**：`stateful.test.mjs` **11 passed / 0 failed**（含注册/order/渲染/≤80 字/去重/跳过注入段/关闭不注册/关闭无事件/**C3 命中时 C1 让位**/事件写入）· 双树语法 0 错 · C1 回归 **10/10** · 版本 `1.6.2-h1`（仓 1.6.2）已打包并装入（restart-required）。",
    "",
    "**环境事实（本轮查得，可复用）**：会话层存储＝`akasha/data/session.jsonl`，记录形如 `{store, session, seq, time, kind:\"intent\", gist}`；**`gist` 里也会出现注入的 runtime context** ⇒ 任何按「用户消息」判定的逻辑都必须先排掉这类段。",
    "",
    "**待办**：① 重启后端到端验证（用一个状态性提问试）；② 基线期改口径后复测（Claude：前 5–7 天同口径）；③ v2 候选（「上次结论 + 出处」需按主题检索库；回复侧钩子待确认宿主能力）。",
    "",
  ].join("\n");
  writeFileSync(P, doc + block, "utf8");
  writeFileSync("<LOCAL_PATH>\\docs\\c1-c3-schedule.md", doc + block, "utf8");
  console.log("  [plan] §10 已写（双份）");
} else console.log("  [plan] already");

const recs = currentRecords(loadStore("canon").records);
const hit = recs.filter((r) => String(r.id).startsWith("canon-observation-ledger-20261010")).pop();
const marker = "**C3 v1 落地（2026-10-10）**";
if (String(hit.claim).includes(marker)) { console.log("  [canon] already"); process.exit(0); }
const add = " " + marker + "：sleep 新增 context 行 `akasha:stateful`（order 134，先于 C1 的 135）——读 `akasha/data/session.jsonl` 尾部 200 行、取最近 intent 段、命中 5 类关键词（发布/安装/版本/开关/存在）即提醒 ≤80 字；**必须跳过注入样式段**（gist 以 Current runtime context 开头或含「阿卡夏·」，否则每回合误触发）；`statefulGate:false` 双停；同类 30 分钟去重；每回合 ≤1 条；**C3 命中 ⇒ 同回合 C1 让位（只出一条）**。验证：`stateful.test.mjs` **11/11**（含优先级联动与跳过注入段）、双树语法 0 错、C1 回归 10/10、版本 1.6.2-h1 已打包并装入。**环境事实（可复用）**：会话层存储＝`akasha/data/session.jsonl`，形如 `{store,session,seq,time,kind:\"intent\",gist}`，且 gist 里混有注入的 runtime context ⇒ 按用户消息判定的逻辑必须先排掉这类段。待办：重启后端到端验证；基线期 5–7 天同口径复测；v2 候选（上次结论+出处 / 回复侧钩子）。";
const next = revise("canon", hit.id, { claim: hit.claim + add, last_reviewed: "2026-10-10" });
console.log("  [canon] " + hit.id + " → " + next.id);
