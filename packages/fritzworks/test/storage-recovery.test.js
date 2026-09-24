import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplicationContext } from '../lib/context.js';
import { resolveConfig } from '../lib/config.js';
import { openDb, createScratchpad } from '../lib/core.js';
import { ensureSessionPanelGroup, readPanelLayout, syncDiscoveredSessionNotes } from '../lib/panels.js';
import { rebindStorage } from '../lib/storage-rebind.js';
import { terminalEnvironmentMatches, inspectTerminalProcesses, terminalSocketOwners } from '../lib/terminal-migration.js';

function fixture(t, { legacy = false, extra = '' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fw-storage-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'config.ini');
  writeFileSync(file, `${legacy ? '' : 'configVersion = 2\n'}[paths]\ndata = ./data\nrepositories = ./cache\nscratchpads = ./scratch\n${legacy ? 'notes = ./legacy-notes' : 'worktrees = ./trees\nsessionNotes = ./writing'}\n${extra}`);
  return { root, file, config: resolveConfig({ home: root, env: {}, configPath: file }) };
}
const noProcess = () => assert.fail('test must never spawn a process');

test('legacy process review binds the reachable socket and never treats missing identity as verified', () => {
  const name = 'fw-browser-agent-71';
  const path = `/run/user/1001/zellij/contract_version_1/${name}`;
  const process = (pid, inode) => ({ pid, ppid: 1, start: String(inode), args: ['zellij', '--server', path], cwd: '/scratch/incoming',
    env: { FRITZWORKS_DAEMON: '1', ZELLIJ_SESSION_NAME: name } });
  const options = { name, identity: { sessionId: '71', role: 'agent' }, config: { configPath: '/config/fw', paths: { data: '/data/fw' } },
    instanceId: 'instance', expectedCwd: '/scratch/incoming', incomplete: false, processes: [process(41, 111), process(42, 222)],
    socketOwners: [{ path, pid: 42, inode: '5199', device: '65' }] };
  const result = inspectTerminalProcesses(options);
  assert.equal(result.verified, false);
  assert.equal(result.reviewRequired, true);
  assert.equal(result.pid, 42);
  assert.equal(inspectTerminalProcesses({ ...options, socketOwners: [] }).reviewRequired, undefined);
  assert.equal(inspectTerminalProcesses({ ...options, expectedCwd: '/other' }).reviewRequired, undefined);
  const bad = structuredClone(options);
  bad.processes[1].env.FRITZWORKS_INSTANCE_ID = 'another-instance';
  assert.equal(inspectTerminalProcesses(bad).reviewRequired, undefined);
  bad.processes[1].env = { ...options.processes[1].env, FRITZWORKS_ID: '70' };
  assert.equal(inspectTerminalProcesses(bad).reviewRequired, undefined);
  const changed = structuredClone(options); changed.socketOwners[0].inode = '5200';
  assert.notEqual(inspectTerminalProcesses(changed).fingerprint, result.fingerprint);
  const stronger = structuredClone(options);
  stronger.processes.push({ pid: 43, ppid: 42, start: '333', args: ['sh'], cwd: '/scratch/incoming', env: { FRITZWORKS_INSTANCE_ID: 'instance', FRITZWORKS_ID: '71' } });
  assert.equal(inspectTerminalProcesses(stronger).verified, true);
  assert.equal(inspectTerminalProcesses(stronger).fingerprint, result.fingerprint);
});

test('socket inspection rejects obsolete path inodes, other users and failed inventory', () => {
  const line = (pid, inode) => `u_str LISTEN 0 4096 /run/user/1001/zellij/session 123 * 0 users:(("zellij",pid=${pid},fd=5)) <-> ino:${inode} dev:0/65 peers:`;
  const stat = () => ({ ino: 5199, dev: 65, uid: 1001, isSocket: () => true });
  assert.deepEqual(terminalSocketOwners(`${line(41, 2412)}\n${line(42, 5199)}`, stat, 1001).map(({ pid }) => pid), [42]);
  assert.equal(terminalSocketOwners(line(42, 5199), stat, 2000).length, 0);
  assert.equal(terminalSocketOwners(line(42, 5199), () => { throw new Error('missing'); }, 1001).length, 0);
});

