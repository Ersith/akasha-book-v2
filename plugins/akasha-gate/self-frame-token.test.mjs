import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import SystemPrompt, { renderPrompt, renderContextSections } from '@deepseek-ai/dsh-system-prompt';
import { apply, selfContributionFor } from './index.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const core = path.resolve(root, '..', 'akasha');
const ORIGINAL_ENV = { AKASHA_ROOT: process.env.AKASHA_ROOT, AKASHA_LOGS: process.env.AKASHA_LOGS };
const fixtures = [];
afterEach(() => {
  for (const dir of fixtures.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  if (ORIGINAL_ENV.AKASHA_ROOT === undefined) delete process.env.AKASHA_ROOT; else process.env.AKASHA_ROOT = ORIGINAL_ENV.AKASHA_ROOT;
  if (ORIGINAL_ENV.AKASHA_LOGS === undefined) delete process.env.AKASHA_LOGS; else process.env.AKASHA_LOGS = ORIGINAL_ENV.AKASHA_LOGS;
});
const rows = (text) => [
  { id: 'i', kind: 'identity', semanticKey: 'identity', claim: `I am ${text}`, revision: 'r1' },
  { id: 'a', kind: 'address', semanticKey: 'address', claim: 'Call Master', revision: 'r1' },
];
function setup(coreDir = core) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akasha-gate-assemble-'));
  fixtures.push(dir);
  process.env.AKASHA_ROOT = dir;
  process.env.AKASHA_LOGS = path.join(dir, 'logs');
  const canon = path.join(dir, 'canon.jsonl');
  const save = (text) => fs.writeFileSync(canon, rows(text).map((r) => JSON.stringify(r)).join('\n') + '\n');
  save('ALPHA');
  const sp = new SystemPrompt(new Context(), { includeHarnessIdentity: false });
  const sections = [];
  const section = sp.section.bind(sp);
  sp.section = (s) => { sections.push(s); return section(s); };
  const loop = {};
  apply({ get: (name) => name === 'agentLoop' ? loop : undefined, systemPrompt: sp, tools: { guard() {} }, on() {} },
    { akashaDir: coreDir, dataDir: dir, log: path.join(dir, 'hooks.jsonl') });
  assert.equal(loop.selfContinuityEnabled, true);
  return { sp, loop, sections, canon, save, dir };
}
const isReason = (reason) => (e) => e.code === 'AKASHA_SELF_FRAME_UNAVAILABLE' && e.reasons.includes(reason);

test('immediate actual assembly awaits loading; same token pins complete contribution', async () => {
  const h = setup(), token = {};
  const first = await h.sp.assemble({ selfStep: token });
  const rendered = renderPrompt(first);
  assert.match(rendered, /I am ALPHA/);
  const original = h.loop.selfContributionProvider(token);
  assert.ok(original.frame.frameId);
  assert.equal(original.body, original.frame.projection.cardText, 'body 必须等于实际发送的自我卡');
  assert.ok(original.body.length <= 600, '自我卡硬上限 600 字符');
  assert.equal(original.sectionText.slice(original.start, original.end), original.body, 'sectionText 切片必须回到正文');
  assert.equal(rendered.slice(original.systemStart + original.start, original.systemStart + original.end), original.body, '真实组装文本的 systemStart 偏移必须回到正文');
  assert.equal(h.loop.selfContributionProvider({}), undefined, '未知 token 不得交付 contribution');
  h.save('BETA');
  const same = await h.sp.assemble({ selfStep: token });
  assert.equal(h.loop.selfContributionProvider(token).frame.frameId, original.frame.frameId);
  assert.match(JSON.stringify(renderContextSections(h.sp.refreshContext(same, { selfStep: token }))), /I am ALPHA/);
  const betaToken = {};
  await h.sp.assemble({ selfStep: betaToken });
  assert.match(renderPrompt(await h.sp.assemble({ selfStep: {} })), /I am BETA/);
  assert.match(JSON.stringify(renderContextSections(h.sp.refreshContext(same, { selfStep: betaToken }))), /I am BETA/);
});

