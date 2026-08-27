import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  configuredLocationAgentStatus,
  configuredLocationShellStatus,
  openDb,
  resolveRow,
  upsertWorkstream,
} from '../lib/core.js';
import {
  agentHookStatus,
  installAgentHooks,
  installShellHooks,
  recordAgentHook,
  recordShellHook,
  shellHookStatus,
} from '../lib/hooks.js';

test('hook installation preserves existing hooks and is idempotent', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ai-workstream-hooks-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir);
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
    theme: 'existing',
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'existing-stop-hook' }] }],
    },
  }));

  const command = 'ws hook agent-status';
  const installed = installAgentHooks({ home, command });
  assert.deepEqual(installed.map(({ provider, added }) => ({ provider, added })), [
    { provider: 'claude', added: 6 },
    { provider: 'codex', added: 5 },
  ]);
  assert.deepEqual(installAgentHooks({ home, command }).map(({ added }) => added), [0, 0]);
  assert.deepEqual(agentHookStatus({ home, command }).map(({ provider, installed: present }) => ({
    provider, installed: present,
  })), [
    { provider: 'claude', installed: true },
    { provider: 'codex', installed: true },
  ]);

  const claude = JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8'));
  assert.equal(claude.theme, 'existing');
  assert.equal(claude.hooks.Stop[0].hooks[0].command, 'existing-stop-hook');
  assert.equal(claude.hooks.Stop[1].hooks[0].command, command);
  assert.equal(claude.hooks.Notification.at(-1).matcher, 'idle_prompt|permission_prompt');

  const dotfilesDir = join(home, 'dotfiles');
  mkdirSync(dotfilesDir);
  writeFileSync(join(dotfilesDir, '.zshrc'), '# existing zsh config\n');
  symlinkSync(join('dotfiles', '.zshrc'), join(home, '.zshrc'));
  const shell = installShellHooks({ home, configHome: join(home, '.config') });
  assert.equal(shell.added, 1);
  assert.equal(shell.updated, true);
  assert.equal(installShellHooks({ home, configHome: join(home, '.config') }).added, 0);
  assert.equal(shellHookStatus({ home, configHome: join(home, '.config') }).installed, true);
  assert.match(readFileSync(shell.path, 'utf8'), /add-zsh-hook preexec/);
  assert.match(readFileSync(join(home, '.zshrc'), 'utf8'), /ai-workstream\/shell\.zsh/);
  assert.equal(lstatSync(join(home, '.zshrc')).isSymbolicLink(), true);
});

test('agent lifecycle hooks update the correct workstream', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-workstream-hook-events-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(join(dir, 'workstreams.db'));
  t.after(() => db.close());
  const row = upsertWorkstream(db, {
    org: 'example', repo: 'project', branch: 'hook-events', source: 'origin',
    path: join(dir, 'project'), created_at: '2026-08-26T12:00:00.000Z',
    last_joined_at: '2026-08-26T12:00:00.000Z',
  });

  assert.deepEqual(recordAgentHook({ hook_event_name: 'UserPromptSubmit', cwd: '/elsewhere' }, {
    db, env: { AI_WORKSTREAM_ID: String(row.id) },
  }), { updated: true, id: row.id, status: 'working' });
  assert.equal(resolveRow(db, String(row.id)).agent_status, 'working');

  assert.deepEqual(recordAgentHook({ hook_event_name: 'PermissionRequest', cwd: row.path }, {
    db, env: {},
  }), { updated: true, id: row.id, status: 'ready' });
  assert.deepEqual(recordAgentHook({ hook_event_name: 'PostToolUse', cwd: row.path }, {
    db, env: {},
  }), { updated: true, id: row.id, status: 'working' });

  assert.deepEqual(recordAgentHook({ hook_event_name: 'Stop', cwd: row.path }, {
    db, env: {},
  }), { updated: true, id: row.id, status: 'ready' });
  assert.equal(resolveRow(db, String(row.id)).agent_status, 'ready');

  assert.deepEqual(recordShellHook('working', {
    db, env: { AI_WORKSTREAM_ID: String(row.id) }, cwd: '/elsewhere',
  }), { updated: true, id: row.id, status: 'working' });
  assert.equal(resolveRow(db, String(row.id)).shell_status, 'working');
  assert.deepEqual(recordShellHook('ready', { db, env: {}, cwd: row.path }), {
    updated: true, id: row.id, status: 'ready',
  });
  assert.equal(resolveRow(db, String(row.id)).shell_status, 'ready');

  const config = {
    locations: {
      savefiles: { id: 'savefiles', path: '/configured/savefiles/' },
      notes: { id: 'notes', path: '/configured/notes/' },
    },
  };
  assert.deepEqual(recordAgentHook({ hook_event_name: 'UserPromptSubmit', cwd: '/elsewhere' }, {
    db, env: { AI_WORKSTREAM_ID: 'savefiles' }, config,
  }), { updated: true, id: 'savefiles', status: 'working' });
  assert.equal(configuredLocationAgentStatus(db, 'savefiles'), 'working');

  assert.deepEqual(recordAgentHook({ hook_event_name: 'Stop', cwd: '/elsewhere' }, {
    db, env: { AI_WORKSTREAM_ID: 'savefiles' }, config,
  }), { updated: true, id: 'savefiles', status: 'ready' });
  assert.equal(configuredLocationAgentStatus(db, 'savefiles'), 'ready');

  assert.deepEqual(recordShellHook('working', {
    db, env: { AI_WORKSTREAM_ID: 'savefiles' }, config, cwd: '/elsewhere',
  }), { updated: true, id: 'savefiles', status: 'working' });
  assert.equal(configuredLocationShellStatus(db, 'savefiles'), 'working');
  assert.deepEqual(recordShellHook('ready', {
    db, env: {}, config, cwd: '/configured/notes/work',
  }), { updated: true, id: 'notes', status: 'ready' });
  assert.equal(configuredLocationShellStatus(db, 'notes'), 'ready');
  assert.deepEqual(recordShellHook('idle', { db, env: {}, config, cwd: row.path }), {
    updated: false, reason: 'unsupported status',
  });

  assert.deepEqual(recordAgentHook({ hook_event_name: 'UserPromptSubmit', cwd: '/configured/notes/work' }, {
    db,
    env: {},
    config,
  }), { updated: true, id: 'notes', status: 'working' });
  assert.equal(configuredLocationAgentStatus(db, 'notes'), 'working');

  assert.deepEqual(recordAgentHook({ hook_event_name: 'PostToolUseFailure', cwd: row.path }, {
    db, env: {},
  }), { updated: false, reason: 'unsupported event' });
});
