import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSelf } from './self-loader.mjs';
import { SelfStepCoordinator } from './self-step.mjs';

function fixture(claim = '我是大肥鱼') {
  const dir = mkdtempSync(join(tmpdir(), 'self-step-'));
  const canonFile = join(dir, 'canon.jsonl');
  writeFileSync(canonFile, [
    { id: 'i', kind: 'identity', semanticKey: 'identity', claim, revision: 'r1' },
    { id: 'a', kind: 'address', semanticKey: 'address', claim: '称呼 Master', revision: 'r1' },
    { id: 'b', kind: 'boundary', semanticKey: 'boundary', claim: '零编造', revision: 'r1' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { dir, canonFile };
}

function coordinator(canonFile) {
  return new SelfStepCoordinator({
    capture: () => projectSelf({ canonFile }),
    subjectId: 'default',
    bindingRevision: 'subject/default/r1',
    storeRootId: 'synthetic',
    idFactory: (() => { let n = 0; return () => `id-${++n}`; })(),
  });
}

test('one step pins frame across self/selfLine even after source changes', () => {
  const f = fixture();
  try {
    const c = coordinator(f.canonFile);
    const step = c.begin();
    assert.equal(step.mode, 'ready');
    const self = c.consume(step, 'self');
    writeFileSync(f.canonFile, [
      { id: 'i', kind: 'identity', semanticKey: 'identity', claim: 'BETA', revision: 'r2' },
      { id: 'a', kind: 'address', semanticKey: 'address', claim: '称呼 Master', revision: 'r1' },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const line = c.consume(step, 'selfLine');
    assert.match(self.text, /我是大肥鱼/);
    assert.equal(line.text, '我是大肥鱼；称呼 Master');
    assert.equal(line.frameId, self.frameId);
    assert.equal(c.refresh(step), step);
    const next = c.nextStep();
    assert.notEqual(next.frameId, step.frameId);
    assert.match(c.consume(next, 'selfLine').text, /BETA/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('pending is explicit and resolves once without recapture', () => {
  const f = fixture();
  try {
    const c = coordinator(f.canonFile);
    const step = c.begin({ pending: true });
    assert.equal(step.mode, 'pending');
    assert.equal(c.consume(step, 'self', { fallback: 'FB' }).status, 'pending');
    const captured = projectSelf({ canonFile: f.canonFile });
    c.resolve(step, captured);
    assert.equal(step.mode, 'ready');
    assert.match(c.consume(step, 'self').text, /我是大肥鱼/);
    assert.throws(() => c.resolve(step, captured), /pending/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('unavailable capture does not fall back to latest source', () => {
  const c = new SelfStepCoordinator({
    capture: () => { throw new Error('synthetic capture failure'); },
    subjectId: 'default', bindingRevision: 'b', storeRootId: 'r', idFactory: () => 'id',
  });
  const step = c.begin();
  assert.equal(step.mode, 'unavailable');
  assert.equal(c.consume(step, 'self', { fallback: 'FB' }).status, 'unavailable');
  assert.equal(c.validate(step, 'x', []).status, 'reject');
});

test('attempt tokens are unique and per-step; final validation uses same frame', () => {
  const f = fixture();
  try {
    const c = coordinator(f.canonFile);
    const step = c.begin();
    const a1 = c.attempt(step), a2 = c.attempt(step);
    assert.notEqual(a1, a2);
    assert.equal(step.attempts.length, 2);
    const provenance = [{ frameId: step.frameId, view: 'self', text: step.frame.projection.stableText, location: 'system' }];
    assert.equal(c.validate(step, { system: step.frame.projection.stableText, messages: [] }, provenance).status, 'allow');
    assert.equal(c.check(step).status, 'current');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});


test('handles are coordinator-owned and read-only; mutation cannot swap frame', () => {
  const f = fixture();
  try {
    const a = coordinator(f.canonFile);
    const b = coordinator(f.canonFile);
    const step = a.begin();
    assert.throws(() => b.consume(step, 'self'), /不属于/);
    assert.throws(() => b.validate(step, {}, []), /不属于/);
    assert.throws(() => b.attempt(step), /不属于/);
    assert.throws(() => { step.mode = 'pending'; }, TypeError);
    assert.throws(() => { step.frame = b.begin().frame; }, TypeError);
    assert.equal(a.consume(step, 'self').status, 'frame');
    assert.ok(Object.isFrozen(step.frame));
    assert.ok(Object.isFrozen(step.attempts));
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('renderPolicy is deep-copied; caller mutation does not change frame', () => {
  const f = fixture();
  try {
    const policy = { budgets: { stable: 4000 } };
    const c = new SelfStepCoordinator({
      capture: () => projectSelf({ canonFile: f.canonFile }),
      subjectId: 'default', bindingRevision: 'b', storeRootId: 'r',
      renderPolicy: policy, idFactory: () => 'id',
    });
    const step = c.begin();
    policy.budgets.stable = 2000;
    assert.equal(step.frame.renderPolicy.budgets.stable, 4000);
    assert.equal(c.check(step).status, 'current');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('attempt id is required to match when supplied; frame-only validation stays explicit', () => {
  const f = fixture();
  try {
    const c = coordinator(f.canonFile);
    const step = c.begin();
    const provenance = [{ frameId: step.frameId, view: 'self', text: step.frame.projection.stableText, location: 'system' }];
    const payload = { system: step.frame.projection.stableText, messages: [] };
    assert.equal(c.validate(step, payload, provenance).status, 'allow');
    const attempt = c.attempt(step);
    assert.equal(c.validate(step, payload, provenance, undefined, attempt).status, 'allow');
    assert.equal(c.validate(step, payload, provenance, undefined, 'bogus').status, 'reject');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
