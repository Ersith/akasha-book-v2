import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readSelfSource, projectSelf, cachePathFor, writeProjectionCache,
  readProjectionCache, clearProjectionCache,
} from './self-loader.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'self-loader-'));
  const canonFile = join(dir, 'canon.jsonl');
  const rows = [
    { id: 'i', kind: 'identity', claim: '我是大肥鱼', revision: 'r1' },
    { id: 'a', kind: 'address', claim: '称 Master', revision: 'r1' },
    { id: 'b', kind: 'boundary', claim: '零编造', revision: 'r1' },
  ];
  writeFileSync(canonFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return { dir, canonFile };
}

test('source is captured frozen with generation and parsed errors', () => {
  const { dir, canonFile } = fixture();
  try {
    const source = readSelfSource({ canonFile });
    assert.equal(source.schemaVersion, 'self-source/v1');
    assert.match(source.generation, /^sha256:[0-9a-f]{64}$/);
    assert.equal(source.records.length, 3);
    assert.equal(Object.isFrozen(source.records[0]), true);
    assert.equal(Object.isFrozen(source), true);
    assert.throws(() => { source.records[0].claim = 'x'; }, TypeError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('projectSelf carries parse errors into failed projection', () => {
  const { dir, canonFile } = fixture();
  try {
    writeFileSync(canonFile, '{"id":"i","kind":"identity","claim":"I"}\n{broken\n', 'utf8');
    const { source, projection } = projectSelf({ canonFile, subjectId: 'default', requiredKinds: ['identity'] });
    assert.equal(source.errors.length, 1);
    assert.equal(projection.status, 'failed');
    assert.ok(projection.warnings.some((w) => w.includes('canon 第')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cache roundtrip, stale, corrupt and old-write guard', () => {
  const { dir, canonFile } = fixture();
  try {
    const { source, projection } = projectSelf({ canonFile });
    const cacheFile = cachePathFor(canonFile);
    assert.equal(writeProjectionCache({ cacheFile, source, projection, capturedAt: 200 }).status, 'written');
    assert.ok(['skipped-newer','skipped-same'].includes(writeProjectionCache({ cacheFile, source, projection, capturedAt: 100 }).status));
    const fresh = readProjectionCache({ cacheFile, generation: source.generation, subjectId: 'default', policyVersion: projection.policyVersion });
    assert.equal(fresh.status, 'fresh');
    assert.equal(fresh.projection.stableHash, projection.stableHash);
    assert.equal(readProjectionCache({ cacheFile, generation: 'sha256:other', subjectId: 'default', policyVersion: projection.policyVersion }).status, 'stale');
    writeFileSync(cacheFile, '{bad json', 'utf8');
    assert.equal(readProjectionCache({ cacheFile, generation: source.generation, subjectId: 'default', policyVersion: projection.policyVersion }).status, 'corrupt');
    clearProjectionCache(cacheFile);
    assert.equal(readProjectionCache({ cacheFile, generation: source.generation, subjectId: 'default', policyVersion: projection.policyVersion }).status, 'missing');
    assert.equal(readdirSync(dir).filter((f) => f.endsWith('.tmp')).length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing canon is an explicit source error, not a healthy empty projection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'self-loader-'));
  try {
    const canonFile = join(dir, 'missing.jsonl');
    const source = readSelfSource({ canonFile });
    assert.equal(source.generation, null);
    assert.equal(source.errors.length, 1);
    const { projection } = projectSelf({ canonFile });
    assert.equal(projection.status, 'failed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('cache path refuses unsupported suffix and source collision', () => {
  const { dir, canonFile } = fixture();
  try {
    assert.throws(() => cachePathFor(join(dir, 'canon.data')), /\.jsonl/);
    const { source, projection } = projectSelf({ canonFile });
    assert.throws(() => writeProjectionCache({ cacheFile: canonFile, source, projection }), /canon 源/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('invalid UTF-8 is a source error, not silent replacement', () => {
  const { dir, canonFile } = fixture();
  try {
    writeFileSync(canonFile, Buffer.concat([Buffer.from('{"id":"i","kind":"identity","claim":"'), Buffer.from([0xff]), Buffer.from('"}\n')]));
    const source = readSelfSource({ canonFile });
    assert.equal(source.records.length, 0);
    assert.ok(source.errors.some((e) => /UTF-8/.test(e.error)));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sourceErrors wrong type is rejected', () => {
  const { dir, canonFile } = fixture();
  try {
    assert.throws(() => projectSelf({ canonFile, sourceErrors: 'bad' }), /sourceErrors/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cache rejects tampered/missing projection body and policy changes write new', () => {
  const { dir, canonFile } = fixture();
  try {
    const { source, projection } = projectSelf({ canonFile });
    const cacheFile = cachePathFor(canonFile);
    writeProjectionCache({ cacheFile, source, projection });
    const raw = JSON.parse(readFileSync(cacheFile, 'utf8'));
    raw.projection.stableText = 'tampered';
    writeFileSync(cacheFile, JSON.stringify(raw));
    assert.equal(readProjectionCache({ cacheFile, generation: source.generation, subjectId: 'default', policyVersion: projection.policyVersion }).status, 'corrupt');
    delete raw.projection.stableText;
    writeFileSync(cacheFile, JSON.stringify(raw));
    assert.equal(readProjectionCache({ cacheFile, generation: source.generation, subjectId: 'default', policyVersion: projection.policyVersion }).status, 'corrupt');

    const v2 = projectSelf({ canonFile, policyVersion: 'self-policy/v2' }).projection;
    assert.equal(writeProjectionCache({ cacheFile, source, projection: v2 }).status, 'written');
    assert.equal(readProjectionCache({ cacheFile, generation: source.generation, subjectId: 'default', policyVersion: 'self-policy/v1' }).status, 'stale');
    assert.equal(readProjectionCache({ cacheFile, generation: source.generation, subjectId: 'default', policyVersion: 'self-policy/v2' }).status, 'fresh');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('older source stamp cannot overwrite newer cache', () => {
  const { dir, canonFile } = fixture();
  try {
    const { source, projection } = projectSelf({ canonFile });
    const cacheFile = cachePathFor(canonFile);
    assert.equal(writeProjectionCache({ cacheFile, source, projection, capturedAt: 200 }).status, 'written');
    const oldSource = { ...source, sourceStamp: source.sourceStamp.map((v, i) => i === 1 ? v - 10_000 : v) };
    writeFileSync(canonFile, `${JSON.stringify({ id: 'new', kind: 'principle', claim: '新源', revision: 'r2' })}
`, { flag: 'a' });
    assert.equal(writeProjectionCache({ cacheFile, source: oldSource, projection }).status, 'skipped-newer');
    assert.equal(readProjectionCache({ cacheFile, generation: source.generation, subjectId: 'default', policyVersion: projection.policyVersion }).status, 'fresh');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
