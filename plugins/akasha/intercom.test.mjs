import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  createProject, joinProject, leaveProject, listProjects, projectFeed,
  readIntercom, foldProjects, sendIntercom, ackIntercom, inboxIntercom,
} from './intercom.mjs';

const identity = {
  model: 'gpt-6-astra',
  modelProvider: 'openai',
  modelSource: 'codex.turn_context',
  effort: 'ultra',
  sessionId: 'test-session-123',
  workspace: '<LOCAL_PATH>',
};
const projectLinks = {
  codexProjectId: 'project-game',
  codexThreadId: 'thread-game',
  repository: 'F:\\Game',
  repoRemote: 'git@github.com:owner/game.git',
  branch: 'feature/visuals',
  prUrl: 'https://github.com/owner/game/pull/12',
};
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'akasha-intercom-test-'));
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, file: join(root, 'logs', 'intercom.jsonl') };
}

test('project workspace and member identity survive feed, list and leave', (t) => {
  const opts = fixture(t);
  assert.equal(createProject('demo', { title: 'Demo', workspace: identity.workspace }, opts).ok, true);
  assert.equal(joinProject('demo', 'codex-test', { agent: 'codex', role: 'review', ...identity }, opts).ok, true);
  leaveProject('demo', 'codex-test', opts);
  const project = listProjects(opts).projects[0];
  assert.equal(project.workspace, '<LOCAL_PATH>');
  assert.equal(project.members[0].active, false);
  for (const [key, value] of Object.entries(identity)) assert.equal(project.members[0][key], value, key);
  const feed = projectFeed('demo', {}, opts);
  assert.equal(feed.workspace, '<LOCAL_PATH>');
  assert.deepEqual(feed.members, project.members);
});

test('rejoining with updated identity appends once and preserves omitted fields and other members', (t) => {
  const opts = fixture(t);
  joinProject('demo', 'Master', { agent: 'human', role: 'owner' }, opts);
  joinProject('demo', 'codex-test', { agent: 'codex', role: 'review', ...identity }, opts);
  const original = readFileSync(opts.file, 'utf8');
  const changed = joinProject('demo', 'codex-test', { model: 'gpt-6.1-sol', effort: 'high' }, opts);
  assert.equal(changed.already, false);
  assert.equal(readIntercom(opts.file).length, 3);
  assert.ok(readFileSync(opts.file, 'utf8').startsWith(original));
  const members = listProjects(opts).projects[0].members;
  assert.equal(members[0].peer, 'Master');
  assert.equal(members[0].active, true);
  const member = members[1];
  assert.equal(member.agent, 'codex');
  assert.equal(member.role, 'review');
  assert.equal(member.model, 'gpt-6.1-sol');
  assert.equal(member.effort, 'high');
  assert.equal(member.sessionId, identity.sessionId);
  assert.equal(member.modelProvider, 'openai');
  assert.equal(member.workspace, '<LOCAL_PATH>');
  const updated = readFileSync(opts.file, 'utf8');
  assert.equal(joinProject('demo', 'codex-test', { model: 'gpt-6.1-sol', effort: 'high' }, opts).already, true);
  assert.equal(joinProject('demo', 'codex-test', { model: undefined, effort: '' }, opts).already, true);
  assert.equal(readFileSync(opts.file, 'utf8'), updated);
});

test('fold accepts legacy records and ignores malformed optional metadata without erasing identity', () => {
  const project = foldProjects([
    { kind: 'proj', project: 'demo', workspace: '/srv/game' },
    { kind: 'proj', project: 'demo', workspace: 'relative/game' },
    { kind: 'join', project: 'demo', peer: 'codex-test', ...identity },
    { kind: 'join', project: 'demo', peer: 'codex-test', model: {}, workspace: false },
    { kind: 'join', project: 'demo', peer: 'legacy', agent: 'codex' },
  ])[0];
  assert.equal(project.workspace, '/srv/game');
  assert.equal(project.members[0].model, 'gpt-6-astra');
  assert.equal(project.members[0].workspace, '<LOCAL_PATH>');
  assert.equal(project.members[1].active, true);
  assert.equal(project.members[1].model, undefined);
});

