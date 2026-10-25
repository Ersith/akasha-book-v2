import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { zstdCompressSync } from 'node:zlib';

const temporaryParent = resolve(tmpdir());
const temporaryRoot = fs.mkdtempSync(join(temporaryParent, 'akasha-session-index-safety-'));
const previousEnvironment = Object.fromEntries(
  ['AKASHA_ROOT', 'AKASHA_LOGS', 'AKASHA_COMPANIONS', 'AKASHA_DIR']
    .map(name => [name, process.env[name]]),
);
process.env.AKASHA_ROOT = join(temporaryRoot, 'data');
process.env.AKASHA_LOGS = join(temporaryRoot, 'logs');
process.env.AKASHA_COMPANIONS = join(temporaryRoot, 'companions-absent.json');
process.env.AKASHA_DIR = dirname(fileURLToPath(import.meta.url));

const originalFs = Object.fromEntries(
  ['readFileSync', 'readdirSync', 'appendFileSync', 'writeFileSync', 'renameSync']
    .map(name => [name, fs[name]]),
);

after(() => {
  Object.assign(fs, originalFs);
  syncBuiltinESMExports();
  for (const [name, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  const target = resolve(temporaryRoot);
  // Only remove this test process's mkdtemp directory, never a parent or shared scratch.
  assert.equal(dirname(target), temporaryParent);
  assert.ok(target.startsWith(temporaryParent + sep + 'akasha-session-index-safety-'));
  fs.rmSync(target, { recursive: true, force: true });
});

// Dynamic import is intentional: data/log roots must be isolated before lib.mjs loads.
const { indexSession, resolveSessionArchive } = await import('./session.mjs');
let fixtureNumber = 0;

function samePath(left, right) {
  try { return resolve(String(left)).toLowerCase() === resolve(right).toLowerCase(); }
  catch { return false; }
}

function withFaults({ readFailure, unreadableDirectory, writes } = {}, run) {
  fs.readFileSync = function (file, ...args) {
    if (readFailure && samePath(file, readFailure.file)) {
      throw Object.assign(new Error(`fixture ${readFailure.code}`), { code: readFailure.code });
    }
    return originalFs.readFileSync.call(this, file, ...args);
  };
  fs.readdirSync = function (file, ...args) {
    if (unreadableDirectory && samePath(file, unreadableDirectory)) {
      throw Object.assign(new Error('fixture access denied'), { code: 'EACCES' });
    }
    return originalFs.readdirSync.call(this, file, ...args);
  };
  for (const name of ['appendFileSync', 'writeFileSync', 'renameSync']) {
    fs[name] = function (...args) {
      const path = name === 'renameSync' ? args[1] : args[0];
      if (writes && (samePath(path, writes.store) || samePath(path, writes.meta)
          || String(path).startsWith(writes.meta + '.'))) {
        writes.events.push({ method: name, path: String(path) });
      }
      // Observation only: real filesystem writes, atomic rename and fsync remain active.
      return originalFs[name].apply(this, args);
    };
  }
  syncBuiltinESMExports();
  try { return run(); }
  finally {
    Object.assign(fs, originalFs);
    syncBuiltinESMExports();
  }
}

function fixture(meta) {
  const dir = join(temporaryRoot, `fixture-${++fixtureNumber}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = join(dir, 'session.v4.jsonl.zstd');
  const store = join(dir, 'session.jsonl');
  const metaFile = join(dir, 'session-meta.json');
  const event = {
    seq: 1, type: 'user/message', time: '2026-10-24T03:00:00Z',
    data: { turn: 1, content: [{ type: 'text', text: 'fixture user request' }] },
  };
  fs.writeFileSync(file, zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n')));
  fs.writeFileSync(store, '');
  if (meta !== undefined) fs.writeFileSync(metaFile, meta);
  return { file, store, metaFile, args: { file, session: 'fixture-self', storeFile: store, metaFile } };
}

function assertFailureWithoutWrites(meta, code) {
  const sample = fixture(meta);
  const beforeStore = fs.readFileSync(sample.store);
  const beforeMeta = fs.readFileSync(sample.metaFile);
  const writes = { store: sample.store, meta: sample.metaFile, events: [] };
  let error;
  withFaults({ readFailure: code ? { file: sample.metaFile, code } : undefined, writes }, () => {
    try { indexSession(sample.args); } catch (caught) { error = caught; }
  });
  assert.ok(error, `must reject before writes: ${JSON.stringify(writes.events)}`);
  if (code) assert.equal(error.code, code);
  assert.deepEqual(fs.readFileSync(sample.store), beforeStore, 'store bytes unchanged');
  assert.deepEqual(fs.readFileSync(sample.metaFile), beforeMeta, 'meta bytes unchanged');
  assert.equal(writes.events.length, 0, 'no store/meta append, write or rename');
}

// These tests mutate node:fs only inside synchronous, sequential callbacks.
test('bad meta JSON rejects before append/meta write', { concurrency: false }, () => {
  assertFailureWithoutWrites('{bad');
});
for (const code of ['EACCES', 'EIO']) {
  test(`${code} propagates before append/meta write`, { concurrency: false }, () => {
    assertFailureWithoutWrites('{"sessions":{"other":{"lastSeq":77}}}', code);
  });
}
for (const value of [null, [], 3, 'text', { sessions: null }, { sessions: [] }, { sessions: 'bad' }]) {
  test(`invalid meta shape ${JSON.stringify(value)} rejects before writes`, { concurrency: false }, () => {
    assertFailureWithoutWrites(JSON.stringify(value));
  });
}
test('missing meta initializes normally', { concurrency: false }, () => {
  const sample = fixture();
  assert.equal(indexSession(sample.args).added, 1);
  const meta = JSON.parse(fs.readFileSync(sample.metaFile, 'utf8'));
  assert.equal(meta.sessions['fixture-self'].lastSeq, 1);
});
test('other sid and unrelated root metadata remain intact', { concurrency: false }, () => {
  const previous = {
    version: 1, marker: { preserve: true },
    sessions: { other: { lastSeq: 77, segments: 4, source: 'fixture-old' }, 'fixture-self': { lastSeq: 0 } },
  };
  const sample = fixture(JSON.stringify(previous));
  assert.equal(indexSession(sample.args).added, 1);
  const next = JSON.parse(fs.readFileSync(sample.metaFile, 'utf8'));
  assert.deepEqual(next.sessions.other, previous.sessions.other);
  assert.deepEqual(next.marker, previous.marker);
  assert.equal(next.sessions['fixture-self'].lastSeq, 1);
});

function scanRoot() {
  const root = join(temporaryRoot, `scan-${++fixtureNumber}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}
const assertScanError = run => assert.throws(run, error => error.code === 'SCAN_FAILED');
test('missing sessions root reports SCAN_FAILED', { concurrency: false }, () => {
  assertScanError(() => resolveSessionArchive(join(temporaryRoot, 'absent-root'), 'wanted'));
});
test('root EACCES reports SCAN_FAILED', { concurrency: false }, () => {
  const root = scanRoot();
  withFaults({ unreadableDirectory: root }, () => assertScanError(() => resolveSessionArchive(root, 'wanted')));
});
test('matching directory EACCES reports SCAN_FAILED', { concurrency: false }, () => {
  const root = scanRoot(), target = join(root, 'session-wanted');
  fs.mkdirSync(target);
  withFaults({ unreadableDirectory: target }, () => assertScanError(() => resolveSessionArchive(root, 'wanted')));
});
test('unreadable subtree without hit reports incomplete SCAN_FAILED', { concurrency: false }, () => {
  const root = scanRoot(), unreadable = join(root, 'a-unreadable');
  fs.mkdirSync(unreadable);
  withFaults({ unreadableDirectory: unreadable }, () => assertScanError(() => resolveSessionArchive(root, 'wanted')));
});
test('unreadable unrelated subtree does not discard a definite later hit', { concurrency: false }, () => {
  const root = scanRoot(), unreadable = join(root, 'a-unreadable'), target = join(root, 'session-wanted');
  fs.mkdirSync(unreadable); fs.mkdirSync(target);
  const file = join(target, 'record.zstd'); fs.writeFileSync(file, 'fixture');
  withFaults({ unreadableDirectory: unreadable }, () => {
    assert.deepEqual(resolveSessionArchive(root, 'wanted'), { file, child: false });
  });
});
test('complete healthy scan with no matching session remains null', { concurrency: false }, () => {
  assert.equal(resolveSessionArchive(scanRoot(), 'wanted'), null);
});
test('bare child session layout still resolves with child marker', { concurrency: false }, () => {
  const root = scanRoot(), target = join(root, 'wanted'); fs.mkdirSync(target);
  const file = join(target, 'record.zstd'); fs.writeFileSync(file, 'fixture');
  assert.deepEqual(resolveSessionArchive(root, 'session-wanted'), { file, child: true });
});
