import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildContextPack, renderPack } from './context-pack.mjs';
import { samplePacks } from './context-pack.review-fixture.mjs';

// Real module only: no model calls, filesystem writes, runtime injection, or mocks.
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const section = (id = 's', text = '规则') => ({ id, order: 1, text });
const baseStable = [
  { id: 'self', order: 1, text: '我是大肥鱼。', source: { kind: 'fixture', id: 'self-r1' } },
  { id: 'rules', order: 2, text: '先核实来源。\n第二条。', source: { kind: 'fixture', id: 'rules-r1' } },
];
const expectedStable = '## self\n我是大肥鱼。\n\n## rules\n先核实来源。\n第二条。';

// Catches destructuring coercion silently accepting arrays and primitive roots.
for (const [name, value] of [['null', null], ['array', []], ['string', 'x'], ['number', 1], ['boolean', true]]) {
  test(`reject malformed root: ${name}`, () => {
    assert.throws(() => buildContextPack(value), TypeError);
  });
}

// Explicit null is malformed; omitted collections retain the API's defaults.
for (const kind of ['stable', 'dynamic']) {
  for (const [name, value] of [['null', null], ['object', {}], ['string', 'x'], ['number', 1]]) {
    test(`reject nonarray ${kind}: ${name}`, () => {
      assert.throws(() => buildContextPack({ [kind]: value }), new RegExp(kind));
    });
  }
  for (const [name, value] of [['null', null], ['array', []], ['string', 'x'], ['number', 1]]) {
    test(`reject invalid ${kind} section: ${name}`, () => {
      assert.throws(() => buildContextPack({ [kind]: [value] }), new RegExp(`${kind}\\[0\\]`));
    });
  }
}

for (const [field, value] of [
  ['id', ''], ['id', '  '], ['id', 7],
  ['order', undefined], ['order', Infinity], ['order', 1.5],
  ['text', undefined], ['text', null], ['text', {}], ['text', 7],
]) {
  test(`reject malformed section field ${field}=${String(value)}`, () => {
    assert.throws(
      () => buildContextPack({ stable: [{ ...section(), [field]: value }] }),
      new RegExp(`stable\\[0\\]\\.${field}`),
    );
  });
}

test('reject duplicate ids even when their order differs', () => {
  assert.throws(() => buildContextPack({
    stable: [section(), { ...section('s', '另一规则'), order: 2 }],
  }), /stable\[1\]\.id/);
});

for (const field of ['maxTokens', 'maxStableTokens']) {
  for (const [name, value] of [
    ['NaN', NaN], ['Infinity', Infinity], ['negative Infinity', -Infinity],
    ['negative', -1], ['fraction', 1.5], ['string', '10'],
  ]) {
    test(`reject ${field}: ${name}`, () => {
      assert.throws(() => buildContextPack({ [field]: value }), new RegExp(field));
    });
  }
}

test('reject a string pretending to disable volatile validation', () => {
  assert.throws(() => buildContextPack({ allowVolatileStable: 'false' }), /allowVolatileStable/);
});

test('stable cannot exceed the total cap even with a larger stable cap', () => {
  assert.throws(() => buildContextPack({
    stable: [section('s', '中'.repeat(20))], maxTokens: 10, maxStableTokens: 100,
  }), /stable.*超预算/);
});

test('stable also respects a narrower stable cap', () => {
  assert.throws(() => buildContextPack({
    stable: [section('s', '中'.repeat(20))], maxTokens: 100, maxStableTokens: 10,
  }), /stable.*超预算/);
});

test('required dynamic cannot disappear when over budget', () => {
  assert.throws(() => buildContextPack({
    dynamic: [{ ...section('must', '中'.repeat(20)), required: true }], maxTokens: 10,
  }), /dynamic\.must.*超预算/);
});