test('invalid metadata is rejected without appending', (t) => {
  const opts = fixture(t);
  createProject('demo', {}, opts);
  const original = readFileSync(opts.file, 'utf8');
  for (const metadata of [
    { model: {} }, { modelProvider: true }, { modelSource: 3 }, { effort: [] },
    { sessionId: null }, { workspace: 'relative/game' }, { workspace: 7 }, { workspace: 'H:game' },
  ]) {
    assert.equal(joinProject('demo', 'codex-test', metadata, opts).ok, false, JSON.stringify(metadata));
  }
  assert.equal(createProject('demo', { workspace: 'relative/game' }, opts).ok, false);
  assert.equal(readFileSync(opts.file, 'utf8'), original);
});

test('project updates retain omitted workspace and accept Windows, UNC and POSIX absolute paths', (t) => {
  const opts = fixture(t);
  for (const [i, workspace] of ['<LOCAL_PATH>', '\\\\server\\share\\game', '/srv/game'].entries()) {
    assert.equal(createProject(`demo-${i}`, { workspace }, opts).ok, true);
    createProject(`demo-${i}`, { title: 'Renamed' }, opts);
    assert.equal(listProjects(opts).projects.find((p) => p.project === `demo-${i}`).workspace, workspace);
  }
});

test('project metadata updates preserve archived state until an explicit reopen', () => {
  const rows = [
    { kind: 'proj', project: 'demo', workspace: '<LOCAL_PATH>', closed: true },
    { kind: 'proj', project: 'demo', title: 'Renamed', workspace: 'H:\\Other' },
  ];
  assert.equal(foldProjects(rows)[0].closed, true);
  rows.push({ kind: 'proj', project: 'demo', closed: false });
  assert.equal(foldProjects(rows)[0].closed, false);
});

test('identity grouping and session titles preserve distinct peers and projects', (t) => {
  const opts = fixture(t);
  const group = { identity: 'gpt', displayName: 'GPT', sessionTitle: 'Visual review' };
  joinProject('game', 'codex-one', { ...identity, ...group }, opts);
  joinProject('game', 'codex-two', { ...identity, ...group, sessionId: 'second', sessionTitle: 'Code review' }, opts);
  joinProject('other', 'codex-one', { identity: 'dafeiyu', displayName: '大肥鱼', sessionTitle: 'Other project' }, opts);
  const original = readFileSync(opts.file, 'utf8');
  assert.equal(joinProject('game', 'codex-one', { sessionTitle: 'Renamed review' }, opts).already, false);
  assert.ok(readFileSync(opts.file, 'utf8').startsWith(original));
  const game = listProjects(opts).projects.find(p => p.project === 'game');
  assert.equal(game.members.length, 2);
  assert.equal(game.members[0].identity, 'gpt');
  assert.equal(game.members[0].displayName, 'GPT');
  assert.equal(game.members[0].sessionTitle, 'Renamed review');
  assert.equal(game.members[0].model, 'gpt-6-astra');
  assert.equal(game.members[1].sessionTitle, 'Code review');
  assert.equal(listProjects(opts).projects.find(p => p.project === 'other').members[0].identity, 'dafeiyu');
  const updated = readFileSync(opts.file, 'utf8');
  assert.equal(joinProject('game', 'codex-one', { identity: ' gpt ', displayName: '', sessionTitle: 'Renamed review' }, opts).already, true);
  assert.equal(readFileSync(opts.file, 'utf8'), updated);
});

