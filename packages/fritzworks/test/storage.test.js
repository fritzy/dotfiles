import assert from 'node:assert/strict';
import test from 'node:test';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplicationContext } from '../lib/context.js';
import { resolveConfig } from '../lib/config.js';
import { openDb, createScratchpad } from '../lib/core.js';
import { ensureSessionPanelGroup, readPanelLayout, syncDiscoveredSessionNotes } from '../lib/panels.js';
import { ensureBrowserTerminalSession, resetBrowserTerminalSession } from '../lib/zellij.js';

function fixture(t, { legacy = false, extra = '' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fw-storage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'config.ini');
  writeFileSync(file, `${legacy ? '' : 'configVersion = 2\n'}[paths]\ndata = ./data\nrepositories = ./cache\nscratchpads = ./scratch\n${legacy ? 'notes = ./legacy-notes' : 'worktrees = ./trees\nsessionNotes = ./writing'}\n${extra}`);
  const config = resolveConfig({ home: root, env: {}, configPath: file });
  return { root, file, config };
}

const noProcess = () => assert.fail('test must never spawn a process');

test('session notes pin UUID directories across years, root changes, labels, and archive', (t) => {
  const { config, root } = fixture(t);
  let date = '2026-12-31T23:59:59.000Z';
  const context = createApplicationContext({ config, clock: () => date, runProcess: noProcess });
  const row = context.operations.createScratchpad({ name: 'project' }).workstream;
  assert.equal(row.notesPath, join(config.paths.sessionNotes, row.uuid));
  assert.equal(existsSync(row.notesPath), false);
  const first = context.operations.createNote(row.id, { body: 'one', title: 'Same title' });
  const second = context.operations.createNote(row.id, { body: 'two', title: 'Same title' });
  assert.notEqual(first.path, second.path);
  date = '2027-01-01T00:00:00.000Z';
  context.operations.execute(row.id, 'rename', { name: 'another label' });
  context.operations.execute(row.id, 'archive', {});
  assert.equal(existsSync(first.path), true);
  context.close();
  const changed = structuredClone(config);
  changed.paths.sessionNotes = join(root, 'other-notes');
  const reopened = createApplicationContext({ config: changed, runProcess: noProcess });
  t.after(() => reopened.close());
  assert.equal(reopened.operations.createNote(row.id, { body: 'three' }).path.startsWith(row.notesPath), true);
  assert.equal(reopened.operations.notes(row.id).notes.length, 3);
  assert.equal(existsSync(changed.paths.sessionNotes), false);
});

test('configured locations retain independent note owner UUIDs and unavailable scans preserve associations', (t) => {
  const { config, root } = fixture(t, { extra: '[locations.notes]\npath = ./external\nname = Writing\n' });
  const context = createApplicationContext({ config, runProcess: noProcess });
  t.after(() => context.close());
  const owner = context.sessionNotes.describe('notes');
  const created = context.sessionNotes.create('notes', 'hello');
  assert.equal(created.path.startsWith(join(config.paths.sessionNotes, owner.uuid)), true);
  ensureSessionPanelGroup(context.db, { id: 'notes', type: 'misc', name: 'Writing', path: join(root, 'external') });
  syncDiscoveredSessionNotes(context.db, null, { sessionNotes: context.sessionNotes });
  const before = readPanelLayout(context.db).groups[0].resources;
  assert.equal(before.length, 1);
  renameSync(owner.path, `${owner.path}-unmounted`);
  const scan = syncDiscoveredSessionNotes(context.db, null, { sessionNotes: context.sessionNotes });
  assert.equal(scan.unavailable.length, 1);
  assert.deepEqual(readPanelLayout(context.db).groups[0].resources, before);
  assert.throws(() => context.sessionNotes.create('notes', 'lost'), /unavailable/);
});

test('session note reads and writes enforce versions and reject symlink escapes', (t) => {
  const { config, root } = fixture(t);
  const context = createApplicationContext({ config, runProcess: noProcess });
  t.after(() => context.close());
  const row = context.operations.createScratchpad({ name: 'notes' }).workstream;
  const note = context.sessionNotes.create(row.id, 'initial');
  context.sessionNotes.write(row.id, note.path, 'edited', { version: note.version });
  assert.throws(() => context.sessionNotes.write(row.id, note.path, 'stale', { version: note.version }), /changed/);
  const outside = join(root, 'outside.md'); writeFileSync(outside, 'outside');
  symlinkSync(outside, join(row.notesPath, 'escape.md'));
  assert.throws(() => context.sessionNotes.scan(row.id), /unavailable/);
  assert.equal(readFileSync(outside, 'utf8'), 'outside');
});

