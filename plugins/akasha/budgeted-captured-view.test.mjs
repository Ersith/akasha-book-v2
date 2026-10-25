import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

const tempParent = resolve(tmpdir());
const root = fs.mkdtempSync(join(tempParent, 'akasha-budgeted-view-test-'));
process.env.AKASHA_ROOT = join(root, 'unavailable-data');
process.env.AKASHA_LOGS = join(root, 'unmanaged-logs');
process.env.TEMP = process.env.TMP = root;
fs.mkdirSync(process.env.AKASHA_LOGS);
after(() => {
  const target = resolve(root);
  assert.ok(target.startsWith(tempParent + sep));
  assert.ok(target.includes('akasha-budgeted-view-test-'));
  fs.rmSync(target, { recursive: true, force: true });
});

const { openBudget } = await import('./m3-resource-budget.mjs');
const { captureBudgetedLookupView, budgetedPairedLookupView } = await import('./budgeted-captured-view.mjs');
const { withCapturedLookupView } = await import('./captured-lookup-view.mjs');
const stores = ['canon', 'mirror', 'orphan', 'pricing', 'lexicon', 'frontier'];
const clock = { now: '2026-10-25T00:00:00Z', cutoff: '2026-10-25T00:00:00Z', today: '2026-10-25' };
function fixture(limits = {}) {
  const dir = fs.mkdtempSync(join(root, 'fixture-'));
  const budgetRoot = join(dir, 'budget'); fs.mkdirSync(budgetRoot);
  const files = Object.fromEntries(stores.map(name => [name, join(dir, name + '.jsonl')]));
  for (const [name, file] of Object.entries(files)) fs.writeFileSync(file, name === 'canon' ? JSON.stringify({ id: 'canon-a', claim: 'memory repair', tags: ['经验'], event_time: '2026-09-01' }) + '\n' : '');
  return { dir, files, evidenceFile: join(dir, 'evidence.jsonl'), budget: openBudget({ root: budgetRoot, limits }) };
}
const request = (extra = {}) => ({ enabled: true, query: 'memory', ...clock, ...extra });

test('disabled wrapper does not inspect budget, query or source getters', async () => {
  const before = fs.readdirSync(root);
  for (const enabled of [undefined, false, 0, 1, 'true']) {
    const result = await budgetedPairedLookupView({ enabled,
      get budget() { throw new Error('budget read'); }, get query() { throw new Error('query read'); },
      get files() { throw new Error('source read'); } });
    assert.deepEqual(result, { enabled: false, mode: 'off', reason: 'disabled' });
  }
  assert.deepEqual(fs.readdirSync(root), before);
});

test('invalid paired parameters reject before budget acquisition', async () => {
  await assert.rejects(budgetedPairedLookupView({ ...request({ query: 'x'.repeat(5000) }),
    get budget() { throw new Error('budget read'); } }), /query/);
  await assert.rejects(budgetedPairedLookupView({ ...request({ options: { loadBalance: true } }),
    get budget() { throw new Error('budget read'); } }), /unsupported|controlled/);
});

test('successful pairing keeps served baseline and releases reservation without log side effects', async () => {
  const f = fixture();
  const before = fs.readFileSync(f.files.canon);
  const idle = f.budget.inspectBudget();
  const result = await budgetedPairedLookupView(request(f));
  assert.strictEqual(result.served, result.baseline);
  assert.equal(result.appliedToResults, false);
  assert.deepEqual(result.baseline.hits.map(h => h.id), ['canon-a']);
  assert.equal(result.view.atomicSourceSnapshot, false);
  assert.equal(f.budget.inspectBudget().usedBytes, idle.usedBytes);
  assert.deepEqual(fs.readdirSync(join(f.budget.root, 'captures')), []);
  assert.deepEqual(fs.readdirSync(process.env.AKASHA_LOGS), []);
  assert.deepEqual(fs.readFileSync(f.files.canon), before);
});

test('live capture holds full reservation; disposal coalesces and releases only after unlink', async () => {
  const f = fixture(); const idle = f.budget.inspectBudget().usedBytes;
  const holder = await captureBudgetedLookupView({ ...f, limits: { maxTotalBytes: 4096 } });
  assert.equal(holder.reservation.reservedBytes, 4096);
  assert.ok(holder.view.manifest.totalBytes < 4096);
  assert.equal(f.budget.inspectBudget().usedBytes, idle + 4096);
  const a = holder.dispose(), b = holder.dispose();
  assert.strictEqual(a, b);
  assert.equal((await a).ok, true);
  assert.equal(f.budget.inspectBudget().usedBytes, idle);
  assert.equal((await holder.dispose()).ok, true);
});