test('project registration is semantically idempotent and preserves omitted mappings and closed state', (t) => {
  const opts = fixture(t);
  const created = createProject('game', { title: 'Game', workspace: 'F:\\Game', ...projectLinks }, opts);
  assert.equal(created.created, true);
  assert.equal(created.already, false);
  const original = readFileSync(opts.file, 'utf8');
  for (const details of [{}, { title: '' }, { branch: ' feature/visuals ' }, { codexProjectId: '' }]) {
    const unchanged = createProject('game', details, opts);
    assert.equal(unchanged.created, false);
    assert.equal(unchanged.already, true);
  }
  assert.equal(readFileSync(opts.file, 'utf8'), original);
  const changed = createProject('game', { branch: 'fix/materials' }, opts);
  assert.equal(changed.created, false);
  assert.equal(changed.already, false);
  assert.equal(readIntercom(opts.file).length, 2);
  assert.ok(readFileSync(opts.file, 'utf8').startsWith(original));
  const project = listProjects(opts).projects[0];
  assert.equal(project.title, 'Game');
  assert.equal(project.workspace, 'F:\\Game');
  for (const key of ['codexProjectId', 'codexThreadId', 'repository', 'repoRemote', 'prUrl']) {
    assert.equal(project[key], projectLinks[key], key);
    assert.equal(projectFeed('game', {}, opts)[key], projectLinks[key], `feed ${key}`);
  }
  appendFileSync(opts.file, JSON.stringify({ kind: 'proj', project: 'game', closed: true }) + '\n');
  createProject('game', { branch: 'fix/archived-metadata' }, opts);
  assert.equal(listProjects(opts).projects[0].closed, true);
});

test('matching names or repository links never merge separately named collaboration projects', (t) => {
  const opts = fixture(t);
  createProject('one', { title: 'Game', ...projectLinks }, opts);
  createProject('two', { title: 'Game', ...projectLinks }, opts);
  joinProject('one', 'codex-one', { identity: 'gpt' }, opts);
  const projects = listProjects(opts).projects;
  assert.equal(projects.length, 2);
  assert.equal(projects.find(p => p.project === 'two').members.length, 0);
  assert.equal(projects.find(p => p.project === 'one').members[0].peer, 'codex-one');
});

test('logical sidebar section mapping and explicit clearing preserve project membership and append-only history', (t) => {
  const opts = fixture(t);
  createProject('one', { title: 'Logical group', workspace: 'F:\\Game', ...projectLinks }, opts);
  createProject('two', { workspace: 'F:\\Game', ...projectLinks }, opts);
  joinProject('one', 'codex-one', { workspace: 'F:\\Game', identity: 'gpt' }, opts);
  appendFileSync(opts.file, JSON.stringify({ kind: 'proj', project: 'one', closed: true }) + '\n');
  const original = readFileSync(opts.file, 'utf8');
  const clearFields = ['workspace', 'repository', 'branch'];
  assert.equal(createProject('one', { codexSectionId: ' section-one ', clearFields }, opts).already, false);
  const updated = readFileSync(opts.file, 'utf8');
  assert.ok(updated.startsWith(original));
  const latest = readIntercom(opts.file).at(-1);
  assert.deepEqual(latest.clearFields, clearFields);
  const project = projectFeed('one', {}, opts);
  assert.equal(project.codexSectionId, 'section-one');
  for (const key of clearFields) {
    assert.equal(Object.hasOwn(project, key), false, key);
    assert.equal(Object.hasOwn(latest, key), false, `serialized ${key}`);
  }
  const listed = listProjects(opts).projects.find(p => p.project === 'one');
  assert.equal(listed.closed, true);
  assert.equal(listed.title, 'Logical group');
  assert.equal(project.codexThreadId, projectLinks.codexThreadId);
  assert.equal(project.members[0].workspace, 'F:\\Game');
  assert.equal(project.members[0].active, true);
  assert.equal(listProjects(opts).projects.find(p => p.project === 'two').repository, 'F:\\Game');
  assert.equal(createProject('one', { codexSectionId: 'section-one', clearFields }, opts).already, true);
  assert.equal(createProject('one', { clearFields: ['workspace'] }, opts).already, true);
  assert.equal(readFileSync(opts.file, 'utf8'), updated);
});

test('clear fields rejects malformed lists, protected keys and simultaneous assignments without appending', (t) => {
  const opts = fixture(t);
  createProject('game', { workspace: 'F:\\Game', ...projectLinks }, opts);
  const original = readFileSync(opts.file, 'utf8');
  for (const details of [
    { clearFields: 'workspace' }, { clearFields: null }, { clearFields: [null] },
    { clearFields: ['members'] }, { clearFields: ['title'] }, { clearFields: ['closed'] },
    { clearFields: ['__proto__'] }, { clearFields: ['workspace', ''] },
    { clearFields: ['workspace'], workspace: '<LOCAL_PATH>' },
    { clearFields: ['workspace'], workspace: '' }, { codexSectionId: {} },
  ]) {
    assert.equal(createProject('game', details, opts).ok, false, JSON.stringify(details));
  }
  assert.equal(createProject('game', { clearFields: [] }, opts).already, true);
  assert.equal(readFileSync(opts.file, 'utf8'), original);
});

