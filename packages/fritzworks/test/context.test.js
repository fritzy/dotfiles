import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { openDb, createScratchpad, writeBrowserUiState } from '../lib/core.js';
import { ensureSessionPanelGroup } from '../lib/panels.js';

import { createApiService } from '../lib/api.js';
import { createApplicationContext } from '../lib/context.js';
import { resolveConfig } from '../lib/config.js';
import { configRevision, daemonEnvironment } from '../lib/runtime-config.js';
import { browserTerminalSessionName, ensureBrowserTerminalSession, resetAllBrowserTerminalSessions } from '../lib/zellij.js';
import { acquireDaemonLock } from '../lib/daemon.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fw-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return (name) => {
    const home = join(root, name);
    mkdirSync(home);
    const configPath = join(home, 'config.ini');
    writeFileSync(configPath, `[paths]\ndata = ./data\nrepositories = ./repositories\nscratchpads = ./scratchpads\nnotes = ./session-documents\n`);
    return resolveConfig({ env: {}, home, configPath });
  };
}

test('two application contexts isolate database, scratchpads, seeds, notes, and lifecycle actions', (t) => {
  const configuration = fixture(t);
  const leftConfig = configuration('left');
  const rightConfig = configuration('right');
  const left = createApplicationContext({ config: leftConfig });
  const right = createApplicationContext({ config: rightConfig });
  t.after(() => { left.close(); right.close(); });
  assert.notEqual(left.instanceId, right.instanceId);
  const a = left.operations.createScratchpad({ name: 'ideas', seed: 'left seed' }).workstream;
  const b = right.operations.createScratchpad({ name: 'ideas', seed: 'right seed' }).workstream;
  assert.equal(a.id, b.id);
  assert.notEqual(a.uuid, b.uuid);
  assert.equal(a.path, join(leftConfig.paths.scratchpads, 'ideas'));
  assert.equal(b.path, join(rightConfig.paths.scratchpads, 'ideas'));
  assert.match(readFileSync(join(leftConfig.paths.data, 'seeds', `${a.id}.md`), 'utf8'), /left seed/);
  assert.match(readFileSync(join(rightConfig.paths.data, 'seeds', `${b.id}.md`), 'utf8'), /right seed/);
  const leftNote = left.operations.createNote(a.id, { body: 'left note' });
  const rightNote = right.operations.createNote(b.id, { body: 'right note' });
  assert.ok(leftNote.path.startsWith(leftConfig.paths.notes + '/'));
  assert.ok(rightNote.path.startsWith(rightConfig.paths.notes + '/'));
  assert.equal(left.operations.notes(a.id).notes.length, 1);
  const target = left.resolveTarget(a.id);
  assert.deepEqual(target, { kind: 'session', id: a.uuid });
  left.operations.execute(target, 'archive', {});
  assert.equal(left.operations.list({ id: a.id, status: 'all' }).items[0].status, 'closed');
  assert.equal(existsSync(b.path), true);
  left.operations.execute(target, 'resume', {});
  assert.equal(existsSync(a.path), true);
  assert.notEqual(right.operations.list({ id: b.id }).items[0].status, 'closed');
  leftConfig.paths.notes = '/unrelated';
  assert.equal(left.operations.notes(a.id).notes.length, 1);
  assert.notEqual(browserTerminalSessionName({ sessionId: a.id, namespace: left.terminalNamespace }),
    browserTerminalSessionName({ sessionId: b.id, namespace: right.terminalNamespace }));
});

test('repository creation passes the owning context to an injected Git adapter', (t) => {
  const configuration = fixture(t);
  const calls = [];
  for (const name of ['left', 'right']) {
    const config = configuration(name);
    const context = createApplicationContext({ config,
      adapters: {
        parseSelector: () => ({ branch: 'main', source: 'origin' }),
        materialize: (org, repo, branch, source, options) => {
          calls.push(options.config);
          return join(options.config.paths.repositories, org, repo, branch);
        },
      },
    });
    t.after(() => context.close());
    const created = context.operations.createRepo({ repository: 'example/project', selector: 'main' });
    assert.equal(created.workstream.path, join(config.paths.repositories, 'example', 'project', 'main'));
    assert.equal(calls.at(-1), context.config);
  }
  assert.notEqual(calls[0].paths.repositories, calls[1].paths.repositories);
});

