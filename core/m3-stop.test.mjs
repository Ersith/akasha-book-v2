import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveCanaryStop } from './m3-stop.mjs';

test('stop switch is off by default and on for explicit values', () => {
  assert.deepEqual(resolveCanaryStop({}), { stopped: false });
  for (const value of ['1', 'true', 'STOP', ' paused ']) assert.equal(resolveCanaryStop({ AKASHA_M3_STOP: value }).stopped, true);
  assert.equal(resolveCanaryStop({ AKASHA_M3_STOP: '0' }).stopped, false);
});

test('stop file is fail-closed on metadata errors; absent is off', () => {
  const dir = mkdtempSync(join(tmpdir(), 'm3-stop-'));
  try {
    const file = join(dir, 'STOP');
    assert.equal(resolveCanaryStop({ AKASHA_M3_STOP_FILE: file }).stopped, false);
    writeFileSync(file, 'stop');
    assert.equal(resolveCanaryStop({ AKASHA_M3_STOP_FILE: file }).stopped, true);
    assert.equal(resolveCanaryStop({ AKASHA_M3_STOP_FILE: 'relative/STOP' }).stopped, true);
    const abs = join(dir, 'MISSING');
    assert.equal(resolveCanaryStop({ AKASHA_M3_STOP_FILE: abs }, { lstat() { const e = new Error('denied'); e.code = 'EPERM'; throw e; } }).stopped, true);
    assert.equal(resolveCanaryStop({ AKASHA_M3_STOP_FILE: abs }, { lstat() { const e = new Error('missing'); e.code = 'ENOENT'; throw e; } }).stopped, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('dangling junction is present and stops', (t) => {
  if (process.platform !== 'win32') { t.skip('junction case requires win32'); return; }
  const dir = mkdtempSync(join(tmpdir(), 'm3-stop-link-'));
  const link = join(dir, 'STOP');
  try {
    try { symlinkSync(join(dir, 'missing-target'), link, 'junction'); }
    catch { t.skip('junction creation unavailable'); return; }
    assert.equal(resolveCanaryStop({ AKASHA_M3_STOP_FILE: link }).stopped, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
