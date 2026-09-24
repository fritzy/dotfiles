import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { resolveConfig, parseIni } from '../lib/config.js';
import { createApplicationContext } from '../lib/context.js';
import { createApiService } from '../lib/api.js';
import { daemonEnvironment, configRevision } from '../lib/runtime-config.js';
import { setupConfig } from '../lib/setup.js';
import { readPanelLayout } from '../lib/panels.js';
import { branchState } from '../web-v2/src/utils.js';

function fixture(t, text = 'configVersion = 2\n') {
  const home = mkdtempSync(join(tmpdir(), 'fw-standalone-config-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const configPath = join(home, 'config.ini');
  writeFileSync(configPath, text);
  return { home, configPath, env: {} };
}

function request(service, path, { method = 'GET', body = {} } = {}) {
  return new Promise((resolve) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method, url: path, headers: { host: 'localhost' } });
    let status;
    service.server.emit('request', req, {
      writeHead(value) { status = value; },
      end(value) { resolve({ status, body: JSON.parse(value) }); },
    });
  });
}

test('v2 neutral roots follow data, have no general notes root, and do not create directories', (t) => {
  const options = fixture(t, 'configVersion = 2\n[paths]\ndata = ./state\n');
  const config = resolveConfig(options);
  for (const name of ['repositories', 'worktrees', 'scratchpads']) assert.equal(config.paths[name], join(options.home, 'state', name));
  assert.equal(config.paths.sessionNotes, join(options.home, 'state', 'session-notes'));
  assert.equal(config.paths.notes, undefined);
  assert.equal(config.paths.dotfiles, undefined);
  assert.deepEqual(config.locations, {});
  assert.deepEqual(config.daemons, {});
  assert.deepEqual(config.notes.weekly, { enabled: false, root: null });
  assert.equal(existsSync(config.paths.data), false);
  assert.deepEqual(config.sources['paths.worktrees'], { kind: 'derived', from: 'paths.data' });
  assert.equal(config.storage.sessionNotes, 'persistent');
});

test('notes and dotfiles are ordinary plain locations with independent names and storage', (t) => {
  const options = fixture(t, `configVersion = 2
[paths]
sessionNotes = ./session documents
worktrees = ./git trees
[locations.notes]
name = Reference material
path = ./reference
[locations.dotfiles]
name = Settings
path = ./settings
`);
  const config = resolveConfig(options);
  assert.equal(config.locations.notes.repo, null);
  assert.equal(config.locations.notes.branch, null);
  assert.equal(config.locations.notes.name, 'Reference material');
  assert.equal(config.locations.dotfiles.name, 'Settings');
  assert.equal(config.paths.sessionNotes, join(options.home, 'session documents'));
  assert.equal(config.paths.notes, undefined);
  assert.equal(config.paths.dotfiles, undefined);
  assert.equal(existsSync(config.locations.notes.path), false);
});

test('named remote entries merge by ID and enabled false suppresses inherited entries', (t) => {
  const options = fixture(t, `configVersion = 2
[daemons.first]
name = First
url = http://127.0.0.1:7441
[daemons.second]
url = https://127.0.0.1:7442/
[daemons.disabled]
enabled = false
`);
  let config = resolveConfig(options);
  assert.deepEqual(Object.keys(config.daemons), ['first', 'second']);
  assert.equal(config.daemons.second.url, 'https://127.0.0.1:7442');
  const defaults = join(options.home, 'defaults.ini');
  writeFileSync(defaults, readFileSync(config.defaultConfigPath, 'utf8') + '\n[daemons.inherited]\nurl = http://localhost:7443\n[locations.inherited]\npath = ./reference\n');
  writeFileSync(options.configPath, 'configVersion = 2\n[daemons.inherited]\nenabled = false\n[locations.inherited]\nenabled = false\n');
  config = resolveConfig({ ...options, defaultConfigPath: defaults });
  assert.deepEqual(config.daemons, {});
  assert.deepEqual(config.locations, {});
});

test('generic environment overrides report their sources and survive child launch resolution', (t) => {
  const options = fixture(t, 'configVersion = 2\n[paths]\nworktrees = ./file-trees\nsessionNotes = ./file-notes\n');
  options.env = {
    FRITZWORKS_DATA: './runtime-state', FRITZWORKS_WORKTREES: '~/trees', FW_WORKTREES: '~/ignored',
    FRITZWORKS_SESSION_NOTES: './é documents', FRITZWORKS_AGENT: 'codex', FW_AGENT: 'claude',
  };
  const config = resolveConfig(options);
  assert.equal(config.paths.worktrees, join(options.home, 'trees'));
  assert.equal(config.paths.sessionNotes, join(options.home, 'é documents'));
  assert.deepEqual(config.sources['paths.sessionNotes'], { kind: 'environment', key: 'FRITZWORKS_SESSION_NOTES' });
  assert.deepEqual(config.sources.agent, { kind: 'environment', key: 'FRITZWORKS_AGENT' });
  assert.equal(configRevision(resolveConfig({ env: daemonEnvironment(config) })), configRevision(config));
});

