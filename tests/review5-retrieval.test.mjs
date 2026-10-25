import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
mkdirSync(join(repo, '_scratch'), { recursive: true });
const scratch = mkdtempSync(join(repo, '_scratch', 'review5-retrieval-'));
process.env.AKASHA_ROOT = join(scratch, 'data'); process.env.AKASHA_LOGS = join(scratch, 'logs'); process.env.AKASHA_QUERY_LOG = 'off';
mkdirSync(process.env.AKASHA_ROOT); mkdirSync(process.env.AKASHA_LOGS);
const lib = await import('../core/lib.mjs');
function record(store, i) {
  const id = store + '-' + String(i).padStart(3, '0'), text = 'needle synthetic ' + i;
  return {
    canon: { id, claim: text, source: { type: '官方', ref: 'synthetic' }, last_reviewed: '2026-10-14' },
    frontier: { id, title: text, url: 'https://example.test/' + i, topic: 'needle', status: '待验证', last_checked: '2026-10-14', next_review: '2026-11-14', supports: [] },
    mirror: { id, story: text, situation: text, behavior: 'synthetic', outcome: 'synthetic', social_reaction: 'synthetic', emotion: 'synthetic' },
    orphan: { id, summary: text, observed: 'synthetic', hypothesis: 'synthetic', would_confirm: 'synthetic', would_refute: 'synthetic', severity: '中', created: '2026-10-14' },
    pricing: { id, behavior: text, valence: 1, severity_default: 1 },
    lexicon: { id, term: text, trigger: 'synthetic', behavior: 'synthetic', resolution: 'synthetic', source: 'synthetic' }
  }[store];
}
function seed(counts) {
  for (const store of lib.STORES) {
    const rows = Array.from({ length: counts[store] || 0 }, (_, i) => record(store, i));
    for (const row of rows) assert.deepEqual(lib.validateRecord(store, row), []);
    writeFileSync(lib.storePath(store), rows.map(JSON.stringify).join('\n') + (rows.length ? '\n' : ''));
  }
}
const ids = r => r.groups.flatMap(g => (g.items || g.hits).map(h => h.id));
const invoke = (tool, args) => {
  const p = spawnSync(process.execPath, [join(repo, 'core/mcp.mjs')], { env: process.env, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 8e6,
    input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: { query: 'needle', ...args } } }) + '\n' });
  assert.equal(p.status, 0, p.stderr); const response = JSON.parse(p.stdout);
  assert.notEqual(response.result.isError, true, JSON.stringify(response));
  return JSON.parse(response.result.content[0].text);
};
function traverse(tool, args, expectedCount, perStoreLimit) {
  let offset = 0; const all = [], pages = [];
  for (let step = 0; step < 100; step++) {
    const r = invoke(tool, { ...args, offset }); pages.push(r);
    assert.equal(r.budget.total, expectedCount);
    assert(ids(r).length <= 50);
    for (const g of r.groups) assert((g.items || g.hits).length <= perStoreLimit);
    const withoutBudget = { ...r }; delete withoutBudget.budget;
    assert.equal(r.budget.usedTokens, lib.estimateTokens(JSON.stringify(withoutBudget)));
    all.push(...ids(r));
    if (r.budget.exhausted) break;
    assert(r.budget.nextOffset > offset, 'cursor must progress'); offset = r.budget.nextOffset;
  }
  assert.equal(pages.at(-1).budget.exhausted, true);
  assert.equal(all.length, expectedCount); assert.equal(new Set(all).size, expectedCount);
  return pages;
}

