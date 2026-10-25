import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildSelfProjection } from './self-projection.mjs';

const base = [
  { id: 'canon-self-core', kind: 'identity', claim: '我是大肥鱼。', revision: 'r1' },
  { id: 'canon-address-layers', kind: 'address', claim: '称 Master 时用“Master”。', revision: 'r1' },
  { id: 'canon-self-boundary', kind: 'boundary', claim: '不冒充人类，不编造记忆。', revision: 'r1' },
  { id: 'canon-self-principle', kind: 'principle', claim: '零编造。', revision: 'r1' },
];

test('deterministic across input order and repeated builds', () => {
  const a = buildSelfProjection(base);
  const b = buildSelfProjection([...base].reverse());
  assert.equal(a.status, 'ok');
  assert.equal(a.stableHash, b.stableHash);
  assert.equal(a.cardHash, b.cardHash);
  assert.deepEqual(a.entries.map((e) => e.id), b.entries.map((e) => e.id));
  assert.equal(a.stableText.split('\n').length, 4);
  assert.equal(a.cardText.length <= 600, true);
});

test('revision-only change keeps stable hash and changes source revisions', () => {
  const a = buildSelfProjection(base);
  const b = buildSelfProjection(base.map((r) => ({ ...r, revision: 'r2' })));
  assert.equal(a.stableHash, b.stableHash);
  assert.notDeepEqual(a.sourceRevisions, b.sourceRevisions);
});

test('claim change changes stable hash', () => {
  const a = buildSelfProjection(base);
  const b = buildSelfProjection(base.map((r) => r.id === 'canon-self-core' ? { ...r, claim: '我是蓝色大肥鱼。' } : r));
  assert.notEqual(a.stableHash, b.stableHash);
});

test('same semantic key with different content is a failed conflict', () => {
  const p = buildSelfProjection([
    ...base,
    { id: 'canon-self-other', kind: 'identity', semanticKey: 'canon-self-core', claim: '另一个身份。', revision: 'r2' },
  ]);
  assert.equal(p.status, 'failed');
  assert.ok(p.warnings.some((w) => w.includes('同键冲突')));
});

test('missing required kind is failed, not silently defaulted', () => {
  const p = buildSelfProjection([base[0]], { requiredKinds: ['identity', 'address'] });
  assert.equal(p.status, 'failed');
  assert.ok(p.warnings.some((w) => w.includes('缺少必需类别')));
});

test('empty input is empty, not ok', () => {
  assert.equal(buildSelfProjection([]).status, 'empty');
});

test('optional budget drop degrades; required overflow fails', () => {
  const p = buildSelfProjection(base, { requiredKinds: ['identity', 'address'], maxCardChars: 40 });
  assert.ok(p.warnings.some((w) => w.includes('card 预算裁掉')), JSON.stringify(p.warnings));
  assert.equal(p.cardText.includes('称 Master'), true);
  const failed = buildSelfProjection(base, { requiredKinds: ['identity', 'address'], maxCardChars: 5 });
  assert.equal(failed.status, 'failed');
});

test('source errors fail closed', () => {
  const p = buildSelfProjection(base, { sourceErrors: ['canon.jsonl 第 2 行坏'] });
  assert.equal(p.status, 'failed');
  assert.ok(p.warnings.some((w) => w.includes('来源错误')));
});

test('subject isolation and invalid input', () => {
  const p = buildSelfProjection([...base, { ...base[0], id: 'other', subjectId: 'other-subject' }], { subjectId: 'default' });
  assert.equal(p.entries.some((e) => e.id === 'other'), false);
  assert.throws(() => buildSelfProjection('x'), /history/);
  assert.throws(() => buildSelfProjection([], { maxCardChars: 0 }), /maxCardChars/);
  assert.throws(() => buildSelfProjection([], { sourceErrors: 'x' }), /sourceErrors/);
});

test('conflict entries are not counted as valid source roots', () => {
  const p = buildSelfProjection([
    ...base,
    { id: 'canon-self-other', kind: 'identity', semanticKey: 'canon-self-core', claim: '冲突', revision: 'r2' },
  ]);
  assert.equal(p.sourceRootIds.includes('canon-self-other'), false);
});

