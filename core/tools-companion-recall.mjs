#!/usr/bin/env node
// companion-recall.mjs —— Hindsight REST 只读检索 CLI（CompanionPort adapter 的直接可用入口）。
// 用法：
//   node tools/companion-recall.mjs（OSS 仓：node core/tools-companion-recall.mjs） "查询词" [--limit 5] [--bank <bankId>] [--base <url>] [--token <t>] [--json]
// 环境变量默认值：
//   HINDSIGHT_API_URL  例 http://127.0.0.1:<PORT>
//   HINDSIGHT_API_PORT 未设 URL 时用 http://127.0.0.1:<port>（默认 9077）
//   HINDSIGHT_BANK_ID  默认 coding-agent::Harness
//   HINDSIGHT_API_TOKEN 可选
// 退出码：0=有命中；1=无命中/降级；2=参数错误。

import { hindsightHttpHooks, openvikingHttpHooks } from '../adapters.mjs';

function parse(argv) {
  const out = { query: '', limit: 5, json: false, driver: 'hindsight', base: '', bank: '', token: '' };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--driver') out.driver = argv[++i] || 'hindsight';
    else if (a === '--limit') out.limit = Number(argv[++i]) || 5;
    else if (a === '--bank') out.bank = argv[++i] || '';
    else if (a === '--base') out.base = argv[++i] || '';
    else if (a === '--token') out.token = argv[++i] || '';
    else if (a === '-h' || a === '--help') out.help = true;
    else rest.push(a);
  }
  out.query = rest.join(' ').trim();
  return out;
}

const args = parse(process.argv.slice(2));
if (args.help || !args.query) {
  console.error('用法：node tools/companion-recall.mjs "查询词" [--limit 5] [--bank <bankId>] [--base <url>] [--json]');
  process.exit(2);
}

if (!['hindsight', 'openviking'].includes(args.driver)) { console.error('未知 driver：' + args.driver); process.exit(2); }
const isOv = args.driver === 'openviking';
const base = args.base || (isOv ? (process.env.OPENVIKING_BASE_URL || ('http://127.0.0.1:' + (process.env.OPENVIKING_PORT || 1933))) : (process.env.HINDSIGHT_API_URL || `http://127.0.0.1:${process.env.HINDSIGHT_API_PORT || 9077}`));
const bank = isOv ? '' : (args.bank || process.env.HINDSIGHT_BANK_ID || '');
const token = args.token || (isOv ? (process.env.OPENVIKING_BEARER_TOKEN || '') : (process.env.HINDSIGHT_API_TOKEN || ''));

const fetchT = (u, o = {}) => fetch(u, { ...o, signal: AbortSignal.timeout(4000) });
const hooks = isOv ? openvikingHttpHooks({ baseUrl: base, token, fetchImpl: fetchT }) : hindsightHttpHooks({ baseUrl: base, bankId: bank, token, fetchImpl: fetchT });
const r = await hooks.search(args.query, { limit: args.limit });

if (args.json) {
  console.log(JSON.stringify({ driver: args.driver, base, bank, ...r }, null, 2));
} else {
  console.log(`${isOv ? 'OpenViking' : 'Hindsight'}${bank ? ' · ' + bank : ''} · ${r.hits.length} 条${r.degraded ? '（降级：' + (r.reason || '未知') + '）' : ''}`);
  for (const h of r.hits) {
    const title = String(h.title || '').slice(0, 60);
    const text = String(h.text || '').replace(/\s+/g, ' ').slice(0, 100);
    console.log(`- ${h.id || '?'} | ${title}\n  ${text}`);
  }
}
process.exit(r.hits.length ? 0 : 1);
