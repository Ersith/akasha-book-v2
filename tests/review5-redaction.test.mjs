import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), 'akasha-review5-redaction-'));
process.env.AKASHA_ROOT = join(scratch, 'data');
process.env.AKASHA_LOGS = join(scratch, 'logs');
process.env.AKASHA_QUERY_LOG = 'off';
mkdirSync(process.env.AKASHA_ROOT);
mkdirSync(process.env.AKASHA_LOGS);
// Optional baseline import supports a red/green check without editing the clone.
const libFile = process.env.AKASHA_TEST_LIB || join(ROOT, 'core/lib.mjs');
const lib = await import(pathToFileURL(libFile));
const SECRET = 'SYNTHETIC_CREDENTIAL_123456';
const MASK = '[redacted]';

test('V01: Unicode-escaped JSON key, numeric lexemes and whitespace', () => {
  const input = '{ "api_\\u006bey" : "' + SECRET + '", "id":9007199254740993, "n":1.0000000000000001, "e":1e+999, "z":-0 }';
  assert.equal(lib.redact(input), input.replace(SECRET, MASK));
});

test('V01: sensitive key propagates through arrays and objects', () => {
  const input = { Authorization: ['Basic ' + SECRET, { nested: [SECRET] }], token: { primary: SECRET, safeBoolean: false } };
  const expected = { Authorization: [MASK, { nested: [MASK] }], token: { primary: MASK, safeBoolean: false } };
  assert.deepEqual(JSON.parse(lib.redact(JSON.stringify(input))), expected);
  assert.deepEqual(lib.redactDeep(input), expected);
});

test('V01: nested JSON string preserves its numeric lexemes', () => {
  const inner = '{ "api_\\u006bey":"' + SECRET + '", "id":9007199254740993, "x":1.0000000000000001 }';
  const input = JSON.stringify({ payload: JSON.stringify({ payload: inner }) });
  const expected = JSON.stringify({ payload: JSON.stringify({ payload: inner.replace(SECRET, MASK) }) });
  assert.equal(lib.redact(input), expected);
});

test('N01: Authorization text, object and ordinary nested control', () => {
  const value = { headers: [{ Authorization: 'Basic ' + SECRET }], safe: 'preserve' };
  assert.deepEqual(JSON.parse(lib.redact(JSON.stringify(value))), { headers: [{ Authorization: MASK }], safe: 'preserve' });
  assert.equal(lib.redact('Authorization: Basic ' + SECRET), 'Authorization: Basic ' + MASK);
});

test('N02: quoted credentials with escaped quotes and backslashes remain valid JSON', () => {
  const input = JSON.stringify({ password: 'prefix"middle\\' + SECRET, safe: 'quote"slash\\tail' });
  assert.equal(lib.redact(input), JSON.stringify({ password: MASK, safe: 'quote"slash\\tail' }));
  assert.equal(lib.redact('password="prefix\\"middle\\\\' + SECRET + '"'), 'password="[redacted]"');
});

test('Q04: safe JSON stays byte-for-byte identical, including duplicates and escapes', () => {
  const input = '\n {"id":9007199254740993,"id":1.0000000000000001,"x":1e+999,"z":-0,"safe":"\\u4e2d\\/\\t"}\t';
  assert.equal(lib.redact(input), input);
});

test('all duplicate sensitive keys are redacted without collapsing JSON members', () => {
  const input = '{"password":"' + SECRET + '","password":"' + SECRET + '"}';
  assert.equal(lib.redact(input), '{"password":"[redacted]","password":"[redacted]"}');
});

test('R10/R11: placeholder words and safe key names keep meaning', () => {
  const input = { tokenizer: SECRET, token_count_source: SECRET, password_policy: SECRET, secretary: SECRET, token: ['False', 'None', '403'], access_token: 'False' + SECRET };
  const expected = { ...input, access_token: MASK };
  assert.deepEqual(lib.redactDeep(input), expected);
  assert.deepEqual(JSON.parse(lib.redact(JSON.stringify(input))), expected);
});

test('credential text inside JSON string is escaped correctly after replacement', () => {
  const input = JSON.stringify({ note: 'visit https://name:super-secret@host/path; password="' + SECRET + '"' });
  const output = JSON.parse(lib.redact(input));
  assert.equal(output.note, 'visit https://[redacted]:[redacted]@host/path; password="[redacted]"');
});

test('idempotent for JSON and actual objects containing redaction markers', () => {
  const input = { payload: JSON.stringify({ Authorization: [SECRET] }) };
  const once = lib.redactDeep(input);
  assert.deepEqual(lib.redactDeep(once), once);
  const text = lib.redact(JSON.stringify(input));
  assert.equal(lib.redact(text), text);
});