test('history validation: supersedes/retired/revoked/cycle', () => {
  const old = { id: 'old', kind: 'identity', semanticKey: 'same', claim: '旧身份', revision: 'r1' };
  const cur = { id: 'cur', kind: 'identity', semanticKey: 'same', claim: '新身份', revision: 'r2', supersedes: 'old' };
  const p = buildSelfProjection([old, cur, { id: 'canon-address-layers', kind: 'address', claim: 'Master', revision: 'r1' }]);
  assert.equal(p.status, 'ok');
  assert.equal(p.entries.some((e) => e.id === 'old'), false);
  assert.equal(p.entries.some((e) => e.id === 'cur'), true);

  const retired = buildSelfProjection([{ ...old, retired: true }, { id: 'canon-address-layers', kind: 'address', claim: 'Master' }]);
  assert.equal(retired.entries.some((e) => e.id === 'old'), false);

  const cycle = buildSelfProjection([
    { id: 'a', kind: 'identity', claim: 'a', supersedes: 'b' },
    { id: 'b', kind: 'identity', claim: 'b', supersedes: 'a' },
    { id: 'canon-address-layers', kind: 'address', claim: 'Master' },
  ]);
  assert.equal(cycle.status, 'failed');
  assert.ok(cycle.warnings.some((w) => w.includes('循环')));
});

test('required semantic keys and approvals fail closed', () => {
  const p = buildSelfProjection(base, { requiredSemanticKeys: ['missing-key'] });
  assert.equal(p.status, 'failed');
  assert.ok(p.warnings.some((w) => w.includes('缺少必需语义键')));

  const noApproval = buildSelfProjection(base, { requireApproval: true });
  assert.equal(noApproval.status, 'failed');
  assert.ok(noApproval.warnings.some((w) => w.includes('缺少有效批准')));

  const digest = (entry) => createHash('sha256')
    .update(JSON.stringify([entry.kind, entry.semanticKey, entry.claim, entry.scope, entry.id, entry.parentId ?? null])).digest('hex');
  const approvals = base.map((r) => ({
    action: 'self', subjectId: 'default', semanticKey: r.semanticKey ?? r.id, expectedRevision: r.revision,
    canonId: r.id, parentId: null,
    digest: digest({ ...r, semanticKey: r.semanticKey ?? r.id, scope: 'global', parentId: r.supersedes ?? null }), approvedBy: 'master',
  }));
  assert.equal(buildSelfProjection(base, { requireApproval: true, approvals }).status, 'ok');
});

test('views expose address/self/selfLine from one projection', () => {
  const p = buildSelfProjection(base);
  assert.match(p.views.addressText, /Master/);
  assert.match(p.views.selfText, /大肥鱼/);
  assert.match(p.views.selfLine, /大肥鱼/);
});


test('unapproved lifecycle cannot hide an approved parent; unsupported control fails', () => {
  const p = buildSelfProjection([
    { id: 'b', kind: 'boundary', claim: '边界', revision: 'r1' },
    { id: 'unapproved-hide', kind: 'boundary', claim: '隐藏', revision: 'r2', supersedes: 'b', retired: true },
    { id: 'canon-address-layers', kind: 'address', claim: 'Master' },
  ], { requireApproval: true, approvals: [] });
  assert.equal(p.status, 'failed');
  assert.ok(p.warnings.some((w) => w.includes('不支持的生命周期状态')));

  const retires = buildSelfProjection([
    { id: 'a', kind: 'identity', claim: 'a', retires: 'b' },
    { id: 'b', kind: 'boundary', claim: 'b' },
    { id: 'canon-address-layers', kind: 'address', claim: 'Master' },
  ]);
  assert.equal(retires.status, 'failed');
  assert.ok(retires.warnings.some((w) => w.includes('不支持的控制事件')));
});

test('structural digest prevents claim/scope ambiguity', () => {
  const a = { id: 'a', kind: 'identity', semanticKey: 'k', claim: 'APPROVED|NOT-APPROVED', scope: 'global', revision: 'r1' };
  const b = { id: 'a', kind: 'identity', semanticKey: 'k', claim: 'APPROVED', scope: 'NOT-APPROVED|global', revision: 'r1' };
  const digest = (r) => createHash('sha256').update(JSON.stringify([
    r.kind, r.semanticKey, r.claim, r.scope, r.id, null,
  ])).digest('hex');
  assert.notEqual(digest(a), digest(b));
});

