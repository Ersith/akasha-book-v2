// openviking-task-record2.mjs —— 把"定时探活"装进 canon（引号已清，check 通过后才跑）
import { loadStore, currentRecords, revise } from "./lib.mjs";

const recs = currentRecords(loadStore("canon").records);
const hit = recs.filter((r) => String(r.id).startsWith("canon-openviking-stall-20261010")).pop();
if (!hit) { console.log("未找到条目"); process.exit(1); }
if (String(hit.claim).includes("定时探活已装")) { console.log("= 已记录"); process.exit(0); }
const add = " **定时探活已装（2026-10-10，用户批准）**：Windows 计划任务 **`OpenViking-Health-AutoFix`**，每 **15 分钟**执行 `node <LOCAL_PATH>\\tools\\openviking-health.mjs --fix`（不在听则清僵死 + WMI 拉起 + 复探），日志落 `openviking-server\\health.log`；**实测已跑通**（`schtasks /Run` 后 health.log 新增一条 `probe=true`，任务状态 Ready、Next Run 已排）。**回滚**：`schtasks /Delete /TN OpenViking-Health-AutoFix /F`。**注意**：任务为「仅登录时运行」——桌面端未登录时探活不会跑，这是刻意保留的（避免无人看管时反复拉起服务）。";
const next = revise("canon", hit.id, { claim: hit.claim + add, last_reviewed: "2026-10-10" });
console.log(hit.id + " → " + next.id);
