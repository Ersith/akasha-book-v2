import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acceptProposal, chainView, currentRecords, lookupDetailed, pendingProposalCount, retireRecord, revise, show, validateRecord } from './lib.mjs';

function fixture(dir) {
  const file = join(dir, 'canon.jsonl');
  writeFileSync(file, JSON.stringify({
    id: 'p', claim: '提案', source: { type: '官方', ref: 'test' }, event_time: '2026-10-25',
    last_reviewed: '2026-10-25', tags: [], status: 'proposed', proposed_by: 'model',
  }) + '\n');
  return file;
}

test('proposed records stay out of the current set until accepted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proposal-'));
  try {
    const file = fixture(dir);
    assert.equal(currentRecords(readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)).length, 0);
    const r = acceptProposal('canon', 'p', { file });
    assert.equal(r.id, 'p-r1');
    const rows = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    const current = currentRecords(rows);
    assert.equal(current.length, 1);
    assert.equal(current[0].id, 'p-r1');
    assert.equal(current[0].status, 'accepted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('proposal status is validated and proposed_by is required', () => {
  const base = { id: 'p', claim: 'x', source: { type: '官方', ref: 't' }, event_time: '2026-10-25', last_reviewed: '2026-10-25', tags: [] };
  assert.deepEqual(validateRecord('canon', { ...base, status: 'proposed' }), ['status=proposed 时必须提供 proposed_by']);
  assert.ok(validateRecord('canon', { ...base, status: 'maybe' }).some((x) => x.includes('status')));
  assert.deepEqual(validateRecord('canon', { ...base, status: 'proposed', proposed_by: 'model' }), []);
});

test('lookup does not surface proposed records before acceptance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proposal-lookup-'));
  try {
    const files = {};
    for (const store of ['canon', 'mirror', 'orphan', 'pricing', 'lexicon', 'frontier']) {
      files[store] = join(dir, store + '.jsonl');
      writeFileSync(files[store], '');
    }
    writeFileSync(files.canon, JSON.stringify({
      id: 'p', claim: '提案', source: { type: '官方', ref: 'test' }, event_time: '2026-10-25',
      last_reviewed: '2026-10-25', tags: [], status: 'proposed', proposed_by: 'model',
    }) + '\n');
    assert.equal(lookupDetailed('提案', { files, contextBudget: false }).hits.some((h) => h.id === 'p'), false);
    acceptProposal('canon', 'p', { file: files.canon });
    assert.equal(lookupDetailed('提案', { files, contextBudget: false }).hits.some((h) => h.id === 'p-r1'), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});



test('accept is locked and cannot be applied twice', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proposal-accept-'));
  try {
    const file = fixture(dir);
    const first = acceptProposal('canon', 'p', { file });
    assert.equal(first.id, 'p-r1');
    assert.throws(() => acceptProposal('canon', 'p', { file }), /找不到当前提案|不是 proposed/);
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('ordinary revise cannot patch proposal status', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proposal-patch-'));
  try {
    const file = fixture(dir);
    assert.throws(() => revise('canon', 'p', { status: 'accepted' }, { file }), /提案状态字段/);
    assert.throws(() => revise('canon', 'p', { proposed_by: 'user' }, { file }), /提案状态字段/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('proposal status is rejected on non-proposal stores', () => {
  const base = { id: 'm', story: 's', situation: 's', behavior: 'b', outcome: 'o', social_reaction: 'r', emotion: 'e' };
  assert.ok(validateRecord('mirror', { ...base, status: 'proposed' }).some((x) => x.includes('仅支持')));
});


test('show and chainView report proposed as proposal, not retired/old', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proposal-view-'));
  try {
    const file = fixture(dir);
    const s = show('p', { file });
    assert.equal(s.found, false);
    assert.equal(s.proposed, true);
    assert.match(s.note, /提案/);
    const files = Object.fromEntries(['canon', 'mirror', 'orphan', 'pricing', 'lexicon', 'frontier'].map((name) => [name, join(dir, name + '.jsonl')]));
    for (const name of Object.keys(files)) if (name !== 'canon') writeFileSync(files[name], '');
    const c = chainView('p', { files });
    assert.equal(c.state, 'proposed');
    assert.equal(c.proposed, true);
    assert.equal(c.retired, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('accepted proposal history is not reported as pending', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proposal-history-'));
  try {
    const file = fixture(dir);
    const r = acceptProposal('canon', 'p', { file });
    assert.equal(r.accepted_by, undefined);
    const s = show('p', { file });
    assert.equal(s.proposed, undefined);
    assert.match(s.note, /已采纳/);
    const files = Object.fromEntries(['canon', 'mirror', 'orphan', 'pricing', 'lexicon', 'frontier'].map((name) => [name, join(dir, name + '.jsonl')]));
    files.canon = file;
    for (const name of Object.keys(files)) if (name !== 'canon') writeFileSync(files[name], '');
    const c = chainView('p', { files });
    assert.equal(c.state, 'current');
    assert.equal(c.proposed, false);
    assert.equal(c.retired, false);
    assert.equal(r.id, 'p-r1');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('status:undefined cannot bypass the proposal guard', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proposal-undef-'));
  try {
    const file = fixture(dir);
    assert.throws(() => revise('canon', 'p', { status: undefined }, { file }), /提案状态字段/);
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('retired accepted proposal is not reported as proposed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proposal-retired-'));
  try {
    const file = fixture(dir);
    const r = acceptProposal('canon', 'p', { file });
    retireRecord('canon', r.id, { file, reason: 'test' });
    const s = show(r.id, { file });
    assert.equal(s.retired, true);
    assert.equal(s.proposed, undefined);
    const files = Object.fromEntries(['canon', 'mirror', 'orphan', 'pricing', 'lexicon', 'frontier'].map((name) => [name, join(dir, name + '.jsonl')]));
    files.canon = file;
    for (const name of Object.keys(files)) if (name !== 'canon') writeFileSync(files[name], '');
    const c = chainView('p', { files });
    assert.equal(c.state, 'retired');
    assert.equal(c.retired, true);
    assert.equal(c.proposed, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('accept records accepted_by and accepted_at', () => {
  const dir = mkdtempSync(join(tmpdir(), 'proposal-accepted-'));
  try {
    const file = fixture(dir);
    acceptProposal('canon', 'p', { file });
    const row = readFileSync(file, 'utf8').trim().split(String.fromCharCode(10)).at(-1);
    const parsed = JSON.parse(row);
    assert.equal(parsed.accepted_by, 'cli');
    assert.equal(typeof parsed.accepted_at, 'string');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
