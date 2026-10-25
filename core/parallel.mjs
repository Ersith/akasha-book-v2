// 阿卡夏·并行会话感知（parallel awareness）v0 — 2026-10-18
// 目的：给当前会话一条「其他主会话在做什么」的内部反馈条（不写入会话层）。
// 数据源：akasha/data/session.jsonl 的 conclusion 段（已带 event time / logged_at / turn / seq / gist）。
// 口径（2026-10-18 用户裁定）：
//   · 每会话只取最新一条结论；只保留最近 60 分钟内活跃的会话（窗口可调）；
//   · 压缩成「做了什么 / 完成 / 下一步」三行，不送思考与工具细节；
//   · 每条都带 seq 指针（深查用 session_event_read(session, seq)，不做全局检索）；
//   · 子代理不进（session-meta 只含主会话；仍按 meta 白名单兜底）；
//   · 每条都标注「另一会话·非本会话·仅同步大致记忆点」。
import { openSync, readSync, closeSync, statSync, existsSync, readFileSync } from 'node:fs';

export const PARALLEL_DEFAULTS = {
  windowMinutes: 60,
  limit: 2,
  tailBytes: 2 * 1024 * 1024,
  didMax: 46,
  doneMax: 34,
  nextMax: 34
};

const norm = (s) => String(s ?? '').replace(/^session-/, '');
const cut = (s, n) => { const t = String(s ?? '').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const clean = (s) => String(s ?? '').replace(/\*\*|__|`/g, '').replace(/#{1,6}\s*/g, '').replace(/\s+/g, ' ').trim();
const sentences = (s) => clean(s).split(/(?<=[。！？!?；;])\s*|\n+/).map((x) => x.replace(/^[#>*+\-\s]+/, '').trim()).filter(Boolean);

/** 读文件尾部若干字节并解析出 conclusion 记录（append-only 索引，尾部窗口足够覆盖最近若干轮）。 */
export function readTailConclusions(file, maxBytes = PARALLEL_DEFAULTS.tailBytes) {
  if (!file || !existsSync(file)) return [];
  const size = statSync(file).size;
  if (size <= 0) return [];
  const start = Math.max(0, size - maxBytes);
  const len = size - start;
  const buf = Buffer.allocUnsafe(len);
  const fd = openSync(file, 'r');
  let text = '';
  try { const n = readSync(fd, buf, 0, len, start); text = buf.subarray(0, n).toString('utf8'); } finally { closeSync(fd); }
  if (start > 0) {
    const nl = text.indexOf('\n');
    if (nl < 0) return [];
    text = text.slice(nl + 1);
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    if (!line.includes('"kind":"conclusion"')) continue;
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r && r.kind === 'conclusion' && r.session && r.time) out.push(r);
  }
  return out;
}

const DONE_RE = /完成|修好|通过|落库|搞定|成功|收口|已(?:执行|修复|验证|完成|删除|安装|对齐|收口)/;
const NEXT_RE = /下一步|接下来|待办|还需|剩余|计划|要(?:做|去)|将会|随后|准备/;
const NEG_RE = /失败|放弃|回滚|无法|未(?:能|完成|做)|没(?:有|能)/;

/** 先按 Markdown 结构（标题/列表/有序项/✅）切段，再按句读切；gist 已被上游折叠成单行，不能只靠 \n。 */
function segments(gist) {
  return String(gist ?? '')
    .split(/\s*(?:#{1,6}\s+|[-*•]\s+|\d+[.、)]\s*|✅\s*)/)
    .flatMap((chunk) => sentences(chunk))
    .map((x) => x.replace(/^Master[，,]\s*/, '').trim())
    .filter(Boolean);
}

/** 把一条结论 gist 压成「做了什么 / 完成 / 下一步」（机械启发式，不编造）。 */
export function summarizeGist(gist) {
  const ss = segments(gist);
  const first = ss[0] || '';
  const rest = ss.slice(1);
  const done = rest.find((s) => DONE_RE.test(s) && !NEG_RE.test(s)) || '';
  const next = rest.find((s) => NEXT_RE.test(s) && !NEG_RE.test(s)) || '';
  return {
    did: cut(first, PARALLEL_DEFAULTS.didMax),
    done: cut(done, PARALLEL_DEFAULTS.doneMax),
    next: cut(next, PARALLEL_DEFAULTS.nextMax),
    title: cut(first, 18)
  };
}

/**
 * 收集并行会话的最新结论。
 * @returns {{total:number, entries:Array, windowMinutes:number, nowMs:number}}
 */
export function collectParallel({ file, metaFile, exclude, nowMs = Date.now(), windowMinutes = PARALLEL_DEFAULTS.windowMinutes, limit = PARALLEL_DEFAULTS.limit } = {}) {
  const ex = new Set((Array.isArray(exclude) ? exclude : [exclude]).map(norm).filter(Boolean));
  let allowed = null;
  if (metaFile && existsSync(metaFile)) {
    try {
      const sessions = JSON.parse(readFileSync(metaFile, 'utf8')).sessions || {};
      const main = new Set();
      for (const [k, v] of Object.entries(sessions)) {
        const src = String((v && v.source) || '');
        // 主会话档案目录是 session-<uuid>；子代理是裸 uuid 目录 ⇒ 只放主会话。
        if (/[\\/]session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[\\/]/i.test(src)) main.add(norm(k));
      }
      allowed = main.size > 0 ? main : null;
    } catch { /* meta 坏 → 不筛 */ }
  }
  const windowMin = Math.max(1, Number(windowMinutes) || PARALLEL_DEFAULTS.windowMinutes);
  const windowMs = windowMin * 60000;
  const latest = new Map();
  for (const r of readTailConclusions(file)) {
    const sid = norm(r.session);
    if (!sid || ex.has(sid)) continue;
    if (allowed && !allowed.has(sid)) continue;
    const t = Date.parse(r.time);
    if (!Number.isFinite(t) || nowMs - t > windowMs) continue;
    const cur = latest.get(sid);
    if (!cur || Date.parse(cur.time) < t) latest.set(sid, r);
  }
  const rows = [...latest.values()].sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
  const total = rows.length;
  const entries = rows.slice(0, Math.max(1, Number(limit) || PARALLEL_DEFAULTS.limit)).map((r) => {
    const s = summarizeGist(r.gist || '');
    return {
      session: norm(r.session),
      turn: Number.isInteger(r.turn) ? r.turn : null,
      seq: Number.isInteger(r.seq) ? r.seq : null,
      time: r.time,
      logged_at: r.logged_at ?? null,
      ageMin: Math.round((nowMs - Date.parse(r.time)) / 60000),
      did: s.did,
      done: s.done,
      next: s.next,
      title: s.title
    };
  });
  return { total, entries, windowMinutes: windowMin, nowMs };
}

const pad = (n) => String(n).padStart(2, '0');
const fmtTime = (iso) => { const d = new Date(iso); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

/** 单条并行反馈（内部反馈样式，不是会话层内容）。 */
export function renderParallelEntry(e) {
  const parts = [`做了什么：${e.did || '—'}`];
  if (e.done) parts.push(`完成：${e.done}`);
  if (e.next) parts.push(`下一步：${e.next}`);
  const ptr = Number.isInteger(e.seq) ? ` · ptr session=${e.session} seq=${e.seq}` : '';
  return `[${fmtTime(e.time)}] 并行·另一会话（非本会话·仅同步大致记忆点）：session-${e.session.slice(0, 8)} turn ${e.turn ?? '?'} · ${parts.join('；')}${ptr}`;
}

/** 多条合成一段（无条目 → null，静默）。 */
export function renderParallelFeed(r) {
  if (!r || !Array.isArray(r.entries) || r.entries.length === 0) return null;
  const lines = r.entries.map(renderParallelEntry);
  const hidden = (r.total || 0) - r.entries.length;
  if (hidden > 0) lines.push(`· 另有 ${hidden} 个活跃会话（node akasha.mjs session parallel 查看）`);
  return lines.join('\n');
}