test('reviewed legacy adoption needs exact approvals, preserves processes, and rejects changed evidence', (t) => {
  const { config, root } = fixture(t);
  const db = openDb(join(config.paths.data, 'workstreams.db'));
  const row = createScratchpad(db, 'legacy-review', config);
  ensureSessionPanelGroup(db, { id: row.id, type: 'scratchpad', name: row.branch, path: row.path });
  let replacement = false;
  const inspect = ({ name }) => name.startsWith('fw-') ? { verified: false, reviewRequired: true, name,
    pid: 42, start: '222', cwd: row.path, fingerprint: `${name}:${replacement ? 'replaced' : 'original'}` }
    : { verified: false, absent: true };
  const context = createApplicationContext({ config, db, runProcess: noProcess,
    adapters: { terminalMigration: { inspect, claimsRoot: join(root, 'claims') } } });
  t.after(async () => { await context.close(); db.close(); });
  const plan = context.terminalMigration.inventory();
  const legacyApprovals = plan.terminals.map((terminal) => ({ panelId: terminal.panelId,
    name: terminal.candidates[0].name, fingerprint: terminal.candidates[0].fingerprint }));
  assert.throws(() => context.terminalMigration.apply({ revision: plan.revision }), /ambiguous/);
  assert.throws(() => context.terminalMigration.apply({ revision: plan.revision, legacyApprovals: [{ ...legacyApprovals[0], fingerprint: 'wrong' }] }), /approval/);
  assert.equal(context.terminalOwnership.status, 'migration_required');
  const result = context.terminalMigration.apply({ revision: plan.revision, legacyApprovals });
  assert.equal(context.terminalOwnership.status, 'owned');
  assert.equal(context.terminalMigration.mappedIdentity(plan.terminals[0].identity).adoptedSession, legacyApprovals[0].name);
  assert.equal(context.terminalMigration.recover({ migrationId: result.migrationId }).status, 'complete');
  replacement = true;
  assert.throws(() => context.terminalMigration.mappedIdentity(plan.terminals[0].identity), /ownership changed/);
  assert.throws(() => context.terminalMigration.apply({ revision: plan.revision, legacyApprovals }), /inventory changed/);
});

test('contradictory inherited terminal identity cannot authorize adoption', () => {
  const config = { configPath: '/config/a.ini', paths: { data: '/data/a' } };
  const identity = { sessionId: '4' };
  const env = { FRITZWORKS_ID: '4', FRITZWORKS_CONFIG: config.configPath, FRITZWORKS_DATA: config.paths.data };
  assert.equal(terminalEnvironmentMatches(env, identity, config, 'instance-a'), true);
  for (const override of [{ FRITZWORKS_DATA: '/data/b' }, { FW_CONFIG: '/config/b.ini' }, { FRITZWORKS_INSTANCE_ID: 'instance-b' }]) {
    assert.equal(terminalEnvironmentMatches({ ...env, ...override }, identity, config, 'instance-a'), false);
  }
});

test('a disappearing volume before the first note cannot be silently recreated', (t) => {
  const { config, root } = fixture(t);
  mkdirSync(config.paths.sessionNotes);
  const context = createApplicationContext({ config, runProcess: noProcess });
  t.after(() => context.close());
  const row = context.operations.createScratchpad({ name: 'lazy' }).workstream;
  renameSync(config.paths.sessionNotes, join(root, 'unmounted'));
  assert.throws(() => context.sessionNotes.create(row.id, 'blocked'), /unavailable/);
  assert.equal(existsSync(config.paths.sessionNotes), false);
});