test('fold applies only allowed clear fields before valid assignments and ignores malformed legacy requests', () => {
  const project = foldProjects([
    { kind: 'proj', project: 'game', title: 'Game', closed: true, workspace: 'F:\\Game', repository: 'F:\\Game', branch: 'main', codexSectionId: 'section-old' },
    { kind: 'join', project: 'game', peer: 'codex-one', workspace: 'F:\\Game' },
    { kind: 'proj', project: 'game', clearFields: 'workspace' },
    { kind: 'proj', project: 'game', clearFields: ['members', 'closed', 'title', null, 'repository', 'branch', 'codexSectionId'], branch: 'fixed', codexSectionId: 'section-new' },
  ])[0];
  assert.equal(project.workspace, 'F:\\Game');
  assert.equal(Object.hasOwn(project, 'repository'), false);
  assert.equal(project.branch, 'fixed');
  assert.equal(project.codexSectionId, 'section-new');
  assert.equal(project.closed, true);
  assert.equal(project.title, 'Game');
  assert.equal(project.members[0].peer, 'codex-one');
});

test('new metadata validates strings, local repository roots, and HTTP PR URLs without appending invalid values', (t) => {
  const opts = fixture(t);
  createProject('game', { ...projectLinks }, opts);
  const original = readFileSync(opts.file, 'utf8');
  for (const key of ['identity', 'displayName', 'sessionTitle']) {
    assert.equal(joinProject('game', 'codex-one', { [key]: {} }, opts).ok, false, key);
  }
  for (const metadata of [
    ...Object.keys(projectLinks).map(key => ({ [key]: {} })),
    { repository: 'relative/game' }, { repository: 'https://github.com/owner/game' },
    { prUrl: 'not a url' }, { prUrl: 'https://' }, { prUrl: 'ftp://example.com/pr/1' },
    { prUrl: 'javascript:alert(1)' },
  ]) {
    assert.equal(createProject('game', metadata, opts).ok, false, JSON.stringify(metadata));
  }
  assert.equal(readFileSync(opts.file, 'utf8'), original);
  for (const [i, repository] of ['F:\\Game', '\\\\server\\share\\Game', '/srv/game'].entries()) {
    assert.equal(createProject(`valid-${i}`, { repository, prUrl: 'http://localhost/pr/1' }, opts).ok, true);
  }
});

test('legacy project and member rows keep valid metadata when later rows contain invalid optional values', () => {
  const project = foldProjects([
    { kind: 'proj', project: 'game', ...projectLinks },
    { kind: 'join', project: 'game', peer: 'codex-one', identity: 'gpt', displayName: 'GPT', sessionTitle: 'Review' },
    { kind: 'proj', project: 'game', repository: 'relative', prUrl: 'javascript:alert(1)', codexProjectId: [] },
    { kind: 'join', project: 'game', peer: 'codex-one', identity: {}, displayName: '', sessionTitle: null },
  ])[0];
  assert.equal(project.repository, 'F:\\Game');
  assert.equal(project.prUrl, projectLinks.prUrl);
  assert.equal(project.codexProjectId, 'project-game');
  assert.equal(project.members[0].identity, 'gpt');
  assert.equal(project.members[0].displayName, 'GPT');
  assert.equal(project.members[0].sessionTitle, 'Review');
});

test('unread is recipient-specific and inbox excludes messages sent by that recipient', (t) => {
  const opts = fixture(t);
  const broadcast = sendIntercom({ from: 'Master', project: 'demo', body: 'broadcast' }, opts);
  const direct = sendIntercom({ from: 'Master', to: 'codex-test', project: 'demo', body: 'direct' }, opts);
  sendIntercom({ from: 'codex-test', project: 'demo', body: 'own broadcast' }, opts);
  sendIntercom({ from: 'codex-test', to: 'codex-test', project: 'demo', body: 'own direct' }, opts);
  ackIntercom(broadcast.id, 'someone-else', opts);
  ackIntercom(direct.id, 'someone-else', opts);
  const inbox = inboxIntercom({ for: 'codex-test', project: 'demo', unreadOnly: true }, opts);
  assert.equal(inbox.total, 2);
  assert.equal(inbox.unread, 2);
  assert.equal(inbox.rows.length, 2);
  assert.ok(inbox.rows.every((row) => row.acked === false));
  ackIntercom(broadcast.id, 'codex-test', opts);
  const remaining = inboxIntercom({ for: 'codex-test', unreadOnly: true }, opts);
  assert.equal(remaining.unread, 1);
  assert.deepEqual(remaining.rows.map((row) => row.id), [direct.id]);
});

