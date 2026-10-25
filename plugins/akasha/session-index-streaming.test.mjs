import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { zstdCompressSync } from 'node:zlib';

const tempParent = path.resolve(tmpdir());
const root = fs.mkdtempSync(path.join(tempParent, 'akasha-index-streaming-'));
const env = {
  AKASHA_ROOT: path.join(root, 'data'), AKASHA_LOGS: path.join(root, 'logs'),
  AKASHA_DIR: path.dirname(fileURLToPath(import.meta.url)),
  AKASHA_COMPANIONS: path.join(root, 'absent-companions.json'),
  AKASHA_SESSIONS_ROOT: path.join(root, 'absent-sessions'), AKASHA_QUERY_LOG: 'off',
};
const priorEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
Object.assign(process.env, env);
fs.mkdirSync(env.AKASHA_ROOT); fs.mkdirSync(env.AKASHA_LOGS);
for (const store of ['canon', 'mirror', 'orphan', 'pricing', 'lexicon', 'frontier']) fs.writeFileSync(path.join(env.AKASHA_ROOT, store + '.jsonl'), '');
const original = { ...fs }, fdFiles = new Map();
let active = null, serial = 0;
const canonical = value => {
  const p = path.resolve(value instanceof URL ? fileURLToPath(value) : String(value));
  return process.platform === 'win32' ? p.toLowerCase() : p;
};
fs.openSync = function (file, flags, ...args) {
  const p = canonical(file);
  if (active?.file === p && flags === 'r' && active.failOpen) throw Object.assign(new Error('fixture EACCES'), { code: 'EACCES' });
  const fd = original.openSync(file, flags, ...args);
  fdFiles.set(fd, { file: p, flags });
  const exclusive = typeof flags === 'number' ? (flags & fs.constants.O_EXCL) !== 0 : String(flags).includes('x');
  if (active && exclusive && (p === active.file + '.lock' || p === active.meta + '.lock')) active.locks.push(p);
  return fd;
};
fs.closeSync = function (fd) { try { return original.closeSync(fd); } finally { fdFiles.delete(fd); } };
fs.readFileSync = function (file, ...args) {
  const p = typeof file === 'number' ? fdFiles.get(file)?.file : canonical(file);
  if (active?.file === p) { active.wholeReads += 1; throw new Error('WHOLE_SESSION_STORE_READ_FORBIDDEN'); }
  return original.readFileSync(file, ...args);
};
fs.readSync = function (fd, buffer, offset, length, position) {
  if (active?.file === fdFiles.get(fd)?.file && fdFiles.get(fd)?.flags === 'r') {
    active.readCalls += 1; active.maxRead = Math.max(active.maxRead, length);
    if (active.readCalls === active.failRead) throw Object.assign(new Error('fixture EIO'), { code: 'EIO' });
    if (active.readCalls === active.zeroRead) return 0;
  }
  return original.readSync(fd, buffer, offset, length, position);
};
syncBuiltinESMExports();
test.after(() => {
  for (const key of ['openSync', 'closeSync', 'readFileSync', 'readSync']) fs[key] = original[key];
  syncBuiltinESMExports();
  for (const [key, value] of Object.entries(priorEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  assert.equal(path.dirname(path.resolve(root)), tempParent);
  assert.ok(path.basename(root).startsWith('akasha-index-streaming-'));
  fs.rmSync(root, { recursive: true, force: true });
});
const { indexSession } = await import('./session.mjs');
const sid = 'target';
const user = (seq, text = 'request') => ({ seq, type: 'user/message', time: 1792800000000, data: { turn: 1, content: [{ type: 'text', text }] } });
const assistant = (seq, text = 'answer') => ({ seq, type: 'assistant/message', time: 1792800001000, data: { turn: 1, message: { content: [{ type: 'text', text }] } } });
const call = (seq = 1) => ({ seq, type: 'tool/call', time: 1792800000000, data: { callId: 'call-1', name: 'read', arguments: '{}', turn: 1, step: 1 } });
const result = (seq = 2) => ({ seq, type: 'tool/result', time: 1792800001000, data: { toolCallId: 'call-1', content: [{ type: 'text', text: 'done' }] } });
const record = (id, session = sid, extra = {}) => ({ id, store: 'session', session, seq: 90, kind: 'intent', gist: id, ptr: { seq: 90 }, ...extra });
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
function fixture(events, rows = [], options = {}) {
  const dir = path.join(root, String(++serial)); fs.mkdirSync(dir);
  const f = { dir, file: path.join(dir, 'source.zstd'), storeFile: path.join(dir, 'session.jsonl'), metaFile: path.join(dir, 'meta.json') };
  fs.writeFileSync(f.file, zstdCompressSync(Buffer.from(jsonl(events))));
  if (!options.missingStore) fs.writeFileSync(f.storeFile, options.raw ?? jsonl(rows));
  fs.writeFileSync(f.metaFile, JSON.stringify(options.meta ?? { version: 1, sessions: { other: { lastSeq: 77, marker: 'preserve' } } }));
  return f;
}
function execute(f, options = {}, faults = {}) {
  assert.equal(active, null);
  const audit = active = { file: canonical(f.storeFile), meta: canonical(f.metaFile), wholeReads: 0, readCalls: 0, maxRead: 0, locks: [], ...faults };
  try { return { result: indexSession({ ...f, session: sid, ...options }), audit }; }
  finally {
    active = null;
    assert.equal(fs.existsSync(f.storeFile + '.lock'), false);
    assert.equal(fs.existsSync(f.metaFile + '.lock'), false);
  }
}
const rowsOf = f => original.readFileSync(f.storeFile, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const metaOf = f => JSON.parse(original.readFileSync(f.metaFile, 'utf8'));
const own = f => metaOf(f).sessions[sid];
function unchangedOnFailure(f, fn, expected) {
  const beforeStore = original.readFileSync(f.storeFile), beforeMeta = original.readFileSync(f.metaFile);
  assert.throws(fn, expected);
  assert.deepEqual(original.readFileSync(f.storeFile), beforeStore);
  assert.deepEqual(original.readFileSync(f.metaFile), beforeMeta);
}

test('index scans multi-chunk store without materializing whole-file text and preserves other metadata', () => {
  const f = fixture([assistant(1)], [record('large-other', 'other', { gist: '中文🙂'.repeat(26000) })]);
  const { result: r, audit } = execute(f);
  assert.equal(r.added, 1); assert.equal(r.lastSeq, 1);
  assert.ok(audit.readCalls > 1); assert.ok(audit.maxRead <= 64 * 1024); assert.equal(audit.wholeReads, 0);
  assert.deepEqual(audit.locks, [canonical(f.storeFile) + '.lock', canonical(f.metaFile) + '.lock']);
  assert.equal(own(f).segments, 1); assert.equal(own(f).conclusions, 1);
  assert.deepEqual(metaOf(f).sessions.other, { lastSeq: 77, marker: 'preserve' });
  assert.equal(rowsOf(f)[0].gist, '中文🙂'.repeat(26000));
});

test('an ID already owned by another session still prevents a duplicate append', () => {
  const seed = fixture([assistant(1)]); execute(seed);
  const prior = { ...rowsOf(seed)[0], session: 'other' };
  const f = fixture([assistant(1)], [prior]);
  const { result: r } = execute(f, { full: true });
  assert.equal(r.added, 0); assert.equal(r.skipped, 1); assert.equal(rowsOf(f).length, 1);
  assert.equal(own(f).segments, 0); assert.equal(own(f).conclusions, 0);
});

test('another session with the same callSeq does not suppress a late completed pair', () => {
  const f = fixture([call(), result()], [record('other-call', 'other', { kind: 'action', gist: 'read：{} ↳ done', ptr: { callSeq: 1 } })], { meta: { version: 1, sessions: { target: { lastSeq: 20 } } } });
  const { result: r } = execute(f);
  assert.equal(r.added, 1); assert.equal(r.lastSeq, 20);
  assert.equal(rowsOf(f).filter(x => x.session === sid && x.kind === 'action').length, 1);
  assert.equal(own(f).segments, 1);
});

test('the current session completed callSeq suppresses an already indexed late pair', () => {
  const f = fixture([call(), result()], [record('old-pair', 'session-target', { kind: 'action', gist: 'read：{} ↳ done', ptr: { callSeq: 1 } })], { meta: { version: 1, sessions: { target: { lastSeq: 20 } } } });
  assert.equal(execute(f).result.added, 0); assert.equal(own(f).segments, 1);
});

test('full rebuild retains unpaired suppression for the same normalized session only', () => {
  const f = fixture([call()], [record('old-unpaired', 'session-target', { kind: 'action', gist: 'old（无结果）', ptr: { callSeq: 1 } })]);
  assert.equal(execute(f, { full: true }).result.added, 0);
  const other = fixture([call()], [record('other-unpaired', 'other', { kind: 'action', gist: 'old（无结果）', ptr: { callSeq: 1 } })]);
  assert.equal(execute(other, { full: true }).result.added, 1);
});

test('full rebuild is idempotent while changed content at the same seq appends a new version', () => {
  const f = fixture([user(1), assistant(2)]);
  assert.equal(execute(f).result.added, 2);
  assert.equal(execute(f, { full: true }).result.added, 0);
  fs.writeFileSync(f.file, zstdCompressSync(Buffer.from(jsonl([user(1), assistant(2, 'changed answer')]))));
  const changed = execute(f, { full: true }).result;
  assert.equal(changed.added, 1); assert.equal(changed.skipped, 1);
  assert.equal(own(f).segments, 3); assert.equal(own(f).conclusions, 2);
  assert.equal(execute(f, { full: true }).result.added, 0);
});

test('legacy IDs with the same content key remain deduplicated across session aliases', () => {
  const seed = fixture([assistant(1)]); execute(seed);
  const prior = { ...rowsOf(seed)[0], id: 'legacy-id', session: 'session-target' };
  const f = fixture([assistant(1)], [prior]);
  const r = execute(f, { full: true }).result;
  assert.equal(r.added, 0); assert.equal(r.skipped, 1); assert.equal(own(f).segments, 1);
});

test('owned and conclusion counts remain distinct-ID counts and retain existing nodes', () => {
  const f = fixture([user(1)], [record('duplicate', sid, { kind: 'conclusion' }), record('duplicate', 'session-target'), record('tree-node', sid, { kind: 'node' }), record('other', 'other', { kind: 'conclusion' })]);
  assert.equal(execute(f).result.added, 1);
  assert.equal(own(f).segments, 3); assert.equal(own(f).conclusions, 1);
});

test('malformed JSON lines remain tolerated and an incomplete tail is quarantined before append', () => {
  const valid = record('keep', sid, { kind: 'conclusion' });
  const f = fixture([user(1)], [], { raw: 'not-json\n' + jsonl([valid]) + '{incomplete' });
  assert.equal(execute(f).result.added, 1);
  assert.equal(own(f).segments, 2); assert.equal(own(f).conclusions, 1);
  assert.ok(original.readFileSync(f.storeFile, 'utf8').startsWith('not-json\n' + jsonl([valid])));
  assert.equal(fs.readdirSync(f.dir).filter(name => name.startsWith('session.jsonl.corrupt-')).length, 1);
});

test('a complete final JSON row without LF participates in deduplication', () => {
  const seed = fixture([assistant(1)]); execute(seed);
  const f = fixture([assistant(1)], [], { raw: JSON.stringify(rowsOf(seed)[0]) });
  assert.equal(execute(f, { full: true }).result.added, 0);
  assert.equal(own(f).segments, 1); assert.equal(rowsOf(f).length, 1);
});

test('a missing store can be indexed normally', () => {
  const f = fixture([user(1)], [], { missingStore: true });
  assert.equal(execute(f).result.added, 1); assert.equal(own(f).segments, 1);
});

test('scan EACCES preserves store and metadata and releases both locks', () => {
  const f = fixture([user(1)], [record('old')]);
  unchangedOnFailure(f, () => execute(f, {}, { failOpen: true }), { code: 'EACCES' });
});

test('a mid-scan EIO never writes a partial snapshot or advances metadata', () => {
  const f = fixture([user(1)], [record('large', 'other', { gist: 'x'.repeat(150000) })]);
  unchangedOnFailure(f, () => execute(f, {}, { failRead: 2 }), { code: 'EIO' });
});

test('unexpected EOF before the initial file size preserves store and metadata', () => {
  const f = fixture([user(1)], [record('large', 'other', { gist: 'x'.repeat(150000) })]);
  unchangedOnFailure(f, () => execute(f, {}, { zeroRead: 2 }), { code: 'EIO' });
});

test('a structurally invalid parsed row is not swallowed as bad JSON', () => {
  const f = fixture([user(1)], [record('keep'), null]);
  unchangedOnFailure(f, () => execute(f), TypeError);
});
