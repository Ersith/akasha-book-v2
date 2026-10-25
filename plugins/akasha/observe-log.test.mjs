import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OBSERVE_LOG_MAX_CAP, appendBoundedObservation, resolveObserveLogLimit } from './observe-log.mjs';

test('bounded append refuses at budget and preserves existing log', () => {
  const dir = mkdtempSync(join(tmpdir(), 'akasha-observe-log-'));
  const file = join(dir, 'time-observe.jsonl');
  try {
    const first = appendBoundedObservation(file, { a: 1 }, { maxBytes: 80 });
    assert.equal(first.ok, true);
    const before = readFileSync(file, 'utf8');
    const oversized = appendBoundedObservation(file, { b: 'x'.repeat(100) }, { maxBytes: 80 });
    assert.equal(oversized.ok, false);
    assert.equal(oversized.reason, 'line-too-large');
    assert.equal(readFileSync(file, 'utf8'), before);

    const capFile = join(dir, 'cap.jsonl');
    for (let i = 0; i < 3; i += 1) assert.equal(appendBoundedObservation(capFile, { i }, { maxBytes: 20 }).ok, true);
    const beforeCap = readFileSync(capFile, 'utf8');
    const over = appendBoundedObservation(capFile, { i: 99 }, { maxBytes: 20 });
    assert.equal(over.ok, false);
    assert.equal(over.reason, 'log-budget-exceeded');
    assert.equal(readFileSync(capFile, 'utf8'), beforeCap);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('log limit defaults and env override', () => {
  assert.equal(resolveObserveLogLimit({}), 64 * 1024 * 1024);
  assert.equal(resolveObserveLogLimit({ AKASHA_TIME_OBSERVE_MAX_BYTES: '123' }), 123);
  assert.equal(resolveObserveLogLimit({ AKASHA_TIME_OBSERVE_MAX_BYTES: String(Number.MAX_SAFE_INTEGER) }), OBSERVE_LOG_MAX_CAP);
  assert.equal(resolveObserveLogLimit({ AKASHA_TIME_OBSERVE_MAX_BYTES: '0' }), 64 * 1024 * 1024);
  assert.equal(resolveObserveLogLimit({ AKASHA_TIME_OBSERVE_MAX_BYTES: 'nope' }), 64 * 1024 * 1024);
});
