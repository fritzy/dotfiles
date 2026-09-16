import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DEFAULT_CONFIG_PATH, parseIni, resolveConfig } from '../lib/config.js';

test('user INI configuration layers over the bundled defaults and environment overrides', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fritzworks-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.ini');
  writeFileSync(configPath, `
agent = codex
gitProtocol = https

[paths]
repositories = ./repos
notes = ~/writing

[locations.dotfiles]
repo = example/dotfiles
path = ./settings
branch = trunk

[locations.savefiles]
repo = example/savefiles
path = ~/savefiles

[commands]
editor = ["nvim", "--clean"]
codex = /opt/codex

[models.claude]
default =
`);

  const config = resolveConfig({
    configPath,
    home: '/users/example',
    env: {
      XDG_DATA_HOME: '/var/example-data',
      FRITZWORKS_SHELL: '["fish","--login"]',
      FRITZWORKS_PORT: '7444',
    },
  });

  assert.equal(config.paths.repositories, join(dir, 'repos'));
  assert.equal(config.paths.notes, '/users/example/writing');
  assert.deepEqual(config.locations.notes, {
    id: 'notes', name: 'notes', repo: 'fritzy/notes', path: '/users/example/writing', branch: 'main',
    closeable: false,
  });
  assert.deepEqual(config.locations.dotfiles, {
    id: 'dotfiles', name: 'dotfiles', repo: 'example/dotfiles', path: join(dir, 'settings'), branch: 'trunk',
    closeable: false,
  });
  assert.deepEqual(config.locations.savefiles, {
    id: 'savefiles', name: 'savefiles', repo: 'example/savefiles', path: '/users/example/savefiles', branch: 'main',
    closeable: false,
  });
  assert.equal(config.paths.dotfiles, join(dir, 'settings'));
  assert.equal(config.paths.data, '/var/example-data/fritzworks');
  assert.equal(config.paths.scratchpads, '/users/example/scratchpad');
  assert.deepEqual(config.commands.shell, ['fish', '--login']);
  assert.deepEqual(config.commands.editor, ['nvim', '--clean']);
  assert.deepEqual(config.commands.codex, ['/opt/codex']);
  assert.equal(config.agent, 'codex');
  assert.equal(config.models.claude.default, null);
  assert.equal(config.models.claude.scratch, 'sonnet');
  assert.equal(config.gitProtocol, 'https');
  assert.deepEqual(config.server, { host: '127.0.0.1', port: 7444, pollInterval: 1000 });
  assert.deepEqual(config.daemons.workstation, {
    id: 'workstation', name: 'Workstation', url: 'http://127.1.1.2:7337',
  });
  assert.equal(config.defaultConfigPath, DEFAULT_CONFIG_PATH);
  assert.equal(config.configPath, configPath);
});

test('daemons are named remote endpoints validated as absolute URLs, with "local" reserved', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'fritzworks-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.ini');
  writeFileSync(configPath, `
[daemons.staging]
url = https://staging.example.com:9000/
`);
  const config = resolveConfig({ configPath, home: '/users/example' });
  assert.deepEqual(config.daemons.staging, {
    id: 'staging', name: 'Staging', url: 'https://staging.example.com:9000',
  });
  assert.deepEqual(config.daemons.workstation, {
    id: 'workstation', name: 'Workstation', url: 'http://127.1.1.2:7337',
  });

  const badUrl = join(dir, 'bad-url.ini');
  writeFileSync(badUrl, '[daemons.staging]\nurl = not-a-url\n');
  assert.throws(
    () => resolveConfig({ configPath: badUrl, home: '/users/example' }),
    /daemons\.staging\.url must be a valid absolute URL/,
  );

  const reserved = join(dir, 'reserved.ini');
  writeFileSync(reserved, '[daemons.local]\nurl = http://example.com\n');
  assert.throws(
    () => resolveConfig({ configPath: reserved, home: '/users/example' }),
    /daemons\.local is reserved/,
  );
});

test('configuration rejects unknown agents', () => {
  const base = { configPath: '/tmp/does-not-exist-fritzworks.ini', home: '/users/example' };
  assert.throws(
    () => resolveConfig({ ...base, env: { FRITZWORKS_AGENT: 'other' } }),
    /unknown agent/,
  );
});

test('default user path follows XDG_CONFIG_HOME and the bundled data path follows XDG_DATA_HOME', () => {
  const config = resolveConfig({
    home: '/users/example',
    env: {
      XDG_CONFIG_HOME: '/var/example-config',
      XDG_DATA_HOME: '/var/example-data',
    },
  });
  assert.equal(config.configPath, '/var/example-config/fritzworks/config.ini');
  assert.equal(config.paths.data, '/var/example-data/fritzworks');
  assert.equal(config.locations.notes.repo, 'fritzy/notes');
  assert.equal(config.locations.notes.branch, 'main');
  assert.equal(config.locations.dotfiles.repo, 'fritzy/dotfiles');
  assert.deepEqual(Object.keys(config.locations), ['notes', 'dotfiles']);
  assert.equal(config.server.port, 7337);
  assert.deepEqual(Object.keys(config.daemons), ['workstation']);
  assert.equal(config.daemons.workstation.url, 'http://127.1.1.2:7337');
});

test('INI parser reports malformed input with its source and line', () => {
  assert.throws(() => parseIni('[paths]\nrepositories', 'broken.ini'), /broken\.ini:2: expected key = value/);
  assert.throws(() => parseIni('[bad section]', 'broken.ini'), /broken\.ini:1: invalid section name/);
  assert.deepEqual(parseIni('[location]\nenabled = true', 'boolean.ini'), { location: { enabled: true } });
});

test('upgrades reuse legacy config and data while explicit and new paths take precedence', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'fritzworks-upgrade-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const configHome = join(home, 'config');
  const dataHome = join(home, 'data');
  const legacyConfig = join(configHome, 'ai-workstream', 'config.ini');
  const newConfig = join(configHome, 'fritzworks', 'config.ini');
  const legacyData = join(dataHome, 'ws');
  mkdirSync(join(configHome, 'ai-workstream'), { recursive: true });
  mkdirSync(legacyData, { recursive: true });
  writeFileSync(legacyConfig, 'agent = codex\n[paths]\nrepositories = ./repos\n');
  writeFileSync(join(legacyData, 'workstreams.db'), 'existing database');
  const options = { home, env: { XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome } };
  let config = resolveConfig(options);
  assert.equal(config.configPath, legacyConfig);
  assert.equal(config.agent, 'codex');
  assert.equal(config.paths.repositories, join(configHome, 'ai-workstream', 'repos'));
  assert.equal(config.paths.data, legacyData);

  mkdirSync(join(configHome, 'fritzworks'));
  writeFileSync(newConfig, 'agent = claude\n');
  config = resolveConfig(options);
  assert.equal(config.configPath, newConfig);
  assert.equal(config.agent, 'claude');
  assert.equal(config.paths.data, legacyData);
  config = resolveConfig({ ...options, env: { ...options.env, FW_DATA_DIR: join(home, 'override') } });
  assert.equal(config.paths.data, join(home, 'override'));
  writeFileSync(newConfig, '[paths]\ndata = ./explicit-data\n');
  assert.equal(resolveConfig(options).paths.data, join(configHome, 'fritzworks', 'explicit-data'));
  writeFileSync(newConfig, '');
  mkdirSync(join(dataHome, 'fritzworks'));
  assert.equal(resolveConfig(options).paths.data, join(dataHome, 'fritzworks'));
});