test('partial relocation copies resume and rewrite saved tabs and browser paths', (t) => {
  const { config, root } = fixture(t);
  const context = createApplicationContext({ config, runProcess: noProcess, adapters: { storageRelocation: {
    liveNames: () => [], copy: (source, destination) => { mkdirSync(destination); writeFileSync(join(destination, 'one.md'), 'partial'); throw new Error('partial copy'); },
  } } });
  t.after(() => context.close());
  const row = context.operations.createScratchpad({ name: 'partial' }).workstream;
  context.sessionNotes.create(row.id, 'initial');
  writeFileSync(join(row.notesPath, 'one.md'), 'whole one');
  writeFileSync(join(row.notesPath, 'two.md'), 'whole two');
  symlinkSync('one.md', join(row.notesPath, 'linked.md'));
  const tabPath = join(config.paths.data, 'editor-tabs.json');
  const tabs = { global: { activePath: join(row.notesPath, 'one.md'), tabs: [{ path: join(row.notesPath, 'one.md'), source: 'file' }] } };
  writeFileSync(tabPath, JSON.stringify(tabs));
  context.db.prepare('INSERT INTO browser_ui_state VALUES (?,?,?)').run('paths', JSON.stringify(tabs), 'now');
  const body = { target: row.id, kind: 'notes', destination: join(root, 'complete-copy'), copy: true };
  const preview = context.storageRelocation.preview(body);
  assert.throws(() => context.storageRelocation.apply({ ...body, revision: preview.revision }), /partial copy/);
  const migration = context.storageMigration.ledger().find(({ kind }) => kind === 'relocation');
  context.storageRelocation.recover({ migrationId: migration.id });
  assert.equal(readFileSync(join(body.destination, 'one.md'), 'utf8'), 'whole one');
  assert.equal(readFileSync(join(body.destination, 'two.md'), 'utf8'), 'whole two');
  assert.equal(readlinkSync(join(body.destination, 'linked.md')), 'one.md');
  assert.equal(JSON.parse(readFileSync(tabPath, 'utf8')).global.activePath, join(body.destination, 'one.md'));
  assert.equal(JSON.parse(context.db.prepare("SELECT state_json FROM browser_ui_state WHERE scope='paths'").get().state_json).global.tabs[0].path, join(body.destination, 'one.md'));
});

test('legacy migration writes reviewed configuration and replays the original ledger ID', (t) => {
  const { config, file } = fixture(t, { legacy: true });
  mkdirSync(config.paths.notes, { recursive: true });
  const db = openDb(join(config.paths.data, 'workstreams.db'));
  const row = createScratchpad(db, 'migrate', config);
  const context = createApplicationContext({ config, db, runProcess: noProcess });
  t.after(() => db.close());
  const preview = context.storageMigration.inventory();
  assert.match(preview.configuration.after, /configVersion = 2/);
  const applied = context.storageMigration.apply({ revision: preview.revision, applyConfiguration: true });
  const next = resolveConfig({ home: config.home, configPath: file, env: {} });
  assert.equal(next.configVersion, 2);
  assert.equal(next.notes.weekly.root, config.paths.notes);
  assert.equal(next.paths.repositories, config.paths.repositories);
  assert.equal(context.storageMigration.recover({ migrationId: applied.migrationId }).status, 'complete');
  assert.ok(context.sessionNotes.create(row.id, 'after adoption').path.includes(row.uuid));
});

test('legacy browser-only configured note owners stay behind migration', (t) => {
  const { config } = fixture(t, { legacy: true, extra: '[locations.docs]\npath = ./docs\n' });
  const db = openDb(join(config.paths.data, 'workstreams.db'));
  db.prepare('INSERT INTO browser_ui_state VALUES (?,?,?)').run('workspaces', JSON.stringify({ workspaces: [{ id: 'docs' }] }), 'now');
  const context = createApplicationContext({ config, db, runProcess: noProcess });
  t.after(() => db.close());
  assert.throws(() => context.sessionNotes.create('docs', 'must wait'), /migration/);
  assert.equal(context.terminalOwnership.status, 'migration_required');
});

