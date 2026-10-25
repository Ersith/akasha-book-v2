import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSelf } from './self-loader.mjs';
import { createSelfFrame, checkSelfFrame, validateSelfPayload } from './self-frame.mjs';

function fixture(claim = '我是大肥鱼') {
  const dir = mkdtempSync(join(tmpdir(), 'self-frame-'));
  const canonFile = join(dir, 'canon.jsonl');
  writeFileSync(canonFile, [
    { id: 'i', kind: 'identity', semanticKey: 'identity', claim, revision: 'r1' },
    { id: 'a', kind: 'address', semanticKey: 'address', claim: '称 Master', revision: 'r1' },
    { id: 'b', kind: 'boundary', semanticKey: 'boundary', claim: '零编造', revision: 'r1' },
  ].map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { dir, canonFile, ...projectSelf({ canonFile }) };
}

const opts = { subjectId: 'default', bindingRevision: 'subject:default', storeRootId: 'canon:default' };

test('frame is frozen and bound to generation/revision/render policy', () => {
  const f = fixture();
  try {
    const frame = createSelfFrame({ ...opts, source: f.source, projection: f.projection });
    assert.match(frame.frameId, /^[0-9a-f]{64}$/);
    assert.equal(Object.isFrozen(frame), true);
    assert.equal(Object.isFrozen(frame.projection), true);
    assert.throws(() => { frame.frameId = 'x'; }, TypeError);
    const same = createSelfFrame({ ...opts, source: f.source, projection: f.projection });
    assert.equal(frame.frameId, same.frameId);
    const other = createSelfFrame({ ...opts, source: f.source, projection: f.projection, renderPolicy: { budgetUnit: 'chars', v: 2 } });
    assert.notEqual(frame.frameId, other.frameId);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('frame check distinguishes current, stale and mismatch', () => {
  const f = fixture();
  try {
    const frame = createSelfFrame({ ...opts, source: f.source, projection: f.projection });
    assert.equal(checkSelfFrame({ frame, source: f.source, projection: f.projection }).status, 'current');
    assert.equal(checkSelfFrame({ frame, source: { ...f.source, generation: 'sha256:other' }, projection: f.projection }).status, 'stale');
    assert.equal(checkSelfFrame({ frame, source: f.source, projection: { ...f.projection, stableHash: 'other' } }).status, 'mismatch');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('payload validation requires provenance, not just matching text', () => {
  const f = fixture();
  try {
    const frame = createSelfFrame({ ...opts, source: f.source, projection: f.projection });
    const payload = JSON.stringify({ system: frame.projection.stableText, messages: [] });
    const provenance = [
      { frameId: frame.frameId, view: 'self', text: frame.projection.stableText, location: 'system' },
    ];
    assert.equal(validateSelfPayload({ frame, payload, provenance }).status, 'allow');
    // 同一句话出现在 payload，但没有受管来源：拒绝。
    assert.equal(validateSelfPayload({ frame, payload, provenance: [] }).status, 'reject');
    assert.equal(validateSelfPayload({ frame, payload, provenance, requiredViews: ['self', 'selfLine'] }).status, 'reject');
    const wrong = provenance.map((p) => ({ ...p, frameId: 'other' }));
    assert.equal(validateSelfPayload({ frame, payload, provenance: wrong }).status, 'reject');
    const conflict = [...provenance, { frameId: frame.frameId, view: 'self', text: '另一版', location: 'system' }];
    assert.equal(validateSelfPayload({ frame, payload, provenance: conflict }).status, 'reject');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('reassembly and failed projection cannot be used as a final frame', () => {
  const f = fixture();
  try {
    const frame = createSelfFrame({ ...opts, source: f.source, projection: f.projection });
    const payload = frame.projection.stableText;
    assert.equal(validateSelfPayload({ frame, payload, provenance: [{ frameId: frame.frameId, view: 'self', text: payload, location: 'context', reassemblyRequired: true }] }).status, 'reject');
    assert.throws(() => createSelfFrame({ ...opts, source: f.source, projection: { ...f.projection, status: 'failed' } }), /不可投递/);
    assert.throws(() => createSelfFrame({ ...opts, source: f.source, projection: { ...f.projection, subjectId: 'other' } }), /subject/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
