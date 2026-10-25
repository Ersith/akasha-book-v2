// Release contract: the real gate, official prompt assembler and maintained host
// carrier/resolver/fence must agree. Only the final network sender is replaced.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt';

const here = path.dirname(fileURLToPath(import.meta.url));
const host = process.env.AKASHA_HOST_TEST_DIR || path.resolve(here, '..', 'self-card-runtime');
const gatePath = process.env.AKASHA_GATE_TEST_DIR || here;
const core = path.resolve(here, '..', 'akasha');
const gate = await import(pathToFileURL(path.join(gatePath, 'index.js')));
const { attachSelfContribution, markSelfManagedRequest, selfContributionOf, transferSelfContribution, transferSelfManagedRequest } = await import(pathToFileURL(path.join(host, 'self-contribution-carrier.mjs')));
const { createSelfPayloadMapper, selfPayloadStateFromCarrier } = await import(pathToFileURL(path.join(host, 'self-payload-resolver.mjs')));
const { sendFenced } = await import(pathToFileURL(path.join(host, 'self-payload-adapter.mjs')));
const originalEnv = { AKASHA_ROOT: process.env.AKASHA_ROOT, AKASHA_LOGS: process.env.AKASHA_LOGS };
const fixtures = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
const row = (id, kind, claim) => ({ id, kind, semanticKey: id, claim, revision: 'r1' });
const short = [row('identity', 'identity', 'I am the test assistant.'), row('address', 'address', 'Call the user Master.')];
const scenarios = {
  available: [...short, row('principle', 'principle', 'A synthetic continuity fact. '.repeat(55))],
  overflow: [row('identity', 'identity', 'A synthetic identity fact. '.repeat(45)), row('address', 'address', 'A synthetic address fact. '.repeat(45)), row('principle', 'principle', 'A synthetic continuity fact. '.repeat(55))],
  short,
};
async function setup(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akasha-card-contract-'));
  fixtures.push(dir);
  process.env.AKASHA_ROOT = dir;
  process.env.AKASHA_LOGS = path.join(dir, 'logs');
  fs.writeFileSync(path.join(dir, 'canon.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
  const sp = new SystemPrompt(new Context(), { includeHarnessIdentity: false });
  const loop = {};
  const machine = {};
  gate.apply({ get: name => name === 'agentLoop' ? loop : undefined, systemPrompt: sp, tools: { guard() {} }, on() {} },
    { akashaDir: core, dataDir: dir, log: path.join(dir, 'hooks.jsonl') });
  machine.selfContributionProvider = loop.selfContributionProvider;
  const token = {};
  const assembly = await sp.assemble({ selfStep: token, agent: machine });
  const system = renderPrompt(assembly);
  const contribution = machine.selfContributionProvider(token);
  assert.ok(contribution);
  const request = markSelfManagedRequest({});
  attachSelfContribution(request, { ...contribution, sourceMessageId: 'contract-system' });
  const copied = {};
  transferSelfContribution(request, copied);
  transferSelfManagedRequest(request, copied);
  const message = { id: 'contract-system', role: 'system', content: [{ type: 'text', text: system }] };
  return { system, contribution, request: copied, message };
}
async function send(h, layout = 'root', mutate = value => value) {
  const mapper = createSelfPayloadMapper(h.request, [h.message]);
  let body;
  if (layout === 'root') {
    mapper.recordRoot(h.message);
    body = { system: h.system, messages: [] };
  } else {
    const update = { role: 'system', content: [{ type: 'text', text: h.system }] };
    mapper.recordUpdate(h.message, update);
    body = { messages: [{ role: 'user', content: [{ type: 'text', text: 'a quoted decoy' }] }, update] };
  }
  const location = mapper.finish(body);
  const state = selfPayloadStateFromCarrier(h.request, location);
  let sends = 0;
  let error;
  try {
    await sendFenced({ request: h.request, state, payload: JSON.stringify(mutate(body)), required: true,
      send: bytes => { sends++; assert.ok(Buffer.isBuffer(bytes)); return 'sent'; } });
  } catch (e) { error = e; }
  return { sends, error, state };
}

for (const name of Object.keys(scenarios)) {
  for (const layout of ['root', 'update']) {
    test(`managed ${name} card reaches the final sender through ${layout} layout`, async () => {
      const h = await setup(scenarios[name]);
      const result = await send(h, layout);
      assert.equal(result.error, undefined, result.error?.message);
      assert.equal(result.sends, 1);
      assert.equal(result.state.mapping[0].view, 'selfCard');
      assert.deepEqual(result.state.requiredViews, ['selfCard']);
      assert.equal(selfContributionOf(h.request).view, 'selfCard');
      assert.equal(h.contribution.body, h.contribution.frame.projection.cardText);
      assert.ok(h.contribution.body.length > 0 && h.contribution.body.length <= 600);
      if (name !== 'short') assert.notEqual(h.contribution.body, h.contribution.frame.projection.stableText);
    });
  }
}
test('post-mapping card mutation is rejected before the sender', async () => {
  const h = await setup(scenarios.overflow);
  const result = await send(h, 'root', body => ({ ...body, system: body.system.replace(h.contribution.body, 'altered') }));
  assert.equal(result.sends, 0);
  assert.equal(result.error?.code, 'AKASHA_SELF_PAYLOAD_REJECTED');
});
test('a missing contribution stays rejected even when user text quotes the whole card', async () => {
  const h = await setup(scenarios.short);
  const request = markSelfManagedRequest({});
  assert.throws(() => createSelfPayloadMapper(request, [{ ...h.message, role: 'user' }]), e => e.code === 'AKASHA_SELF_PAYLOAD_REJECTED' && e.reasons.includes('carrier-missing'));
});
test('legacy compact card stays bounded with long source identifiers', () => {
  const card = gate.compactSelfCard([
    row('i'.repeat(350), 'identity', 'I am the test assistant.'),
    row('a'.repeat(350), 'address', 'Call the user Master.'),
  ]);
  assert.ok(card.length > 0 && card.length <= 600, `card length ${card.length}`);
  assert.match(card, /test assistant/);
  assert.match(card, /Master/);
});