test('quota refusal happens before opening invalid sources and creates no capture', async () => {
  const f = fixture({ maxLeases: 1 });
  const held = f.budget.reserveCapture({ bytes: 4096 });
  assert.equal(held.ok, true);
  await assert.rejects(captureBudgetedLookupView({ ...f, files: {}, limits: { maxTotalBytes: 4096 } }), { code: 'M3_CAPTURE_BUDGET_REFUSED' });
  assert.deepEqual(fs.readdirSync(held.tempRoot), []);
  assert.equal(f.budget.releaseCapture(held.token).ok, true);
});

test('malformed source and capture limit rejection release their reservation', async () => {
  const f = fixture(); const idle = f.budget.inspectBudget().usedBytes;
  fs.writeFileSync(f.files.canon, '{partial');
  await assert.rejects(captureBudgetedLookupView({ ...f, limits: { maxTotalBytes: 4096 } }), error => {
    assert.equal(error.code, 'CAPTURE_JSONL'); assert.equal(error.cleanup.ok, true); return true;
  });
  assert.equal(f.budget.inspectBudget().usedBytes, idle);
  await assert.rejects(captureBudgetedLookupView({ ...f, limits: { maxRecords: 0 } }), { code: 'CAPTURE_ARGUMENT' });
  assert.equal(f.budget.inspectBudget().usedBytes, idle);
});

test('non-Error and frozen input exceptions cannot strand an empty reservation', async () => {
  const f = fixture(); const idle = f.budget.inspectBudget().usedBytes;
  for (const thrown of [null, undefined, 'input-failed', Object.freeze(new Error('frozen input failure'))]) {
    const files = { ...f.files, get canon() { throw thrown; } };
    await assert.rejects(captureBudgetedLookupView({ ...f, files, limits: { maxTotalBytes: 4096 } }), error => {
      assert.equal(error.cleanup.ok, true); assert.strictEqual(error.cause, thrown); return true;
    });
    assert.equal(f.budget.inspectBudget().usedBytes, idle);
    assert.deepEqual(fs.readdirSync(join(f.budget.root, 'captures')), []);
  }
});

test('foreign capture entry blocks disposal and retains full charge until explicit retry', async () => {
  const f = fixture(); const idle = f.budget.inspectBudget().usedBytes;
  const holder = await captureBudgetedLookupView({ ...f, limits: { maxTotalBytes: 4096 } });
  const foreign = join(dirname(holder.view.files.canon), 'foreign.txt');
  fs.writeFileSync(foreign, 'preserve');
  const cleanup = await holder.dispose();
  assert.equal(cleanup.ok, false); assert.equal(cleanup.stage, 'view');
  assert.equal(f.budget.inspectBudget().usedBytes, idle + 4096);
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'preserve');
  fs.unlinkSync(foreign);
  assert.equal((await holder.dispose()).ok, true);
  assert.equal(f.budget.inspectBudget().usedBytes, idle);
});

test('consume/dispose exclusion also retains budget while the callback awaits', async () => {
  const f = fixture(); const idle = f.budget.inspectBudget().usedBytes;
  const holder = await captureBudgetedLookupView({ ...f, limits: { maxTotalBytes: 4096 } });
  let unblock, entered;
  const start = new Promise(r => { entered = r; });
  const wait = new Promise(r => { unblock = r; });
  const run = withCapturedLookupView(holder.view, async () => { entered(); await wait; return 'ok'; });
  await start;
  try {
    const blocked = await holder.dispose();
    assert.equal(blocked.ok, false); assert.equal(blocked.errors[0].code, 'CAPTURE_IN_USE');
    assert.equal(f.budget.inspectBudget().usedBytes, idle + 4096);
  } finally { unblock(); await run; assert.equal((await holder.dispose()).ok, true); }
  assert.equal(f.budget.inspectBudget().usedBytes, idle);
});