test('required dynamic shares the total budget already consumed by stable', () => {
  const stable = [section('s', '规'.repeat(12))];
  const dynamic = [{ ...section('must', '动'.repeat(12)), required: true }];
  assert.equal(buildContextPack({ stable, maxTokens: 25 }).stable.text, `## s\n${'规'.repeat(12)}`);
  assert.deepEqual(buildContextPack({ dynamic, maxTokens: 25 }).dynamic.sections, ['must']);
  assert.throws(() => buildContextPack({ stable, dynamic, maxTokens: 25 }), /dynamic\.must.*超预算/);
});

test('required dynamic cannot disappear through whitespace normalization', () => {
  assert.throws(() => buildContextPack({
    dynamic: [{ ...section('must', ' \r\n '), required: true }],
  }), /dynamic/);
});

test('optional dynamic omissions are explicit and preserve the stable text', () => {
  const pack = buildContextPack({
    stable: [section('s', '规则')],
    dynamic: [section('large', '中'.repeat(100))], maxTokens: 20,
  });
  assert.equal(pack.stable.text, '## s\n规则');
  assert.deepEqual(pack.dynamic.sections, []);
  assert.deepEqual(pack.dynamic.omitted, [{ id: 'large', reason: 'budget' }]);
  assert.ok(pack.totalTokens <= 20);
});

test('explicitly volatile stable sections fail even without a matching text prefix', () => {
  assert.throws(() => buildContextPack({
    stable: [{ ...section('live', '本轮有 1 条更新'), volatile: true }],
  }), /stable.*易变/);
});

test('explicit volatile allowance retains plain text and reports a warning', () => {
  const pack = buildContextPack({
    stable: [{ ...section('live', '本轮有一条更新。'), volatile: true }],
    allowVolatileStable: true,
  });
  assert.equal(pack.stable.text, '## live\n本轮有一条更新。');
  assert.ok(Array.isArray(pack.warnings) && pack.warnings.length > 0);
});

test('three changing dynamic rounds retain nonempty stable bytes and independent hashes', () => {
  const rounds = [1, 2, 3].map((round) => buildContextPack({
    stable: baseStable,
    dynamic: [section('pulse', `本轮更新 ${round} 条。`)],
    asOf: `2026-10-20T12:00:0${round}Z`,
    sourceRevisions: { canon: 'r1' },
  }));
  for (const [i, pack] of rounds.entries()) {
    assert.equal(pack.stable.text, expectedStable);
    assert.deepEqual(pack.stable.sections, ['self', 'rules']);
    assert.ok(Buffer.byteLength(pack.stable.text, 'utf8') > 0);
    assert.equal(pack.stable.contentHash, sha256(expectedStable));
    assert.equal(pack.stable.hash, pack.stable.contentHash);
    assert.equal(pack.dynamic.text, `## pulse\n本轮更新 ${i + 1} 条。`);
    assert.equal(pack.dynamic.contentHash, sha256(pack.dynamic.text));
  }
  assert.equal(new Set(rounds.map((p) => p.stable.cacheKey)).size, 1);
  assert.equal(new Set(rounds.map((p) => p.dynamic.contentHash)).size, 3);
});

test('stable body positive control changes the content hash and cache key', () => {
  const before = buildContextPack({ stable: baseStable });
  const after = buildContextPack({
    stable: [{ ...baseStable[0], text: '我是大肥鱼，身份版本二。' }, baseStable[1]],
  });
  assert.notEqual(after.stable.text, before.stable.text);
  assert.notEqual(after.stable.contentHash, before.stable.contentHash);
  assert.notEqual(after.stable.cacheKey, before.stable.cacheKey);
  assert.equal(after.dynamic.contentHash, before.dynamic.contentHash);
});

test('source revision only invalidates cache identity without changing content', () => {
  const before = buildContextPack({ stable: baseStable, sourceRevisions: { canon: 'r1' } });
  const after = buildContextPack({ stable: baseStable, sourceRevisions: { canon: 'r2' } });
  assert.equal(before.stable.text, expectedStable);
  assert.equal(after.stable.text, expectedStable);
  assert.equal(after.stable.contentHash, before.stable.contentHash);
  assert.notEqual(after.stable.cacheKey, before.stable.cacheKey);
});

