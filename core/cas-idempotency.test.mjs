import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { revise } from './lib.mjs';

function fixture(dir) {
  const file = join(dir, 'canon.jsonl');
  writeFileSync(file, JSON.stringify({
    id: 'x', claim: 'v1', source: { type: '官方', ref: 'test' }, event_time: '2026-10-25', last_reviewed: '2026-10-25', tags: [],
  }) + '\n');
  return file;
}

test('revise expectedId rejects a stale chain', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cas-'));
  try {
    const file = fixture(dir);
    const first = revise('canon', 'x', { claim: 'v2' }, { file, expectedId: 'x' });
    assert.equal(first.id, 'x-r1');
    assert.throws(() => revise('canon', 'x', { claim: 'v3' }, { file, expectedId: 'x' }), /stale_input/);
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('revise idempotencyKey replays the first result without a second version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idem-'));
  try {
    const file = fixture(dir);
    const first = revise('canon', 'x', { claim: 'v2' }, { file, idempotencyKey: 'k1' });
    const second = revise('canon', 'x', { claim: 'v2' }, { file, idempotencyKey: 'k1' });
    assert.equal(first.id, 'x-r1');
    assert.equal(second.id, 'x-r1');
    assert.equal(second.idempotent, true);
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('idempotency receipts fail closed on corrupt tail and missing result', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idem-corrupt-'));
  try {
    const file = fixture(dir);
    revise('canon', 'x', { claim: 'v2' }, { file, idempotencyKey: 'k1' });
    const receipt = join(dir, 'idempotency.jsonl');
    appendFileSync(receipt, '{"key":"k1"', 'utf8');
    assert.throws(() => revise('canon', 'x', { claim: 'v2' }, { file, idempotencyKey: 'k1' }), /idempotency_log_corrupt/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('idempotency key is scoped to one data file and rejects request conflicts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idem-scope-'));
  try {
    const fileA = fixture(dir);
    const fileB = join(dir, 'other.jsonl');
    writeFileSync(fileB, JSON.stringify({
      id: 'x', claim: 'v1', source: { type: '官方', ref: 'test' }, event_time: '2026-10-25', last_reviewed: '2026-10-25', tags: [],
    }) + '\n');
    const a = revise('canon', 'x', { claim: 'v2' }, { file: fileA, idempotencyKey: 'k1' });
    const b = revise('canon', 'x', { claim: 'v2' }, { file: fileB, idempotencyKey: 'k1' });
    assert.equal(a.id, 'x-r1');
    assert.equal(b.id, 'x-r1');
    assert.equal(readFileSync(fileB, 'utf8').trim().split('\n').length, 2);
    assert.throws(() => revise('canon', 'x', { claim: 'v3' }, { file: fileA, idempotencyKey: 'k1' }), /idempotency_conflict/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('idempotency key recovers from the body when the receipt file is lost', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idem-recover-'));
  try {
    const file = fixture(dir);
    const first = revise('canon', 'x', { claim: 'v2' }, { file, idempotencyKey: 'k1' });
    rmSync(join(dir, 'idempotency.jsonl'));
    const retry = revise('canon', 'x', { claim: 'v2' }, { file, idempotencyKey: 'k1' });
    assert.equal(first.id, 'x-r1');
    assert.equal(retry.id, 'x-r1');
    assert.equal(retry.idempotent, true);
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('receipt replay fails closed when the referenced body is gone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idem-stale-'));
  try {
    const file = fixture(dir);
    revise('canon', 'x', { claim: 'v2' }, { file, idempotencyKey: 'k1' });
    const receipt = join(dir, 'idempotency.jsonl');
    const row = JSON.parse(readFileSync(receipt, 'utf8').trim());
    row.result.id = 'missing-id';
    writeFileSync(receipt, JSON.stringify(row) + '\n');
    assert.throws(() => revise('canon', 'x', { claim: 'v2' }, { file, idempotencyKey: 'k1' }), /idempotency_receipt_stale/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('explicit empty protected values are rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idem-empty-'));
  try {
    const file = fixture(dir);
    assert.throws(() => revise('canon', 'x', { claim: 'v2' }, { file, idempotencyKey: '' }), /idempotencyKey/);
    assert.throws(() => revise('canon', 'x', { claim: 'v2' }, { file, expectedId: '' }), /expectedId/);
    assert.throws(() => revise('canon', 'x', { claim: 'v2' }, { file, idempotencyKey: null }), /idempotencyKey/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('receipt must match the body credentials and existing result', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idem-tamper-'));
  try {
    const file = fixture(dir);
    revise('canon', 'x', { claim: 'v2' }, { file, idempotencyKey: 'k1' });
    const receipt = join(dir, 'idempotency.jsonl');
    const row = JSON.parse(readFileSync(receipt, 'utf8').trim());
    row.result.id = 'y';
    writeFileSync(receipt, JSON.stringify(row) + '\n');
    assert.throws(() => revise('canon', 'x', { claim: 'v2' }, { file, idempotencyKey: 'k1' }), /idempotency_receipt_stale/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('body recovery reports the original root for later revisions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idem-root-'));
  try {
    const file = fixture(dir);
    revise('canon', 'x', { claim: 'v2' }, { file });
    const first = revise('canon', 'x', { claim: 'v3' }, { file, idempotencyKey: 'k2' });
    rmSync(join(dir, 'idempotency.jsonl'));
    const retry = revise('canon', 'x', { claim: 'v3' }, { file, idempotencyKey: 'k2' });
    assert.equal(first.id, 'x-r2');
    assert.equal(retry.id, 'x-r2');
    assert.equal(retry.root, 'x');
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('legacy receipt rows fail closed instead of being ignored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idem-legacy-'));
  try {
    const file = fixture(dir);
    revise('canon', 'x', { claim: 'v2' }, { file, idempotencyKey: 'k1' });
    const receipt = join(dir, 'idempotency.jsonl');
    const row = JSON.parse(readFileSync(receipt, 'utf8').trim());
    writeFileSync(receipt, JSON.stringify({ key: 'k1', store: 'canon', result: row.result, at: row.at }) + '\n');
    assert.throws(() => revise('canon', 'x', { claim: 'v2' }, { file, idempotencyKey: 'k1' }), /idempotency_log_legacy/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('body recovery is scoped to the same store', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idem-store-'));
  try {
    const file = fixture(dir);
    revise('canon', 'x', { claim: 'v2' }, { file, idempotencyKey: 'shared-key' });
    writeFileSync(file, readFileSync(file, 'utf8') + JSON.stringify({
      id: 'y', story: '测试', situation: '情境', behavior: '行为', outcome: '结果', social_reaction: '反应', emotion: '情绪', evidence: 'story',
    }) + '\n');
    const r = revise('mirror', 'y', { outcome: '第二次' }, { file, idempotencyKey: 'shared-key' });
    assert.equal(r.id, 'y-r1');
    assert.notEqual(r.id, 'x-r1');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('undefined protected fields mean absent, while null/empty still fail', () => {
  const dir = mkdtempSync(join(tmpdir(), 'idem-undefined-'));
  try {
    const file = fixture(dir);
    const ordinary = revise('canon', 'x', { claim: 'v2' }, { file });
    assert.equal(ordinary.id, 'x-r1');
    const withUndefined = revise('canon', 'x', { claim: 'v3' }, { file, expectedId: undefined, idempotencyKey: undefined });
    assert.equal(withUndefined.id, 'x-r2');
    const onlyExpected = revise('canon', 'x', { claim: 'v4' }, { file, expectedId: 'x-r2' });
    assert.equal(onlyExpected.id, 'x-r3');
    const onlyKey = revise('canon', 'x', { claim: 'v5' }, { file, idempotencyKey: 'k-only' });
    assert.equal(onlyKey.id, 'x-r4');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