test('offline data rebind preserves instance and paths, retires old authority, and recovers interruption', (t) => {
  const { config, root, file } = fixture(t);
  const context = createApplicationContext({ config, runProcess: noProcess });
  const row = context.operations.createScratchpad({ name: 'rebind' }).workstream;
  const note = context.sessionNotes.create(row.id, 'keep');
  context.adapters.writeSeed(row, 'retained briefing');
  const instanceId = context.instanceId;
  context.close();
  const destination = join(root, 'new-data');
  const preview = rebindStorage({ config, destination });
  assert.throws(() => rebindStorage({ config, destination, action: 'apply', revision: preview.revision }, {
    checkpoint: () => { throw new Error('interrupted before config'); },
  }), /interrupted before config/);
  assert.throws(() => createApplicationContext({ config, runProcess: noProcess }), /retired/);
  const old = new DatabaseSync(join(config.paths.data, 'workstreams.db'), { readOnly: true });
  const migrationId = old.prepare("SELECT id FROM storage_migrations WHERE kind='rebind'").get().id;
  old.close();
  writeFileSync(join(destination, 'workstreams.db'), 'interrupted snapshot');
  rebindStorage({ config, source: config.paths.data, action: 'recover', migrationId });
  const next = resolveConfig({ home: root, env: {}, configPath: file });
  assert.equal(next.paths.data, destination);
  assert.equal(readFileSync(join(destination, 'seeds', `${row.id}.md`), 'utf8'), 'retained briefing\n');
  const resumed = createApplicationContext({ config: next, runProcess: noProcess });
  t.after(() => resumed.close());
  assert.equal(resumed.instanceId, instanceId);
  assert.equal(resumed.sessionNotes.scan(row.id)[0].path, note.path);
  assert.equal(resumed.operations.createNote(row.id, { body: 'still here' }).path.startsWith(row.notesPath), true);
});

test('location identity migration retains UUID notes and panel resources across restart', (t) => {
  const { config, root, file } = fixture(t, { extra: '[locations.docs]\npath = ./docs\n' });
  const context = createApplicationContext({ config, runProcess: noProcess, adapters: { storageRelocation: { liveNames: () => [] } } });
  const note = context.sessionNotes.create('docs', 'keep');
  const uuid = context.sessionNotes.describe('docs').uuid;
  ensureSessionPanelGroup(context.db, { id: 'docs', type: 'misc', name: 'Docs', path: join(root, 'docs') }, { roles: [] });
  syncDiscoveredSessionNotes(context.db, null, { sessionNotes: context.sessionNotes });
  const plan = context.locationMigration.preview({ from: 'docs', to: 'writing' });
  context.locationMigration.apply({ from: 'docs', to: 'writing', revision: plan.revision });
  assert.throws(() => context.sessionNotes.create('docs', 'must restart'), /restart/);
  context.close();
  const next = createApplicationContext({ config: resolveConfig({ home: root, env: {}, configPath: file }), runProcess: noProcess });
  t.after(() => next.close());
  assert.equal(next.sessionNotes.describe('writing').uuid, uuid);
  assert.equal(next.sessionNotes.scan('writing')[0].path, note.path);
  assert.equal(readPanelLayout(next.db).groups[0].resources[0].value, note.path);
});

test('failed clone reservations retry without deleting the interrupted cache', (t) => {
  const { config, root } = fixture(t);
  const complete = new Set();
  const trees = new Map();
  const clones = [];
  const runProcess = (command, args) => {
    assert.equal(command, 'git');
    const good = (stdout = '') => ({ status: 0, stdout });
    if (args[0] === 'clone') {
      const target = args.at(-1); clones.push(target); mkdirSync(target);
      if (clones.length === 1) return { status: 1, stderr: 'interrupted clone' };
      complete.add(target); return good();
    }
    if (args.includes('--is-bare-repository')) return complete.has(args[1]) ? good('true') : { status: 1 };
    if (args.includes('rev-parse')) return good(trees.get(args[1]).common);
    if (args.includes('symbolic-ref')) return good(trees.get(args[1]).branch);
    if (args.includes('check-ref-format')) return good();
    if (args.includes('show-ref')) return { status: 1 };
    if (args.includes('ls-remote')) return { status: 2 };
    if (args.includes('list')) return good([...trees.keys()].map((path) => `worktree ${path}`).join('\n'));
    if (args.includes('add')) {
      const at = args.indexOf('add');
      const path = args[at + 3]; mkdirSync(path);
      trees.set(path, { common: args[1], branch: args[at + 2] }); return good();
    }
    assert.fail(`unexpected injected command: ${args}`);
  };
  const context = createApplicationContext({ config, runProcess });
  t.after(() => context.close());
  const input = { repository: 'https://example.invalid/team/project.git', selector: 'feature/topic' };
  assert.throws(() => context.operations.createRepo(input), /interrupted clone/);
  const row = context.operations.createRepo(input).workstream;
  assert.notEqual(clones[0], clones[1]);
  assert.equal(existsSync(clones[0]), true);
  assert.equal(context.gitStorage.record(row.uuid).common_dir, clones[1]);
});

