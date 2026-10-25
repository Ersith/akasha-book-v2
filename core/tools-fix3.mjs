// fix3.mjs —— ① 门控 shell 分支收窄 ② pwsh 专属坑条目+映射 ③ C3 词表补自然说法
import { readFileSync, writeFileSync } from "node:fs";
import { loadStore, currentRecords, appendRecord } from "./lib.mjs";

// ---------- ① 门控收窄 ----------
const G = ["<LOCAL_PATH>\\dist\\akasha-oss\\plugins\\akasha-gate\\index.js", "<LOCAL_PATH>\\dsh-akasha-gate\\index.js"];
const G_ANCHOR = "const WRITE_IDIOM = ";
const G_ADD = `// 2026-10-10 假阳性修复：shell 命令的写构造判定（收窄）——只认重定向与写/删类构造，
// 不再用广义写词表（那张表会让「只读命令里出现 data 路径」也被拒；当日实测被误拦一次）。
const WRITE_CMD = /(>>|(?<![=\\-])>(?![&=])|Set-Content|Add-Content|Out-File|Remove-Item|Move-Item|Copy-Item|New-Item|Set-Item|\\bdel\\b|\\brm\\b|tee\\b|sed -i)/i;
`;
const G_OLD = "if (command && mentionsDataDir(command) && WRITE_IDIOM.test(command)) {";
const G_NEW = "if (command && mentionsDataDir(command) && WRITE_CMD.test(command)) {";
for (const f of G) {
  let t = readFileSync(f, "utf8");
  if (t.includes("WRITE_CMD")) { console.log("  = 门控已修：" + f); continue; }
  if (!t.includes(G_ANCHOR) || !t.includes(G_OLD)) { console.log("  ✗ 门控锚点缺失：" + f); continue; }
  t = t.replace(G_ANCHOR, G_ADD + G_ANCHOR).replace(G_OLD, G_NEW);
  writeFileSync(f, t, "utf8");
  console.log("  ✓ 门控已收窄：" + f);
}

// ---------- ② pwsh 专属坑条目 ----------
const recs = currentRecords(loadStore("canon").records);
if (!recs.some((r) => String(r.id).startsWith("canon-trap-pwsh-inline-js"))) {
  const r = appendRecord("canon", {
    id: "canon-trap-pwsh-inline-js",
    claim: "**工具陷阱·pwsh 内联多行脚本（可执行条目）**。**触发**：把多行 JS/Python 直接塞进 pwsh 的 node -e 或单行命令；或脚本串里内嵌同类引号。**症状**：Unterminated string constant / Unexpected identifier / 替换静默 0 处却当成功（2026-10-10 单日四次）。**正确动作**：① 多行脚本一律先落 .mjs 文件再执行；② 运行前 node --check <脚本>；③ 串内禁止内嵌同类引号（用「」或外层换引号）；④ 中文命令行走命令行时优先纯 ASCII。**自检问句**：这段代码是文件，还是我正往命令行里塞？",
    source: { type: "复现", ref: "2026-10-10 单日内联翻车 4 次记录" },
    event_time: "2026-10-10", last_reviewed: "2026-10-10", tags: ["陷阱", "pwsh", "工具坑", "C1素材"],
  });
  console.log("  + " + r.id);
} else console.log("  = pwsh 条目已存在");
for (const f of ["<AKASHA_DIR>\\lib.mjs", "<LOCAL_PATH>\\dist\\akasha-oss\\core\\lib.mjs"]) {
  let t = readFileSync(f, "utf8");
  const old = "  pwsh: ['canon-review-manual-20261010', 'canon-npm-publish-20261010', 'canon-dsh-store-remediation-20261010'],";
  const neu = "  pwsh: ['canon-trap-pwsh-inline-js', 'canon-review-manual-20261010', 'canon-npm-publish-20261010', 'canon-dsh-store-remediation-20261010'],";
  if (t.includes(old)) { writeFileSync(f, t.replace(old, neu), "utf8"); console.log("  ✓ pwsh 映射前置：" + f.split("\\").pop()); }
  else console.log("  = pwsh 映射未改（已是新版或锚点不符）：" + f.split("\\").pop());
}

// ---------- ③ C3 词表补自然说法 ----------
const S = ["<LOCAL_PATH>\\dsh-akasha-sleep\\lib\\index.js", "<LOCAL_PATH>\\dist\\akasha-oss\\plugins\\akasha-sleep\\lib\\index.js"];
const S_OLD = '      { cat: "开关", re: /开关|启用|禁用|默认开|默认关/ },';
const S_NEW = '      { cat: "开关/运行", re: /开关|启用|禁用|默认开|默认关|开着|关着|在跑|跑着|还在吗|开着吗|装着吗|有没有开/ },';
for (const f of S) {
  let t = readFileSync(f, "utf8");
  if (t.includes("开着吗")) { console.log("  = C3 词表已补：" + f.split("\\").pop()); continue; }
  if (!t.includes(S_OLD)) { console.log("  ✗ C3 词表锚点缺失：" + f); continue; }
  writeFileSync(f, t.replace(S_OLD, S_NEW), "utf8");
  console.log("  ✓ C3 词表已补：" + f.split("\\").pop());
}