test('explicit legacy migration inventories multiple years and numeric slugs without moving notes', (t) => {
  const { config } = fixture(t, { legacy: true });
  const db = openDb(join(config.paths.data, 'workstreams.db'));
  const row = createScratchpad(db, 'old', config);
  const paths = [join(config.paths.notes, 'work', '2025', 'workstream', `${row.id}-old`), join(config.paths.notes, 'work', '2026', 'workstream', row.uuid)];
  for (const path of paths) { mkdirSync(path, { recursive: true }); writeFileSync(join(path, 'note.md'), path); }
  const context = createApplicationContext({ config, db, runProcess: noProcess });
  t.after(() => db.close());
  assert.throws(() => context.sessionNotes.scan(row.id), /migration/);
  const preview = context.storageMigration.inventory();
  assert.deepEqual(preview.errors, []);
  assert.equal(preview.owners[0].primary, paths[1]);
  const result = context.storageMigration.apply({ revision: preview.revision });
  assert.equal(existsSync(join(result.backup, 'workstreams.db')), true);
  assert.equal(context.sessionNotes.scan(row.id).length, 2);
  assert.throws(() => context.sessionNotes.read(row.id, 'note.md'), /ambiguous/);
  assert.equal(context.sessionNotes.create(row.id, 'new').path.startsWith(paths[1]), true);
  assert.ok(paths.every(existsSync));
  const rerun = context.storageMigration.inventory();
  assert.equal(context.storageMigration.apply({ revision: rerun.revision }).status, 'complete');
});

function fakeGit(root) {
  const source = join(root, 'local-project');
  const common = join(root, 'repository-metadata');
  mkdirSync(source); mkdirSync(common);
  const trees = new Map();
  const calls = [];
  const run = (command, args) => {
    assert.equal(command, 'git'); calls.push(args);
    const good = (stdout = '') => ({ status: 0, stdout });
    if (args.includes('rev-parse')) return good(trees.get(args[1])?.common || common);
    if (args.includes('symbolic-ref')) return good(trees.get(args[1])?.branch || 'main');
    if (args.includes('check-ref-format')) return good();
    if (args.includes('show-ref')) return { status: 1 };
    if (args.includes('list')) return good([...trees.keys()].map((path) => `worktree ${path}`).join('\n'));
    if (args.includes('add')) {
      const at = args.indexOf('add');
      const branch = args[at + 2], path = args[at + 3];
      mkdirSync(path); trees.set(path, { common, branch }); return good();
    }
    if (args.includes('remove')) return { status: 1, stderr: 'removal deliberately failed' };
    assert.fail(`unexpected mock Git call: ${args.join(' ')}`);
  };
  return { source, common, trees, calls, run };
}

test('local Git needs no hosting tools, allocates colliding branches separately, and pins paths across root edits', (t) => {
  const { config, root } = fixture(t);
  const fake = fakeGit(root);
  const context = createApplicationContext({ config, runProcess: fake.run, adapters: { worktreeDirty: () => '' } });
  const a = context.operations.createRepo({ repository: fake.source, selector: 'feature/a' }).workstream;
  const b = context.operations.createRepo({ repository: fake.source, selector: 'feature-a' }).workstream;
  assert.notEqual(a.path, b.path);
  assert.ok(a.path.startsWith(config.paths.worktrees));
  assert.equal(context.gitStorage.record(a.uuid).common_dir, fake.common);
  assert.equal(fake.calls.some((args) => args.includes('clone') || args.includes('fetch')), false);
  context.close();
  const changed = structuredClone(config); changed.paths.worktrees = join(root, 'other-trees'); changed.paths.repositories = join(root, 'other-cache');
  const reopened = createApplicationContext({ config: changed, runProcess: fake.run });
  t.after(() => reopened.close());
  assert.equal(reopened.gitStorage.materialize(a), a.path);
  assert.throws(() => reopened.gitStorage.remove(a), /deliberately failed/);
  assert.ok(existsSync(a.path));
  fake.trees.get(a.path).common = join(root, 'wrong-repository'); mkdirSync(join(root, 'wrong-repository'));
  assert.throws(() => reopened.gitStorage.remove(a), /different repository/);
});

