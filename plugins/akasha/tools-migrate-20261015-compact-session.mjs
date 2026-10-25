// 一次性：会话层索引**紧凑化**（2026-10-15；用户拍板「确实需要紧凑化」）
// 背景：跨形态孪生（裸 / session- 前缀指向同一档案，却各存一份）⇒ 真库 43916 行里 11553 行是内容重复。
// 策略：**按归一内容键去重**——同键行只留一行；`kind:'node'` **一律保留**（同 id 多代是设计，不是重复）；
//       保留优先级：裸形态会话键 > 前缀形态；同形态取首见。
// 纪律：① 先备份；② dry-run 出对照（保留/丢弃/按会话分布）；③ 原子写（.tmp → rename）；④ 写后验（行数/键唯一/check）。
// 用法：node tools/migrate-20261015-compact-session.mjs [--apply]
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, statSync } from 'node:fs';
import { contentKeyOf, normSid as norm } from './tools-session-key.mjs';

// 2026-10-15（GPT 复核 session N1 收尾）：`AKASHA_ROOT` 与核心**同口径**＝放 jsonl 的目录本身（不再自作主张追加 /data）；
// 原实现 `ROOT.replace(/\/data\/?$/,'')+'/data/session.jsonl'` 对 `custom-store` 这类根会拼错（Windows 反斜杠也不匹配该去尾正则）。
const DATA_ROOT = process.env.AKASHA_ROOT ? String(process.env.AKASHA_ROOT) : '<AKASHA_DIR>/data';
const STORE = DATA_ROOT.endsWith('.jsonl') ? DATA_ROOT : `${DATA_ROOT.replace(/[\\/]+$/, '')}/session.jsonl`;
// 备份**随目标走**且带时间戳（原先是固定真回滚目录 ⇒ 指向沙箱 `--apply` 也会碰真实回滚件 ✗）；可用 AKASHA_BAK 覆盖。
const STORE_DIR = STORE.replace(/[\\/][^\\/]+$/, '');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const BAK = process.env.AKASHA_BAK ? String(process.env.AKASHA_BAK) : `${STORE_DIR}/_rollback-20261015-compact`;
const APPLY = process.argv.includes('--apply');

const isNode = (r) => r.kind === 'node';
// 2026-10-15（GPT 复核 P1/N4）：内容键**抽到 tools/session-key.mjs**（shape 与 migrate 共用同一函数——两边必须给出同一
// "什么是重复"口径；首版两处各写一套、对 topic/promotion 相反）。topic 按代次+指纹、promotion 按 id、机械段按内容、其余 id/整行。
const key = (r) => contentKeyOf(r);

const raw = readFileSync(STORE, 'utf8');
const lines = raw.split('\n').filter(Boolean);
const rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });

const seen = new Map();          // key -> 当前保留的 index
const keep = [];                 // 保留的原始行号
const drop = [];                 // 丢弃的原始行号（内容重复）
const droppedBySess = {};
rows.forEach((r, i) => {
  if (!r || isNode(r)) { keep.push(i); return; }                       // 坏行/节点：一律保留（节点同 id 多代是设计）
  const k = key(r);
  if (!seen.has(k)) { seen.set(k, i); keep.push(i); return; }
  const prev = rows[seen.get(k)];
  const prevBare = !String(prev.session ?? '').startsWith('session-');
  const curBare = !String(r.session ?? '').startsWith('session-');
  if (curBare && !prevBare) {                                          // 更规范的形态出现 ⇒ 用新的替旧的
    const pi = seen.get(k);
    drop.push(pi);
    droppedBySess[norm(prev.session)] = (droppedBySess[norm(prev.session)] ?? 0) + 1;
    keep.splice(keep.indexOf(pi), 1);
    seen.set(k, i);
    keep.push(i);
    return;
  }
  drop.push(i);
  droppedBySess[norm(r.session)] = (droppedBySess[norm(r.session)] ?? 0) + 1;
});

keep.sort((a, b) => a - b);
const kept = keep.map((i) => lines[i]);
const out = kept.join('\n') + '\n';

console.log(`原：${lines.length} 行 / ${(statSync(STORE).size / 1048576).toFixed(1)} MB`);
console.log(`计划保留 ${kept.length} 行 / 丢弃 ${drop.length} 行（内容重复）`);
const byKind = {};
for (const i of drop) { const k = rows[i].kind ?? '?'; byKind[k] = (byKind[k] ?? 0) + 1; }
console.log('丢弃按 kind：', JSON.stringify(byKind));
console.log('丢弃按会话（归一后）：', JSON.stringify(droppedBySess));
const nodes = rows.filter((r) => r && isNode(r)).length;
console.log(`其中 node 行 ${nodes}（全部保留，不参与去重）`);

if (!APPLY) { console.log('\n[预演] 加 --apply 才执行。备份目标：' + BAK); process.exit(0); }

if (!existsSync(BAK)) mkdirSync(BAK, { recursive: true });
const BAK_FILE = `${BAK}/session.jsonl.pre-compact-${STAMP}`;
copyFileSync(STORE, BAK_FILE);
console.log('已备份 →', BAK_FILE);

writeFileSync(`${STORE}.tmp`, out, 'utf8');
renameSync(`${STORE}.tmp`, STORE);
console.log('已写回（原子替换）');

// 写后验
const after = readFileSync(STORE, 'utf8').split('\n').filter(Boolean);
const keys = new Map();
let bad = 0;
for (const l of after) { try { const r = JSON.parse(l); if (!isNode(r)) { const k = key(r); keys.set(k, (keys.get(k) ?? 0) + 1); } } catch { bad += 1; } }
const dupLeft = [...keys.values()].filter((n) => n > 1).reduce((a, b) => a + b - 1, 0);
console.log(`写后：${after.length} 行 / ${(statSync(STORE).size / 1048576).toFixed(1)} MB / 坏行 ${bad} / 残留内容重复 ${dupLeft}`);
