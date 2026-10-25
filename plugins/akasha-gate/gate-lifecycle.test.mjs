// Integration: actual gate.apply, Cordis plugin/fiber lifecycle, and SystemPrompt.
// Tool guard and machine are inert services; no host/model/database is started.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Context, Service } from '@deepseek-ai/cordis';
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt';

const root = path.dirname(fileURLToPath(import.meta.url));
const core = path.resolve(root, '..', 'akasha');
const originalEnv = { root: process.env.AKASHA_ROOT, logs: process.env.AKASHA_LOGS };
let moduleSequence = 0;
afterEach(() => {
  if (originalEnv.root === undefined) delete process.env.AKASHA_ROOT; else process.env.AKASHA_ROOT = originalEnv.root;
  if (originalEnv.logs === undefined) delete process.env.AKASHA_LOGS; else process.env.AKASHA_LOGS = originalEnv.logs;
});

function setup(t, label) {
  const prefix = path.join(os.tmpdir(), 'akasha-gate-lifecycle-');
  const dir = fs.mkdtempSync(prefix);
  const canon = path.join(dir, 'canon.jsonl');
  process.env.AKASHA_ROOT = dir;
  process.env.AKASHA_LOGS = path.join(dir, 'logs');
  const ctx = new Context();
  const rawPrompt = new SystemPrompt(ctx, { includeHarnessIdentity: false });
  class Tools extends Service {
    constructor() { super(ctx, 'tools'); }
    guard() { return () => {}; }
  }
  class AgentLoop extends Service { constructor() { super(ctx, 'agentLoop'); } }
  class Machine extends Service { constructor() { super(ctx, 'testMachine'); } }
  new Tools();
  const rawLoop = new AgentLoop();
  const rawMachine = new Machine();
  const machine = ctx.testMachine;
  const save = text => fs.writeFileSync(canon, [
    { id: 'i', kind: 'identity', semanticKey: 'identity', claim: `I am ${text}`, revision: 'r1' },
    { id: 'a', kind: 'address', semanticKey: 'address', claim: 'Call Master', revision: 'r1' },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');
  save(label);
  async function install(coreDir = core) {
    const module = await import(`./index.js?lifecycle=${++moduleSequence}`);
    const fiber = ctx.plugin(module, { akashaDir: coreDir, dataDir: dir, log: path.join(dir, 'hooks.jsonl') });
    await fiber;
    assert.equal(rawLoop.selfContinuityEnabled, true);
    return { fiber, module, provider: rawLoop.selfContributionProvider };
  }
  const assemble = token => ctx.systemPrompt.assemble({ agent: machine, scope: machine, selfStep: token });
  t.after(async () => {
    await ctx.fiber.dispose();
    assert.ok(path.resolve(dir).startsWith(path.resolve(prefix)), 'cleanup is restricted to this generated fixture');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { ctx, rawPrompt, rawLoop, rawMachine, machine, canon, dir, install, assemble, save };
}

test('real gate.apply refreshes an existing proxied machine after accepted SystemPrompt assembly', async t => {
  const h = setup(t, 'ALPHA');
  h.rawMachine.selfContributionProvider = () => undefined;
  const installed = await h.install();
  const token = {};
  const assembly = await h.assemble(token);
  const accepted = h.rawMachine.selfContributionProvider(token);
  assert.match(accepted.body, /ALPHA/);
  assert.equal(h.rawMachine.selfContinuityEnabled, true);
  assert.equal(h.machine.selfContributionProvider(token).frameId, accepted.frameId);
  assert.equal(renderPrompt(assembly).slice(accepted.systemStart + accepted.start, accepted.systemStart + accepted.end), accepted.body);
  assert.equal(installed.module.selfContributionFor({}), undefined);
  h.save('BETA');
  await h.assemble(token);
  assert.equal(h.rawMachine.selfContributionProvider(token).frameId, accepted.frameId, 'same token pins the accepted frame');
  assert.match(h.rawMachine.selfContributionProvider(token).body, /ALPHA/);
});

test('actual plugin disposal and repeated module reload preserve old tokens and bind only the new module', async t => {
  const h = setup(t, 'ONE');
  const baseDescriptor = Object.getOwnPropertyDescriptor(h.rawPrompt, 'assemble');
  let previous;
  for (const label of ['ONE', 'TWO', 'THREE']) {
    h.save(label);
    const installed = await h.install();
    if (previous) {
      assert.equal(h.rawMachine.selfContributionProvider, previous.machineProvider, 'installation alone cannot rewrite a cached machine');
      assert.equal(installed.module.selfContributionFor(previous.token), undefined, 'new ESM module has its own private token map');
    }
    const token = {};
    await h.assemble(token);
    const machineProvider = h.rawMachine.selfContributionProvider;
    assert.match(machineProvider(token).body, new RegExp(label));
    if (previous) assert.match(previous.provider(previous.token).body, new RegExp(previous.label));
    await installed.fiber.dispose();
    assert.deepEqual(Object.getOwnPropertyDescriptor(h.rawPrompt, 'assemble'), baseDescriptor, 'top wrapper is removed with its Cordis effect');
    assert.match(installed.provider(token).body, new RegExp(label), 'unload preserves already accepted token reads');
    previous = { ...installed, token, label, machineProvider };
  }
});

test('new gate module with failed loading never replaces a machine accepted provider', async t => {
  const h = setup(t, 'OLD');
  const old = await h.install();
  const oldToken = {};
  await h.assemble(oldToken);
  const machineProvider = h.rawMachine.selfContributionProvider;
  await old.fiber.dispose();
  const next = await h.install(path.join(h.dir, 'missing-core'));
  const token = {};
  await assert.rejects(h.assemble(token), error => error.code === 'AKASHA_SELF_FRAME_UNAVAILABLE' && error.reasons.includes('module-load-failed'));
  assert.equal(h.rawMachine.selfContributionProvider, machineProvider);
  assert.match(machineProvider(oldToken).body, /OLD/);
  assert.equal(next.module.selfContributionFor(token), undefined);
});

test('separate gate environments keep same-token frame and machine bindings isolated', async t => {
  const a = setup(t, 'ENV-A');
  const b = setup(t, 'ENV-B');
  const ga = await a.install();
  const gb = await b.install();
  const token = {};
  await a.assemble(token);
  await b.assemble(token);
  const ca = a.rawMachine.selfContributionProvider(token);
  const cb = b.rawMachine.selfContributionProvider(token);
  assert.match(ca.body, /ENV-A/);
  assert.match(cb.body, /ENV-B/);
  assert.notEqual(ca.frameId, cb.frameId);
  assert.equal(ga.module.selfContributionFor(token).frameId, ca.frameId);
  assert.equal(gb.module.selfContributionFor(token).frameId, cb.frameId);
});