test('v2 rejects unknown keys, malformed maps, invalid IDs, missing paths, and old aliases', (t) => {
  const options = fixture(t);
  for (const text of [
    'configVersion = 3', 'configVersion = true', 'configVersion = null', 'configVersion = 2\nunknown = true',
    'configVersion = 2\n[paths]\nnotes = ~/notes',
    'configVersion = 2\n[locations.notes]\nrepo = example/project',
    'configVersion = 2\n[locations.notes]\npath = ./reference\nname = false',
    'configVersion = 2\n[locations.notes]\npath = ./reference\ncloseable = true',
    'configVersion = 2\n[locations.notes]\npath = ./reference\nbranch = main',
    'configVersion = 2\nlocations = []', 'configVersion = 2\n[locations]\nnotes = false',
    'configVersion = 2\n[notes.weekly]\nenabled = true',
    'configVersion = 2\n[daemons.local]\nurl = http://localhost:7000',
    'configVersion = 2\n[daemons.bad]\nurl = http://localhost/prefix',
    'configVersion = 2\n[daemons.bad]\nurl = https://remote.example',
    'configVersion = 2\n[daemons.bad]\nurl = http://user:password@localhost',
    'configVersion = 2\n[models.other]\ndefault = example',
  ]) {
    writeFileSync(options.configPath, text);
    assert.throws(() => resolveConfig(options), undefined, text);
    assert.equal(existsSync(join(options.home, '.local')), false);
  }
  writeFileSync(options.configPath, 'configVersion = 2');
  assert.throws(() => resolveConfig({ ...options, env: { FRITZWORKS_NOTES: '~/old' } }), /legacy notes\/dotfiles/);
  assert.throws(() => parseIni('[locations.constructor]\npath = /tmp'), /invalid section/);
  assert.throws(() => parseIni('agent = claude\nagent = codex'), /duplicate key/);
  const jsonPath = join(options.home, 'bad.json');
  writeFileSync(jsonPath, '{"configVersion":2,"locations":{"123":{"path":"/tmp"}}}');
  assert.throws(() => resolveConfig({ ...options, configPath: jsonPath }), /unknown configuration key/);
});

test('managed root conflicts include nesting, data ownership, and symlink aliases', (t) => {
  const options = fixture(t);
  for (const paths of [
    'repositories = ./same\nworktrees = ./same',
    'repositories = ./same\nworktrees = ./same/child',
    'sessionNotes = ./data\ndata = ./data/state',
  ]) {
    writeFileSync(options.configPath, `configVersion = 2\n[paths]\n${paths}\n`);
    assert.throws(() => resolveConfig(options), /conflicts|must not contain/);
  }
  mkdirSync(join(options.home, 'target'));
  symlinkSync(join(options.home, 'target'), join(options.home, 'alias'));
  writeFileSync(options.configPath, 'configVersion = 2\n[paths]\nrepositories = ./target\nworktrees = ./alias/new\n');
  assert.throws(() => resolveConfig(options), /conflicts/);
});

test('legacy compatibility preserves storage aliases without injecting location IDs into storage', (t) => {
  const options = fixture(t, '[locations.notes]\npath = ./old-notes\n[locations.dotfiles]\npath = ./settings\n');
  const config = resolveConfig(options);
  assert.equal(config.configVersion, 1);
  assert.equal(config.paths.notes, join(options.home, 'old-notes'));
  assert.equal(config.paths.dotfiles, undefined);
  assert.equal(config.notes.weekly.root, config.paths.notes);
  assert.equal(config.notes.weekly.enabled, true);
  assert.equal(config.sources['paths.notes'].kind, 'legacy-alias');
  assert.ok(config.diagnostics.some((message) => message.includes('Legacy locations.notes')));
  assert.throws(() => resolveConfig({ ...options, env: { FRITZWORKS_WORKTREES: './new-trees' } }), /require configVersion = 2/);
});

