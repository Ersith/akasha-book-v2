// Regression: tree reads must not materialize the whole session store, even before a no-op.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';

const root = fs.mkdtempSync(path.join(tmpdir(), 'akasha-tree-streaming-'));
const env = {
  AKASHA_ROOT: path.join(root, 'data'), AKASHA_LOGS: path.join(root, 'logs'),
  AKASHA_DIR: root, AKASHA_COMPANIONS: path.join(root, 'no-companions.json'),
  AKASHA_SESSIONS_ROOT: path.join(root, 'no-host-sessions'), AKASHA_QUERY_LOG: 'off',
};
const priorEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
Object.assign(process.env, env);
fs.mkdirSync(env.AKASHA_ROOT, { recursive: true });
fs.mkdirSync(env.AKASHA_LOGS, { recursive: true });
for (const name of ['canon', 'mirror', 'orphan', 'pricing', 'lexicon', 'frontier']) {
  fs.writeFileSync(path.join(env.AKASHA_ROOT, name + '.jsonl'), '');
}

const original = { ...fs };
const fdFiles = new Map();
let active = null;
const canonical = value => {
  const resolved = path.resolve(value instanceof URL ? fileURLToPath(value) : String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
fs.openSync = function (file, ...args) {
  const fd = original.openSync(file, ...args);
  fdFiles.set(fd, canonical(file));
  return fd;
};
fs.closeSync = function (fd) {
  try { return original.closeSync(fd); } finally { fdFiles.delete(fd); }
};
fs.readFileSync = function (file, ...args) {
  const resolved = typeof file === 'number' ? fdFiles.get(file) : canonical(file);
  if (active && resolved === active.file) {
    active.wholeReads += 1;
    throw new Error('WHOLE_SESSION_STORE_READ_FORBIDDEN');
  }
  return original.readFileSync(file, ...args);
};
fs.readSync = function (fd, ...args) {
  const n = original.readSync(fd, ...args);
  if (active && fdFiles.get(fd) === active.file) active.readCalls += 1;
  return n;
};
fs.fsyncSync = function (fd) {
  const result = original.fsyncSync(fd); // Real fsync; no permission-model shim.
  if (active && fdFiles.get(fd) === active.file + '.lock') active.lockFsyncs += 1;
  return result;
};
syncBuiltinESMExports();
test.after(() => {
  for (const name of ['openSync', 'closeSync', 'readFileSync', 'readSync', 'fsyncSync']) fs[name] = original[name];
  syncBuiltinESMExports();
  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true });
});
// All filesystem roots and guards are in place before importing the module under test.
const { buildTree, autoBuildTree, lookupSegmentsDetailed, latestNodes, renderTree } = await import('./session.mjs');
const segment = (id, seq, session = 'target', gist = id) => ({
  id, store: 'session', session, kind: 'conclusion', seq, turn: seq,
  gist, extra: gist, keywords: [], time: '2026-10-24T00:00:00Z', ptr: { seq },
});
let serial = 0;
function store(rows, raw) {
  const file = path.join(root, 'store-' + (++serial) + '.jsonl');
  fs.writeFileSync(file, raw ?? rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  return file;
}
function guarded(file, fn) {
  assert.equal(active, null);
  active = { file: canonical(file), wholeReads: 0, readCalls: 0, lockFsyncs: 0 };
  try {
    const result = fn();
    assert.equal(active.wholeReads, 0);
    return { result, audit: { ...active } };
  } finally {
    active = null;
    assert.equal(fs.existsSync(file + '.lock'), false, 'owned store lock must be released');
  }
}
const children = tree => tree.nodes.filter(node => node.level === 1).flatMap(node => node.children);

test('buildTree streams only target segments while preserving global generation and first target ID', () => {
  const floor = 9000000000000000;
  const file = store([
    segment('shared', 0, 'other', 'FOREIGN'),
    segment('shared', 1, 'session-target', 'FIRST'),
    segment('shared', 99, 'target', 'DUPLICATE'), segment('second', 2),
    { id: 'foreign-node', kind: 'node', session: 'other', treegen: floor },
  ]);
  const before = fs.readFileSync(file);
  const { result } = guarded(file, () => buildTree({ session: 'target', storeFile: file }));
  assert.equal(result.treegen, floor + 1);
  assert.deepEqual(children(result), ['shared', 'second']);
  assert.ok(result.nodes.every(node => node.session === 'target' && !/FOREIGN|DUPLICATE/.test(node.gist)));
  assert.deepEqual(fs.readFileSync(file), before);
});

test('buildTree preserves UTF-8 split across 64KiB and a complete final line without LF', () => {
  const row = { padding: '', ...segment('unicode', 1, 'target', '跨界汉字😀') };
  const markerOffset = Buffer.from(JSON.stringify(row)).indexOf(Buffer.from('跨'));
  row.padding = 'x'.repeat(65535 - markerOffset);
  const bytes = Buffer.from(JSON.stringify(row) + '\r\n\r\n' + JSON.stringify(segment('tail', 2, 'session-target', '无换行尾条')));
  assert.equal(bytes.indexOf(Buffer.from('跨')), 65535);
  const file = store([], bytes);
  const { result, audit } = guarded(file, () => buildTree({ session: 'target', storeFile: file }));
  assert.ok(audit.readCalls >= 2);
  assert.deepEqual(children(result), ['unicode', 'tail']);
  assert.ok(result.nodes.some(node => node.gist.includes('跨界汉字😀')));
  assert.ok(result.nodes.some(node => node.gist.includes('无换行尾条')));
  assert.ok(result.nodes.every(node => !node.gist.includes('\uFFFD')));
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('autoBuildTree built and unchanged branches stream under a real fsynced lock', () => {
  const file = store([segment('one', 1), segment('other', 100, 'other')]);
  const before = fs.readFileSync(file);
  const built = guarded(file, () => autoBuildTree({ session: 'target', storeFile: file }));
  assert.equal(built.result.built, true);
  assert.equal(built.result.reason, 'built');
  assert.equal(built.result.segCount, 1);
  assert.ok(built.audit.lockFsyncs >= 1);
  const after = fs.readFileSync(file);
  assert.deepEqual(after.subarray(0, before.length), before);
  const written = after.toString('utf8').trim().split('\n').map(JSON.parse).filter(row => row.kind === 'node');
  assert.ok(written.length > 0);
  assert.deepEqual(written.filter(row => row.level === 1).flatMap(row => row.children), ['one']);
  const unchanged = guarded(file, () => autoBuildTree({ session: 'session-target', storeFile: file }));
  assert.equal(unchanged.result.reason, 'fingerprint-unchanged');
  assert.equal(unchanged.result.treegen, built.result.treegen);
  assert.ok(unchanged.audit.lockFsyncs >= 1);
  assert.deepEqual(fs.readFileSync(file), after);
  const forced = guarded(file, () => autoBuildTree({ session: 'target', storeFile: file, force: true }));
  assert.equal(forced.result.reason, 'content-unchanged');
  assert.equal(forced.result.treegen, built.result.treegen);
  assert.deepEqual(fs.readFileSync(file), after);
});

test('autoBuildTree dirty throttled branch never whole-loads or appends', () => {
  const file = store([
    segment('one', 1), segment('two', 2),
    { id: 'current-node', kind: 'node', session: 'target', treegen: 123,
      treeFingerprint: { segCount: 1, latestSeq: 1 }, logged_at: new Date().toISOString() },
  ]);
  const before = fs.readFileSync(file);
  const { result, audit } = guarded(file, () => autoBuildTree({ session: 'target', storeFile: file, minIntervalMs: 3600000 }));
  assert.equal(result.built, false);
  assert.equal(result.reason, 'throttled');
  assert.equal(result.segCount, 2);
  assert.equal(result.latestSeq, 2);
  assert.equal(result.treegen, 123);
  assert.ok(result.nextEligibleInMs > 0 && result.nextEligibleInMs <= 3600000);
  assert.ok(audit.lockFsyncs >= 1);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('incremental build appends only changed nodes; latestNodes restores the full tree', async () => {
  const rows = Array.from({ length: 40 }, (_, i) => segment('inc-' + i, i + 1));
  const file = store(rows);
  const first = guarded(file, () => autoBuildTree({ session: 'target', storeFile: file, minIntervalMs: 0 }));
  assert.equal(first.result.built, true);
  const firstCount = first.result.nodes;
  fs.appendFileSync(file, JSON.stringify(segment('inc-40', 41)) + '\n');
  const second = guarded(file, () => autoBuildTree({ session: 'target', storeFile: file, force: true, minIntervalMs: 0 }));
  assert.equal(second.result.built, true);
  assert.ok(second.result.nodes < firstCount, JSON.stringify(second.result));
  const nodes = latestNodes(file, 'target');
  assert.equal(nodes.length, second.result.totalNodes, JSON.stringify({ total: second.result.totalNodes, got: nodes.length }));
  const expected = buildTree({ session: 'target', storeFile: file });
  assert.deepEqual(nodes.map((n) => n.id).sort(), expected.nodes.map((n) => n.id).sort());
  const detailed = lookupSegmentsDetailed('inc-0', { storeFile: file, level: 'nodes', limit: 5 });
  const hits = detailed.hits;
  assert.equal(detailed.sessionTotal, 8, JSON.stringify(detailed));
  assert.ok(hits.length > 0, JSON.stringify(hits));
  assert.ok(hits.every((hit) => expected.nodes.some((node) => node.id === hit.id)), JSON.stringify(hits.map((hit) => hit.id)));
  const rendered = renderTree(file, 'target');
  assert.ok(rendered.includes('41 段'), rendered);
  const committed = latestNodes(file, 'target').map((n) => n.id).sort();
  const manifest = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse).filter((row) => row.kind === 'tree-manifest').sort((a, b) => b.treegen - a.treegen)[0];
  const uncommittedGen = (Number(manifest.treegen) || 0) + 1;
  fs.appendFileSync(file, JSON.stringify({ ...expected.nodes[0], gist: 'uncommitted', treegen: uncommittedGen }) + '\n');
  assert.deepEqual(latestNodes(file, 'target').map((n) => n.id).sort(), committed);
  assert.notEqual(latestNodes(file, 'target').find((n) => n.id === expected.nodes[0].id)?.gist, 'uncommitted');
  assert.equal(lookupSegmentsDetailed('uncommitted', { storeFile: file, level: 'nodes' }).hits.length, 0);
  const nodeRows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse).filter((row) => row.kind === 'node');
  const counts = new Map();
  for (const row of nodeRows) counts.set(row.id, (counts.get(row.id) || 0) + 1);
  assert.ok([...counts.values()].some((count) => count === 1), 'unchanged nodes must not be re-appended');
});

test('repeated manual builds project one active node per id', async () => {
  const { commitTreeGeneration } = await import('./session.mjs');
  const file = store([segment('m-1', 1), segment('m-2', 2)]);
  const first = buildTree({ session: 'target', storeFile: file });
  assert.equal(commitTreeGeneration(file, 'target', first.treegen, first.nodes, first.segCount).built, true);
  const second = buildTree({ session: 'target', storeFile: file });
  assert.equal(commitTreeGeneration(file, 'target', second.treegen, second.nodes, second.segCount).built, false);
  const active = latestNodes(file, 'target');
  assert.equal(new Set(active.map((n) => n.id)).size, active.length);
  const hits = lookupSegmentsDetailed('m-1', { storeFile: file, level: 'nodes' });
  assert.ok(hits.hits.length <= 1, JSON.stringify(hits.hits));
  assert.equal(hits.sessionTotal, active.length);
});

test('invalid manifest fallback is one per id across tree, lookup and title', () => {
  const file = store([
    { id: 'future', kind: 'node', session: 'target', treegen: 2, level: 1, gist: 'future', children: [], seq: 1 },
    { id: 'm', kind: 'tree-manifest', session: 'target', treegen: 1, active_ids: ['future'] },
  ]);
  const active = latestNodes(file, 'target');
  assert.equal(active.length, 1);
  const hits = lookupSegmentsDetailed('future', { storeFile: file, level: 'nodes' });
  assert.equal(hits.hits.length, 1);
  assert.ok(renderTree(file, 'target').includes('fallback'));
});
