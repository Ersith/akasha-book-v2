// akasha/recog.mjs —— 再认知（re-cognition）离线层（2026-10-22，按 design-recognition-and-category 稿）
// 手令触发；只读选样 → 计划 JSON → 人工/模型填 decisions → --yes 只追加落库。
// 三态：still-holds（追加 verification + last_reviewed）/ superseded（revise）/ answered（orphan 软退役）。
// 严格只追加：不直接改原行；没有证据的 still-holds 一律拒绝（复读机防线）。
// R1/R2（2026-10-22 GPT 复审）：操作键 (batchId, sourceId) 与实际 revision/tombstone 同行落库；
// 回执只是可重建汇总；计划带 tip 版本闸，链尾已变 ⇒ stale-plan。
import { appendFileSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { LOGS_DIR, currentRecords, loadStore, retireRecord, revise, storePath, todayLocal, writeFileAtomic } from './lib.mjs';

export const RECOG_VERDICTS = ['still-holds', 'superseded', 'answered'];
export const RECOG_MAX_BATCH = 20;
export const RECOG_DEFAULT_STALE_DAYS = 90;

const asDay = (v) => {
  const s = String(v ?? '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};
const dayMs = (s) => {
  const t = Date.parse(s + 'T00:00:00Z');
  return Number.isFinite(t) ? t : null;
};
const ageDays = (anchor, today) => {
  const a = asDay(anchor), b = asDay(today);
  if (!a || !b) return null;
  const x = dayMs(a), y = dayMs(b);
  return x === null || y === null ? null : Math.floor((y - x) / 86400000);
};

function recordsFor(store, files = {}) {
  return currentRecords(loadStore(store, files[store]).records);
}

function shortHash(text) {
  return createHash('sha256').update(String(text)).digest('hex').slice(0, 8);
}

function tipOf(store, id, files = {}) {
  return tipFromRecords(loadStore(store, files[store]).records, id);
}

function tipFromRecords(records, id) {
  const byId = new Map(records.map((r) => [r.id, r]));
  let tip = byId.get(id);
  if (!tip) return null;
  const seen = new Set([tip.id]);
  for (;;) {
    const next = records.find((r) => r.supersedes === tip.id);
    if (!next || seen.has(next.id)) break;
    seen.add(next.id);
    tip = next;
  }
  return tip.id;
}

function decisionFingerprint(a) {
  return createHash('sha256').update(JSON.stringify({ verdict: a.verdict, evidence: String(a.evidence), newClaim: a.newClaim ?? null, today: a.today })).digest('hex').slice(0, 16);
}

/**
 * 只读选样。scope: canon | orphan | all（all 明确只含 canon+orphan；session L0 未接）。
 * 默认 90 天，手动 --stale-days 可调。返回 {batchId, ..., items, capped}；不写任何文件。
 */
export function buildRecogBatch(opts = {}) {
  const today = asDay(opts.today) || todayLocal();
  const rawScope = opts.scope ?? 'all';
  if (!['canon', 'orphan', 'all'].includes(rawScope)) throw new Error('recog scope 不支持：' + rawScope + '（可选 canon / orphan / all；all 不含 session）');
  const scope = rawScope;
  const staleDays = Number.isInteger(opts.staleDays) && opts.staleDays > 0 ? opts.staleDays : RECOG_DEFAULT_STALE_DAYS;
  const max = Number.isInteger(opts.max) && opts.max > 0 ? Math.min(opts.max, RECOG_MAX_BATCH) : RECOG_MAX_BATCH;
  const files = opts.files && typeof opts.files === 'object' ? opts.files : {};
  const stores = scope === 'all' ? ['canon', 'orphan'] : [scope];
  const all = [];
  for (const store of stores) {
    for (const r of recordsFor(store, files)) {
      const anchor = store === 'canon'
        ? (asDay(r.last_reviewed) || asDay(r.event_time) || asDay(r.logged_at) || asDay(r.created))
        : (asDay(r.created) || asDay(r.event_time) || asDay(r.logged_at));
      const age = anchor ? ageDays(anchor, today) : null;
      if (age === null) continue;             // 无日期锚：不猜，留给 review
      if (age < staleDays) continue;
      all.push({
        store,
        id: r.id,
        tip: r.id,                             // R2：计划生成时的链尾；apply 时链尾变了 ⇒ stale-plan
        claim: String(store === 'canon' ? (r.claim ?? '') : (r.summary ?? '')).slice(0, 240),
        anchor,
        ageDays: age,
      });
    }
  }
  all.sort((a, b) => (b.ageDays - a.ageDays) || String(a.id).localeCompare(String(b.id)));
  const capped = all.length > max;
  const items = all.slice(0, max);
  const batchId = 'recog-' + today.replace(/-/g, '') + '-' + scope + '-' + shortHash(staleDays + '|' + items.map((x) => x.store + ':' + x.id).join(','));
  return { batchId, createdAt: new Date().toISOString(), today, scope, staleDays, max, items, capped, omitted: Math.max(0, all.length - items.length) };
}

function physicalPath(file) {
  try { return realpathSync.native(file); }
  catch {
    try { return join(realpathSync.native(dirname(file)), basename(file)); }
    catch { return resolve(file); }
  }
}

function samePhysicalFile(a, b) {
  const pa = physicalPath(a), pb = physicalPath(b);
  if (pa.toLowerCase() === pb.toLowerCase()) return true; // Windows 大小写/设备前缀归一
  try {
    const sa = statSync(a), sb = statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch { return false; }
}

export function writeRecogPlan(batch, file) {
  if (!file) throw new Error('writeRecogPlan 需要输出路径');
  const out = resolve(file);
  for (const store of ['canon', 'mirror', 'orphan', 'pricing', 'lexicon', 'frontier']) {
    const target = resolve(storePath(store));
    if (out === target || samePhysicalFile(out, target)) {
      throw new Error(`拒绝把计划写到 ${store} 存储文件：${out}`);
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify({ ...batch, decisions: [] }, null, 2) + '\n');
  return file;
}

export function loadRecogPlan(file) {
  const plan = JSON.parse(readFileSync(file, 'utf8'));
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.items)) throw new Error('再认知计划格式非法：缺 items');
  return plan;
}

function validatePlan(plan) {
  if (!plan || typeof plan !== 'object' || !Array.isArray(plan.items)) throw new Error('计划必须是含 items 的对象');
  if (!Array.isArray(plan.decisions)) throw new Error('计划必须带 decisions 数组');
  if (typeof plan.batchId !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(plan.batchId)) throw new Error('计划 batchId 非法');
  if (plan.items.length > RECOG_MAX_BATCH) throw new Error(`单批不得超过 ${RECOG_MAX_BATCH} 条`);
  const ids = new Set();
  for (const it of plan.items) {
    if (!it || !['canon', 'orphan'].includes(it.store) || typeof it.id !== 'string') throw new Error('items 项必须是 canon/orphan + id');
    if (typeof it.tip !== 'string' || !it.tip) throw new Error('items 缺少 tip（旧计划请用当前版本重建）：' + it.store + ':' + it.id);
    const key = it.store + ':' + it.id;
    if (ids.has(key)) throw new Error('计划内重复 item：' + key);
    ids.add(key);
  }
  const seen = new Set();
  for (const d of plan.decisions) {
    if (!d || typeof d.id !== 'string') throw new Error('decision 缺 id');
    const key = d.store + ':' + d.id;
    if (!ids.has(key)) throw new Error('decision 不在计划 items 内：' + key);
    if (seen.has(key)) throw new Error('同一 item 只能有一个 decision：' + key);
    seen.add(key);
    if (!RECOG_VERDICTS.includes(d.verdict)) throw new Error('verdict 须为 ' + RECOG_VERDICTS.join('/') + '：' + key);
    if (!String(d.evidence ?? '').trim()) throw new Error('每条 decision 必须带 evidence（新证据/反例检索）：' + key);
    if (d.verdict === 'still-holds' && d.store !== 'canon') throw new Error('still-holds 只适用于 canon：' + key);
    if (d.verdict === 'superseded' && (d.store !== 'canon' || !String(d.newClaim ?? '').trim())) throw new Error('superseded 需 canon + newClaim：' + key);
    if (d.verdict === 'answered' && d.store !== 'orphan') throw new Error('answered 只适用于 orphan：' + key);
  }
  return plan;
}

function legacyAnswered(records, a) {
  const markerRe = /(?:^|·\s*)recog-batch:([A-Za-z0-9._-]{1,80})\s*$/;
  const revoked = new Set(records.map((r) => r.revokes).filter((v) => typeof v === 'string' && v !== ''));
  return records.find((r) => {
    if (r.recog || r.retires !== a.sourceId || revoked.has(r.id)) return false;
    const m = String(r.retired_reason || '').match(markerRe);
    return !!m && m[1] === a.batchId;
  });
}

function actionDone(a, files) {
  const records = loadStore(a.store, files[a.store]).records;
  // R1：先识别本操作已完成（无论回执在不在），再谈版本漂移——避免把自己的成功当成漂移。
  for (const r of records) {
    if (r && r.recog && r.recog.batchId === a.batchId && r.recog.sourceId === a.sourceId) {
      if (r.recog.verdict !== a.verdict || r.recog.fingerprint !== a.fingerprint) throw new Error('同一操作键已有不同 decision（冲突）：' + a.store + ':' + a.sourceId);
      return true;
    }
  }
  if (a.verdict === 'answered') return !!legacyAnswered(records, a);
  return false;
}

// R1/R2 最终守卫：必须在 revise/retire 的 store 锁内执行（不再把锁外检查当最终写守卫）。
function guardFor(a) {
  return (records) => {
    for (const r of records) {
      if (r && r.recog && r.recog.batchId === a.batchId && r.recog.sourceId === a.sourceId) {
        if (r.recog.verdict !== a.verdict || r.recog.fingerprint !== a.fingerprint) throw new Error('同一操作键已有不同 decision（冲突）：' + a.store + ':' + a.sourceId);
        return { already: true };
      }
    }
    if (a.verdict === 'answered') {
      const legacy = legacyAnswered(records, a);
      if (legacy) return { already: true };
      const revoked = new Set(records.map((r) => r.revokes).filter((v) => typeof v === 'string' && v !== ''));
      const foreign = records.some((r) => r.retires === a.sourceId && !revoked.has(r.id));
      if (foreign) throw new Error('stale-plan：' + a.store + ':' + a.sourceId + ' 已被非本批退役');
    }
    if (tipFromRecords(records, a.sourceId) !== a.sourceId) throw new Error('stale-plan：' + a.store + ':' + a.sourceId + ' 的链尾已变化，请重建计划');
    return { ok: true };
  };
}

/**
 * 执行计划。默认 dry；dry 只返回将发生的动作，不写库、不写回执/观测。
 * R1：操作键 (batchId, sourceId) 写在 revision/tombstone 上；回执不是唯一真值。
 * R2：计划里的 tip 必须仍是当前链尾；否则 stale-plan，要求重建。
 */
export function applyRecogPlan(plan, opts = {}) {
  validatePlan(plan);
  const dry = opts.dry !== false;
  const files = opts.files && typeof opts.files === 'object' ? opts.files : {};
  const logFile = opts.logFile || join(LOGS_DIR, 'hooks.jsonl');
  const receiptFile = opts.receiptFile || join(LOGS_DIR, `recog-${plan.batchId}.json`);
  const items = new Map(plan.items.map((it) => [it.store + ':' + it.id, it]));
  const actions = [];
  for (const d of plan.decisions) {
    const it = items.get(d.store + ':' + d.id);
    const base = { batchId: plan.batchId, store: d.store, sourceId: it.id, id: d.id, verdict: d.verdict, evidence: d.evidence, newClaim: d.newClaim, today: plan.today };
    base.fingerprint = decisionFingerprint(base);
    if (d.verdict === 'still-holds') {
      actions.push({ ...base, patch: { last_reviewed: plan.today, verification: { kind: 'doc', at: plan.today, ref: String(d.evidence) }, recog: { batchId: plan.batchId, sourceId: it.id, verdict: d.verdict, fingerprint: base.fingerprint } } });
    } else if (d.verdict === 'superseded') {
      actions.push({ ...base, patch: { claim: String(d.newClaim), last_reviewed: plan.today, verification: { kind: 'doc', at: plan.today, ref: String(d.evidence) }, recog: { batchId: plan.batchId, sourceId: it.id, verdict: d.verdict, fingerprint: base.fingerprint } } });
    } else {
      actions.push({ ...base, reason: 'recog-answered: ' + String(d.evidence) + ' · recog-batch:' + plan.batchId });
    }
  }
  if (dry) {
    for (const a of actions) {
      if (actionDone(a, files)) continue;
      if (tipOf(a.store, a.sourceId, files) !== a.sourceId) throw new Error('stale-plan：' + a.store + ':' + a.sourceId + ' 的链尾已变化，请重建计划');
    }
    return { ok: true, dry: true, batchId: plan.batchId, actions, receiptFile };
  }
  const started = Date.now();
  const applied = [], skipped = [];
  for (const a of actions) {
    // 锁外只做预览/早报错；最终判重与版本闸在 revise/retire 的 store 锁内（guardFor）。
    if (a.verdict === 'answered') {
      const r = retireRecord('orphan', a.sourceId, { reason: a.reason, file: files.orphan, guard: guardFor(a), extra: { recog: { batchId: a.batchId, sourceId: a.sourceId, verdict: a.verdict, fingerprint: a.fingerprint } } });
      if (r.already) skipped.push({ store: a.store, id: a.sourceId, verdict: a.verdict, why: 'done' });
      else applied.push({ store: a.store, id: a.sourceId, verdict: a.verdict });
    } else {
      const r = revise(a.store, a.sourceId, a.patch, { file: files[a.store], guard: guardFor(a) });
      if (r && r.already) skipped.push({ store: a.store, id: a.sourceId, verdict: a.verdict, why: 'done' });
      else applied.push({ store: a.store, id: a.sourceId, verdict: a.verdict });
    }
  }
  const complete = plan.decisions.length === plan.items.length;
  const receipt = {
    batchId: plan.batchId, at: new Date().toISOString(), scope: plan.scope, today: plan.today,
    input: plan.items.length, decisions: plan.decisions.length, complete, applied, skipped,
    counts: {
      'still-holds': applied.filter((x) => x.verdict === 'still-holds').length,
      superseded: applied.filter((x) => x.verdict === 'superseded').length,
      answered: applied.filter((x) => x.verdict === 'answered').length,
      skipped: skipped.length,
    },
    ms: Date.now() - started,
  };
  mkdirSync(dirname(receiptFile), { recursive: true });
  writeFileAtomic(receiptFile, JSON.stringify(receipt, null, 2) + '\n');
  try {
    appendFileSync(logFile, JSON.stringify({ ts: new Date().toISOString(), kind: 'recog', batchId: plan.batchId, scope: plan.scope, input: plan.items.length, decisions: plan.decisions.length, complete, ...receipt.counts, ms: receipt.ms }) + '\n', 'utf8');
  } catch { /* 观测失败不回滚落库 */ }
  return { ok: true, dry: false, batchId: plan.batchId, receipt, receiptFile, already: applied.length === 0 && skipped.length === actions.length };
}