test('instance identity survives reopening and active config requires explicit restart', (t) => {
  const config = fixture(t)('daemon');
  const context = createApplicationContext({ config });
  const id = context.instanceId;
  const namespace = context.terminalNamespace;
  const revision = context.configRevision;
  writeFileSync(config.configPath, '[paths]\ndata = ./data\nnotes = ./other-notes\n');
  assert.equal(context.configurationStatus().restartRequired, true);
  assert.equal(context.configurationStatus().activeRevision, revision);
  assert.equal(context.config.paths.notes, config.paths.notes);
  writeFileSync(config.configPath, '[broken');
  assert.match(context.configurationStatus().error, /invalid section/);
  context.close();
  const reopened = createApplicationContext({ config });
  t.after(() => reopened.close());
  assert.equal(reopened.instanceId, id);
  assert.equal(reopened.terminalNamespace, namespace);
});

test('daemon launch environment selects the same file and effective settings as the caller', (t) => {
  const config = fixture(t)('selected');
  const env = daemonEnvironment(config, {
    PATH: process.env.PATH, FRITZWORKS_CONFIG: '/wrong/config.ini',
    FRITZWORKS_NOTES: '/wrong/notes', FW_DATA_DIR: '/wrong/data', XDG_DATA_HOME: '/wrong/xdg',
  });
  const child = resolveConfig({ env });
  assert.equal(child.configPath, config.configPath);
  assert.equal(configRevision(child), configRevision(config));
  writeFileSync(config.configPath, '[paths]\ndata = ./data\nnotes = ./updated\n');
  assert.equal(resolveConfig({ env }).paths.notes, join(config.home, 'updated'));
});

test('API creates its database from the supplied config and exposes revision status', async (t) => {
  const config = fixture(t)('api');
  const service = createApiService({ config, pollInterval: 0 });
  t.after(() => service.close());
  assert.equal(existsSync(join(config.paths.data, 'workstreams.db')), true);
  service.context.operations.createScratchpad({ name: 'test' });
  assert.equal(service.context.operations.list({}).total, 1);
});

test('typed references separate session and location identities', (t) => {
  const config = fixture(t)('typed');
  config.locations = { example: { id: 'example', path: config.home, repo: 'example/project' } };
  const context = createApplicationContext({ config });
  t.after(() => context.close());
  const session = context.operations.createScratchpad({ name: 'example' }).workstream;
  assert.deepEqual(context.resolveTarget('example'), { kind: 'location', id: 'example' });
  assert.deepEqual(context.resolveTarget({ kind: 'session', id: 'example' }), { kind: 'session', id: session.uuid });
  assert.throws(() => context.resolveTarget({ kind: 'operation', id: 'example' }), /target must/);
});

test('one owner lock protects a data directory across foreground and detached entry points', (t) => {
  const configuration = fixture(t);
  const config = configuration('owner');
  const other = configuration('other');
  const release = acquireDaemonLock(config);
  t.after(release);
  assert.throws(() => acquireDaemonLock(config), /already owned/);
  const releaseOther = acquireDaemonLock(other);
  releaseOther();
  release();
  acquireDaemonLock(config)();
});

test('new terminal namespaces reset only their own sessions and propagate config into private layouts', (t) => {
  const config = fixture(t)('terminal');
  const context = createApplicationContext({ config });
  t.after(() => context.close());
  const own = browserTerminalSessionName({ namespace: context.terminalNamespace, sessionId: 1 });
  const other = 'fw-other-browser-shell-1';
  const calls = [];
  const run = (args) => {
    calls.push(args);
    return { status: 0, stdout: args[0] === 'list-sessions' ? `${own}\n${other}\nfw-browser-shell-1\n` : '' };
  };
  assert.deepEqual(resetAllBrowserTerminalSessions({ namespace: context.terminalNamespace, run }).sessions, [own]);
  ensureBrowserTerminalSession({ namespace: context.terminalNamespace, sessionId: 2 }, {
    command: ['sh'], cwd: config.home, runtimeDir: join(config.paths.data, 'runtime'),
    env: context.environment, run,
  });
  const layout = calls.find((args) => args.includes('override-layout')).at(-1);
  assert.ok(layout.startsWith(config.paths.data + '/runtime/'));
  const text = readFileSync(layout, 'utf8');
  assert.ok(text.includes(`FRITZWORKS_CONFIG=${config.configPath}`));
  assert.ok(text.includes(`FRITZWORKS_INSTANCE_ID=${context.instanceId}`));
});

