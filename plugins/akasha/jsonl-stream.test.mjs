import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseJsonlStream, checkPromotions } from './lib.mjs';

test('chunked parser keeps line numbers for bad JSON and handles CRLF', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsonl-stream-'));
  try {
    const file = join(dir, 'x.jsonl');
    writeFileSync(file, '{"a":1}\r\nnot-json\r\n{"b":2}\n');
    const parsed = parseJsonlStream(file, { chunkSize: 5 });
    assert.equal(parsed.records.length, 2);
    assert.deepEqual(parsed.records, [{ a: 1 }, { b: 2 }]);
    assert.equal(parsed.errors.length, 1);
    assert.equal(parsed.errors[0].line, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('chunked parser caps an overlong line and still reads the next line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsonl-long-'));
  try {
    const file = join(dir, 'x.jsonl');
    writeFileSync(file, 'x'.repeat(50) + '\n{"ok":1}\n');
    const parsed = parseJsonlStream(file, { chunkSize: 5, maxLineBytes: 10 });
    assert.deepEqual(parsed.records, [{ ok: 1 }]);
    assert.equal(parsed.errors.length, 1);
    assert.match(parsed.errors[0].error, /上限/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('checkPromotions reports a bad line instead of silently dropping it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'promotions-bad-'));
  try {
    const file = join(dir, 'session.jsonl');
    writeFileSync(file, '{"id":"seg-ok","kind":"process"}\nnot-json\n');
    const out = checkPromotions({ canon: [{ id: 'canon-x', promoted_from: 'seg-ok' }] }, file);
    assert.ok(out.some((error) => error.code === 'bad-jsonl' && error.line === 2), JSON.stringify(out));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('line cap applies when the newline is in the same chunk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsonl-cap-same-'));
  try {
    const file = join(dir, 'x.jsonl');
    const payload = JSON.stringify({ data: 'x'.repeat(40) });
    assert.ok(payload.length > 10 && payload.length < 128);
    writeFileSync(file, payload + '\n');
    const parsed = parseJsonlStream(file, { chunkSize: 128, maxLineBytes: 10 });
    assert.equal(parsed.records.length, 0);
    assert.equal(parsed.errors.length, 1);
    assert.equal(parsed.errors[0].line, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('line numbers stay aligned after a cross-chunk overlong line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jsonl-line-no-'));
  try {
    const file = join(dir, 'x.jsonl');
    writeFileSync(file, 'x'.repeat(50) + '\nnot-json\n');
    const parsed = parseJsonlStream(file, { chunkSize: 5, maxLineBytes: 10 });
    assert.deepEqual(parsed.errors.map((error) => error.line), [1, 2]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
