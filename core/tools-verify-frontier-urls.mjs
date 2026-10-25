// 前沿层文献核对（2026-10-07）：逐条抓取当前版本条目的 URL，核对可达性 + 页面标题相似度。
// 输出：akasha\logs\frontier-url-audit-<date>.json（含每条明细）。
// 用法：node akasha\tools\verify-frontier-urls.mjs
// 纪律：只报告事实（HTTP 码 / 标题相似度 / 错误原文），不做美化；失败与低相似条目交人工复核。
import { loadStore, currentRecords } from './lib.mjs';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) akasha-frontier-audit/1.0';
const arg = (name, dflt) => { const a = process.argv.find((x) => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : dflt; };
const onlyIds = arg('only', '').split(',').filter(Boolean);
const timeoutMs = Number(arg('timeout', '15000'));
const seq = process.argv.includes('--seq');
const conc = seq ? 1 : 5;
const all = currentRecords(loadStore('frontier').records)
  .map((r) => ({ id: r.id, title: r.title || '', url: r.url || '', status: r.status || '' }));
const items = onlyIds.length ? all.filter((i) => onlyIds.includes(i.id)) : all;
if (!items.length) { console.log('无匹配条目（--only 过滤后为空）'); process.exit(2); }

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ').trim();
const sim = (recordTitle, pageTitle) => {
  const A = new Set(norm(recordTitle).split(' ').filter((w) => w.length > 2));
  const B = new Set(norm(pageTitle).split(' ').filter((w) => w.length > 2));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return Number((hit / A.size).toFixed(3));
};

const one = async (it) => {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(it.url, { redirect: 'follow', signal: ctl.signal, headers: { 'user-agent': UA } });
    let pageTitle = '';
    const ct = res.headers.get('content-type') || '';
    if (res.ok && ct.includes('html')) {
      const html = (await res.text()).slice(0, 200000);
      const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      if (m) pageTitle = m[1].replace(/\s+/g, ' ').trim().slice(0, 200);
    }
    return { ...it, http: res.status, ok: res.ok, finalUrl: res.url, pageTitle, titleScore: pageTitle ? sim(it.title, pageTitle) : null };
  } catch (e) {
    return { ...it, http: null, ok: false, error: String(e?.name === 'AbortError' ? `timeout(${timeoutMs}ms)` : (e?.message || e)).slice(0, 140), finalUrl: null, pageTitle: '', titleScore: null };
  } finally { clearTimeout(timer); }
};

const results = [];
const queue = [...items];
const workers = Array.from({ length: conc }, async () => {
  for (;;) {
    const it = queue.shift();
    if (!it) break;
    const r = await one(it);
    results.push(r);
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${String(r.http ?? '-').padEnd(4)} sim=${r.titleScore ?? '-'}  ${r.id}`);
    if (seq) await new Promise((res) => setTimeout(res, 600));
  }
});
await Promise.all(workers);

const report = {
  at: new Date().toISOString(),
  total: results.length,
  okCount: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).map((r) => ({ id: r.id, url: r.url, http: r.http, error: r.error })),
  lowSim: results.filter((r) => r.ok && r.titleScore !== null && r.titleScore < 0.5)
    .map((r) => ({ id: r.id, title: r.title, pageTitle: r.pageTitle, score: r.titleScore, url: r.url })),
  results
};
const suffix = onlyIds.length ? '-retry' : '';
const out = join(ROOT, 'logs', `frontier-url-audit-${new Date().toISOString().slice(0, 10)}${suffix}.json`);
writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
console.log(`\n合计 ${report.total}；可达 ${report.okCount}；失败 ${report.failed.length}；标题低相似 ${report.lowSim.length}`);
console.log('报告：' + out);
