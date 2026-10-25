import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, rmdir, rename, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { captureLookupView, isCapturedLookupView } from './captured-lookup-view.mjs';
import * as captureModule from './captured-lookup-view.mjs';

const stores = ['canon', 'mirror', 'orphan', 'pricing', 'lexicon', 'frontier'];
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const guarded = (...args) => captureModule.withCapturedLookupView(...args);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'akasha-capture-test-'));
  const source = join(root, 'source');
  const tempRoot = join(root, 'views');
  await mkdir(source);
  await mkdir(tempRoot);
  const files = Object.fromEntries(stores.map((name) => [name, join(source, name + '.jsonl')]));
  for (const name of stores) await writeFile(files[name], JSON.stringify({ id: name, text: '合成记录' }) + '\n');
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  return { root, source, files, tempRoot, evidenceFile: join(source, 'evidence.jsonl') };
}

test('captures exact bytes, bounded manifest, optional missing evidence and private brand', async (t) => {
  const f = await fixture(t);
  const bytes = Buffer.from('{"id":"a","text":"汉字😀"}\r\n\n{"id":"b"}');
  await writeFile(f.files.canon, bytes);
  const view = await captureLookupView({ ...f, limits: { chunkBytes: 3 } });
  assert.equal(isCapturedLookupView(view), true);
  assert.equal(isCapturedLookupView({ ...view }), false);
  assert.deepEqual(await readFile(view.files.canon), bytes);
  assert.equal((await readFile(view.evidenceFile)).length, 0);
  const entry = view.manifest.files.find((item) => item.name === 'canon');
  assert.equal(entry.sha256, digest(bytes));
  assert.equal(entry.records, 2);
  assert.equal(view.manifest.files.find((item) => item.name === 'evidence').sourceMissing, true);
  assert.equal(view.manifest.atomicSourceSnapshot, false);
  assert.equal(view.manifest.totalRecords, 7);
  assert.equal(view.manifest.files.length, 7);
  assert.throws(() => { view.manifest.files[0].sha256 = 'forged'; }, TypeError);
  assert.throws(() => { view.files.canon = f.files.canon; }, TypeError);
  assert.deepEqual(await view.verify(), { ok: true, errors: [] });
  assert.equal((await view.dispose()).ok, true);
  assert.equal(isCapturedLookupView(view), false);
  assert.equal((await view.verify()).ok, false);
  assert.equal((await view.dispose()).ok, true);
  assert.deepEqual(await readdir(f.tempRoot), []);
});

test('requires explicit absolute paths and bounded numeric limits', async (t) => {
  const f = await fixture(t);
  for (const args of [
    { ...f, files: { canon: f.files.canon } },
    { ...f, files: { ...f.files, canon: 'relative.jsonl' } },
    { ...f, evidenceFile: undefined },
    { ...f, tempRoot: 'relative' },
    { ...f, limits: { maxTotalBytes: 16 * 1024 * 1024 + 1 } },
    { ...f, limits: { maxConcurrent: 3 } },
    { ...f, limits: { maxRecords: 1.5 } },
    { ...f, limits: { toString: 1 } },
  ]) await assert.rejects(captureLookupView(args), { code: 'CAPTURE_ARGUMENT' });
  assert.deepEqual(await readdir(f.tempRoot), []);
});

test('missing required store and non-file source fail with complete cleanup', async (t) => {
  const f = await fixture(t);
  await assert.rejects(captureLookupView({ ...f, files: { ...f.files, canon: join(f.source, 'missing') } }), { code: 'ENOENT' });
  await assert.rejects(captureLookupView({ ...f, evidenceFile: f.source }), { code: 'CAPTURE_SOURCE_TYPE' });
  assert.deepEqual(await readdir(f.tempRoot), []);
});

test('inherited object property names are not valid limit keys', async (t) => {
  const f = await fixture(t);
  await assert.rejects(async () => {
    const unexpected = await captureLookupView({ ...f, limits: { toString: 1 } });
    await unexpected.dispose();
  }, { code: 'CAPTURE_ARGUMENT' });
  assert.deepEqual(await readdir(f.tempRoot), []);
});

test('strict UTF8 and truncated JSON fail; valid JSON without final LF is accepted', async (t) => {
  const f = await fixture(t);
  for (const bytes of [Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]), Buffer.from('{"id":')]) {
    await writeFile(f.files.canon, bytes);
    await assert.rejects(captureLookupView(f), (e) => ['CAPTURE_UTF8', 'CAPTURE_JSONL'].includes(e.code));
    assert.deepEqual(await readdir(f.tempRoot), []);
  }
  await writeFile(f.files.canon, '{"id":"complete"}');
  const view = await captureLookupView(f);
  assert.equal((await view.verify()).ok, true);
  await view.dispose();
});

