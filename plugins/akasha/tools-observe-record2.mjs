// observe-record2.mjs —— 观察口径落档（引号已清；check 通过才跑）
import { copyFileSync } from "node:fs";
import { loadStore, currentRecords, appendRecord } from "./lib.mjs";

const OSS = "<LOCAL_PATH>\\dist\\akasha-oss";
copyFileSync(OSS + "\\docs\\observation-metrics.md", "<LOCAL_PATH>\\docs\\observation-metrics.md");
copyFileSync("<AKASHA_DIR>\\tools\\observe.mjs", OSS + "\\core\\tools-observe.mjs");
console.log("  [sync] 文档双份 + 脚本副本进仓");

const recs = currentRecords(loadStore("canon").records);
if (recs.some((r) => String(r.id).startsWith("canon-observe-metrics-20261010"))) { console.log("= canon 已存在"); process.exit(0); }
const r = appendRecord("canon", {
  id: "canon-observe-metrics-20261010",
  claim: "**观察口径与脚本（C1/C3 基线期→观察期，2026-10-10 立）**：不做 A/B，改用**同口径过程指标对照**。脚本＝`akasha/tools/observe.mjs`（只读）：单窗口 `--since/--until`、两窗口 `--base A:B --obs C:D`、`--json`。**六指标（定义写死防事后解释）**：M1 C1 触发数（kind=preflight）· M2 提示后 30 分钟内同工具再失败（**粗代理**）· M3 C3 触发数（kind=stateful-reminder）· M4 **同坑失败（回合级/会话级分列）**· M5 **可预防漏召率**（recallSignals preventable 口径）· M6 **H5 候选**（会话层更正语命中，**须人工复核**）。**判定先注册**：主判据＝观察期 M4 会话级 与 M5 同向下降；参考阈值＝可预防漏召率**第一期 ≤15%**（基线 83–91%）；反指标＝触发数暴涨判「噪声」；**负结果同样入 canon**。**已知局限**：M2 非因果 · M6 仅候选 · 样本小（每日 2–3 会话 / 8–13 次失败，只看趋势）· 两期任务构成不同，**不得作因果结论** · 库规模在变（复算须记库版本）。**首跑基线（2026-10-10）**：C1 触发 2（提示后同工具再失败 0）· C3 触发 0 · 同坑 13 回合/2 会话 · 失败 8 漏 7（87.5%）· 可预防 6 漏 5（83.3%）· H5 候选 11。",
  source: { type: "复现", ref: "docs/observation-metrics.md + tools/observe.mjs 实跑输出" },
  event_time: "2026-10-10",
  last_reviewed: "2026-10-10",
  tags: ["观察", "度量", "C1", "C3", "基线"],
});
console.log("+ " + r.id);
