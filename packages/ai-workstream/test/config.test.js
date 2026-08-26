import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DEFAULT_CONFIG_PATH, parseIni, resolveConfig } from '../lib/config.js';

test('user INI configuration layers over the bundled defaults and environment overrides', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-workstream-config-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const configPath = join(dir, 'config.ini');
  writeFileSync(configPath, `
panels = shell, agent
agent = codex
gitProtocol = https

[paths]
repositories = ./repos
notes = ~/writing

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
      AI_WORKSTREAM_PANELS: 'editor,agent',
      AI_WORKSTREAM_SHELL: '["fish","--login"]',
    },
  });

  assert.equal(config.paths.repositories, join(dir, 'repos'));
  assert.equal(config.paths.notes, '/users/example/writing');
  assert.equal(config.paths.data, '/var/example-data/ws');
  assert.equal(config.paths.scratchpads, '/users/example/scratchpad');
  assert.deepEqual(config.panels, ['editor', 'agent']);
  assert.deepEqual(config.commands.shell, ['fish', '--login']);
  assert.deepEqual(config.commands.editor, ['nvim', '--clean']);
  assert.deepEqual(config.commands.codex, ['/opt/codex']);
  assert.equal(config.agent, 'codex');
  assert.equal(config.models.claude.default, null);
  assert.equal(config.models.claude.scratch, 'sonnet');
  assert.equal(config.gitProtocol, 'https');
  assert.equal(config.defaultConfigPath, DEFAULT_CONFIG_PATH);
  assert.equal(config.configPath, configPath);
});

test('configuration rejects unknown panels and agents', () => {
  const base = { configPath: '/tmp/does-not-exist-ai-workstream.ini', home: '/users/example' };
  assert.throws(
    () => resolveConfig({ ...base, env: { AI_WORKSTREAM_PANELS: 'shell,browser' } }),
    /unknown panel/,
  );
  assert.throws(
    () => resolveConfig({ ...base, env: { AI_WORKSTREAM_AGENT: 'other' } }),
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
  assert.equal(config.configPath, '/var/example-config/ai-workstream/config.ini');
  assert.equal(config.paths.data, '/var/example-data/ws');
  assert.deepEqual(config.panels, ['shell', 'editor', 'agent']);
});

test('INI parser reports malformed input with its source and line', () => {
  assert.throws(() => parseIni('[paths]\nrepositories', 'broken.ini'), /broken\.ini:2: expected key = value/);
  assert.throws(() => parseIni('[bad section]', 'broken.ini'), /broken\.ini:1: invalid section name/);
});