test('caller parameters and capture bounds are fixed before asynchronous copying', async () => {
  const f = fixture(); const options = { tag: '经验' }, limits = { maxTotalBytes: 4096 };
  const pending = budgetedPairedLookupView(request({ ...f, options, limits }));
  options.tag = 'missing'; limits.maxTotalBytes = 1;
  const result = await pending;
  assert.equal(result.parameters.options.tag, '经验');
  assert.equal(result.baseline.hits.length, 1);
});

test('manager identity and its configured per-capture ceiling are enforced', async () => {
  const f = fixture({ maxLeaseBytes: 1024 });
  await assert.rejects(captureBudgetedLookupView({ ...f, budget: { ...f.budget } }), { code: 'M3_CAPTURE_BUDGET_ARGUMENT' });
  await assert.rejects(captureBudgetedLookupView({ ...f, limits: { maxTotalBytes: 2048 } }), { code: 'M3_CAPTURE_BUDGET_ARGUMENT' });
  for (const maxTotalBytes of [null, undefined, NaN, 0]) {
    await assert.rejects(captureBudgetedLookupView({ ...f, limits: { maxTotalBytes } }), { code: 'M3_CAPTURE_BUDGET_ARGUMENT' });
  }
  const holder = await captureBudgetedLookupView(f);
  assert.equal(holder.reservation.reservedBytes, 1024);
  assert.equal((await holder.dispose()).ok, true);
});

test('managed logs and a live capture compete for the same total budget', async () => {
  const f = fixture({ maxTotalBytes: 2 * 65536 + 4096 + 5000 });
  const holder = await captureBudgetedLookupView({ ...f, limits: { maxTotalBytes: 4096 } });
  const input = { operationId: 'shared-quota', log: 'observations', record: { text: 'x'.repeat(1600) } };
  try { assert.equal(f.budget.appendManagedLog(input).ok, false); }
  finally { assert.equal((await holder.dispose()).ok, true); }
  assert.equal(f.budget.appendManagedLog(input).status, 'committed');
  assert.ok(f.budget.inspectBudget().logActualBytes > 1600);
});

test('budget release IO failure stays visible after view deletion and can be retried', async () => {
  const f = fixture({ lockTimeoutMs: 10 }); const idle = f.budget.inspectBudget().usedBytes;
  const holder = await captureBudgetedLookupView({ ...f, limits: { maxTotalBytes: 4096 } });
  const lock = join(f.budget.root, 'budget.lock');
  fs.writeFileSync(lock, JSON.stringify({ token: 'test-owned-lock' }), { flag: 'wx' });
  try {
    const status = await holder.dispose();
    assert.equal(status.ok, false); assert.equal(status.stage, 'budget');
    assert.equal(status.errors[0].code, 'M3_LOCK_BUSY');
    assert.equal(fs.existsSync(holder.view.files.canon), false);
  } finally { fs.unlinkSync(lock); }
  assert.equal(f.budget.inspectBudget().usedBytes, idle + 4096);
  assert.equal((await holder.dispose()).ok, true);
  assert.equal(f.budget.inspectBudget().usedBytes, idle);
});

test('paired cleanup failure remains explicit and exposes one bounded retry', async () => {
  const f = fixture(); const idle = f.budget.inspectBudget().usedBytes;
  const originalRead = fs.readFileSync; let foreign, failure;
  try {
    fs.readFileSync = function(file, ...args) {
      const bytes = originalRead.call(this, file, ...args);
      if (String(file).endsWith('evidence.jsonl') && String(file).startsWith(f.budget.root)) {
        foreign = join(dirname(file), 'foreign.txt'); fs.writeFileSync(foreign, 'preserve');
      }
      return bytes;
    };
    syncBuiltinESMExports();
    await assert.rejects(budgetedPairedLookupView(request({ ...f, limits: { maxTotalBytes: 4096 } })), error => {
      failure = error;
      assert.equal(error.code, 'M3_CAPTURED_VIEW_CLEANUP');
      assert.equal(error.cause.code, 'CAPTURED_VIEW_INTEGRITY'); return true;
    });
    assert.equal(f.budget.inspectBudget().usedBytes, idle + 4096);
  } finally {
    fs.readFileSync = originalRead; syncBuiltinESMExports();
    if (foreign) { assert.equal(fs.readFileSync(foreign, 'utf8'), 'preserve'); fs.unlinkSync(foreign); }
    if (failure) assert.equal((await failure.dispose()).ok, true);
  }
  assert.equal(f.budget.inspectBudget().usedBytes, idle);
});
