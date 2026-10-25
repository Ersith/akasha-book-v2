import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendOutcome, readOutcomes, summarizeOutcomes } from './outcome-log.mjs';

test('outcome log appends explicit verdicts and summarizes by id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'outcome-log-'));
  try {
    const file = join(dir, 'outcome-log.jsonl');
    appendOutcome(file, { ids: ['a', 'b'], verdict: '成功', source: '用户验收', session: 's', turn: 1 });
    appendOutcome(file, { ids: ['a'], verdict: '失败', source: '用户纠正', session: 's', turn: 2 });
    appendOutcome(file, { ids: ['a'], verdict: '未判定' });
    const summary = summarizeOutcomes(readOutcomes(file));
    assert.equal(summary.total, 3);
    assert.equal(summary.ids, 2);
    assert.equal(summary.rows.find((row) => row.id === 'a').failure, 1);
    assert.equal(summary.rows.find((row) => row.id === 'a').unknown, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('outcome log rejects empty ids and bad verdicts', () => {
  assert.throws(() => appendOutcome('x', { ids: [], verdict: '成功' }), /id/);
  assert.throws(() => appendOutcome('x', { ids: ['a'], verdict: 'maybe' }), /verdict/);
});
