// 全库体检（2026-10-08，用户要求「保险起见整个阿卡夏之书再看看」）。
// 只读：不动任何数据。覆盖 check 之外的不变式：
//   1) 重复 id（库内）/ 跨库同名 id
//   2) supersedes / retires 悬空与环
//   3) 修订链断裂（链上有 id 被物理删除却仍被引用）
//   4) 墓碑指向不存在的目标；退役 id 仍出现在当前集（自证矛盾）
//   5) 日期格式（last_reviewed / last_checked / next_review / created / event_time）
//   6) id 前缀与库不匹配
//   7) 不可达记录（既非当前、也不是任何记录的前身/退役目标）
//   8) frontier：url 协议、状态枚举、到期口径
//   9) 会话层：坏行 / meta 与数据自洽
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, STORES, loadStore, currentRecords, retiredIds, allIds, validateRecord, todayLocal } from './lib.mjs';

const PREFIX = { canon: 'canon-', mirror: 'mirror-', orphan: 'orphan-', pricing: 'price-', lexicon: 'lex-', frontier: ['front-', 'frontier-'] };
const DATE_FIELDS = ['last_reviewed', 'last_checked', 'next_review', 'created', 'event_time'];
const problems = [];
const warnings = [];
const add = (lvl, store, id, msg) => (lvl === 'P' ? problems : warnings).push(`[${store}] ${id}: ${msg}`);

const allIdsGlobal = new Map();   // id -> [stores]
const storeData = {};
for (const store of STORES) {
  const { records, errors } = loadStore(store);
  storeData[store] = records;
  for (const e of errors) add('P', store, '(load)', e.error);
  for (const r of records) {
    if (!allIdsGlobal.has(r.id)) allIdsGlobal.set(r.id, []);
    allIdsGlobal.get(r.id).push(store);
  }
}