// Review proposal: key-order invariance is not a pre-existing documented guarantee.
test('[review proposal] revision-map insertion order preserves semantic cache identity', () => {
  const a = buildContextPack({ stable: baseStable, sourceRevisions: { canon: 'r1', rules: 'r2' } });
  const b = buildContextPack({ stable: baseStable, sourceRevisions: { rules: 'r2', canon: 'r1' } });
  assert.equal(a.stable.contentHash, b.stable.contentHash);
  assert.equal(a.stable.cacheKey, b.stable.cacheKey);
});

test('empty stable hashes stay distinguishable from required nonempty stable content', () => {
  const emptyRounds = [1, 2, 3].map((i) => buildContextPack({ dynamic: [section('d', `轮次 ${i}`)] }));
  assert.equal(new Set(emptyRounds.map((p) => p.stable.contentHash)).size, 1);
  for (const pack of emptyRounds) {
    assert.equal(pack.stable.text, '');
    assert.deepEqual(pack.stable.sections, []);
    assert.notEqual(pack.stable.contentHash, sha256(expectedStable));
  }
});

test('fixed sorting preserves accented identifiers under reversed input', () => {
  const stable = [{ id: 'é', order: 1, text: '甲' }, { id: 'e\u0301', order: 1, text: '乙' }];
  const expected = '## e\u0301\n乙\n\n## é\n甲';
  for (const rows of [stable, [...stable].reverse()]) {
    const pack = buildContextPack({ stable: rows });
    assert.equal(pack.stable.text, expected);
    assert.equal(pack.stable.contentHash, sha256(expected));
  }
});

test('CRLF normalization, explicit ordering and Chinese survive final rendering', () => {
  const pack = buildContextPack({
    stable: [{ ...baseStable[1], text: '先核实来源。\r\n第二条。' }, baseStable[0]],
    dynamic: [section('pulse', '本轮更新 1 条。')],
  });
  assert.equal(pack.stable.text, expectedStable);
  assert.equal(renderPack(pack), `${expectedStable}\n\n## pulse\n本轮更新 1 条。`);
  assert.equal(pack.stable.contentHash, sha256(expectedStable));
});

// These inputs use pure production-format renderers with fixed synthetic data.
// Expectations come from the fixture contract, never from buildContextPack.
for (const sample of samplePacks) {
  test(`representative format preserves coverage, ordering and rendered bytes: ${sample.name}`, () => {
    assert.ok(sample.provenance, 'fixture must identify its source');
    const input = structuredClone(sample.input);
    const expected = `${sample.expectedStableText}\n\n${sample.expectedDynamicText}`;
    const base = buildContextPack(input);
    assert.equal(base.stable.text, sample.expectedStableText);
    assert.equal(base.dynamic.text, sample.expectedDynamicText);
    assert.equal(renderPack(base), expected);
    for (const id of sample.requiredStableIds) assert.ok(base.stable.sections.includes(id), `stable ${id}`);
    for (const id of sample.requiredDynamicIds) assert.ok(base.dynamic.sections.includes(id), `dynamic ${id}`);
    const reversed = buildContextPack({
      ...input, stable: [...input.stable].reverse(), dynamic: [...input.dynamic].reverse(),
    });
    assert.equal(renderPack(reversed), expected);
    assert.equal(reversed.stable.contentHash, sha256(sample.expectedStableText));
    assert.equal(reversed.dynamic.contentHash, sha256(sample.expectedDynamicText));
    const crlf = buildContextPack({
      ...input,
      stable: input.stable.map((s) => ({ ...s, text: s.text.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n') })),
      dynamic: input.dynamic.map((s) => ({ ...s, text: s.text.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n') })),
    });
    assert.equal(renderPack(crlf), expected);
    assert.equal(crlf.stable.contentHash, base.stable.contentHash);
    assert.equal(crlf.dynamic.contentHash, base.dynamic.contentHash);
  });
}
