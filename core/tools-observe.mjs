// observe.mjs —— C1/C3 过程指标与「基线期 vs 观察期」同口径对照（只读；不改任何数据）
// 用法：
//   node tools/observe.mjs --since 2026-10-10 --until 2026-10-12          # 单窗口报告
//   node tools/observe.mjs --base 2026-10-10:2026-10-12 --obs 2026-10-13:2026-10-17   # 两窗口对照
//   node tools/observe.mjs --since 2026-10-10 --json                      # 附 JSON 摘要
// 口径（写死，防事后解释）：
//   · preflight 触发数 = hooks 里 kind=preflight（C1）
//   · 提示后同工具再失败 = 该 preflight 之后 30 分钟内，同工具出现 ok:false（提示无效的粗代理）
//   · stateful 触发数 = kind=stateful-reminder（C3）
//   · 同坑复发 = 落在 RECALL_TRAP_MAP 覆盖工具上的失败：**回合级**（逐次）与**会话级**（同会话只算一次）分列
//   · 可预防漏召 = recallSignals 的 preventable 口径（回合级）；会话级另算
//   · 矛盾式漏召（H5 候选）= 会话层 gist 命中「更正/恰恰相反/我错了/已纠正」等更正语（**候选，须人工复核**）
import { readFileSync } from "node:fs";
import { recallSignals, RECALL_TRAP_MAP, sessionKeyOf } from "./lib.mjs";

const LOG = "<AKASHA_DIR>\\logs\\hooks.jsonl";
const SESS = "<AKASHA_DIR>\\data\\session.jsonl";
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const since = flag("--since"), until = flag("--until"), wantJson = args.includes("--json");
const base = flag("--base"), obs = flag("--obs");

const parse = (p) => { const out = []; let t = ""; try { t = readFileSync(p, "utf8"); } catch { return out; }
  for (const l of t.split(/\r?\n/)) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* skip */ } } return out; };
const day = (ts) => String(ts || "").slice(0, 10);
const inWin = (ts, w) => { const d = day(ts); return (!w.s || d >= w.s) && (!w.u || d <= w.u); };
const winOf = (spec, fallback) => { if (!spec) return { s: fallback.s, u: fallback.u }; const [s, u] = String(spec).split(":"); return { s: s || null, u: u || null }; };

function report(w) {
  const hooks = parse(LOG).filter((r) => inWin(r.ts, w));
  const pre = hooks.filter((r) => r.kind === "preflight");
  const stf = hooks.filter((r) => r.kind === "stateful-reminder");
  // 提示无效（粗代理）：preflight 后 30 分钟内同工具再失败
  const fails = hooks.filter((r) => r.kind === "tool" && r.ok === false);
  let ineffective = 0;
  for (const p of pre) {
    const t0 = Date.parse(p.ts);
    if (fails.some((f) => f.tool === p.tool && Date.parse(f.ts) - t0 > 0 && Date.parse(f.ts) - t0 <= 30 * 60 * 1000)) ineffective++;
  }
  // 同类失败：回合级 / 会话级
  const mappedTools = new Set(Object.keys(RECALL_TRAP_MAP));
  const mappedFails = fails.filter((f) => mappedTools.has(String(f.tool)));
  const sessWithMapped = new Set(mappedFails.map((f) => sessionKeyOf(f)));
  // 可预防漏召（沿用 lib 口径）
  const r = recallSignals(hooks, { toolTraps: mappedTools });
  // H5 候选（会话层更正语）
  const sess = parse(SESS).filter((x) => inWin(x.time, w));
  const h5 = sess.filter((x) => x.kind && /更正|恰恰相反|我错了|已纠正|改口/.test(String(x.gist || "")) && !String(x.gist || "").startsWith("Current runtime context") && !String(x.gist || "").includes("阿卡夏·"));
  const out = {
    window: (w.s || "*") + " → " + (w.u || "now"),
    hooksInWindow: hooks.length,
    preflight: pre.length,
    preflightIneffective: ineffective,
    stateful: stf.length,
    mappedToolFails_turn: mappedFails.length,
    mappedToolFails_session: sessWithMapped.size,
    failureTurns: r.failureTurns, misses: r.misses,
    missRate: +(r.missRate * 100).toFixed(1),
    preventable: { fails: r.preventable.fails, missed: r.preventable.missed, rate: +(r.preventable.missRate * 100).toFixed(1) },
    h5Candidates: h5.length,
    byTool: r.byTool,
  };
  return out;
}

const line = (o) =>
  "  窗口 " + o.window + "：hooks " + o.hooksInWindow +
  " | C1 触发 " + o.preflight + "（其中提示后同工具再失败 " + o.preflightIneffective + "）" +
  " | C3 触发 " + o.stateful +
  " | 同坑失败 回合级 " + o.mappedToolFails_turn + " / 会话级 " + o.mappedToolFails_session +
  " | 失败回合 " + o.failureTurns + " 漏 " + o.misses + "（" + o.missRate + "%）" +
  " | 可预防 " + o.preventable.fails + " 漏 " + o.preventable.missed + "（" + o.preventable.rate + "%）" +
  " | H5 候选 " + o.h5Candidates;

let json = {};
if (base || obs) {
  const b = report(winOf(base, { s: null, u: null })), o = report(winOf(obs, { s: null, u: null }));
  console.log("基线 vs 观察（同口径）");
  console.log(line(b)); console.log(line(o));
  const d = (x, y) => (x ? (y - x) : 0);
  console.log("  差值：C1 " + d(b.preflight, o.preflight) + " · C3 " + d(b.stateful, o.stateful) +
    " · 同坑回合级 " + d(b.mappedToolFails_turn, o.mappedToolFails_turn) +
    " · 同坑会话级 " + d(b.mappedToolFails_session, o.mappedToolFails_session) +
    " · 漏召率 " + (b.missRate + "→" + o.missRate) + " · 可预防漏召率 " + (b.preventable.rate + "→" + o.preventable.rate));
  json = { base: b, obs: o };
} else {
  const o = report({ s: since, u: until });
  console.log("单窗口报告"); console.log(line(o));
  console.log("  按工具（回合级失败）：" + Object.entries(o.byTool || {}).sort((a, b2) => b2[1].fails - a[1].fails).slice(0, 6).map(([t, v]) => t + "×" + v.fails + (v.preventableMisses ? "(可预防漏" + v.preventableMisses + ")" : "")).join("  "));
  json = { window: o };
}
if (wantJson) console.log("\nJSON:\n" + JSON.stringify(json, null, 1));
