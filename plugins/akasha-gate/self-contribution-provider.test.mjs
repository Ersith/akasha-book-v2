import test from 'node:test';
import assert from 'node:assert/strict';
import { Context, Service } from '@deepseek-ai/cordis';
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import { createSelfContributionProvider } from './self-contribution-provider.mjs';

const contribution = text => Object.freeze({
  frame: Object.freeze({ frameId: text }), frameId: text,
  body: text, start: 0, end: text.length, sectionText: text,
});
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
function setup() {
  const ctx = new Context();
  const raw = new SystemPrompt(ctx, { includeHarnessIdentity: false });
  const sp = ctx.systemPrompt;
  let current;
  let failed = false;
  sp.section({ name: 'akasha:self', order: 1, text(context) {
    if (failed) throw new Error('synthetic renderer rejected');
    const value = contribution(current.label);
    current.values.set(context.selfStep, value);
    return value.sectionText;
  } });
  class TestAgent extends Service {
    constructor() { super(ctx, 'bridgeTestAgent'); }
  }
  const rawAgent = new TestAgent();
  const agent = ctx.bridgeTestAgent;
  function install(label) {
    const values = new WeakMap();
    const before = [];
    const provider = createSelfContributionProvider({
      systemPrompt: sp,
      contributionFor: token => values.get(token),
      beforeAssemble: context => { before.push(context.selfStep); },
      afterAssemble: context => {
        if (context.selfStep && context.agent) {
          context.agent.selfContributionProvider = provider;
          context.agent.selfContinuityEnabled = true;
        }
      },
    });
    current = { label, values, provider };
    return { provider, values, before };
  }
  return { ctx, raw, sp, rawAgent, agent, install, fail: value => { failed = value; } };
}

test('keeps token-specific rendered interpolation offsets', async () => {
  const sp = { assemble: async ctx => ({ sections: [
    { name: 'a', text: '{{prefix}}' }, { name: 'akasha:self', text: 'SELF' },
  ], variables: { prefix: ctx.prefix } }) };
  const provider = createSelfContributionProvider({ systemPrompt: sp, contributionFor: () => contribution('SELF') });
  const a = { selfStep: {}, prefix: 'P' };
  const b = { selfStep: {}, prefix: 'LONGER' };
  await sp.assemble(a);
  await sp.assemble(b);
  assert.equal(provider(a.selfStep).systemStart, 3);
  assert.equal(provider(b.selfStep).systemStart, 8);
});

test('accepted real SystemPrompt binds the raw agent behind a Cordis proxy', async () => {
  const h = setup();
  h.rawAgent.selfContributionProvider = () => undefined;
  h.install('NEW');
  const token = {};
  const assembly = await h.sp.assemble({ agent: h.agent, selfStep: token });
  assert.equal(renderPrompt(assembly), 'NEW');
  assert.equal(h.rawAgent.selfContributionProvider(token).body, 'NEW');
  assert.equal(h.agent.selfContributionProvider(token).systemStart, 0);
  assert.equal(h.rawAgent.selfContinuityEnabled, true);
});

test('accepted token can be read repeatedly and unknown token stays absent', async () => {
  const h = setup();
  const one = h.install('ONE');
  const token = {};
  await h.sp.assemble({ agent: h.agent, selfStep: token });
  assert.deepEqual(one.provider(token), one.provider(token));
  assert.equal(one.provider({}), undefined);
});

test('failed assembly never binds its provider and prior accepted token stays readable', async () => {
  const h = setup();
  const one = h.install('OLD');
  const oldToken = {};
  await h.sp.assemble({ agent: h.agent, selfStep: oldToken });
  const prior = h.rawAgent.selfContributionProvider;
  const next = h.install('NEW');
  h.fail(true);
  await assert.rejects(h.sp.assemble({ agent: h.agent, selfStep: {} }), /synthetic renderer rejected/);
  assert.equal(h.rawAgent.selfContributionProvider, prior);
  assert.equal(one.provider(oldToken).body, 'OLD');
  assert.equal(next.provider({}), undefined);
});