test('legacy terminal adoption persists exact verified mappings, recovers reruns, and rejects another instance', (t) => {
  const { config, root } = fixture(t);
  const db = openDb(join(config.paths.data, 'workstreams.db'));
  const row = createScratchpad(db, 'old', config);
  ensureSessionPanelGroup(db, { id: row.id, type: 'scratchpad', name: row.branch, path: row.path });
  const inspect = ({ name }) => name.startsWith('fw-')
    ? { verified: true, name, pid: 123, start: '456', fingerprint: name }
    : { verified: false, reason: 'not live' };
  const adapters = { terminalMigration: { inspect, claimsRoot: join(root, 'claims') } };
  const context = createApplicationContext({ config, db, runProcess: noProcess, adapters });
  t.after(() => db.close());
  const preview = context.terminalMigration.inventory();
  assert.equal(preview.blocked.length, 0);
  assert.throws(() => context.assertTerminalOwnership(), /migration/);
  context.terminalMigration.apply({ revision: preview.revision });
  assert.equal(context.terminalOwnership.status, 'owned');
  const identity = context.terminalMigration.mappedIdentity(preview.terminals[0].identity);
  const commands = [];
  const run = (args) => { commands.push(args); return { status: 0, stdout: args[0] === 'list-sessions' ? `${identity.adoptedSession}\n` : '' }; };
  assert.equal(ensureBrowserTerminalSession(identity, { run }).created, false);
  assert.ok(commands.every((args) => args[0] === 'list-sessions'));
  resetBrowserTerminalSession(identity, { run });
  assert.ok(commands.filter((args) => args[0] !== 'list-sessions').every((args) => args.includes(identity.adoptedSession)));
  assert.equal(context.terminalMigration.recover({ revision: preview.revision }).status, 'complete');
  db.prepare("UPDATE application_metadata SET value='other-instance' WHERE key='instanceId'").run();
  assert.throws(() => createApplicationContext({ config, db, runProcess: noProcess, adapters }), /different daemon instance/);
});

test('ambiguous terminal evidence never clears migration guard or invokes terminal actions', (t) => {
  const { config } = fixture(t);
  const db = openDb(join(config.paths.data, 'workstreams.db'));
  const row = createScratchpad(db, 'old', config);
  ensureSessionPanelGroup(db, { id: row.id, type: 'scratchpad', name: row.branch, path: row.path });
  const context = createApplicationContext({ config, db, runProcess: noProcess,
    adapters: { terminalMigration: { inspect: () => ({ verified: false, reason: 'ambiguous' }) } } });
  t.after(() => db.close());
  const preview = context.terminalMigration.inventory();
  assert.throws(() => context.terminalMigration.apply({ revision: preview.revision }), /ambiguous/);
  assert.equal(context.terminalOwnership.status, 'migration_required');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM terminal_adoptions').get().n, 0);
});

test('note relocation previews active terminals, keeps backups, and supports cross-volume retained copies', (t) => {
  const { config, root } = fixture(t);
  const context = createApplicationContext({ config, runProcess: noProcess, adapters: { storageRelocation: { liveNames: () => [] } } });
  t.after(() => context.close());
  const row = context.operations.createScratchpad({ name: 'move' }).workstream;
  const file = context.sessionNotes.create(row.id, 'preserved');
  const body = { target: row.id, kind: 'notes', destination: join(root, 'relocated'), copy: true };
  const preview = context.storageRelocation.preview(body);
  const result = context.storageRelocation.apply({ ...body, revision: preview.revision });
  assert.equal(result.retainedSource, row.notesPath);
  assert.ok(existsSync(file.path));
  assert.equal(context.sessionNotes.describe(row.id).path, body.destination);
  assert.equal(context.storageRelocation.recover({ migrationId: result.migrationId }).status, 'complete');
});

test('interrupted relocation blocks note writers and resumes from its durable ledger', (t) => {
  const { config, root } = fixture(t);
  const context = createApplicationContext({ config, runProcess: noProcess, adapters: { storageRelocation: {
    liveNames: () => [], copy: (source, destination, options) => { cpSync(source, destination, options); throw new Error('interrupted after copy'); },
  } } });
  t.after(() => context.close());
  const row = context.operations.createScratchpad({ name: 'recover' }).workstream;
  context.sessionNotes.create(row.id, 'preserve');
  const body = { target: row.id, kind: 'notes', destination: join(root, 'recovered'), copy: true };
  const preview = context.storageRelocation.preview(body);
  assert.throws(() => context.storageRelocation.apply({ ...body, revision: preview.revision }), /interrupted after copy/);
  assert.throws(() => context.sessionNotes.create(row.id, 'must wait'), /interrupted relocation/);
  const ledger = context.storageMigration.ledger().find((item) => item.kind === 'relocation');
  assert.equal(ledger.status, 'interrupted');
  assert.equal(context.storageRelocation.recover({ migrationId: ledger.id }).status, 'complete');
  assert.equal(context.sessionNotes.scan(row.id).length, 1);
});

test('a copied data directory cannot claim the original instance identity', (t) => {
  const { config, root } = fixture(t);
  const context = createApplicationContext({ config, runProcess: noProcess });
  context.operations.createScratchpad({ name: 'original' });
  context.close();
  const other = structuredClone(config);
  other.paths.data = join(root, 'copied-data'); mkdirSync(other.paths.data);
  copyFileSync(join(config.paths.data, 'workstreams.db'), join(other.paths.data, 'workstreams.db'));
  assert.throws(() => createApplicationContext({ config: other, runProcess: noProcess }), /offline rebind/);
});