for (const store of STORES) {
  const records = storeData[store];
  const ids = records.map((r) => r.id);
  const idSet = new Set(ids);
  const cur = new Set(currentRecords(records).map((r) => r.id));
  const ret = retiredIds(records);

  // 1) 库内重复 id
  const dups = ids.filter((id, i) => ids.indexOf(id) !== i);
  for (const d of new Set(dups)) add('P', store, d, '库内重复 id ×' + ids.filter((x) => x === d).length);

  // 2/3) supersedes 悬空 / 环 / retires 悬空
  for (const r of records) {
    if (r.supersedes && !idSet.has(r.supersedes)) add('P', store, r.id, 'supersedes 悬空 → ' + r.supersedes);
    if (r.retires && !idSet.has(r.retires)) add('P', store, r.id, 'retires 悬空 → ' + r.retires);
    // 环检测
    let cursor = r; const seen = new Set();
    while (cursor && cursor.supersedes && idSet.has(cursor.supersedes)) {
      if (seen.has(cursor.id)) { add('P', store, r.id, 'supersedes 成环'); break; }
      seen.add(cursor.id);
      cursor = records.find((x) => x.id === cursor.supersedes);
    }
  }

  // 4) 退役目标仍在当前集（自证矛盾）；墓碑自己不得出现在当前集
  for (const t of ret) if (cur.has(t)) add('P', store, t, '已被退役却仍出现在当前集');
  for (const r of records) if (r.retires && cur.has(r.id)) add('P', store, r.id, '墓碑出现在当前集');

  // 5) 日期格式 + 6) 前缀
  for (const r of records) {
    for (const f of DATE_FIELDS) {
      const v = r[f];
      if (v !== undefined && !/^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(String(v))) add('P', store, r.id, `${f} 日期格式可疑：${v}`);
    }
    const want = [].concat(PREFIX[store]);
    if (!want.some((p) => String(r.id).startsWith(p))) add('W', store, r.id, `id 前缀与库不匹配（期望 ${want.join(' 或 ')}）`);
    const errs = validateRecord(store, r);
    for (const e of errs) add('P', store, r.id, '校验：' + e);
  }

  // 7) 不可达：既不是当前、也不是任何记录的 supersedes/retires 目标
  const referenced = new Set(records.map((r) => r.supersedes).concat(records.map((r) => r.retires)).filter(Boolean));
  for (const r of records) {
    if (cur.has(r.id) || ret.has(r.id) || referenced.has(r.id)) continue;
    if (r.retires) continue;                     // 墓碑本身
    add('W', store, r.id, '不可达记录（非当前、也无人引用）');
  }

  // 8) frontier 专项
  if (store === 'frontier') {
    const today = todayLocal();
    for (const r of currentRecords(records)) {
      if (!/^https?:\/\//.test(r.url)) add('P', store, r.id, 'url 非 http(s)：' + r.url);
      if (r.next_review < today) add('W', store, r.id, `已到期未复审（${r.next_review}）`);
    }
  }
}

// 跨库同名 id
for (const [id, stores] of allIdsGlobal) if (stores.length > 1) add('P', 'cross', id, '跨库同名 id：' + stores.join('+'));

// 9) 会话层
const sessFile = join(ROOT, 'data', 'session.jsonl');
if (existsSync(sessFile)) {
  const lines = readFileSync(sessFile, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  let bad = 0; const byId = new Map();
  for (const l of lines) {
    try {
      const r = JSON.parse(l);
      const k = r.id ?? '(无id)';
      if (!byId.has(k)) byId.set(k, []);
      byId.get(k).push(Number(r.treegen) || 0);
    } catch { bad++; }
  }
  if (bad) add('P', 'session', '(file)', `坏行 ${bad} 条`);
  // 弧线节点 id 跨代稳定（id 不含代）⇒ 同 id 多次出现是**设计如此**，只要各代互异；
  // 同 id 同代出现两次才是真重复（双写）。
  const trueDup = [...byId.entries()].filter(([, gens]) => gens.length > 1 && new Set(gens).size !== gens.length);
  const crossGen = [...byId.entries()].filter(([, gens]) => gens.length > 1 && new Set(gens).size === gens.length);
  if (trueDup.length) add('P', 'session', '(file)', `同 id 同代真重复 ${trueDup.length} 个：${trueDup.slice(0, 3).map(([i]) => i).join(',')}`);
  else add('I', 'session', '(file)', `跨代节点 ${crossGen.length} 个（各代互异，符合设计）`);
}

// 10) 周边：hooks 线 / 睡眠报告 / _trash 备份可解析
const hooksFile = join(ROOT, 'logs', 'hooks.jsonl');
if (existsSync(hooksFile)) {
  const lines = readFileSync(hooksFile, 'utf8').split(/\r?\n/).filter((l) => l.trim());
  let bad = 0; const kinds = new Map();
  for (const l of lines.slice(-2000)) {
    try { const r = JSON.parse(l); kinds.set(r.kind ?? '(无 kind)', (kinds.get(r.kind) ?? 0) + 1); } catch { bad++; }
  }
  if (bad) add('P', 'hooks', '(file)', `最近 2000 行有 ${bad} 条坏行`);
  const errs = [...kinds.entries()].filter(([k]) => /error|deny|denial/i.test(k));
  if (errs.length) add('W', 'hooks', '(file)', '近期错误/拦截类事件：' + errs.map(([k, n]) => `${k}×${n}`).join('，'));
}
const trashDir = join(ROOT, 'data', '_trash');
if (existsSync(trashDir)) {
  for (const f of readFileSync ? [] : []) { /* noop */ }
  const { readdirSync } = await import('node:fs');
  for (const name of readdirSync(trashDir)) {
    const p = join(trashDir, name);
    const lines = readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.trim());
    let bad = 0;
    for (const l of lines) { try { JSON.parse(l); } catch { bad++; } }
    if (bad) add('P', 'trash', name, `备份文件有 ${bad} 条坏行`);
    else add('I', 'trash', name, `可解析：${lines.length} 行`);
  }
}
const sleepDir = join(ROOT, 'data');
{
  const { readdirSync } = await import('node:fs');
  const reports = readdirSync(sleepDir).filter((f) => f.startsWith('sleep-') && f.endsWith('.json'));
  const latest = reports.sort().at(-1);
  if (latest) {
    try {
      const j = JSON.parse(readFileSync(join(sleepDir, latest), 'utf8'));
      const keys = Object.keys(j);
      add('I', 'sleep', latest, '可解析；顶层字段：' + keys.slice(0, 8).join(','));
    } catch (e) { add('P', 'sleep', latest, '报告不可解析：' + e.message); }
  }
}

// 汇总
console.log('=== 全库体检报告（2026-10-08）===');
for (const store of STORES) {
  const records = storeData[store];
  console.log(`  ${store.padEnd(9)} 行=${String(records.length).padStart(4)}  当前=${String(currentRecords(records).length).padStart(4)}  退役=${retiredIds(records).size}  唯一 id=${allIds(records).size}`);
}
console.log(`\n硬问题 ${problems.length} 条，提醒 ${warnings.length} 条`);
for (const p of problems.slice(0, 40)) console.log('  ✗ ' + p);
for (const w of warnings.slice(0, 40)) console.log('  ! ' + w);
process.exit(problems.length ? 1 : 0);