test('ordinary prose, bracketed labels and assignment fallback remain supported', () => {
  assert.equal(lib.redact('[WARNING] retry later'), '[WARNING] retry later');
  assert.equal(lib.redact('[not found] retry later'), '[not found] retry later');
  assert.equal(lib.redact('[todo] retry later'), '[todo] retry later');
  assert.equal(lib.redact('a prose {fragment}'), 'a prose {fragment}');
  assert.equal(lib.redact('token=' + SECRET), 'token=' + MASK);
});

test('complete credential values remain masked when outer JSON is truncated or malformed', () => {
  for (const input of ['{"api_\\u006bey":"' + SECRET + '"', '[{"Authorization":["' + SECRET + '"]},]']) {
    const output = lib.redact(input);
    assert.equal(output.includes(SECRET), false);
    assert(output.includes(MASK));
  }
});

test('nesting limit is explicit and does not fall back to unredacted input', () => {
  const input = '['.repeat(70) + '{"api_\\u006bey":"' + SECRET + '"}' + ']'.repeat(70);
  assert.throws(() => lib.redact(input), (error) => error.code === 'AKASHA_REDACTION_LIMIT' && !error.message.includes(SECRET));
  let object = { api_key: SECRET };
  for (let i = 0; i < 70; i++) object = { value: object };
  assert.throws(() => lib.redactDeep(object), { code: 'AKASHA_REDACTION_LIMIT' });
});

test('cyclic object fails explicitly without stack overflow', () => {
  const object = {};
  object.self = object;
  assert.throws(() => lib.redactDeep(object), { code: 'AKASHA_REDACTION_CYCLE' });
});

test('work and node limits fail explicitly, including otherwise harmless input', () => {
  assert.throws(() => lib.redact('x'.repeat(8 * 1024 * 1024 + 1)), { code: 'AKASHA_REDACTION_LIMIT' });
  assert.throws(() => lib.redact('[' + 'null,'.repeat(100000) + 'null]'), { code: 'AKASHA_REDACTION_LIMIT' });
});

test('malformed credential values produce a visible conservative mask', () => {
  for (const input of ['{"api_key":"\\uZZZZ' + SECRET + '"}', 'prefix {"api_\\u006bey":"' + SECRET, '{"Authorization":["' + SECRET + '",broken]}']) {
    assert.equal(lib.redact(input).includes(SECRET), false);
    assert(lib.redact(input).includes('[redacted-invalid-json]'));
  }
  assert.equal(lib.redact('prefix {"api_key":"[redac'), 'prefix [redacted-invalid-json]');
});

test('sensitive primitive prefixes require JSON token boundaries', () => {
  for (const prefix of ['null', 'false', 'true', '123456', '1.5', '1e2']) {
    for (const input of ['{"api_key":' + prefix + SECRET + '}', 'fragment "api_\\u006bey":' + prefix + SECRET]) {
      const output = lib.redact(input);
      assert.equal(output.includes(SECRET), false);
      assert(output.includes('[redacted-invalid-json]'));
    }
    const valid = '{"api_key":' + prefix + '}';
    assert.equal(lib.redact(valid), valid);
  }
});

test('standalone key definitions in prose keep their following explanation', () => {
  const input = '参数 "token": 表示词元数量，不是访问凭据。后续正文应该保留。';
  assert.equal(lib.redact(input), input);
  assert.equal(lib.redact(JSON.stringify({ note: input })), JSON.stringify({ note: input }));
  assert.equal(lib.redact('{"token":' + SECRET + '}'), '[redacted-invalid-json]');
});

test('root JSON strings, escaped credential values and primitive arrays are supported', () => {
  const inner = '{"api_key":"\\u0053YNTHETIC_CREDENTIAL_123456","n":9007199254740993}';
  assert.equal(lib.redact(JSON.stringify(inner)), JSON.stringify('{"api_key":"[redacted]","n":9007199254740993}'));
  assert.equal(lib.redact('[true,false,null,-0,1e+999,1.0000000000000001]'), '[true,false,null,-0,1e+999,1.0000000000000001]');
});

test('shared subobjects are allowed and are redacted according to each parent context', () => {
  const shared = { value: SECRET };
  assert.deepEqual(lib.redactDeep({ token: shared, safe: shared }), { token: { value: MASK }, safe: { value: SECRET } });
});

test('own __proto__ member is preserved as data and its descendants redacted', () => {
  const input = JSON.parse('{"__proto__":{"api_key":"' + SECRET + '"},"safe":"value"}');
  const output = lib.redactDeep(input);
  assert.equal(Object.getPrototypeOf(output), Object.prototype);
  assert.equal(Object.hasOwn(output, '__proto__'), true);
  assert.equal(output.__proto__.api_key, MASK);
});

