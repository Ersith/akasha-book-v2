import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendNodes, appendSegments } from './session.mjs';

test('session node append is idempotent for identical rebuilds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'session-idempotent-'));
  try {
    const file = join(dir, 'session.jsonl');
    const node = { id: 'node-1', kind: 'node', gist: 'same' };
    assert.equal(appendNodes(file, [node], 1).added, 1);
    const second = appendNodes(file, [node], 1);
    assert.equal(second.added, 0);
    assert.equal(second.skipped, 1);
    const newGen = appendNodes(file, [node], 2);
    assert.equal(newGen.added, 1);
    const changed = appendNodes(file, [{ ...node, gist: 'changed' }], 2);
    assert.equal(changed.added, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('segment append is idempotent for identical rebuilds', () => {
  const dir = mkdtempSync(join(tmpdir(), 'segment-idempotent-'));
  try {
    const file = join(dir, 'session.jsonl');
    const seg = { id: 'seg-1', kind: 'process', gist: 'same' };
    assert.equal(appendSegments(file, [seg]).added, 1);
    const second = appendSegments(file, [seg]);
    assert.equal(second.added, 0);
    assert.equal(second.skipped, 1);
    assert.equal(appendSegments(file, [{ ...seg, gist: 'changed' }]).added, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