test('transient early loading does not poison token; actual assembly with same token succeeds', async () => {
  const h = setup(), token = {};
  assert.throws(() => h.sections.find((s) => s.name === 'akasha:self').text({ selfStep: token }), isReason('loading'));
  assert.equal(selfContributionFor(token), undefined);
  assert.match(renderPrompt(await h.sp.assemble({ selfStep: token })), /I am ALPHA/);
  assert.ok(h.loop.selfContributionProvider(token));
});

test('failed source capture remains failed for same token; new token captures recovered source', async () => {
  const h = setup(), token = {};
  fs.writeFileSync(h.canon, '{broken\n');
  await assert.rejects(h.sp.assemble({ selfStep: token }), isReason('projection-failed'));
  assert.equal(selfContributionFor(token), undefined);
  h.save('RECOVERED');
  await assert.rejects(h.sp.assemble({ selfStep: token }), isReason('projection-failed'));
  assert.equal(selfContributionFor(token), undefined);
  assert.match(renderPrompt(await h.sp.assemble({ selfStep: {} })), /I am RECOVERED/);
});

test('benign brace text is sanitized inside the frame and still yields an exact contribution', async () => {
  const h = setup(), token = {};
  h.save('{{name}}ALPHA');
  await h.sp.assemble({ selfStep: token });
  const contribution = selfContributionFor(token);
  assert.ok(contribution, 'sanitized text must not reject the assembly');
  assert.ok(!contribution.body.includes('{{'), 'no raw brace anchor');
  assert.ok(contribution.body.length <= 600);
  assert.equal(contribution.sectionText.slice(contribution.start, contribution.end), contribution.body);
});

test('missing core rejects token-managed assembly but tokenless old-host path preserves fallback', async () => {
  const h = setup(path.join(root, 'missing-core'));
  await assert.rejects(h.sp.assemble({ selfStep: {} }), isReason('module-load-failed'));
  const old = await h.sp.assemble({});
  assert.match(renderPrompt(old), /暂不可读/);
  assert.match(JSON.stringify(renderContextSections(h.sp.refreshContext(old, {}))), /我是大肥鱼/);
});

// The send boundary validates the bounded self card, not the full stable history.
// Both selection and summary are finalized inside the frame before assembly.
for (const cardCase of ['available', 'overflow']) {
  test(`bounded self card survives ${cardCase} assembly`, async () => {
    const h = setup(), token = {};
    const identity = cardCase === 'overflow' ? 'Synthetic identity fact. '.repeat(45) : 'ALPHA';
    const records = [
      ...rows(identity),
      { id: 'p', kind: 'principle', semanticKey: 'principle', claim: 'Synthetic continuity fact. '.repeat(55), revision: 'r1' },
    ];
    fs.writeFileSync(h.canon, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
    const assembly = await h.sp.assemble({ selfStep: token });
    const rendered = renderPrompt(assembly);
    const contribution = h.loop.selfContributionProvider(token);
    assert.ok(contribution, 'accepted assembly must expose its same-token contribution');
    const projection = contribution.frame.projection;
    assert.ok(projection.stableText.length > 600, 'fixture must exceed the display-card budget');
    if (cardCase === 'available') {
      assert.ok(projection.cardText.length > 0, 'fixture must exercise non-empty cardText');
      assert.ok(projection.cardText.length < projection.stableText.length);
      assert.equal(contribution.body, projection.cardText, 'available card must be sent as-is');
    } else {
      assert.ok(projection.cardText.length > 0, 'summary must be finalized in the frame');
      assert.equal(projection.cardStatus, 'summary');
      assert.ok(contribution.body.length <= 600, 'overflow summary must stay within 600 chars');
      assert.notEqual(contribution.body, projection.stableText, 'the stable source remains complete');
      assert.equal(contribution.body, projection.cardText, 'no post-frame fallback may replace the card');
    }
    assert.equal(contribution.view, 'selfCard');
    assert.equal(contribution.frame.renderPolicy.selfView, 'selfCard');
    assert.equal(contribution.sectionText.slice(contribution.start, contribution.end), contribution.body);
    assert.equal(rendered.slice(contribution.systemStart + contribution.start, contribution.systemStart + contribution.end), contribution.body,
      'the exact assembled range sent downstream must match the self card');
  });
}
