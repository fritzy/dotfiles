import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createApplicationContext } from '../lib/context.js';
import { resolveConfig } from '../lib/config.js';
import { openDb, upsertWorkstream } from '../lib/core.js';

const noProcess = () => assert.fail('test must never spawn a process');

function fixture(t, { legacy = false, protocol = 'ssh' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fw-storage-review-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const configPath = join(root, 'config.ini');
  writeFileSync(configPath, `${legacy ? '' : 'configVersion = 2\n'}gitProtocol = ${protocol}\n[paths]\ndata = ./data\nrepositories = ./cache\nscratchpads = ./scratch\n${legacy ? 'notes = ./notes' : 'worktrees = ./trees\nsessionNotes = ./writing'}\n`);
  return { root, config: resolveConfig({ home: root, env: {}, configPath }) };
}

function mockGit() {
  const refs = new Set();
  const trees = new Map();
  const calls = [];
  const state = { remoteStatus: 0, remoteError: null, bare: true, extraListing: '', localCommon: null };
  const run = (command, args) => {
    assert.equal(command, 'git'); calls.push(args);
    const good = (stdout = '') => ({ status: 0, stdout });
    if (args[0] === 'clone') { mkdirSync(args.at(-1)); return good(); }
    if (args.includes('--is-bare-repository')) return good(String(state.bare));
    if (args.includes('rev-parse')) {
      const common = trees.get(args[1])?.common || state.localCommon;
      return common ? good(common) : { status: 128, stderr: 'worktree unavailable' };
    }
    if (args.includes('symbolic-ref')) return good(trees.get(args[1]).branch);
    if (args.includes('check-ref-format')) return good();
    if (args.includes('show-ref')) return { status: refs.has(args.at(-1)) ? 0 : 1 };
    if (args.includes('ls-remote')) return { status: state.remoteStatus, error: state.remoteError, stderr: 'remote unavailable' };
    if (args.includes('fetch')) { refs.add(args.at(-1).split(':').at(-1)); return good(); }
    if (args.includes('list')) return good([...trees].map(([path, tree]) => `worktree ${path}\nbranch refs/heads/${tree.branch}\n`).join('\n') + state.extraListing);
    if (args.includes('add')) {
      const at = args.indexOf('add');
      const isNew = args[at + 1] === '-b';
      const branch = args[at + 2];
      const path = args[at + (isNew ? 3 : 1)];
      mkdirSync(path); trees.set(path, { common: args[1], branch }); refs.add(`refs/heads/${branch}`);
      return good();
    }
    assert.fail(`unexpected mocked Git command: ${args.join(' ')}`);
  };
  return { refs, trees, calls, state, run };
}

test('relocation rejects exact, nested, parent and symlink-alias note reservations', (t) => {
  const { root, config } = fixture(t);
  const context = createApplicationContext({ config, runProcess: noProcess });
  t.after(() => context.close());
  const a = context.operations.createScratchpad({ name: 'a' }).workstream;
  const b = context.operations.createScratchpad({ name: 'b' }).workstream;
  const note = context.sessionNotes.create(a.id, 'owned by a');
  const reservedParent = join(root, 'reserved');
  const reserved = join(reservedParent, 'b');
  context.db.prepare('UPDATE storage_owners SET notes_path=?,notes_reads=?,notes_canonical=?,notes_anchor=NULL WHERE uuid=?')
    .run(reserved, JSON.stringify([reserved]), reserved, b.uuid);
  const before = context.db.prepare('SELECT * FROM storage_owners ORDER BY owner_key').all();
  const body = { target: a.id, kind: 'notes' };
  for (const destination of [reserved, join(reserved, 'nested'), reservedParent]) {
    assert.throws(() => context.storageRelocation.preview({ ...body, destination }), /reserved storage/);
  }
  mkdirSync(reservedParent);
  symlinkSync(reservedParent, join(root, 'alias'));
  assert.throws(() => context.storageRelocation.preview({ ...body, destination: join(root, 'alias', 'b') }), /reserved storage/);
  assert.deepEqual(context.db.prepare('SELECT * FROM storage_owners ORDER BY owner_key').all(), before);
  assert.equal(existsSync(reserved), false);
  assert.equal(readFileSync(note.path, 'utf8'), 'owned by a\n');
  assert.equal(context.sessionNotes.scan(b.id).length, 0);
});

test('relocation honors legacy read directories, managed worktrees and pending destinations', (t) => {
  const { root, config } = fixture(t);
  const context = createApplicationContext({ config, runProcess: noProcess });
  t.after(() => context.close());
  const row = context.operations.createScratchpad({ name: 'move' }).workstream;
  context.sessionNotes.create(row.id, 'keep');
  const read = join(root, 'old-notes');
  context.db.prepare('INSERT INTO storage_owners (owner_key,uuid,notes_reads) VALUES (?,?,?)').run('location:old', 'old', JSON.stringify([read]));
  const tree = join(root, 'reserved-tree');
  const cache = join(root, 'reserved-cache');
  context.db.prepare('INSERT INTO repository_storage VALUES (?,?,?,?,?)').run('repo', 'source', cache, 'url', 2);
  context.db.prepare('INSERT INTO worktree_storage VALUES (?,?,?,?,?,?,?)').run('other-tree', 'repo', tree, 'topic', 'origin', 2, 'removed');
  const pending = join(root, 'pending');
  context.db.prepare('INSERT INTO storage_migrations (id,kind,status,plan_json,updated_at) VALUES (?,?,?,?,?)')
    .run('other-move', 'relocation', 'interrupted', JSON.stringify({ destination: pending, source: join(root, 'old-source') }), 'now');
  for (const destination of [read, tree, join(cache, 'nested'), join(pending, 'nested')]) {
    assert.throws(() => context.storageRelocation.preview({ target: row.id, kind: 'notes', destination }), /reserved storage/);
  }
});

test('relocation recovery rechecks reservations acquired after its preview', (t) => {
  const { root, config } = fixture(t);
  const context = createApplicationContext({ config, runProcess: noProcess, adapters: { storageRelocation: {
    liveNames: () => [], copy: () => { throw new Error('interrupted before copy'); },
  } } });
  t.after(() => context.close());
  const row = context.operations.createScratchpad({ name: 'move' }).workstream;
  const note = context.sessionNotes.create(row.id, 'preserved');
  const body = { target: row.id, kind: 'notes', destination: join(root, 'late-reservation'), copy: true };
  const preview = context.storageRelocation.preview(body);
  assert.throws(() => context.storageRelocation.apply({ ...body, revision: preview.revision }), /interrupted before copy/);
  const migration = context.storageMigration.ledger().find(({ kind }) => kind === 'relocation');
  context.db.prepare('INSERT INTO storage_owners (owner_key,uuid,notes_path,notes_reads) VALUES (?,?,?,?)')
    .run('location:later', 'later', body.destination, JSON.stringify([body.destination]));
  assert.throws(() => context.storageRelocation.recover({ migrationId: migration.id }), /reserved storage/);
  assert.equal(existsSync(body.destination), false);
  assert.equal(readFileSync(note.path, 'utf8'), 'preserved\n');
  assert.equal(context.db.prepare('SELECT notes_path FROM storage_owners WHERE uuid=?').get(row.uuid).notes_path, row.notesPath);
});

function legacyFixture(t) {
  const fixtureData = fixture(t, { legacy: true });
  const { config } = fixtureData;
  mkdirSync(config.paths.notes);
  const container = join(config.paths.repositories, 'team', 'project');
  const common = join(container, '.bare');
  mkdirSync(common, { recursive: true });
  const db = openDb(join(config.paths.data, 'workstreams.db'));
  const row = upsertWorkstream(db, { org: 'team', repo: 'project', branch: 'feature/kept', source: 'origin',
    path: join(container, 'feature-kept'), status: 'closed', created_at: 'now', last_joined_at: 'now' });
  db.prepare("UPDATE workstreams SET status='closed' WHERE id=?").run(row.id);
  row.status = 'closed';
  const fake = mockGit(); fake.refs.add(`refs/heads/${row.branch}`);
  const context = createApplicationContext({ config, db, runProcess: fake.run });
  t.after(() => db.close());
  return { ...fixtureData, row, common, fake, context };
}

test('closed removed legacy worktrees migrate, rerun and resume from retained local branches', (t) => {
  const { context, row, common, fake } = legacyFixture(t);
  const preview = context.storageMigration.inventory();
  assert.deepEqual(preview.errors, []);
  assert.equal(preview.worktrees[0].status, 'removed');
  assert.equal(preview.worktrees[0].common_dir, common);
  const applied = context.storageMigration.apply({ revision: preview.revision });
  assert.equal(context.gitStorage.record(row.uuid).status, 'removed');
  assert.equal(context.storageMigration.recover({ migrationId: applied.migrationId }).status, 'complete');
  const again = context.storageMigration.inventory();
  assert.deepEqual(again.errors, []);
  context.storageMigration.apply({ revision: again.revision });
  context.operations.execute(row.id, 'resume', {});
  assert.equal(context.gitStorage.record(row.uuid).status, 'ready');
  assert.equal(existsSync(row.path), true);
  assert.ok(fake.calls.every((args) => !args.includes('clone') && !args.includes('fetch') && !args.includes('ls-remote')));
  assert.deepEqual(fake.calls.find((args) => args.includes('add')), ['--git-dir', common, 'worktree', 'add', row.path, row.branch]);
});

test('migration reruns retain volume anchors for adopted but uncreated note directories', (t) => {
  const { context, config, row, root } = legacyFixture(t);
  context.storageMigration.apply({ revision: context.storageMigration.inventory().revision });
  const before = context.db.prepare('SELECT * FROM storage_owners WHERE uuid=?').get(row.uuid);
  assert.equal(before.notes_created, 0);
  assert.ok(before.notes_anchor);
  assert.equal(existsSync(before.notes_path), false);
  context.storageMigration.apply({ revision: context.storageMigration.inventory().revision });
  const after = context.db.prepare('SELECT * FROM storage_owners WHERE uuid=?').get(row.uuid);
  assert.equal(after.notes_canonical, before.notes_canonical);
  assert.equal(after.notes_anchor, before.notes_anchor);
  renameSync(config.paths.notes, join(root, 'unmounted-notes'));
  assert.throws(() => context.sessionNotes.create(row.id, 'must wait'), /unavailable/);
  assert.equal(existsSync(config.paths.notes), false);
});

test('missing legacy worktrees remain blocked when removal evidence is ambiguous', async (t) => {
  const cases = {
    'active row': ({ context, row }) => context.db.prepare("UPDATE workstreams SET status='paused' WHERE id=?").run(row.id),
    'missing cache volume': ({ common }) => renameSync(dirname(common), `${dirname(common)}-unmounted`),
    'unexpected layout': ({ context, row, root }) => context.db.prepare('UPDATE workstreams SET path=? WHERE id=?').run(join(root, 'elsewhere'), row.id),
    'missing branch': ({ fake }) => fake.refs.clear(),
    'non-bare cache': ({ fake }) => { fake.state.bare = false; },
    'stale worktree registration': ({ row, fake }) => { fake.state.extraListing = `worktree ${row.path}\nbranch refs/heads/${row.branch}\n`; },
    'branch registered elsewhere': ({ root, row, fake }) => { fake.state.extraListing = `worktree ${join(root, 'other')}\nbranch refs/heads/${row.branch}\n`; },
    'dangling checkout symlink': ({ row, root }) => symlinkSync(join(root, 'absent-volume'), row.path),
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, (t) => {
    const data = legacyFixture(t); change(data);
    const preview = data.context.storageMigration.inventory();
    assert.ok(preview.errors.length > 0);
    assert.throws(() => data.context.storageMigration.apply({ revision: preview.revision }));
    assert.equal(data.context.gitStorage.record(data.row.uuid), undefined);
    assert.ok(data.fake.calls.every((args) => !args.includes('add') && !args.includes('fetch')));
  });
});

test('remote branches are refreshed, while local branches and explicit bases avoid network', async (t) => {
  const cases = [
    { name: 'branch added after clone', kind: 'url', expected: 'refs/remotes/origin/topic', network: true },
    { name: 'adopted tracking branch', kind: 'legacy', tracking: true, expected: 'refs/remotes/origin/topic', network: true },
    { name: 'existing local branch', kind: 'url', local: true, expected: null, network: false },
    { name: 'explicit parent', kind: 'url', base: 'parent', expected: 'parent', network: false },
    { name: 'local repository snapshot', kind: 'local', tracking: true, expected: 'refs/remotes/origin/topic', network: false },
    { name: 'new local branch', kind: 'local', expected: 'HEAD', network: false },
    { name: 'new remote branch', kind: 'url', remoteStatus: 2, expected: 'HEAD', network: true },
  ];
  for (const item of cases) await t.test(item.name, (t) => {
    const { root, config } = fixture(t);
    const fake = mockGit(); fake.state.remoteStatus = item.remoteStatus ?? 0;
    if (item.local) fake.refs.add('refs/heads/topic');
    if (item.tracking) fake.refs.add('refs/remotes/origin/topic');
    const context = createApplicationContext({ config, runProcess: fake.run });
    t.after(() => context.close());
    const common = join(root, 'retained-cache'); mkdirSync(common);
    const path = join(root, 'checkout');
    context.db.prepare('INSERT INTO repository_storage VALUES (?,?,?,?,?)').run('repo', 'explicit-source', common, item.kind, 1);
    context.db.prepare('INSERT INTO worktree_storage VALUES (?,?,?,?,?,?,?)').run('uuid', 'repo', path, 'topic', 'origin', 1, 'removed');
    context.gitStorage.materialize({ uuid: 'uuid', branch: 'topic', source: 'origin' }, { base: item.base });
    const add = fake.calls.find((args) => args.includes('add'));
    assert.deepEqual(add.slice(4), item.local ? [path, 'topic'] : ['-b', 'topic', path, item.expected]);
    assert.equal(fake.calls.some((args) => args.includes('ls-remote')), item.network);
    assert.equal(fake.calls.some((args) => args.includes('fetch')), item.network && item.remoteStatus !== 2);
    if (item.network && item.remoteStatus !== 2) {
      assert.ok(fake.calls.some((args) => args.at(-1) === '+refs/heads/topic:refs/remotes/origin/topic'));
    }
  });
});

test('remote lookup authentication and process errors never fall back to HEAD', async (t) => {
  for (const error of [{ status: 128 }, { status: 0, error: new Error('spawn denied') }]) await t.test(String(error.status), (t) => {
    const { config } = fixture(t);
    const fake = mockGit(); fake.state.remoteStatus = error.status; fake.state.remoteError = error.error;
    const context = createApplicationContext({ config, runProcess: fake.run });
    t.after(() => context.close());
    assert.throws(() => context.operations.createRepo({ repository: 'https://example.invalid/repo.git', selector: 'topic' }), /remote unavailable|spawn denied/);
    assert.equal(fake.calls.some((args) => args.includes('add')), false);
  });
});

test('GitHub shorthand and fork URLs honor the owning protocol, explicit URLs stay literal', async (t) => {
  for (const protocol of ['ssh', 'https']) await t.test(protocol, (t) => {
    const { config } = fixture(t, { protocol });
    const fake = mockGit(); fake.state.remoteStatus = 2;
    const context = createApplicationContext({ config, runProcess: fake.run,
      adapters: { parseSelector: (_org, _repo, selector) => selector.startsWith('fork:')
        ? { branch: selector.slice(5), source: 'fork:contributor' } : { branch: selector, source: 'origin' } } });
    t.after(() => context.close());
    const url = (owner) => protocol === 'ssh' ? `git@github.com:${owner}/project.git` : `https://github.com/${owner}/project.git`;
    context.operations.createRepo({ repository: 'team/project', selector: 'topic' });
    assert.equal(fake.calls.find((args) => args[0] === 'clone')[3], url('team'));
    context.operations.createRepo({ repository: 'team/project', selector: 'fork:fork-topic' });
    assert.ok(fake.calls.some((args) => args.includes('fetch') && args[3] === url('contributor')));
    const explicit = protocol === 'ssh' ? 'https://example.invalid/explicit.git' : 'git@example.invalid:explicit.git';
    context.operations.createRepo({ repository: explicit, selector: 'literal' });
    assert.equal(fake.calls.filter((args) => args[0] === 'clone').at(-1)[3], explicit);
  });
});
