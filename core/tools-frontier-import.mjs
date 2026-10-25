// frontier-import.mjs —— 把 paper-fetch 的草案 JSON 正式写入 frontier 层（去重 / 校验 / 走 lib.appendRecord 校验路径）。
// 规则（canon 2026-10-08 裁定）：frontier 只收**来源可靠、有学术或前沿背景**的论文文献；须 http(s) url + next_review。
// 用法：node tools/frontier-import.mjs <草案.json…> [--topic <标签>] [--dry]
import { readFileSync, existsSync } from 'node:fs';
import { appendRecord, currentRecords, loadStore, todayLocal } from './lib.mjs';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const ti = args.indexOf('--topic');
const topic = ti >= 0 ? args[ti + 1] : null;
const files = args.filter((a) => !a.startsWith('--') && a !== topic);
if (!files.length) { console.error('用法：node tools/frontier-import.mjs <草案.json…> [--topic <标签>] [--dry]'); process.exit(2); }

const existing = currentRecords(loadStore('frontier').records);
const byId = new Set(existing.map((r) => String(r.id)));
const byUrl = new Set(existing.map((r) => String(r?.source?.ref ?? '')));

const ACADEMIC = /(^https?:\/\/(dx\.)?doi\.org\/|arxiv\.org|openalex\.org|semanticscholar\.org|ssrn\.com|zenodo\.org|preprints\.org|nature\.com|science\.org|acm\.org|ieee\.org|springer|elsevier|wiley)/i;

let added = 0, skipped = 0;
const report = [];
for (const f of files) {
  if (!existsSync(f)) { report.push('  跳过（不存在）：' + f); continue; }
  let drafts = [];
  try { drafts = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { report.push('  跳过（JSON 非法）：' + f + ' — ' + e.message); continue; }
  if (!Array.isArray(drafts)) drafts = [drafts];
  for (const d of drafts) {
    const url = String(d?.source?.ref ?? '');
    const id = String(d?.id ?? '');
    if (!id || !url) { skipped++; report.push('  跳过（缺 id/url）：' + (id || url || '?')); continue; }
    if (!ACADEMIC.test(url)) { skipped++; report.push('  跳过（非学术来源）：' + url); continue; }
    if (byId.has(id) || byUrl.has(url)) { skipped++; report.push('  跳过（重复）：' + id); continue; }
    // frontier 真 schema（2026-10-11 核对 data/frontier.jsonl 实测形态）：
    //   id / title / url / year / topic / status(已实践|已复现|高引用|待验证) / last_checked / next_review / supports[] / note
    const claim = String(d.claim ?? '');
    const parts = claim.split(' —— ');
    const title = String(parts[0] ?? '').trim() || ('（无标题）' + id);
    const note = parts.slice(1).join(' —— ').replace(/\s+/g, ' ').slice(0, 240);
    const yearTag = Array.isArray(d.tags) ? d.tags.find((t) => /^\d{4}$/.test(String(t))) : '';
    const rec = {
      id,
      title,
      url,
      year: yearTag ? Number(yearTag) : undefined,
      topic: topic || '未分类',
      status: '待验证',                      // 诚实默认：我们尚未实践过它
      last_checked: todayLocal(),
      next_review: String(d.next_review ?? ''),
      supports: [],                          // 尚未映射到我们文档的章节
      note: note || '（待补读摘要）'
    };
    if (dry) { added++; report.push('  [dry] 将写入：' + rec.id); continue; }
    try {
      appendRecord('frontier', rec);
      byId.add(id); byUrl.add(url); added++;
      report.push('  + ' + rec.id);
    } catch (e) { skipped++; report.push('  ✗ 写入失败：' + id + ' — ' + e.message); }
  }
}
console.log('frontier 导入：新增 ' + added + ' 条 / 跳过 ' + skipped + ' 条' + (dry ? '（dry-run，未写入）' : ''));
for (const l of report) console.log(l);