test('CLI stores camelCase identity options and scopes inbox to requested project', (t) => {
  const opts = fixture(t);
  const data = join(opts.root, 'data');
  mkdirSync(data);
  writeFileSync(join(data, 'canon.jsonl'), '');
  const cli = (...args) => {
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./akasha.mjs', import.meta.url)), 'intercom', ...args, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, AKASHA_ROOT: data, AKASHA_LOGS: join(opts.root, 'logs'), AKASHA_DIR: opts.root },
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    return JSON.parse(child.stdout);
  };
  cli('project', 'create', 'demo', '--title', 'Demo', '--workspace', '<LOCAL_PATH>',
    '--codex-project-id', 'project-game', '--codex-thread-id', 'thread-game',
    '--repository', 'F:\\Game', '--repo-remote', 'git@github.com:owner/game.git',
    '--branch', 'feature/visuals', '--pr-url', 'https://github.com/owner/game/pull/12');
  cli('join', '--project', 'demo', '--as', 'codex-test', '--agent', 'codex', '--role', 'review',
    '--model', 'gpt-6-astra', '--model-provider', 'openai', '--model-source', 'codex.turn_context',
    '--effort', 'ultra', '--session-id', 'test-session-123', '--workspace', '<LOCAL_PATH>',
    '--identity', 'gpt', '--display-name', 'GPT', '--session-title', 'Visual review');
  const project = cli('project', 'list').projects[0];
  assert.equal(project.workspace, '<LOCAL_PATH>');
  for (const [key, value] of Object.entries(identity)) assert.equal(project.members[0][key], value, key);
  assert.equal(project.members[0].identity, 'gpt');
  assert.equal(project.members[0].displayName, 'GPT');
  assert.equal(project.members[0].sessionTitle, 'Visual review');
  for (const [key, value] of Object.entries(projectLinks)) assert.equal(project[key], value, key);
  const original = readFileSync(opts.file, 'utf8');
  assert.equal(cli('project', 'create', 'demo', '--branch', 'feature/visuals').already, true);
  assert.equal(readFileSync(opts.file, 'utf8'), original);
  cli('project', 'create', 'demo', '--branch', 'fix/materials');
  assert.equal(cli('project', 'list').projects[0].title, 'Demo');
  const clearArgs = ['project', 'create', 'demo', '--codex-section-id', 'section-one', '--clear-fields', 'workspace,repository,branch'];
  assert.equal(cli(...clearArgs).already, false);
  const cleared = cli('project', 'list').projects[0];
  assert.equal(cleared.codexSectionId, 'section-one');
  for (const key of ['workspace', 'repository', 'branch']) assert.equal(Object.hasOwn(cleared, key), false, key);
  assert.equal(cleared.members[0].workspace, '<LOCAL_PATH>');
  assert.equal(cli(...clearArgs).already, true);
  cli('join', '--project', 'demo', '--as', 'codex-test', '--model', 'gpt-6.1-sol');
  assert.equal(cli('project', 'list').projects[0].members[0].role, 'review');
  sendIntercom({ from: 'Master', project: 'demo', body: 'here' }, opts);
  sendIntercom({ from: 'Master', project: 'elsewhere', body: 'elsewhere' }, opts);
  assert.equal(cli('inbox', '--project', 'demo', '--for', 'codex-test').total, 1);
});

test('inbox rejects malformed project instead of widening to all projects', (t) => {
  const opts = fixture(t);
  const r = inboxIntercom({ for: 'codex-test', project: 'bad project' }, opts);
  assert.equal(r.ok, false);
  assert.match(r.error, /工程名非法/);
});
