import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyRecogPlan, writeRecogPlan } from './recog.mjs';
import { storePath } from './lib.mjs';

test('recog refuses writing a plan onto a store file', () => {
  assert.throws(() => writeRecogPlan({ batchId: 'recog-safe', items: [] }, storePath('canon')), /拒绝把计划写到 canon/);
});

test('recog rejects a plan with path-traversal batchId before writing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'akasha-recog-security-'));
  const planFile = join(dir, 'plan.json');
  try {
    writeFileSync(planFile, JSON.stringify({ batchId: '../escape', decisions: [], items: [] }), 'utf8');
    assert.throws(() => applyRecogPlan({ batchId: '../escape', decisions: [], items: [] }, { dry: false }), /batchId 非法/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
