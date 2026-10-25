// akasha/tools/import-frontier.mjs（v2，2026-10-07 改安全出口）
// 从设计稿 §4「相关论文地图」补录前沿层：**幂等合并追加**——已存在的 id 一律跳过，绝不覆盖 / 绝不删除。
// ⚠️ v1 用 writeFileSync 整体覆盖 frontier.jsonl——在「库 = 活库、另有作者与修订链」之后，重跑会抹掉
//    设计稿外的新增与全部修订历史（2026-10-07 类扫发现的「生成器 vs 活库」类事故隐患）。v2 起只追加。
// 用法：node tools/import-frontier.mjs [--dry]
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendRecord, loadStore } from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DOC = join(ROOT, '..', 'research', 'ai-memory-architecture-20261006.md');

const TOPICS = { A: '记忆系统', B: '经验学习', C: '离线巩固', D: '检索与线索', E: '可信度与校准', F: '情绪与价值', G: '孤案与方法学', H: '社会学习', I: '评测', J: '知识边界', K: '推理控制' };
const SUPPORTS = {
  A: ['§2.2 三层存储', '§2.5 排序'], B: ['§2.9 社会学习', '§2.10 评价'], C: ['§2.7 离线层'],
  D: ['§2.4 回忆双通路', '§2.5 排序'], E: ['§2.11③ 边界标注', '§3 可靠性利用'],
  F: ['§2.6 定价与情绪', '§2.13 情绪学习论'], G: ['§2.8 孤案政策'], H: ['§2.9 社会学习'],
  I: ['§2.10 评价'], J: ['§2.11 知识分层', '§2.12 羞耻定价'],
  K: ['§7 形态（纪律注入）', '§9 思维链注入', '§10 强制力']
};
const TENTATIVE = ['Sleep-time Compute', 'Memory for Autonomous', 'Why Language Models Hallucinate', 'AbstentionBench', 'Auditable Long-Term Memory', 'Knowledge Boundary', 'A-MEM', 'Mem0', 'Zep'];

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'entry';
const addDays = n => { const d = new Date(Date.UTC(2026, 9, 6)); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

const text = readFileSync(DOC, 'utf8');
const section = text.split('## 4. 相关论文地图')[1].split('## 5.')[0];
const lines = section.split(/\r?\n/);
let group = null;
const entries = [];
const seen = new Set();

for (const line of lines) {
  const g = line.match(/^### ([A-K])\./);
  if (g) { group = g[1]; continue; }
  if (!group) continue;
  if (!/^\d+\.\s/.test(line)) continue;
  const links = [...line.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g)];
  if (!links.length) continue;

  const plain = line.replace(/^\d+\.\s+/, '').replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/g, '$1');
  const firstTitle = links[0][1].replace(/\s+/g, ' ').trim();
  let note = plain;
  if (note.startsWith(firstTitle)) note = note.slice(firstTitle.length).trim();
  note = note.replace(/^（[^）]*）\s*/u, '').replace(/^[—\-–]+\s*/u, '').replace(/[。\s]+$/u, '').trim().slice(0, 160);
  const ym = plain.match(/20\d{2}/);
  const year = ym ? Number(ym[0]) : null;

  for (const [k, lk] of links.entries()) {
    const title = lk[1].replace(/\s+/g, ' ').trim();
    let id = 'front-' + slug(title);
    let n = 2;
    while (seen.has(id)) { id = 'front-' + slug(title) + '-' + n; n += 1; }
    seen.add(id);
    const status = TENTATIVE.some(t => title.includes(t)) ? '待验证' : '高引用';
    const entry = {
      id, title, url: lk[2], year: k === 0 ? year : null, topic: TOPICS[group], status,
      last_checked: '2026-10-06',
      next_review: addDays(status === '待验证' ? 90 : 180),
      supports: SUPPORTS[group], note
    };
    if (!note) delete entry.note;
    entries.push(entry);
  }
}

// —— 安全出口：幂等合并追加（绝不覆盖 / 绝不删除）——
const dry = process.argv.includes('--dry');
const existing = new Set(loadStore('frontier').records.map(r => r.id));
let added = 0; let skipped = 0;
for (const e of entries) {
  if (existing.has(e.id)) { skipped++; continue; }
  if (dry) { console.log('dry: 将追加 ' + e.id); added++; continue; }
  try { appendRecord('frontier', e); } catch (error) { console.log('跳过（校验未过）：' + e.id + ' — ' + String(error?.message ?? error).slice(0, 120)); skipped++; continue; }
  existing.add(e.id);
  added++;
}
console.log(`合并完成：设计稿生成 ${entries.length} 条；新增 ${added}，已存在跳过 ${skipped}（库内其余内容与修订链原样保留）。`);
