import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectSelf, writeProjectionCache, readProjectionCache } from './self-loader.mjs';

const base = () => [
  { id: 'identity', kind: 'identity', claim: 'Test identity', revision: 'v1' },
  { id: 'address', kind: 'address', claim: 'Test address', revision: 'v1' },
];
function fixture(t, rows, raw) {
  const dir = mkdtempSync(join(tmpdir(), 'self-runtime-compat-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const canonFile = join(dir, 'canon.jsonl');
  writeFileSync(canonFile, raw ?? rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  return { canonFile, cacheFile: join(dir, 'cache.json') };
}

test('mixed input excludes ordinary knowledge while retaining both self assertions', t => {
  const paths = fixture(t, [...base(), { id: 'knowledge', claim: 'Ordinary knowledge', tags: ['工具'] }]);
  const before = readFileSync(paths.canonFile);
  const { projection } = projectSelf({ ...paths, inputMode: 'mixed-canon' });
  assert.equal(projection.status, 'ok');
  assert.deepEqual(projection.entries.map(e => e.id).sort(), ['address', 'identity']);
  assert.deepEqual(readFileSync(paths.canonFile), before);
});

test('optional short card cannot reject a valid complete stable identity', t => {
  const rows = base(); rows[0].claim = 'I'.repeat(700);
  const paths = fixture(t, rows);
  const { projection } = projectSelf({ ...paths, inputMode: 'mixed-canon', cardOverflow: 'omit', maxStableChars: 8192, maxCardChars: 600 });
  assert.equal(projection.status, 'degraded');
  assert.equal(projection.cardStatus, 'unavailable');
  assert.equal(projection.cardText, '');
  assert.deepEqual(projection.selectedCardIds, []);
  assert.ok(projection.stableText.includes(rows[0].claim));
  assert.deepEqual(projection.selectedStableIds.sort(), ['address', 'identity']);
});

test('strict default retains rejection when required card exceeds its budget', t => {
  const rows = base(); rows[0].claim = 'I'.repeat(700);
  const { projection } = projectSelf(fixture(t, rows));
  assert.equal(projection.status, 'failed');
  assert.ok(projection.warnings.includes('card 必需内容超预算'));
});

test('optional card never permits stable identity overflow', t => {
  const rows = base(); rows[0].claim = 'I'.repeat(9000);
  const { projection } = projectSelf({ ...fixture(t, rows), inputMode: 'mixed-canon', cardOverflow: 'omit', maxStableChars: 8192 });
  assert.equal(projection.status, 'failed');
});

test('mixed input preserves broken reference failure before filtering ordinary records', t => {
  const { projection } = projectSelf({ ...fixture(t, [...base(), { id: 'knowledge', claim: 'Ordinary', supersedes: 'missing' }]), inputMode: 'mixed-canon', cardOverflow: 'omit' });
  assert.equal(projection.status, 'failed');
});

test('invalid source JSON remains unavailable in mixed mode', t => {
  const { source, projection } = projectSelf({ ...fixture(t, null, '{broken}\n'), inputMode: 'mixed-canon', cardOverflow: 'omit' });
  assert.equal(source.errors.length, 1);
  assert.equal(projection.status, 'failed');
});

test('optional card cache roundtrip preserves status and detects budget tampering', t => {
  const rows = base(); rows[0].claim = 'I'.repeat(700);
  const paths = fixture(t, rows);
  const { source, projection } = projectSelf({ ...paths, inputMode: 'mixed-canon', cardOverflow: 'omit' });
  assert.equal(projection.status, 'degraded');
  assert.equal(writeProjectionCache({ ...paths, source, projection }).status, 'written');
  const options = { cacheFile: paths.cacheFile, generation: source.generation, subjectId: projection.subjectId, policyVersion: projection.policyVersion };
  assert.equal(readProjectionCache(options).status, 'fresh');
  const bytes = readFileSync(paths.cacheFile, 'utf8');
  const cache = JSON.parse(bytes);
  cache.projection.budgetPolicy.maxCardChars = 1000;
  writeFileSync(paths.cacheFile, JSON.stringify(cache));
  assert.equal(readProjectionCache(options).status, 'corrupt');
  writeFileSync(paths.cacheFile, bytes);
  const altered = JSON.parse(bytes); altered.projection.cardStatus = 'ok';
  writeFileSync(paths.cacheFile, JSON.stringify(altered));
  assert.equal(readProjectionCache(options).status, 'corrupt');
});

test('unknown input mode is rejected rather than silently interpreted as strict self', t => {
  assert.throws(() => projectSelf({ ...fixture(t, base()), inputMode: 'mixed-typo' }), /inputMode/);
});
