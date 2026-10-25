import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openCanaryJournal, isCanaryJournal } from './m3-canary-journal.mjs';
import { openBudget } from './m3-resource-budget.mjs';

function tempJournal(t) {
  const dir = mkdtempSync(join(tmpdir(), 'm3-journal-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, journal: openCanaryJournal({ root: dir }) };
}

test('attempt and terminal use stable operation ids and are idempotent', (t) => {
  const { dir, journal } = tempJournal(t);
  assert.equal(isCanaryJournal(journal), true);
  const attempt = journal.recordAttempt('req-1', { selected: true, eligible: true });
  assert.equal(attempt.ok, true);
  assert.equal(journal.recordAttempt('req-1', { selected: true, eligible: true }).ok, true);
  assert.equal(journal.recordAttempt('req-1', { selected: false }).reason, 'operation-conflict');
  const terminal = journal.recordTerminal('req-1', { status: 'baseline', logged: true });
  assert.equal(terminal.ok, true);
  assert.equal(journal.reconcile('req-1', 'terminal').ok, true);
  assert.equal(journal.reconcile('req-1', 'bogus').reason, 'invalid-stage');
  assert.match(readFileSync(join(dir, 'logs', 'attempts.jsonl'), 'utf8'), /req-1:attempt/);
  assert.match(readFileSync(join(dir, 'logs', 'terminals.jsonl'), 'utf8'), /req-1:terminal/);
});

test('journal rejects unsafe ids and requires an explicit owned root', (t) => {
  const { journal } = tempJournal(t);
  assert.throws(() => journal.recordAttempt('bad id', {}), /requestId/);
  assert.throws(() => journal.recordTerminal('x'.repeat(97), {}), /requestId/);
  assert.throws(() => openCanaryJournal({ root: 'relative' }), /absolute/);
});


test('reconcile refuses an operation id owned by another log', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'm3-journal-shared-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const budget = openBudget({ root: dir });
  assert.equal(budget.appendManagedLog({ operationId: 'req-1:attempt', log: 'observations', record: { x: 1 } }).ok, true);
  const journal = openCanaryJournal({ root: dir });
  assert.equal(journal.recordAttempt('req-1', {}).reason, 'operation-conflict');
  assert.equal(journal.reconcile('req-1', 'attempt').reason, 'operation-log-mismatch');
});


test('unknown cross-log reconcile also refuses instead of returning unknown', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'm3-journal-unknown-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const budget = openBudget({ root: dir });
  assert.equal(budget.appendManagedLog({ operationId: 'req-2:attempt', log: 'observations', record: { x: 1 } }).ok, true);
  const logPath = join(dir, 'logs', 'observations.jsonl');
  const bytes = readFileSync(logPath); bytes[0] ^= 1; writeFileSync(logPath, bytes);
  const journal = openCanaryJournal({ root: dir });
  assert.equal(journal.reconcile('req-2', 'attempt').reason, 'operation-log-mismatch');
});
