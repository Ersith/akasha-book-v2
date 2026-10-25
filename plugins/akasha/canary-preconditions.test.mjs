import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSessionIdentity } from './session-identity.mjs';
import { snapshotDataView } from './data-view.mjs';

test('session identity prefers AKASHA and hashes the id', () => {
  const a = resolveSessionIdentity({ AKASHA_SESSION_ID: 'session-abcdef12', DSH_SESSION_ID: 'session-ffffffff' });
  assert.equal(a.source, 'akasha');
  assert.equal(a.wellFormed, true);
  assert.match(a.idHash, /^[0-9a-f]{16}$/);
  assert.equal(resolveSessionIdentity({ DSH_SESSION_ID: 'session-ffffffff' }).source, 'dsh');
  assert.equal(resolveSessionIdentity({ AKASHA_SESSION_ID: 'x' }).wellFormed, false);
  assert.equal(resolveSessionIdentity({}).present, false);
});

test('data view hash changes when a file changes and marks missing files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'akasha-view-'));
  const file = join(dir, 'canon.jsonl');
  try {
    writeFileSync(file, 'a\n');
    const evidence = join(dir, 'missing.jsonl');
    const one = snapshotDataView({ canon: file, evidence }, { allowMissing: ['evidence'] });
    assert.equal(one.files.length, 1);
    assert.equal(one.missing.length, 1);
    assert.equal(one.valid, true);
    const required = snapshotDataView({ canon: join(dir, 'required.jsonl') });
    assert.equal(required.valid, false);
    assert.equal(required.errors[0].code, 'ENOENT');
    writeFileSync(file, 'b\n');
    const two = snapshotDataView({ canon: file, evidence }, { allowMissing: ['evidence'] });
    assert.notEqual(one.hash, two.hash);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