test('JSONL rows must be objects, including evidence rows', async (t) => {
  const f = await fixture(t);
  for (const value of ['null', '[]', '42', 'true', '"scalar"']) {
    await writeFile(f.evidenceFile, value + '\n');
    await assert.rejects(captureLookupView(f), { code: 'CAPTURE_RECORD' });
    assert.deepEqual(await readdir(f.tempRoot), []);
  }
});

test('per-file, aggregate-byte, line-byte and aggregate-record limits reject without leftovers', async (t) => {
  const f = await fixture(t);
  for (const limits of [{ maxFileBytes: 5 }, { maxTotalBytes: 60 }, { maxLineBytes: 5 }, { maxRecords: 2 }]) {
    await assert.rejects(captureLookupView({ ...f, limits }), { code: 'CAPTURE_LIMIT' });
    assert.deepEqual(await readdir(f.tempRoot), []);
  }
});

test('sealed view ignores later source writes but verifies full copied bytes', async (t) => {
  const f = await fixture(t);
  const view = await captureLookupView(f);
  const old = await readFile(view.files.canon);
  await writeFile(f.files.canon, '{"id":"superseded"}\n');
  assert.deepEqual(await readFile(view.files.canon), old);
  assert.equal((await view.verify()).ok, true);
  const changed = Buffer.from(old);
  changed[changed.indexOf(Buffer.from('canon'))] = 'C'.charCodeAt(0);
  await writeFile(view.files.canon, changed);
  const result = await view.verify();
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.code === 'CAPTURE_DIGEST'));
  assert.equal((await view.dispose()).ok, true);
});

test('active-view lease persists until successful dispose and cannot exceed process ceiling', async (t) => {
  const f = await fixture(t);
  const one = await captureLookupView(f);
  const two = await captureLookupView(f);
  await assert.rejects(captureLookupView(f), { code: 'CAPTURE_BUSY' });
  await assert.rejects(captureLookupView({ ...f, limits: { maxConcurrent: 1 } }), { code: 'CAPTURE_BUSY' });
  await one.dispose();
  const three = await captureLookupView(f);
  await two.dispose();
  await three.dispose();
});

test('simultaneous captures reserve their process slots before asynchronous work', async (t) => {
  const f = await fixture(t);
  const pending = [captureLookupView(f), captureLookupView(f), captureLookupView(f)];
  const results = await Promise.allSettled(pending);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
  assert.equal(results[2].reason.code, 'CAPTURE_BUSY');
  const views = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  assert.notEqual(views[0].files.canon, views[1].files.canon);
  assert.equal(views[0].manifest.hash, views[1].manifest.hash);
  await Promise.all(views.map((view) => view.dispose()));
});

test('unknown added contents block cleanup rather than being deleted recursively', async (t) => {
  const f = await fixture(t);
  const view = await captureLookupView(f);
  const extra = join(dirname(view.files.canon), 'unowned.txt');
  await writeFile(extra, 'preserve');
  assert.equal((await view.verify()).ok, false);
  assert.equal((await view.dispose()).ok, false);
  assert.equal(await readFile(extra, 'utf8'), 'preserve');
  await unlink(extra);
  assert.equal((await view.dispose()).ok, true);
});

test('directory replacement refuses cleanup and leaves unrelated replacement contents untouched', async (t) => {
  const f = await fixture(t);
  const view = await captureLookupView(f);
  const owned = dirname(view.files.canon);
  const saved = owned + '-saved';
  await rename(owned, saved);
  await mkdir(owned);
  await writeFile(join(owned, 'unrelated.txt'), 'keep');
  assert.equal((await view.verify()).ok, false);
  assert.equal((await view.dispose()).ok, false);
  assert.equal(await readFile(join(owned, 'unrelated.txt'), 'utf8'), 'keep');
  await unlink(join(owned, 'unrelated.txt'));
  await rmdir(owned);
  await rename(saved, owned);
  assert.equal((await view.dispose()).ok, true);
});

test('parent replacement refuses cleanup without following the replacement tree', async (t) => {
  const f = await fixture(t);
  const view = await captureLookupView(f);
  const saved = f.tempRoot + '-saved';
  await rename(f.tempRoot, saved);
  await mkdir(f.tempRoot);
  await writeFile(join(f.tempRoot, 'keep.txt'), 'keep');
  assert.equal((await view.dispose()).ok, false);
  assert.equal(await readFile(join(f.tempRoot, 'keep.txt'), 'utf8'), 'keep');
  await unlink(join(f.tempRoot, 'keep.txt'));
  await rmdir(f.tempRoot);
  await rename(saved, f.tempRoot);
  assert.equal((await view.dispose()).ok, true);
});

