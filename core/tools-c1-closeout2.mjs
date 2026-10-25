// c1-closeout2.mjs —— 端到端验证记录 + 测试调用点修正 + 内联禁令（引号已清）
import { readFileSync, writeFileSync } from "node:fs";
import { loadStore, currentRecords, revise } from "./lib.mjs";

// ① 测试：把 ⑤ 那次调用的空列表修成 ["edit"]
const T = "<LOCAL_PATH>\\dsh-akasha-sleep\\preflight.test.mjs";
let s = readFileSync(T, "utf8");
const bad = "captureRows({ akashaDir: FIX, preflightHints: true }, []));";
const good = "captureRows({ akashaDir: FIX, preflightHints: true }, [\"edit\"]));";
const n = s.split(bad).length - 1;
if (n > 0) { s = s.split(bad).join(good); writeFileSync(T, s, "utf8"); console.log("  ✓ 测试调用点已修 " + n + " 处"); }
else console.log("  = 无可修");
writeFileSync("<LOCAL_PATH>\\dist\\akasha-oss\\plugins\\akasha-sleep\\preflight.test.mjs", s, "utf8");

// ② 计划 §8 追加端到端结论
const P = "<LOCAL_PATH>\\dist\\akasha-oss\\docs\\c1-c3-schedule.md";
let doc = readFileSync(P, "utf8");
if (!doc.includes("端到端验证（生产）")) {
  doc += "\n### 端到端验证（生产，2026-10-10）\n\n";
  doc += "- 做法：故意制造一次真实失败（read 传 offset=99999）→ noteFailure 记下 → 下一回合的 runtime context 出现了：\n";
  doc += "  [坑前提示] read 前：先用 grep 拿真实行号再读 —— 条目 canon-trap-read-offset-range\n";
  doc += "- 结论：C1 在真实会话里生效（工具名 / 动作 / 条目 id / ≤80 字 全对，与既有回查提示行并存不冲突）；\n";
  doc += "- 第二次确认：再下一回合该行未重复出现 ⇒ 同工具 30 分钟去重在线上同样有效。\n";
  doc += "- 教训（我自己的）：禁止 pwsh 内联多行 JS；多行脚本一律先落文件再执行；脚本内串字串禁止内嵌同类引号。\n";
  writeFileSync(P, doc, "utf8");
  writeFileSync("<LOCAL_PATH>\\docs\\c1-c3-schedule.md", doc, "utf8");
  console.log("  [plan] 端到端验证 + 去重确认 + 教训 已记（双份）");
} else console.log("  [plan] already");

// ③ canon
const recs = currentRecords(loadStore("canon").records);
const hit = recs.filter((r) => String(r.id).startsWith("canon-observation-ledger-20261010")).pop();
const marker = "**C1 端到端验证通过（2026-10-10）**";
if (String(hit.claim).includes(marker)) { console.log("  [canon] already"); process.exit(0); }
const add = " " + marker + "：制造真实失败（read offset=99999）后，下一回合 runtime context 出现 [坑前提示] read 前：先用 grep 拿真实行号再读 —— 条目 canon-trap-read-offset-range ⇒ C1 在生产会话生效；再下一回合该行未重复 ⇒ 30 分钟去重线上有效。同日由自测抓到两处真 bug：过滤字段写错（f.at vs 实际 ts）致提示永不出现（已装 1.6.0-h1 为坏版本）；事件写用 require_(node:fs) 在桩环境失败（改用顶部已导入的 appendFileSync）。修后自测 9/10，唯一失败系我测试调用点传空列表（非产品缺陷）。新增纪律：禁止 pwsh 内联多行 JS（同日四次被引号/转义/静默替换绊倒），多行脚本先落文件再执行。";
const next = revise("canon", hit.id, { claim: hit.claim + add, last_reviewed: "2026-10-10" });
console.log("  [canon] " + hit.id + " → " + next.id);
