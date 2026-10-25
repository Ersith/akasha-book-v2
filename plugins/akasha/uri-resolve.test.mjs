import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseAkashaUri, show, showUri } from './lib.mjs';

const fixture = (records) => {
  const dir = mkdtempSync(join(tmpdir(), 'akasha-uri-'));
  const file = join(dir, 'canon.jsonl');
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return { dir, file };
};
const rec = (id, claim = id) => ({ id, claim, source: { type: '复现', ref: 'test' }, event_time: '2026-10-23', last_reviewed: '2026-10-23', tags: [] });
const ID = 'canon-exp-engineering-vs-presence-20261023';
const URI = 'akasha://canon/' + encodeURIComponent(ID);

test('showUri resolves an explicit URI to the same fixture record', () => {
  const { dir, file } = fixture([rec(ID)]);
  try {
    const bare = show(ID, { store: 'canon', file });
    const viaUri = showUri(URI, { store: 'canon', file });
    assert.equal(bare.found, true);
    assert.equal(viaUri.found, true);
    assert.equal(viaUri.store, 'canon');
    assert.equal(viaUri.id, ID);
    assert.equal(viaUri.record.claim, bare.record.claim);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('bare show keeps URI-shaped and incomplete literal IDs as IDs', () => {
  const shaped = 'akasha://canon/foo';
  const { dir, file } = fixture([rec('foo', 'plain foo'), rec(shaped, 'literal URI-shaped id'), rec('akasha://note', 'incomplete literal')]);
  try {
    assert.equal(show(shaped, { store: 'canon', file }).id, shaped);
    assert.equal(show(shaped, { store: 'canon', file }).record.claim, 'literal URI-shaped id');
    assert.equal(show('akasha://canon/foo', { store: 'canon', file, inputKind: 'uri' }).id, 'foo');
    assert.equal(show('akasha://note', { store: 'canon', file }).id, 'akasha://note');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('URI parser round-trips special IDs and rejects bad forms', () => {
  const special = 'part#frag?query%25';
  assert.deepEqual(parseAkashaUri('akasha://canon/' + encodeURIComponent(special)), { store: 'canon', id: special });
  assert.throws(() => parseAkashaUri('https://canon/' + ID), /not an akasha URI/);
  assert.throws(() => parseAkashaUri('akasha://nope/' + ID), /unknown akasha store/);
  assert.throws(() => parseAkashaUri('akasha://canon/%E0%A4%A'), /percent-encoding/);
  assert.throws(() => parseAkashaUri('akasha://canon/'), /missing store or id|invalid akasha URI component/);
  assert.throws(() => parseAkashaUri('akasha://canon/a/b'), /invalid akasha URI component/);
});

test('explicit store mismatch and invalid inputKind fail closed', () => {
  const { dir, file } = fixture([rec(ID)]);
  try {
    const r = showUri(URI, { store: 'mirror', file });
    assert.equal(r.found, false);
    assert.match(r.note, /不一致/);
    assert.throws(() => show(ID, { inputKind: 'auto' }), /invalid inputKind/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI refuses --uri combined with --expand in either order', () => {
  const cli = fileURLToPath(new URL('./akasha.mjs', import.meta.url));
  const { dir } = fixture([]);
  try {
    for (const args of [
      ['show', '--uri', URI, '--expand', '--json'],
      ['show', URI, '--uri', '--expand', '--json'],
    ]) {
      const r = spawnSync(process.execPath, [cli, ...args], {
        encoding: 'utf8',
        env: { ...process.env, AKASHA_ROOT: dir, AKASHA_LOGS: join(dir, 'logs') },
        timeout: 15000,
      });
      assert.ifError(r.error);
      assert.equal(r.status, 1, `expected guard exit 1 for ${args.join(' ')}`);
      assert.match(r.stderr, /暂不支持与 --expand 同用/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