test('source or copy links are refused without touching their targets', async (t) => {
  const f = await fixture(t);
  const link = join(f.root, 'source-link');
  try { await symlink(f.source, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (e) { if (['EPERM', 'EACCES'].includes(e.code)) return t.skip('OS disallows creating test links'); throw e; }
  await assert.rejects(captureLookupView({ ...f, files: { ...f.files, canon: join(link, 'canon.jsonl') } }), { code: 'CAPTURE_PATH' });
  await assert.rejects(captureLookupView({ ...f, tempRoot: link }), { code: 'CAPTURE_PATH' });
  const view = await captureLookupView(f);
  const original = join(f.root, 'saved-canon.jsonl');
  await rename(view.files.canon, original);
  await symlink(f.source, view.files.canon, process.platform === 'win32' ? 'junction' : 'dir');
  const originalSource = await readFile(f.files.canon);
  const verification = await view.verify();
  const disposal = await view.dispose();
  assert.equal(verification.ok, false);
  assert.equal(verification.errors[0].code, 'CAPTURE_PATH');
  assert.equal(disposal.ok, false);
  assert.equal(disposal.errors[0].code, 'CAPTURE_PATH');
  assert.deepEqual(await readFile(f.files.canon), originalSource);
  await unlink(view.files.canon);
  await rename(original, view.files.canon);
  assert.equal((await view.dispose()).ok, true);
});

test('real second Node process changes source during streaming; capture rejects and cleans', async (t) => {
  const f = await fixture(t);
  const row = JSON.stringify({ id: 'synthetic', text: 'x'.repeat(220) }) + '\n';
  await writeFile(f.files.canon, row.repeat(12000));
  const childCode = `const fs=require('node:fs');const path=require('node:path'); const [root,source]=process.argv.slice(1); console.log('ready'); const timer=setInterval(()=>{for(const d of fs.readdirSync(root)){const p=path.join(root,d,'canon.jsonl');try{if(fs.statSync(p).size>0){fs.appendFileSync(source,'{"id":"child-write"}\\n');clearInterval(timer);process.exit(0)}}catch{}}},1);setTimeout(()=>process.exit(2),10000).unref();`;
  const child = spawn(process.execPath, ['-e', childCode, f.tempRoot, f.files.canon], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const finished = once(child, 'exit');
  await once(child.stdout, 'data');
  await assert.rejects(captureLookupView({ ...f, limits: { chunkBytes: 1024 } }), { code: 'CAPTURE_SOURCE_CHANGED' });
  const [exit] = await finished;
  assert.equal(exit, 0);
  assert.deepEqual(await readdir(f.tempRoot), []);
  assert.match(await readFile(f.files.canon, 'utf8'), /child-write/);
});

for (const fault of [{ code: 'EIO', target: 'canon' }, { code: 'EACCES', target: 'evidence' }]) {
  test(`${fault.code} source read failure preserves code, cleans copies and releases the lease`, async (t) => {
    const f = await fixture(t);
    await writeFile(f.evidenceFile, '{"event":"synthetic"}\n');
    const target = fault.target === 'evidence' ? f.evidenceFile : f.files[fault.target];
    const childCode = `
      import assert from 'node:assert/strict';
      import fs from 'node:fs/promises';
      import { syncBuiltinESMExports } from 'node:module';
      const [moduleURL, fixtureJSON, target, faultCode] = process.argv.slice(1);
      const fixture = JSON.parse(fixtureJSON);
      const originalOpen = fs.open;
      fs.open = async function(path, flags, ...rest) {
        if (String(path) === target && flags === 'r') throw Object.assign(new Error('synthetic read failure'), { code: faultCode });
        return originalOpen.call(this, path, flags, ...rest);
      };
      syncBuiltinESMExports();
      const { captureLookupView } = await import(moduleURL);
      let failure;
      try { await captureLookupView(fixture); } catch (error) { failure = error; }
      assert.equal(failure?.code, faultCode);
      assert.equal(failure.cleanup.ok, true);
      assert.deepEqual(await fs.readdir(fixture.tempRoot), []);
      fs.open = originalOpen;
      syncBuiltinESMExports();
      // Two simultaneously retained views prove no lease survived the failure.
      const first = await captureLookupView(fixture);
      const second = await captureLookupView(fixture);
      assert.equal((await first.verify()).ok, true);
      assert.equal((await second.verify()).ok, true);
      assert.equal((await first.dispose()).ok, true);
      assert.equal((await second.dispose()).ok, true);
      assert.deepEqual(await fs.readdir(fixture.tempRoot), []);
      console.log(JSON.stringify({ code: failure.code, cleanup: failure.cleanup.ok, retainedAfterRecovery: 2 }));
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', childCode,
      new URL('./captured-lookup-view.mjs', import.meta.url).href, JSON.stringify(f), target, fault.code],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    const [exit] = await once(child, 'close');
    assert.equal(exit, 0, stderr);
    assert.deepEqual(JSON.parse(stdout), { code: fault.code, cleanup: true, retainedAfterRecovery: 2 });
  });
}

test('consumer lease blocks dispose, direct verify and a second consumer before and during async use', async (t) => {
  const f = await fixture(t);
  const view = await captureLookupView(f);
  const entered = deferred(), release = deferred();
  let pending;
  try {
    pending = guarded(view, async access => {
      assert.strictEqual(access, view);
      entered.resolve();
      await release.promise;
      return 'kept-result';
    });
    await assert.rejects(view.dispose(), { code: 'CAPTURE_IN_USE' });
    await assert.rejects(view.verify(), { code: 'CAPTURE_IN_USE' });
    await assert.rejects(guarded(view, () => 'second'), { code: 'CAPTURE_IN_USE' });
    await entered.promise;
    assert.equal((await readFile(view.files.canon)).length > 0, true);
    await assert.rejects(view.dispose(), { code: 'CAPTURE_IN_USE' });
    release.resolve();
    assert.equal(await pending, 'kept-result');
    assert.equal((await view.verify()).ok, true);
  } finally { release.resolve(); if (pending) await pending.catch(() => {}); assert.equal((await view.dispose()).ok, true); }
});

test('same-view callback reentry rejects without queueing behind itself', async (t) => {
  const f = await fixture(t); const view = await captureLookupView(f);
  try {
    assert.equal(await guarded(view, async () => {
      await assert.rejects(guarded(view, () => 'nested'), { code: 'CAPTURE_IN_USE' });
      await assert.rejects(view.verify(), { code: 'CAPTURE_IN_USE' });
      await assert.rejects(view.dispose(), { code: 'CAPTURE_IN_USE' });
      return 'outer';
    }), 'outer');
  } finally { assert.equal((await view.dispose()).ok, true); }
});

test('sync and async consumer exceptions preserve their identity and release the lease', async (t) => {
  const f = await fixture(t); const view = await captureLookupView(f);
  try {
    for (const asyncThrow of [false, true]) {
      const sentinel = new Error('synthetic consumer failure');
      const consumer = asyncThrow ? async () => { await Promise.resolve(); throw sentinel; } : () => { throw sentinel; };
      await assert.rejects(guarded(view, consumer), error => error === sentinel);
      assert.equal((await view.verify()).ok, true);
      assert.equal(await guarded(view, () => 'recovered'), 'recovered');
    }
  } finally { assert.equal((await view.dispose()).ok, true); }
});

test('pre/post integrity failures never publish a result and always release consumer ownership', async (t) => {
  const f = await fixture(t); const view = await captureLookupView(f);
  const original = await readFile(view.files.canon);
  try {
    await writeFile(view.files.canon, '{"id":"changed"}\n');
    let invoked = false;
    await assert.rejects(guarded(view, () => { invoked = true; }), { code: 'CAPTURED_VIEW_INTEGRITY' });
    assert.equal(invoked, false);
    await writeFile(view.files.canon, original);
    await assert.rejects(guarded(view, async () => { await writeFile(view.files.canon, '{"id":"changed"}\n'); return 'must-not-publish'; }), { code: 'CAPTURED_VIEW_INTEGRITY' });
    await writeFile(view.files.canon, original);
    const sentinel = new Error('consumer also failed');
    await assert.rejects(guarded(view, async () => { await writeFile(view.files.canon, '{"id":"changed"}\n'); throw sentinel; }), error => error.code === 'CAPTURED_VIEW_INTEGRITY' && error.cause === sentinel);
    await writeFile(view.files.canon, original);
    assert.equal(await guarded(view, () => 'restored'), 'restored');
  } finally { assert.equal((await view.dispose()).ok, true); }
});

test('a disposal queued before consumption finishes first and the consumer is never invoked', async (t) => {
  const f = await fixture(t); const view = await captureLookupView(f);
  const disposal = view.dispose(); let invoked = false;
  try {
    await assert.rejects(guarded(view, () => { invoked = true; }), { code: 'CAPTURED_VIEW_INTEGRITY' });
    assert.equal((await disposal).ok, true); assert.equal(invoked, false);
  } finally { await disposal; await view.dispose(); }
});

test('a held consumer lease does not block a different captured view', async (t) => {
  const f = await fixture(t); const first = await captureLookupView(f), second = await captureLookupView(f);
  const entered = deferred(), release = deferred(); let pending;
  try {
    pending = guarded(first, async () => { entered.resolve(); await release.promise; return 1; });
    await entered.promise;
    assert.equal(await guarded(second, () => 2), 2);
    assert.equal((await second.dispose()).ok, true);
    release.resolve(); assert.equal(await pending, 1);
  } finally { release.resolve(); if (pending) await pending.catch(() => {}); await first.dispose(); await second.dispose(); }
});