test('mixed prose, quotations, list markers and fenced JSON preserve ordinary text', () => {
  for (const text of ['"Use the cache" means retain the result.', '[1] retain the result.', '[note] retain the result.']) {
    assert.equal(lib.redact(text), text);
    assert.equal(lib.redact(JSON.stringify({ note: text })), JSON.stringify({ note: text }));
  }
  const json = '{"api_\\u006bey":"' + SECRET + '","n":9007199254740993}';
  for (const wrap of [x => 'Debug: ' + x + ' done.', x => '```json\n' + x + '\n```', x => 'first ' + x + ' second ' + x]) {
    assert.equal(lib.redact(wrap(json)), wrap(json.replace(SECRET, MASK)));
  }
});

test('credential-shaped JSON keys still use the text policy, including escaped keys', () => {
  for (const key of ['ghp_AAAAAAAAAAAAAAAAAAAA', 'ghp_\\u0041AAAAAAAAAAAAAAAAAAA']) {
    assert.equal(lib.redact('{"' + key + '":"value","id":9007199254740993}'), '{"ghp_[redacted]":"value","id":9007199254740993}');
  }
});

test('valid stored JSON and truncated masked credentials remain retrievable', () => {
  for (const store of lib.STORES) writeFileSync(lib.storePath(store), '');
  const source = { type: '官方', ref: 'synthetic' };
  lib.appendRecord('canon', { id: 'canon-plain-json', claim: '{"kind":"evidence","note":"alpha"}', source, last_reviewed: '2026-10-14' });
  for (let n = 80; n < 125; n += 5) {
    const claim = JSON.stringify({ text: 'alpha ' + 'x'.repeat(n), api_key: SECRET, after: 'tail'.repeat(100) });
    lib.appendRecord('canon', { id: 'canon-json-' + n, claim, source, last_reviewed: '2026-10-14' });
  }
  const result = lib.lookupDetailed('alpha', { contextBudget: false, __noQueryLog: true });
  assert.equal(result.hits.length, 10);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test('redaction module participates in generation staleness detection', async () => {
  const copied = join(scratch, 'generation-core'); mkdirSync(copied);
  for (const file of ['lib.mjs', 'json-redaction.mjs']) copyFileSync(join(dirname(libFile), file), join(copied, file));
  const loaded = await import(pathToFileURL(join(copied, 'lib.mjs')));
  assert.equal(loaded.generationInfo().stale_on_disk, false);
  const file = join(copied, 'json-redaction.mjs'), before = statSync(file);
  utimesSync(file, before.atime, new Date(before.mtimeMs + 2000));
  assert.equal(loaded.generationInfo().stale_on_disk, true);
});

test('MCP persists structured masks and exact numbers; resource-limit write is rejected atomically', () => {
  for (const store of lib.STORES) writeFileSync(lib.storePath(store), '');
  lib.appendRecord('canon', { id: 'canon-review5', claim: 'initial', source: { type: '官方', ref: 'synthetic' }, last_reviewed: '2026-10-14' });
  const claim = '{"api_\\u006bey":"' + SECRET + '","id":9007199254740993,"x":1.0000000000000001}';
  const note = JSON.stringify({ headers: { Authorization: ['Basic ' + SECRET] } });
  const payload = JSON.stringify({ payload: JSON.stringify({ api_key: SECRET }) });
  function call(patch, id = 'canon-review5') {
    const child = spawnSync(process.execPath, [join(dirname(libFile), 'mcp.mjs')], {
      env: process.env, encoding: 'utf8', timeout: 10000,
      input: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'akasha_revise', arguments: { store: 'canon', id, patch } } }) + '\n',
    });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  }
  const success = call({ claim, note, payload });
  assert.equal(success.error, undefined);
  assert.notEqual(success.result.isError, true);
  const persisted = lib.loadStore('canon').records.at(-1);
  assert.equal(persisted.claim, claim.replace(SECRET, MASK));
  assert.deepEqual(JSON.parse(persisted.note), { headers: { Authorization: [MASK] } });
  assert.equal(JSON.parse(JSON.parse(persisted.payload).payload).api_key, MASK);
  assert.equal(readFileSync(lib.storePath('canon'), 'utf8').includes(SECRET), false);
  const malformed = call({ claim: 'prefix {"api_\\u006bey":"' + SECRET }, persisted.id);
  assert.notEqual(malformed.result?.isError, true);
  assert.equal(lib.loadStore('canon').records.at(-1).claim, 'prefix [redacted-invalid-json]');
  const before = readFileSync(lib.storePath('canon'), 'utf8');
  const failure = call({ claim: '['.repeat(70) + '{"api_key":"' + SECRET + '"}' + ']'.repeat(70) }, lib.loadStore('canon').records.at(-1).id);
  assert.ok(failure.error || failure.result?.isError);
  assert.equal(JSON.stringify(failure).includes(SECRET), false);
  assert.equal(readFileSync(lib.storePath('canon'), 'utf8'), before);
});