test('same claim/revision double root is still a conflict; source root is root not tip', () => {
  const p = buildSelfProjection([
    { id: 'root', kind: 'identity', semanticKey: 'same', claim: '同', revision: 'r1' },
    { id: 'tip', kind: 'identity', semanticKey: 'same', claim: '同', revision: 'r1' },
    { id: 'canon-address-layers', kind: 'address', claim: 'Master' },
  ]);
  assert.equal(p.status, 'failed');
  const chained = buildSelfProjection([
    { id: 'root', kind: 'identity', semanticKey: 'same', claim: '旧', revision: 'r1' },
    { id: 'tip', kind: 'identity', semanticKey: 'same', claim: '新', revision: 'r2', supersedes: 'root' },
    { id: 'canon-address-layers', kind: 'address', claim: 'Master' },
  ]);
  assert.deepEqual(chained.sourceRootIds, ['canon-address-layers', 'root'].sort());
});

test('bad current records fail; skipHistoryValidation requires boolean', () => {
  const p = buildSelfProjection([null, {}, { id: 'canon-address-layers', kind: 'address', claim: 'Master' }]);
  assert.equal(p.status, 'failed');
  assert.throws(() => buildSelfProjection([], { skipHistoryValidation: 'false' }), /skipHistoryValidation/);
});


test('requireApproval failure does not leak unapproved body; task scope excluded', () => {
  const p = buildSelfProjection(base, { requireApproval: true, approvals: [] });
  assert.equal(p.status, 'failed');
  assert.equal(p.stableText, '');
  assert.equal(p.cardText, '');
  assert.deepEqual(p.views, { selfText: '', selfLine: '', addressText: '' });
  const task = buildSelfProjection([
    ...base,
    { id: 'task-t1', kind: 'commitment_policy', claim: '任务 T1 承诺', scope: 'task:T1' },
  ]);
  assert.equal(task.status, 'ok');
  assert.equal(task.stableText.includes('任务 T1'), false);
});


test('__proto__ ID survives source manifest; spaced IDs are not merged', () => {
  const p = buildSelfProjection([
    { id: '__proto__', kind: 'identity', claim: 'p', revision: 'r1' },
    { id: ' x ', kind: 'boundary', claim: 'x', revision: 'r1' },
    { id: 'canon-address-layers', kind: 'address', claim: 'Master', revision: 'r1' },
  ]);
  assert.equal(Object.prototype.hasOwnProperty.call(p.sourceRevisions, '__proto__'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(p.sourceRevisions, ' x '), true);
});


test('lifecycle approval works with canonical supersedes and inactive root needs approval', () => {
  const { createHash } = process.getBuiltinModule('node:crypto');
  const digest = (r) => createHash('sha256').update(JSON.stringify([r.kind, r.semanticKey, r.claim, r.scope, r.id, r.parentId ?? null])).digest('hex');
  const base = [
    { id: 'i', kind: 'identity', claim: 'I', revision: 'r1' },
    { id: 'b', kind: 'boundary', semanticKey: 'boundary', claim: '旧边界', revision: 'r1' },
    { id: 'a', kind: 'address', claim: 'Master', revision: 'r1' },
    { id: 'b2', kind: 'boundary', semanticKey: 'boundary', claim: '新边界', revision: 'r2', supersedes: 'b' },
  ];
  const approvals = base.map((r) => ({
    action: 'self', subjectId: 'default', semanticKey: r.semanticKey ?? r.id, expectedRevision: r.revision,
    canonId: r.id, parentId: r.supersedes ?? null,
    digest: digest({ ...r, semanticKey: r.semanticKey ?? r.id, scope: 'global', parentId: r.supersedes ?? null }),
    approvedBy: 'master',
  }));
  assert.equal(buildSelfProjection(base, { requireApproval: true, approvals }).status, 'ok');

  const inactive = buildSelfProjection([
    { id: 'b', kind: 'boundary', claim: '边界', revision: 'r1', retired: true },
    { id: 'a', kind: 'address', claim: 'Master', revision: 'r1' },
  ], { requireApproval: true, approvals: [] });
  assert.equal(inactive.status, 'failed');
  assert.ok(inactive.warnings.some((w) => w.includes('不支持的生命周期状态')));
});

test('card-only drop degrades; malformed optional fails', () => {
  const p = buildSelfProjection([
    ...base,
    { id: 'p1', kind: 'principle', claim: 'P'.repeat(30), revision: 'r1' },
  ], { maxStableChars: 200, maxCardChars: 50 });
  assert.equal(p.status, 'degraded');
  assert.ok(p.warnings.some((w) => w.includes('card 预算裁掉')));

  const bad = buildSelfProjection([
    ...base,
    { id: 'bad', kind: 'principle', claim: 42, revision: 'r1' },
  ]);
  assert.equal(bad.status, 'failed');
});
