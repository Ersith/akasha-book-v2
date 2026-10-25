import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createProject, joinProject, leaveProject, sendIntercom, readIntercom, inboxIntercom } from './intercom.mjs';

const cliPath = fileURLToPath(new URL('./akasha.mjs', import.meta.url));
const sender = 'codex-fixture';
const recipient = 'session-fixture';
function fixture(t, broadcast = false) {
  const root = mkdtempSync(join(tmpdir(), 'akasha-intercom-reply-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); rmSync(root, { recursive: true, force: true }); });
  const opts = { file: join(root, 'logs', 'intercom.jsonl') };
  const data = join(root, 'data'); mkdirSync(data); writeFileSync(join(data, 'canon.jsonl'), '');
  createProject('fixture', {}, opts);
  joinProject('fixture', sender, {}, opts); joinProject('fixture', recipient, {}, opts);
  const source = sendIntercom({ project: 'fixture', from: sender, to: broadcast ? '' : recipient, body: 'original task' }, opts).row;
  const env = { ...process.env, AKASHA_ROOT: data, AKASHA_LOGS: join(root, 'logs'), AKASHA_DIR: root };
  return { root, opts, source, env };
}
const reply = (source, over = {}) => ({ project: 'fixture', from: recipient, to: sender, type: 'result',
  subject: 'fixture reply', body: 'processed original task', replyTo: source.id, ...over });
const rows = (fx) => readIntercom(fx.opts.file);
const acks = (fx) => rows(fx).filter(row => row.kind === 'ack' && row.acks === fx.source.id);
function withAppendFault(predicate, action) {
  const original = fs.appendFileSync;
  fs.appendFileSync = function(file, text, ...args) {
    if (predicate(String(text))) { const error = new Error('fixture append failure'); error.code = 'EIO'; throw error; }
    return original.call(this, file, text, ...args);
  };
  syncBuiltinESMExports();
  try { return action(); } finally { fs.appendFileSync = original; syncBuiltinESMExports(); }
}
function withPartialReply(mode, action) {
  const original = fs.appendFileSync; let failed = false;
  fs.appendFileSync = function(file, text, ...args) {
    if (!failed && String(text).includes('"replyTo"')) {
      failed = true;
      original.call(this, file, mode === 'partial-json' ? String(text).slice(0, 50) : String(text).replace(/\n$/, ''), ...args);
      const error = new Error('fixture partial write'); error.code = 'EIO'; throw error;
    }
    return original.call(this, file, text, ...args);
  };
  syncBuiltinESMExports();
  try { return action(); } finally { fs.appendFileSync = original; syncBuiltinESMExports(); }
}
function runCli(fx, args) {
  return spawnSync(process.execPath, [cliPath, 'intercom', ...args, '--json'], {
    encoding: 'utf8', timeout: 15000, cwd: tmpdir(), env: fx.env,
  });
}
const cliArgs = (fx) => ['send', '--project', 'fixture', '--from', recipient, '--to', sender,
  '--type', 'result', '--body', 'CLI reply', '--reply-to', fx.source.id];

test('explicit direct reply records canonical reference and receipt only for its actual recipient', t => {
  const fx = fixture(t); const before = readFileSync(fx.opts.file, 'utf8');
  const result = sendIntercom(reply(fx.source, { refs: ['file:fixture', `intercom:${fx.source.id}`] }), fx.opts);
  assert.equal(result.ok, true); assert.equal(result.sent, true); assert.equal(result.already, false);
  assert.equal(result.row.replyTo, fx.source.id);
  assert.deepEqual(result.row.refs, ['file:fixture', `intercom:${fx.source.id}`]);
  assert.equal(result.receipt.ok, true);
  assert.equal(acks(fx).length, 1); assert.equal(acks(fx)[0].by, recipient);
  assert.equal(inboxIntercom({ for: recipient, project: 'fixture', unreadOnly: true }, fx.opts).unread, 0);
  assert.ok(readFileSync(fx.opts.file, 'utf8').startsWith(before));
});

test('ordinary refs and body mentions remain references without reply or automatic ACK', t => {
  const fx = fixture(t);
  const result = sendIntercom({ project: 'fixture', from: recipient, to: sender, body: `mentions ${fx.source.id}`, refs: [`intercom:${fx.source.id}`] }, fx.opts);
  assert.equal(result.ok, true); assert.equal(result.row.replyTo, undefined); assert.equal(acks(fx).length, 0);
});

test('reply validation rejects missing, malformed, cross-project, self and wrong recipient sources without append', t => {
  const fx = fixture(t);
  const own = sendIntercom({ project: 'fixture', from: recipient, to: sender, body: 'my own message' }, fx.opts).row;
  const foreign = sendIntercom({ project: 'elsewhere', from: sender, to: recipient, body: 'other project' }, fx.opts).row;
  const before = readFileSync(fx.opts.file, 'utf8');
  for (const over of [
    { replyTo: '' }, { replyTo: true }, { replyTo: null }, { replyTo: 'missing-id' },
    { replyTo: ' ' + fx.source.id }, { replyTo: own.id }, { replyTo: foreign.id },
    { from: 'other-session' }, { to: 'other-codex' }, { to: '' }, { body: '' },
    { project: 'elsewhere' }, { from: { peer: recipient } },
  ]) {
    const result = sendIntercom(reply(fx.source, over), fx.opts);
    assert.equal(result.ok, false, JSON.stringify(over));
    assert.equal(readFileSync(fx.opts.file, 'utf8'), before, JSON.stringify(over));
  }
});

test('closed projects refuse new replies and do not ACK', t => {
  const fx = fixture(t);
  appendFileSync(fx.opts.file, JSON.stringify({ kind: 'proj', project: 'fixture', closed: true }) + '\n');
  const before = readFileSync(fx.opts.file, 'utf8');
  assert.equal(sendIntercom(reply(fx.source), fx.opts).ok, false);
  assert.equal(readFileSync(fx.opts.file, 'utf8'), before);
});

test('broadcast reply is directed to its sender and requires an active project recipient', t => {
  const fx = fixture(t, true); const before = readFileSync(fx.opts.file, 'utf8');
  assert.equal(sendIntercom(reply(fx.source, { from: 'outsider' }), fx.opts).ok, false);
  assert.equal(readFileSync(fx.opts.file, 'utf8'), before);
  leaveProject('fixture', recipient, fx.opts);
  assert.equal(sendIntercom(reply(fx.source), fx.opts).ok, false);
  joinProject('fixture', recipient, {}, fx.opts);
  const result = sendIntercom(reply(fx.source), fx.opts);
  assert.equal(result.ok, true); assert.equal(result.row.to, sender); assert.equal(acks(fx)[0].by, recipient);
});

test('repeated explicit reply is idempotent and changed payload under the same key is rejected', t => {
  const fx = fixture(t); const input = reply(fx.source);
  const first = sendIntercom(input, fx.opts); assert.equal(first.ok, true);
  const after = readFileSync(fx.opts.file, 'utf8');
  const second = sendIntercom(input, fx.opts);
  assert.equal(second.ok, true); assert.equal(second.already, true); assert.equal(second.id, first.id);
  assert.equal(readFileSync(fx.opts.file, 'utf8'), after);
  for (const over of [{ body: 'different' }, { subject: 'different' }, { refs: ['file:different'] }]) {
    assert.equal(sendIntercom(reply(fx.source, over), fx.opts).ok, false);
    assert.equal(readFileSync(fx.opts.file, 'utf8'), after);
  }
});

test('reply append failure never writes an ACK', t => {
  const fx = fixture(t); const before = readFileSync(fx.opts.file, 'utf8');
  const result = withAppendFault(text => text.includes('"replyTo"'), () => sendIntercom(reply(fx.source), fx.opts));
  assert.equal(result.ok, false); assert.equal(result.sent, false);
  assert.equal(readFileSync(fx.opts.file, 'utf8'), before);
});

test('ACK append failure reports the durable reply and retry repairs the receipt without resending', t => {
  const fx = fixture(t); const input = reply(fx.source);
  const partial = withAppendFault(text => text.includes('"kind":"ack"'), () => sendIntercom(input, fx.opts));
  assert.equal(partial.ok, false); assert.equal(partial.sent, true); assert.equal(partial.receipt.ok, false);
  assert.equal(rows(fx).filter(row => row.kind === 'msg' && row.replyTo === fx.source.id).length, 1);
  assert.equal(acks(fx).length, 0);
  const fixed = sendIntercom(input, fx.opts);
  assert.equal(fixed.ok, true); assert.equal(fixed.already, true); assert.equal(fixed.id, partial.id);
  assert.equal(fixed.receipt.ok, true); assert.equal(acks(fx).length, 1);
  assert.equal(rows(fx).filter(row => row.kind === 'msg' && row.replyTo === fx.source.id).length, 1);
});

for (const mode of ['partial-json', 'json-without-newline']) {
  test(`retry preserves ${mode} residue and confirms a readable reply plus ACK`, t => {
    const fx = fixture(t); const input = reply(fx.source);
    const failed = withPartialReply(mode, () => sendIntercom(input, fx.opts));
    assert.equal(failed.ok, false); assert.equal(acks(fx).length, 0);
    const residue = readFileSync(fx.opts.file, 'utf8');
    assert.equal(residue.endsWith('\n'), false);
    const retried = sendIntercom(input, fx.opts);
    if (mode === 'partial-json') {
      assert.equal(retried.ok, false);
      assert.equal(retried.code, 'RECOVERY_REQUIRED');
      assert.equal(acks(fx).length, 0);
      assert.equal(rows(fx).filter(row => row.kind === 'msg' && row.replyTo === fx.source.id).length, 0);
      assert.ok(readFileSync(fx.opts.file, 'utf8').startsWith(residue), 'preserve the original residual bytes');
      assert.equal(readFileSync(fx.opts.file, 'utf8').endsWith('\n'), false);
      return;
    }
    assert.equal(retried.ok, true);
    const persisted = rows(fx).filter(row => row.kind === 'msg' && row.replyTo === fx.source.id);
    assert.equal(persisted.length, 1, 'successful receipt requires one parseable full reply');
    assert.equal(persisted[0].body, input.body); assert.equal(persisted[0].id, retried.id);
    assert.equal(acks(fx).length, 1, 'successful receipt must itself be parseable');
    assert.equal(acks(fx)[0].by, recipient);
    assert.ok(readFileSync(fx.opts.file, 'utf8').startsWith(residue), 'preserve the original residual bytes');
    assert.equal(readFileSync(fx.opts.file, 'utf8').endsWith('\n'), true);
    if (mode === 'json-without-newline') {
      assert.equal(retried.id, failed.id); assert.equal(retried.already, true);
    }
  });
}

test('CLI wires --reply-to and refuses missing or repeated values without touching its isolated ledger', t => {
  const fx = fixture(t); const before = readFileSync(fx.opts.file, 'utf8');
  for (const args of [cliArgs(fx).slice(0, -1), [...cliArgs(fx), '--reply-to', fx.source.id],
    [...cliArgs(fx).slice(0, -2), `--reply-to=${fx.source.id}`]]) {
    const result = runCli(fx, args);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.equal(readFileSync(fx.opts.file, 'utf8'), before);
  }
  const result = runCli(fx, cliArgs(fx));
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.row.replyTo, fx.source.id); assert.equal(parsed.receipt.ok, true);
  assert.equal(acks(fx).length, 1);
});

test('two short CLI processes racing the same explicit reply produce one message and one receipt', async t => {
  const fx = fixture(t);
  const run = () => new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, [cliPath, 'intercom', ...cliArgs(fx), '--json'], {
      cwd: tmpdir(), env: fx.env, timeout: 15000, windowsHide: true,
    });
    let out = '', err = '';
    child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { err += data; });
    child.on('error', reject); child.on('close', code => resolveChild({ code, out, err }));
  });
  const results = await Promise.all([run(), run()]);
  for (const result of results) assert.equal(result.code, 0, result.err || result.out);
  assert.equal(JSON.parse(results[0].out).id, JSON.parse(results[1].out).id);
  assert.equal(rows(fx).filter(row => row.kind === 'msg' && row.replyTo === fx.source.id).length, 1);
  assert.equal(acks(fx).length, 1);
});