for (const supplied of [false, true]) {
  test(`preinitialized databases isolate terminal namespaces (${supplied ? 'supplied handles' : 'CLI-first'})`, (t) => {
    const configuration = fixture(t);
    const values = [];
    for (const name of ['left', 'right']) {
      const config = configuration(name);
      const db = openDb(join(config.paths.data, 'workstreams.db'));
      if (!supplied) db.close();
      const context = createApplicationContext({ config, ...(supplied ? { db } : {}) });
      assert.equal(context.terminalOwnership.status, 'owned');
      values.push({ config, namespace: context.terminalNamespace, id: context.instanceId });
      context.close();
      if (supplied) db.close();
    }
    assert.notEqual(values[0].namespace, values[1].namespace);
    assert.notEqual(values[0].id, values[1].id);
    for (const value of values) {
      const reopened = createApplicationContext({ config: value.config });
      assert.equal(reopened.terminalNamespace, value.namespace);
      reopened.close();
    }
  });
}

test('an erroneous shared namespace on an empty database is repaired without legacy adoption', (t) => {
  const config = fixture(t)('empty');
  const db = openDb(join(config.paths.data, 'workstreams.db'));
  db.exec("CREATE TABLE application_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO application_metadata VALUES ('terminalNamespace', 'fw')");
  const context = createApplicationContext({ config, db });
  t.after(() => db.close());
  assert.notEqual(context.terminalNamespace, 'fw');
  assert.equal(context.terminalOwnership.status, 'owned');
});

test('legacy terminal records are preserved and quarantined until ownership can be verified', (t) => {
  const configuration = fixture(t);
  const namespaces = [];
  for (const name of ['left', 'right']) {
    const config = configuration(name);
    const db = openDb(join(config.paths.data, 'workstreams.db'));
    const row = createScratchpad(db, 'legacy', config);
    ensureSessionPanelGroup(db, { id: row.id, type: 'scratchpad', name: row.branch, path: row.path }, { roles: ['shell', 'agent'] });
    const before = db.prepare('SELECT * FROM panels ORDER BY id').all();
    const context = createApplicationContext({ config, db });
    namespaces.push(context.terminalNamespace);
    assert.equal(context.terminalOwnership.status, 'migration_required');
    assert.deepEqual(context.terminalOwnership.panelIds, before.map(({ id }) => id));
    assert.throws(() => context.assertTerminalOwnership(), (error) => error.status === 409);
    assert.throws(() => context.operations.execute(row.id, 'archive', {}), /ownership requires migration/);
    assert.deepEqual(db.prepare('SELECT * FROM panels ORDER BY id').all(), before);
    db.close();
    const reopened = createApplicationContext({ config });
    assert.equal(reopened.terminalOwnership.status, 'migration_required');
    assert.deepEqual(reopened.terminalOwnership.panelIds, context.terminalOwnership.panelIds);
    reopened.close();
  }
  assert.notEqual(namespaces[0], namespaces[1]);
});

test('pre-panel browser terminal records also require ownership migration', (t) => {
  const config = fixture(t)('browser-state');
  const db = openDb(join(config.paths.data, 'workstreams.db'));
  t.after(() => db.close());
  writeBrowserUiState(db, 'bottom-terminals', { terminals: [{ id: 'old-terminal' }] });
  const context = createApplicationContext({ config, db });
  assert.equal(context.terminalOwnership.status, 'migration_required');
  assert.deepEqual(context.terminalOwnership.browserScopes, ['bottom-terminals']);
});
