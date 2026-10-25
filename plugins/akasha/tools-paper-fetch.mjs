// paper-fetch.mjs —— 免费学术源直连（arXiv / Semantic Scholar / OpenAlex / Crossref），产出 frontier 待审草案
// 设计原则：① 零账号零密钥（全部公共只读接口）② 只产草案、不自动入库（frontier 须人工审阅后落）
// 用法：
//   node tools/paper-fetch.mjs search "<关键词>" [--source arxiv|s2|openalex|crossref|all] [--n 5] [--draft]
//   node tools/paper-fetch.mjs id arXiv:2401.01234        # 按 id 取单篇
// 输出：终端表格 +（--draft）草案 JSON 落 _scratch/paper-drafts/
import { mkdirSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n, d = null) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const has = (n) => args.includes(n);
const N = Number(flag("--n", "5"));
const SRC = flag("--source", "all");
const UA = "akasha-book/1.0 (paper-fetch; local use)";
const cut = (s, n = 400) => String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, n);
const year = (d) => String(d || "").slice(0, 4);

async function getJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
  return r.json();
}
async function getText(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
  return r.text();
}

async function fromArxiv(q) {
  const url = "https://export.arxiv.org/api/query?search_query=all:" + encodeURIComponent(q) + "&max_results=" + N + "&sortBy=relevance";
  const xml = await getText(url);
  const out = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const pick = (tag) => (e.match(new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">")) || [])[1] || "";
    out.push({ source: "arxiv", id: cut(pick("id"), 200), title: cut(pick("title"), 240), year: year(pick("published")), venue: "arXiv", url: pick("id").trim(), abstract: cut(pick("summary")) });
  }
  return out;
}
async function fromS2(q) {
  const url = "https://api.semanticscholar.org/graph/v1/paper/search?query=" + encodeURIComponent(q) + "&limit=" + N + "&fields=title,abstract,year,venue,url,externalIds";
  const d = await getJson(url);
  return (d.data || []).map((p) => ({ source: "s2", id: (p.externalIds && (p.externalIds.ArXiv || p.externalIds.DOI)) || p.paperId, title: cut(p.title, 240), year: year(p.year), venue: p.venue || "S2", url: p.url || ("https://www.semanticscholar.org/paper/" + p.paperId), abstract: cut(p.abstract) }));
}
async function fromOpenAlex(q) {
  const url = "https://api.openalex.org/works?search=" + encodeURIComponent(q) + "&per-page=" + N;
  const d = await getJson(url);
  return (d.results || []).map((w) => ({ source: "openalex", id: w.doi || w.id, title: cut(w.title, 240), year: year(w.publication_year), venue: (w.primary_location && w.primary_location.source && w.primary_location.source.display_name) || "OpenAlex", url: w.doi || w.id, abstract: cut(w.abstract_inverted_index ? Object.keys(w.abstract_inverted_index).join(" ") : "") }));
}
async function fromCrossref(q) {
  const url = "https://api.crossref.org/works?query=" + encodeURIComponent(q) + "&rows=" + N + "&select=title,abstract,URL,issued,container-title,DOI";
  const d = await getJson(url);
  return ((d.message && d.message.items) || []).map((w) => ({ source: "crossref", id: w.DOI, title: cut((w.title || [])[0], 240), year: year(((w.issued || {})["date-parts"] || [[null]])[0][0]), venue: (w["container-title"] || [])[0] || "Crossref", url: w.URL, abstract: cut(w.abstract) }));
}

const SOURCES = { arxiv: fromArxiv, s2: fromS2, openalex: fromOpenAlex, crossref: fromCrossref };

if (cmd === "id") {
  const q = args[1] || "";
  const rows = q.startsWith("arXiv:") ? await fromArxiv(q.replace("arXiv:", "")) : await fromS2(q);
  print(rows);
} else if (cmd === "search") {
  const q = args[1] || flag("--q", "");
  if (!q) { console.log("用法：node tools/paper-fetch.mjs search \"<关键词>\" [--source arxiv|s2|openalex|crossref|all] [--n 5] [--draft]"); process.exit(2); }
  const names = SRC === "all" ? ["arxiv", "s2", "openalex", "crossref"] : [SRC];
  let rows = [];
  for (const n of names) {
    try { const got = await SOURCES[n](q); rows = rows.concat(got); console.log("[" + n + "] " + got.length + " 条"); }
    catch (e) { console.log("[" + n + "] 取回失败：" + e.message); }
  }
  print(rows);
} else {
  console.log("用法：node tools/paper-fetch.mjs search \"<关键词>\" [--source ...] [--n 5] [--draft]\n       node tools/paper-fetch.mjs id arXiv:2401.01234");
  process.exit(2);
}

function print(rows) {
  console.log("\n共 " + rows.length + " 条：");
  rows.slice(0, N * 4).forEach((r, i) => {
    console.log(" " + String(i + 1).padStart(2) + ". [" + r.source + "] " + r.year + " · " + r.title);
    console.log("     " + r.url);
    if (r.abstract) console.log("     摘要：" + r.abstract.slice(0, 140) + (r.abstract.length > 140 ? "…" : ""));
  });
  if (has("--draft")) {
    const dir = "<LOCAL_PATH>\\_scratch\\paper-drafts";
    mkdirSync(dir, { recursive: true });
    const next = new Date(Date.now() + 180 * 864e5).toISOString().slice(0, 10);
    const drafts = rows.map((r) => ({
      id: "front-" + String(r.title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) + "-" + r.year,
      claim: r.title + " —— " + (r.abstract ? r.abstract.slice(0, 240) : "（无摘要，须人工补读）"),
      source: { type: "官方", ref: r.url },
      next_review: next,
      tags: ["文献", r.source, r.year].filter(Boolean),
    }));
    const f = dir + "\\draft-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + ".json";
    writeFileSync(f, JSON.stringify(drafts, null, 1), "utf8");
    console.log("\n[草案] " + drafts.length + " 条 → " + f + "\n（须人工审阅：核来源可靠性 + 补要点，再用 frontier add 落库）");
  }
}