test('V03: 20 hits remain reachable across the 12-item page boundary', () => {
  seed({ canon: 20 });
  const pages = traverse('akasha_cross', { depth: 'pointer', maxTokens: 100000 }, 20, 12);
  assert.deepEqual(pages.map(p => ids(p).length), [12, 8]);
  assert.equal(pages[0].total, 20); assert.equal(pages[0].budget.exhausted, false);
});
test('V03/V04: cross preserves every store and every hit over 50-item pages', () => {
  seed(Object.fromEntries(lib.STORES.map(s => [s, 15])));
  const pages = traverse('akasha_cross', { depth: 'summary', maxTokens: 100000 }, 90, 12);
  assert.equal(ids(pages[0]).length, 50); assert.equal(pages[0].total, 90);
  assert.equal(pages[0].groups.length, 6);
});
test('V04: brief shares total/per-store limits and can retrieve all candidates', () => {
  seed(Object.fromEntries(lib.STORES.map(s => [s, 15])));
  traverse('akasha_brief', { depth: 'pointer', perStore: 12, maxTokens: 100000 }, 90, 12);
  traverse('akasha_brief', { depth: 'summary', maxTokens: 100000 }, 90, 3);
});
test('count-only cross still returns a truthful continuation cursor', () => {
  seed({ canon: 25, mirror: 1 });
  const pages = traverse('akasha_cross', { depth: 'pointer' }, 26, 12);
  assert(pages.every(p => p.budget.mode === 'per-page-count' && p.budget.capTokens === null));
});
test('combined token and count limits preserve all short hits', () => {
  seed(Object.fromEntries(lib.STORES.map(s => [s, 10])));
  traverse('akasha_cross', { depth: 'pointer', maxTokens: 1800 }, 60, 12);
  traverse('akasha_brief', { depth: 'pointer', perStore: 12, maxTokens: 2400 }, 60, 12);
});
test('zero/negative/non-integer perStore values use bounded defaults; 1 stays 1', () => {
  seed({ canon: 20 });
  for (const perStore of [0, -1, 1.5]) {
    assert.equal(ids(invoke('akasha_cross', { depth: 'pointer', perStore })).length, 12);
    assert.equal(ids(invoke('akasha_brief', { depth: 'pointer', perStore, maxTokens: 100000 })).length, 3);
  }
  traverse('akasha_cross', { depth: 'pointer', perStore: 1 }, 20, 1);
});
test('offset at/end/beyond and empty result terminate without duplicates', () => {
  seed({ canon: 20 });
  for (const offset of [20, 30]) {
    const r = invoke('akasha_cross', { depth: 'summary', offset });
    assert.deepEqual(ids(r), []); assert(r.budget.exhausted); assert.equal(r.budget.nextOffset, 20);
  }
  seed({}); const empty = invoke('akasha_cross', { depth: 'summary' });
  assert.deepEqual(ids(empty), []); assert(empty.budget.exhausted);
});
test('full/reflect retain unbounded cross; default MCP is summary-bounded', () => {
  seed({ canon: 20 });
  // 2026-10-19：MCP 日常读默认 depth=summary（token 省），默认不再保证 20 条全量。
  const dflt = invoke('akasha_cross', {});
  assert.equal(dflt.depth, 'summary'); assert.equal(ids(dflt).length, 12); assert.ok(dflt.budget && dflt.budget.trimmed > 0);
  for (const args of [{ depth: 'full' }, { depth: 'pointer', reflect: true }, { depth: 'full', perStore: 0 }]) {
    const r = invoke('akasha_cross', args); assert.equal(ids(r).length, 20); assert.equal(r.depth, 'full'); assert.equal(r.budget, undefined);
  }
  assert.equal(lib.brief('needle', { contextBudget: false }).groups[0].hits.length, 3);
});
test('V05: MCP trace:true returns diagnostics without requiring report', () => {
  seed({ canon: 2 });
  assert(Array.isArray(invoke('akasha_lookup', {})));
  assert.equal(invoke('akasha_lookup', { report: true }).trace, undefined);
  for (const args of [{ trace: true }, { trace: true, report: true }, { trace: true, recall: true }]) {
    const r = invoke('akasha_lookup', args); assert(Array.isArray(r.hits)); assert.equal(r.trace.length, 2);
  }
});
test('V05: recall trace includes citation-only candidates and RRF evidence', () => {
  seed({ canon: 1 });
  lib.appendRecord('canon', { ...record('canon', 50), claim: 'unrelated reference', relates_to: ['canon-000'] });
  const r = invoke('akasha_lookup', { trace: true, recall: true });
  const citation = r.trace.find(t => t.id === 'canon-050');
  assert(citation); assert.equal(citation.store, 'canon'); assert(citation.paths.includes('citation')); assert(citation.rrfScore > 0);
});
test('V05: CLI recall --trace --json exposes trace rather than silently returning hits', () => {
  seed({ canon: 2 });
  const p = spawnSync(process.execPath, [join(repo, 'core/akasha.mjs'), 'lookup', 'needle', '--recall', '--trace', '--json'], { env: process.env, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(p.status, 0, p.stderr); const trace = JSON.parse(p.stdout);
  assert.equal(trace.length, 2); assert(trace.every(t => Array.isArray(t.paths) && typeof t.rrfScore === 'number'));
});
