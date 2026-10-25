// canon-io.mjs —— 通用：从 JSON 文件建/改 canon 条目（避免把长中文写进 JS 字符串）
// 用法：
//   node tools/canon-io.mjs add    payload.json            # payload: {id, claim, source?, tags?, event_time?}
//   node tools/canon-io.mjs append payload.json            # payload: {id, text}（把 text 追加到该条目当前版本 claim 末尾）
import { readFileSync } from "node:fs";
import { loadStore, currentRecords, appendRecord, revise, todayLocal } from "./lib.mjs";

const [mode, file] = process.argv.slice(2);
if (!mode || !file) { console.log("用法：node tools/canon-io.mjs <add|append> <payload.json>"); process.exit(2); }
const p = JSON.parse(readFileSync(file, "utf8"));

if (mode === "add") {
  const recs = currentRecords(loadStore("canon").records);
  if (recs.some((r) => String(r.id).startsWith(p.id))) { console.log("= 已存在（跳过）：" + p.id); process.exit(0); }
  const rec = appendRecord("canon", {
    id: p.id, claim: p.claim,
    source: p.source || { type: "他人", ref: "n/a" },
    event_time: p.event_time || todayLocal(),
    last_reviewed: p.event_time || todayLocal(),
    tags: p.tags || [],
  });
  console.log("+ " + rec.id);
} else if (mode === "append") {
  const recs = currentRecords(loadStore("canon").records);
  const hit = recs.filter((r) => String(r.id).startsWith(p.id)).pop();
  if (!hit) { console.log("未找到条目：" + p.id); process.exit(1); }
  if (String(hit.claim).includes(p.text.slice(0, 24))) { console.log("= 已包含（跳过）"); process.exit(0); }
  const next = revise("canon", hit.id, { claim: hit.claim + " " + p.text, last_reviewed: todayLocal() });
  console.log(hit.id + " → " + next.id);
} else { console.log("mode 只支持 add / append"); process.exit(2); }