test('in-process migration HTTP routes adopt, recover, relocate and retain note content', async (t) => {
  const { createApiService } = await import('../lib/api.js');
  const { Readable } = await import('node:stream');
  const { config, root } = fixture(t, { legacy: true });
  mkdirSync(config.paths.notes, { recursive: true });
  const db = openDb(join(config.paths.data, 'workstreams.db'));
  const row = createScratchpad(db, 'http-migration', config);
  const context = createApplicationContext({ config, db, runProcess: noProcess, adapters: { storageRelocation: { liveNames: () => [] } } });
  const service = createApiService({ context, pollInterval: 0, checkGit: async () => null, checkPr: async () => ({ added: false }) });
  t.after(async () => { await service.close(); db.close(); });
  const request = (path, body) => new Promise((done) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    req.method = body === undefined ? 'GET' : 'POST'; req.url = path; req.headers = { host: 'localhost' };
    let status;
    service.server.emit('request', req, { writeHead(value) { status = value; }, end(value) { done({ status, body: JSON.parse(value) }); } });
  });
  const inventory = await request('/migrations/storage');
  assert.equal(inventory.status, 200);
  const result = await request('/migrations/storage/apply', { revision: inventory.body.revision });
  assert.equal(result.status, 200);
  assert.equal((await request('/migrations/storage/recover', { migrationId: result.body.migrationId })).status, 200);
  const note = context.sessionNotes.create(row.id, 'http content');
  const body = { target: row.uuid, kind: 'notes', destination: join(root, 'http-notes'), copy: true };
  const preview = await request('/storage/relocate/preview', body);
  assert.equal(preview.status, 200);
  const moved = await request('/storage/relocate/apply', { ...body, revision: preview.body.revision });
  assert.equal(moved.status, 200);
  const read = await request(`/fw/${row.uuid}/note-file?path=${encodeURIComponent(join(body.destination, note.file))}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.content, 'http content\n');
});

test('verified inactive legacy panels can recover without touching a process', (t) => {
  const { config } = fixture(t);
  const db = openDb(join(config.paths.data, 'workstreams.db'));
  const row = createScratchpad(db, 'inactive', config);
  ensureSessionPanelGroup(db, { id: row.id, type: 'scratchpad', name: row.branch, path: row.path });
  const context = createApplicationContext({ config, db, runProcess: noProcess,
    adapters: { terminalMigration: { inspect: () => ({ verified: false, absent: true }) } } });
  t.after(() => db.close());
  const plan = context.terminalMigration.inventory();
  assert.equal(plan.blocked.length, 0);
  assert.equal(plan.terminals.every(({ inactive }) => inactive), true);
  const result = context.terminalMigration.apply({ revision: plan.revision });
  assert.equal(context.terminalOwnership.status, 'owned');
  assert.equal(context.terminalMigration.recover({ migrationId: result.migrationId }).status, 'complete');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM terminal_adoptions').get().count, 0);
});

test('config data edits fail before creating a competing state directory', (t) => {
  const { config, root } = fixture(t);
  const context = createApplicationContext({ config, runProcess: noProcess });
  context.close();
  const next = structuredClone(config); next.paths.data = join(root, 'accidental-data');
  assert.throws(() => createApplicationContext({ config: next, runProcess: noProcess }), /offline rebind/);
  assert.equal(existsSync(next.paths.data), false);
});
