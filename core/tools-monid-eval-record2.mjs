// monid-eval-record2.mjs —— Monid 评估结论 + 接入前置（canon；引号已清）
import { loadStore, currentRecords, appendRecord } from "./lib.mjs";

const recs = currentRecords(loadStore("canon").records);
if (recs.some((r) => String(r.id).startsWith("canon-monid-eval-20261010"))) { console.log("= 已存在"); process.exit(0); }
const r = appendRecord("canon", {
  id: "canon-monid-eval-20261010",
  claim: "**Monid 评估（2026-10-10；用户给的接入判据＝能否供给知识层：基石文献 / 一般知识教程 / 可形成知识与推理的经验链）**。**它是什么**：`monid.ai`＝**agent 工具/数据接口的聚合与统一计费层**（自称 1700+ tools；业界称「agent tools 的 OpenRouter」；2026 年获 7.7M 美元种子轮；Delaware C-Corp）。**它不自己抓数据**——转售上游（Apify / TikTokHub 等 scraping、Exa / TinyFish search、Ahrefs、Apollo、Seedance 等）。**结论：按该判据，现状＝不接入**——目录强项是**社媒/电商 scraping 与情报 enrichment**，**未见学术源**；且其 `SKILL.md` 自己把「academic-search MCP」列为**用户已有工具、不该经它**的例子 ⇒ 对「基石文献」**边际增益≈0**（原生 `web_search` / `web_fetch` 已覆盖通用检索；文献基石正解＝arXiv / OpenAlex / Semantic Scholar / Crossref / PubMed 等学术源）。**接入前置三条（若将来要接）**：① 只在它能补**知识层**缺口时接，且**只挑单条源**、小额度、先验质量与合规；② **API key 禁止贴进对话或记忆**——其 SKILL 建议「让用户粘贴 key」，那会把密钥写进会话记录；必须改为**文件/env 注入**并只存于我们掌控的路径；③ **它的自更新 skill 不得自动落进我们的技能库**——`SKILL.md` 明确要求 agent **把最新版 skill 存进技能目录并启用、以便后续会话自动加载**（＝行为注入面）；接入须**人工审阅 + 固定版本、禁自动更新**。**其它风险**：`monid setup --email` 会复用上下文里的邮箱（身份外发面）；`sfs` provider 会把本地文件上传到 `sfs.monid.ai`（数据离机）；`npm install -g @monid-ai/cli` 属全局安装；上游断供/涨价。**再评估触发条件**：若确需其某条学术/文献源，先装 CLI + 免费账号跑 `monid discover -q academic paper` 证实目录里真有，再按前置三条小样验证。**另记**：该推文（@Astronaut_1216）为**带返佣链接**的推广（URL 带 fpr / af_tid 参数），非中立评测。",
  source: { type: "官方", ref: "https://monid.ai/SKILL.md (v0.1.7) · https://monid.ai/ · https://monid.ai/tools · Forkast 报道（7.7M 美元种子轮）" },
  event_time: "2026-10-10",
  last_reviewed: "2026-10-10",
  tags: ["评估", "外部工具", "接入判据", "Monid"],
});
console.log("+ " + r.id);