test('configless v2 identity survives reopening and setup records the selected schema', (t) => {
  const { home } = fixture(t);
  const options = { home, env: {} };
  const config = resolveConfig(options);
  const context = createApplicationContext({ config });
  context.close();
  const reopened = resolveConfig(options);
  assert.equal(reopened.configVersion, 2);
  assert.equal(configRevision(reopened), configRevision(config));
  assert.equal(resolveConfig({ env: daemonEnvironment(config) }).configVersion, 2);
  setupConfig({ config: reopened });
  assert.match(readFileSync(config.configPath, 'utf8'), /configVersion = 2/);
  assert.equal(resolveConfig(options).configVersion, 2);
});

test('plain locations project and resume through HTTP without Git or special labels', async (t) => {
  const options = fixture(t, `configVersion = 2
[locations.notes]
name = Reference
path = ./reference
[locations.dotfiles]
name = Settings
path = ./settings
[locations.git]
path = ./git
`);
  for (const name of ['reference', 'settings', 'git']) mkdirSync(join(options.home, name));
  writeFileSync(join(options.home, 'git', '.git'), 'gitdir: fixture-only');
  const calls = [];
  const config = resolveConfig(options);
  const service = createApiService({ config, pollInterval: 0, checkGit: async (path) => { calls.push(path); return true; } });
  t.after(() => service.close());
  const listing = await request(service, '/fw/all?status=all');
  assert.equal(listing.status, 200);
  assert.deepEqual(listing.body.items.map(({ name }) => name), ['Reference', 'Settings', 'git']);
  assert.equal(listing.body.items[0].repoUrl, null);
  assert.equal(listing.body.items[0].gitPresent, false);
  assert.equal(branchState(listing.body.items[0]).icon, 'folder');
  assert.equal(listing.body.items[2].gitPresent, true);
  for (const id of ['notes', 'dotfiles']) {
    assert.equal((await request(service, `/fw/${id}/resume`, { method: 'POST' })).status, 200);
    assert.equal((await request(service, `/fw/${id}/archive`, { method: 'POST' })).status, 400);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(calls.every((path) => path === join(options.home, 'git')));
  assert.equal(existsSync(config.paths.sessionNotes), false);
  rmSync(join(options.home, 'settings'), { recursive: true });
  assert.equal((await request(service, '/fw/dotfiles/resume', { method: 'POST' })).status, 404);
  assert.equal(existsSync(config.locations.dotfiles.path), false);
  assert.equal(readPanelLayout(service.db).groups.find(({ ownerId }) => ownerId === 'notes').label, 'Reference');
});

test('v2 session notes work independently while weekly notes remain opt-in', async (t) => {
  const options = fixture(t);
  const config = resolveConfig(options);
  const context = createApplicationContext({ config, adapters: {
    parseSelector() { assert.fail('Git selector must not run'); },
    materialize() { assert.fail('Git adapter must not run'); },
  } });
  const service = createApiService({ context, pollInterval: 0 });
  t.after(() => { service.close(); context.close(); });
  assert.equal(context.operations.list({}).total, 0);
  const row = context.operations.createScratchpad({ name: 'ideas' }).workstream;
  assert.equal(row.notesPath, join(config.paths.sessionNotes, row.uuid));
  assert.equal(existsSync(row.notesPath), false);
  assert.equal((await request(service, `/fw/${row.id}/note`, { method: 'POST', body: { body: 'note' } })).status, 201);
  for (const [path, body] of [['/fw/digest', { write: true }]]) {
    assert.equal((await request(service, path, { method: 'POST', body })).status, 409);
  }
  assert.equal((await request(service, '/fw/digest', { method: 'POST' })).status, 200);
  assert.equal((await request(service, `/fw/${row.id}/sync`, { method: 'POST' })).body.notes.unavailable, undefined);
  assert.equal((await request(service, '/notes/weekly', { method: 'POST', body: { kind: 'work' } })).status, 409);
  const defaults = await request(service, '/fw/new');
  assert.equal(defaults.body.repositoryCreation.available, true);
  assert.equal(defaults.body.repositoryRoot, null);
  const layout = await request(service, '/panel-layout');
  const group = layout.body.groups.find(({ ownerId }) => ownerId === String(row.id));
  assert.equal(group.markdownDirectory, row.notesPath);
  const implicit = await request(service, `/panel-layout/groups/${group.id}/resources`, { method: 'POST', body: { kind: 'markdown', content: 'hello', revision: layout.body.revision } });
  assert.equal(implicit.status, 200);
  const nextRevision = (await request(service, '/panel-layout')).body.revision;
  const explicit = await request(service, `/panel-layout/groups/${group.id}/resources`, { method: 'POST', body: { kind: 'markdown', content: 'hello', value: './readme.md', revision: nextRevision } });
  assert.equal(explicit.status, 200);
  assert.equal(readFileSync(join(row.path, 'readme.md'), 'utf8'), 'hello\n');
  assert.equal(existsSync(config.paths.sessionNotes), true);
  assert.equal(existsSync(config.paths.worktrees), false);
  assert.equal(existsSync(config.paths.repositories), false);
  assert.equal(existsSync(join(options.home, 'notes')), false);
});

test('weekly notes use their explicit root independently of session storage and locations', async (t) => {
  const options = fixture(t, 'configVersion = 2\n[notes.weekly]\nenabled = true\nroot = ./weekly\n[locations.notes]\npath = ./reference\n');
  const config = resolveConfig(options);
  const service = createApiService({ config, pollInterval: 0 });
  t.after(() => service.close());
  const weekly = await request(service, '/notes/weekly', { method: 'POST', body: { kind: 'work' } });
  assert.equal(weekly.status, 200);
  assert.equal(existsSync(join(options.home, 'weekly', 'work')), true);
  assert.equal(existsSync(config.paths.sessionNotes), false);
  assert.equal(existsSync(config.locations.notes.path), false);
});

test('config validate and effective reporting are offline and reject invalid files before state creation', (t) => {
  const options = fixture(t, 'configVersion = 2\n[paths]\ndata = ./state\n');
  const run = (args) => spawnSync(process.execPath, [new URL('../cli.js', import.meta.url).pathname, 'config', ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, FRITZWORKS_CONFIG: options.configPath, FRITZWORKS_HOME: options.home },
  });
  const valid = run(['validate']);
  assert.ifError(valid.error);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(JSON.parse(valid.stdout).valid, true);
  const effective = run([]);
  assert.ifError(effective.error);
  assert.equal(effective.status, 0, effective.stderr);
  assert.equal(JSON.parse(effective.stdout).sources['paths.data'].kind, 'file');
  assert.equal(existsSync(join(options.home, 'state')), false);
  writeFileSync(options.configPath, 'configVersion = 2\n[paths]\ndata = ./state\nunknown = ./bad\n');
  const invalid = run(['validate']);
  assert.ifError(invalid.error);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /unknown configuration key paths.unknown/);
  assert.equal(existsSync(join(options.home, 'state')), false);
});


