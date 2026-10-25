import assert from 'node:assert/strict';
import { buildContextPack, renderPack, estimateTokens } from './context-pack.mjs';

const stable = [
  { id: 'self', order: 1, text: '我是大肥鱼。' },
  { id: 'rules', order: 2, text: '零编造；先注册判据再读数据。' },
];
const dyn = [
  { id: 'pulse', order: 2, text: '库脉搏：canon 1 / mirror 0。' },
  { id: 'time', order: 1, text: '当前时间：2026-10-20 20:50。' },
];

// 1. 稳定段与输入顺序无关（显式唯一 id/order）
const a = buildContextPack({ stable, dynamic: dyn, maxTokens: 500 });
const b = buildContextPack({ stable: [...stable].reverse(), dynamic: [...dyn].reverse(), maxTokens: 500 });
assert.equal(a.stable.hash, b.stable.hash);
assert.equal(a.packHash, b.packHash);
assert.ok(a.stable.text.indexOf('我是大肥鱼') < a.stable.text.indexOf('零编造'));

// 2. 动态变化不改稳定 hash；来源版本变化改 cacheKey 但不改正文 hash
const c = buildContextPack({ stable, dynamic: [...dyn, { id: 'sleep', order: 3, text: '睡眠摘要：x' }], maxTokens: 500 });
assert.equal(a.stable.hash, c.stable.hash);
assert.notEqual(a.dynamic.hash, c.dynamic.hash);
const d = buildContextPack({ stable, dynamic: dyn, maxTokens: 500, sourceRevisions: { canon: 'r2' } });
assert.equal(a.stable.hash, d.stable.hash);
assert.notEqual(a.stable.cacheKey, d.stable.cacheKey);
assert.equal(a.asOf, null);

// 3. stable 中的脉搏/时间行拒绝；section.volatile 也拒绝；可显式放行
assert.throws(() => buildContextPack({ stable: [{ id: 'bad', order: 1, text: '库脉搏：canon 1' }], dynamic: [] }), /易变/);
assert.throws(() => buildContextPack({ stable: [{ id: 'bad', order: 1, text: 'x', volatile: true }], dynamic: [] }), /易变/);
assert.doesNotThrow(() => buildContextPack({ stable: [{ id: 'bad', order: 1, text: '讨论“库脉搏字段”的规则' }], dynamic: [], allowVolatileStable: true }));

// 4. 预算只裁动态，稳定段完整；断言真实上限
const e = buildContextPack({ stable, dynamic: [
  { id: 'd1', order: 1, text: 'x'.repeat(400) },
  { id: 'd2', order: 2, text: 'y'.repeat(400) },
], maxTokens: 150 });
assert.deepEqual(e.stable.sections, ['self', 'rules']);
assert.ok(e.dynamic.omitted.length >= 1);
assert.ok(e.totalTokens <= 150);

// 5. 输入/预算严格校验
assert.throws(() => buildContextPack({ stable, dynamic: [], maxTokens: NaN }), /maxTokens/);
assert.throws(() => buildContextPack({ stable, dynamic: [], maxTokens: -1 }), /maxTokens/);
assert.throws(() => buildContextPack({ stable, dynamic: [], maxTokens: 'bad' }), /maxTokens/);
assert.throws(() => buildContextPack(42), /root/);
assert.throws(() => buildContextPack([]), /root/);
assert.throws(() => buildContextPack({ stable: null }), /stable/);
assert.throws(() => buildContextPack({ dynamic: null }), /dynamic/);
assert.throws(() => buildContextPack({ stable: [{ id: 'must', order: 1, text: ' \r\n ', required: true }] }), /required section/);
assert.throws(() => buildContextPack({ stable: 'bad', dynamic: [] }), /stable/);
assert.throws(() => buildContextPack({ stable: [{ id: 'a', order: 1 }], dynamic: [] }), /text/);
assert.throws(() => buildContextPack({ stable: [{ id: 'a', order: 1, text: 1 }], dynamic: [] }), /text/);
assert.throws(() => buildContextPack({ stable: [{ id: 'a', order: 1, text: 'x' }, { id: 'a', order: 2, text: 'y' }], dynamic: [] }), /重复/);
assert.throws(() => buildContextPack({ stable: [{ id: 'a', text: 'x' }], dynamic: [] }), /order/);
assert.throws(() => buildContextPack({ stable: [], dynamic: [], maxStableTokens: -1 }), /maxStableTokens/);
assert.throws(() => buildContextPack({ stable: [], dynamic: [], sourceRevisions: [] }), /sourceRevisions/);
assert.throws(() => buildContextPack({ stable: [], dynamic: [], allowVolatileStable: 'false' }), /allowVolatileStable/);
assert.throws(() => buildContextPack({ stable: [{ id: 'big', order: 1, text: '中'.repeat(20) }], dynamic: [], maxTokens: 10 }), /超预算/);

// 6. 必需动态段不能静默丢
assert.throws(() => buildContextPack({ stable, dynamic: [{ id: 'must', order: 1, text: 'x'.repeat(1000), required: true }], maxTokens: 50 }), /必需段超预算/);

// 7. 渲染与估算
assert.ok(renderPack(a).includes('我是大肥鱼'));
assert.ok(renderPack(a).includes('当前时间'));
assert.ok(estimateTokens('中文') >= 2);

// 8. 元数据保留在 sectionMeta，不混入正文
const f = buildContextPack({ stable: [{ id: 'self', order: 1, text: 'x', source: { kind: 'canon', id: 'c1' } }], dynamic: [] });
assert.deepEqual(f.stable.sectionMeta[0].source, { kind: 'canon', id: 'c1' });
assert.ok(!f.stable.text.includes('canon'));

// 9. sourceRevisions 键序不影响 cacheKey；显式 volatile 放行仍留 warning
const g1 = buildContextPack({ stable, dynamic: [], sourceRevisions: { a: '1', b: '2' } });
const g2 = buildContextPack({ stable, dynamic: [], sourceRevisions: { b: '2', a: '1' } });
assert.equal(g1.stable.cacheKey, g2.stable.cacheKey);
const w = buildContextPack({ stable: [{ id: 'v', order: 1, text: 'x', volatile: true }], dynamic: [], allowVolatileStable: true });
assert.ok(w.warnings.some((x) => x.includes('volatile')));

console.log('context-pack tests: ok');