test('three successive wrapper layers bind the newest accepted provider', async () => {
  const h = setup();
  h.install('ONE');
  h.install('TWO');
  h.install('THREE');
  const token = {};
  await h.sp.assemble({ agent: h.agent, selfStep: token });
  assert.equal(h.rawAgent.selfContributionProvider(token).body, 'THREE');
});

test('independent Cordis environments do not share providers even for the same token', async () => {
  const a = setup();
  const b = setup();
  a.install('A');
  b.install('B');
  const token = {};
  await a.sp.assemble({ agent: a.agent, selfStep: token });
  await b.sp.assemble({ agent: b.agent, selfStep: token });
  assert.equal(a.rawAgent.selfContributionProvider(token).body, 'A');
  assert.equal(b.rawAgent.selfContributionProvider(token).body, 'B');
});

test('disposing an inner layer bypasses hooks but preserves its accepted token map', async () => {
  const h = setup();
  const one = h.install('ONE');
  const oldToken = {};
  await h.sp.assemble({ agent: h.agent, selfStep: oldToken });
  const two = h.install('TWO');
  one.provider.dispose();
  one.provider.dispose();
  const token = {};
  await h.sp.assemble({ agent: h.agent, selfStep: token });
  assert.equal(one.before.length, 1);
  assert.equal(two.before.length, 1);
  assert.equal(h.rawAgent.selfContributionProvider(token).body, 'TWO');
  assert.equal(one.provider(oldToken).body, 'ONE');
});

test('top-layer dispose restores the method through a real Cordis service proxy', () => {
  const h = setup();
  const ownBefore = Object.getOwnPropertyDescriptor(h.raw, 'assemble');
  const one = h.install('ONE');
  const wrapper = Object.getOwnPropertyDescriptor(h.raw, 'assemble').value;
  assert.notEqual(h.sp.assemble, wrapper, 'Cordis shadows method reads');
  one.provider.dispose();
  assert.deepEqual(Object.getOwnPropertyDescriptor(h.raw, 'assemble'), ownBefore);
});

test('disposing an older layer cannot remove a newer wrapper', async () => {
  const h = setup();
  const one = h.install('ONE');
  const two = h.install('TWO');
  const top = Object.getOwnPropertyDescriptor(h.raw, 'assemble').value;
  one.provider.dispose();
  assert.equal(Object.getOwnPropertyDescriptor(h.raw, 'assemble').value, top);
  const token = {};
  await h.sp.assemble({ agent: h.agent, selfStep: token });
  assert.equal(two.provider(token).body, 'TWO');
});

test('dispose during an in-flight assembly prevents late binding or token acceptance', async () => {
  const started = deferred();
  const resume = deferred();
  const sp = { assemble: async () => {
    started.resolve();
    await resume.promise;
    return { sections: [{ name: 'akasha:self', text: 'SELF' }], variables: {} };
  } };
  let after = 0;
  const provider = createSelfContributionProvider({
    systemPrompt: sp, contributionFor: () => contribution('SELF'), afterAssemble: () => { after++; },
  });
  const token = {};
  const pending = sp.assemble({ selfStep: token });
  await started.promise;
  try { provider.dispose(); } finally { resume.resolve(); }
  await pending;
  assert.equal(after, 0);
  assert.throws(() => provider(token), /accepted assembly/);
});

test('real Cordis effect cleanup disposes the wrapper', async () => {
  const h = setup();
  const one = h.install('ONE');
  h.ctx.effect(() => () => one.provider.dispose(), 'akasha.selfContributionProvider()');
  await h.ctx.fiber.dispose();
  assert.equal(Object.getOwnPropertyDescriptor(h.raw, 'assemble'), undefined);
});

test('strict accepted-assembly versus contribution text verification remains enforced', async () => {
  const sp = { assemble: async () => ({ sections: [{ name: 'akasha:self', text: 'OTHER' }], variables: {} }) };
  const provider = createSelfContributionProvider({ systemPrompt: sp, contributionFor: () => contribution('SELF') });
  const token = {};
  await sp.assemble({ selfStep: token });
  assert.throws(() => provider(token), /文本与 contribution 不一致/);
});