test('CLI-first configless data keeps v2 defaults on later resolution', (t) => {
  const { home } = fixture(t);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { openDb } = await import(${JSON.stringify(new URL('../lib/core.js', import.meta.url).href)});
    openDb().close();
  `], { encoding: 'utf8', env: { PATH: process.env.PATH, FRITZWORKS_HOME: home } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const config = resolveConfig({ home, env: {} });
  assert.equal(config.configVersion, 2);
  assert.equal(config.paths.notes, undefined);
  assert.equal(config.paths.sessionNotes, join(config.paths.data, 'session-notes'));
});

test('legacy location IDs do not consume unrelated environment settings', (t) => {
  const options = fixture(t, ['agent', 'shell', 'editor', 'config', 'Notes', 'Dotfiles']
    .map((id) => `[locations.${id}]\npath = ./projects/${id}\n`).join('\n'));
  for (const prefix of ['FRITZWORKS', 'FW']) {
    const config = resolveConfig({ ...options, env: {
      [`${prefix}_AGENT`]: 'codex',
      [`${prefix}_SHELL`]: '["fish","--login"]',
      [`${prefix}_EDITOR`]: '["nvim","--clean"]',
      [`${prefix}_CONFIG`]: options.configPath,
      [`${prefix}_NOTES`]: './legacy-notes',
      [`${prefix}_DOTFILES`]: './legacy-dotfiles',
    } });
    for (const id of ['agent', 'shell', 'editor', 'config', 'Notes', 'Dotfiles']) {
      assert.equal(config.locations[id].path, join(options.home, 'projects', id));
      assert.deepEqual(config.sources[`locations.${id}.path`], {
        kind: 'file', file: options.configPath, key: `locations.${id}.path`,
      });
    }
    assert.equal(config.agent, 'codex');
    assert.deepEqual(config.commands.shell, ['fish', '--login']);
    assert.deepEqual(config.commands.editor, ['nvim', '--clean']);
  }
});

test('historical notes and dotfiles aliases preserve environment precedence and sources', (t) => {
  const options = fixture(t, `[paths]
notes = ./path-notes
dotfiles = ./path-dotfiles
[locations.notes]
path = ./location-notes
[locations.dotfiles]
path = ./location-dotfiles
`);
  for (const env of [
    {},
    { FW_NOTES: './short-notes', FW_DOTFILES: './short-dotfiles' },
    { FRITZWORKS_NOTES: './long-notes', FRITZWORKS_DOTFILES: './long-dotfiles' },
    { FRITZWORKS_NOTES: './long-notes', FRITZWORKS_DOTFILES: './long-dotfiles', FW_NOTES: './short-notes', FW_DOTFILES: './short-dotfiles' },
  ]) {
    const config = resolveConfig({ ...options, env });
    for (const id of ['notes', 'dotfiles']) {
      const key = [`FRITZWORKS_${id.toUpperCase()}`, `FW_${id.toUpperCase()}`].find((name) => env[name] !== undefined);
      const expected = env[key] || `./path-${id}`;
      assert.equal(config.locations[id].path, join(options.home, expected));
      assert.deepEqual(config.sources[`locations.${id}.path`], key
        ? { kind: 'environment', key }
        : { kind: 'legacy-alias', from: `paths.${id}` });
    }
    assert.equal(config.paths.notes, config.locations.notes.path);
    assert.equal(config.notes.weekly.root, config.paths.notes);
    assert.deepEqual(config.sources['paths.notes'], { kind: 'legacy-alias', from: 'locations.notes.path' });
  }
  writeFileSync(options.configPath, '[locations.notes]\npath = ./location-notes\n[locations.dotfiles]\npath = ./location-dotfiles\n');
  const config = resolveConfig(options);
  for (const id of ['notes', 'dotfiles']) {
    assert.equal(config.locations[id].path, join(options.home, `location-${id}`));
    assert.equal(config.sources[`locations.${id}.path`].kind, 'file');
  }
});

test('directory validation rejects file ancestors and symlink targets before creating daemon state', (t) => {
  const options = fixture(t);
  const file = join(options.home, 'parent-file');
  writeFileSync(file, 'existing file');
  symlinkSync(file, join(options.home, 'file-link'));
  symlinkSync(join(options.home, 'missing-target'), join(options.home, 'dangling-link'));
  const invalidPaths = ['parent-file', 'parent-file/child', 'file-link', 'file-link/child', 'dangling-link/child'];
  for (const version of [1, 2]) {
    const pathNames = version === 2 ? ['data', 'repositories', 'worktrees', 'scratchpads', 'sessionNotes'] : ['data', 'repositories', 'scratchpads', 'notes'];
    const cases = [
      ...pathNames.map((name) => (path) => `[paths]\n${name === 'data' ? '' : 'data = ./state\n'}${name} = ./${path}\n`),
      (path) => `[paths]\ndata = ./state\n[locations.project]\npath = ./${path}\n`,
      (path) => `[paths]\ndata = ./state\n[notes.weekly]\nenabled = true\nroot = ./${path}\n`,
    ];
    for (const body of cases) {
      for (const path of invalidPaths) {
        writeFileSync(options.configPath, `configVersion = ${version}\n${body(path)}`);
        assert.throws(() => {
          const context = createApplicationContext({ config: resolveConfig(options) });
          context.close();
        }, /requires a directory/, `${version}: ${body(path)}`);
        assert.equal(existsSync(join(options.home, 'state')), false);
        assert.equal(existsSync(join(options.home, '.local')), false);
        assert.equal(readFileSync(file, 'utf8'), 'existing file');
      }
    }
  }
});

test('directory validation accepts missing trees beneath real and symlinked directory ancestors', (t) => {
  const options = fixture(t);
  mkdirSync(join(options.home, 'existing'));
  symlinkSync(join(options.home, 'existing'), join(options.home, 'directory-link'));
  for (const version of [1, 2]) {
    writeFileSync(options.configPath, `configVersion = ${version}
[paths]
data = ./missing/state
repositories = ./missing/repositories
scratchpads = ./directory-link/missing/scratchpads
${version === 2 ? 'sessionNotes = ./missing/sessions\nworktrees = ./missing/worktrees' : 'notes = ./missing/legacy-notes'}
[locations.project]
path = ./directory-link/missing/project
[notes.weekly]
enabled = true
root = ./directory-link/missing/weekly
`);
    const config = resolveConfig(options);
    assert.equal(config.paths.scratchpads, join(options.home, 'directory-link', 'missing', 'scratchpads'));
    assert.equal(config.locations.project.path, join(options.home, 'directory-link', 'missing', 'project'));
    assert.equal(config.notes.weekly.root, join(options.home, 'directory-link', 'missing', 'weekly'));
    assert.equal(existsSync(join(options.home, 'missing')), false);
    assert.equal(existsSync(join(options.home, 'existing', 'missing')), false);
  }
});
