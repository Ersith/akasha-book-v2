// openviking-fix-record.mjs —— 记录：OpenViking 僵死根因 + 处置脚本 + runbook + 触发信号
import { loadStore, currentRecords, appendRecord } from "./lib.mjs";

const recs = currentRecords(loadStore("canon").records);
if (recs.some((r) => String(r.id).startsWith("canon-openviking-stall-20261010"))) { console.log("= 已存在"); process.exit(0); }
const r = appendRecord("canon", {
  id: "canon-openviking-stall-20261010",
  claim: "**OpenViking 服务端僵死与处置（2026-10-10 首见，已排障＋自愈＋成文）**。**形态**：宿主弹「工具已更新 · 移除 15 个」（`mcp__openviking_*` 整批消失）⇒ 此后 `list_mcp_resources(openviking)` 报 **server is disconnected**；**阿卡夏（`mcp__akasha__*`）不受影响**。**链路**：`@haven/openviking-memory`（stdio 代理 `mcp-proxy.mjs`）→ **HTTP `http://127.0.0.1:<PORT>`**（端口在插件 `cordis.patch.yml` 的 `endpoint`）。**根因**：`openviking-server.exe` **进程活着但 1933 监听丢失**——`server.out.log` 尾部 `ClientDisconnect` → `ERROR Received exception from stream` → `WM update tool_call failed (Request timed out.)` ⇒ 会话流异常后**未重新 bind 端口**；客户端连不上且**不会自动重连**。**诱因**：与短时间**多次重启桌面端**高度相关。**处置**（实测有效）：① `Test-NetConnection 127.0.0.1 -Port 1933` 判定；② `node <LOCAL_PATH>\\tools\\openviking-health.mjs [--fix]`（探活 / 清僵死 + **WMI 脱离式**拉起 + 复探，日志落 `openviking-server\\health.log`）；③ 服务端起来后**重启桌面端**让宿主客户端重连（重启后核 `list_mcp_resources(openviking)` 不再 disconnected ⇒ 已验证恢复）。**坑**：**不要跑 `start-server.bat`**——其 `start /b` 会挂住调用方控制台（当日实测被挂住 10 分钟）；`openviking` 无 CLI；**进程存在 ≠ 服务可用，判据永远是 1933 能否连**。**触发信号（写死）**：见到「工具已更新 · 移除 N 个」且涉及 `mcp__openviking_*` ⇒ 立即按 `docs/runbook/openviking-recover.md` 处置。",
  source: { type: "复现", ref: "排障记录 docs/runbook/openviking-recover.md（含端口/日志/进程三类证据）＋ tools/openviking-health.mjs（自测 exit=0 在听）" },
  event_time: "2026-10-10",
  last_reviewed: "2026-10-10",
  tags: ["运维", "OpenViking", "排障", "自愈"],
});
console.log("+ " + r.id);
