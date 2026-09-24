import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveConfig } from '../lib/config.js';
import { diagnose } from '../lib/doctor.js';
import { agentHookStatus, installAgentHooks, installShellHooks, uninstallAgentHooks, uninstallShellHooks } from '../lib/hooks.js';
import { installCommandLinks, manageSkills, setupCheckout, setupConfig } from '../lib/setup.js';

function temporary(t) {
  const home = mkdtempSync(join(tmpdir(), 'fw-setup-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test('setup preserves user configuration and skills remove only unchanged owned files', (t) => {
  const home = temporary(t);
  const env = { XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), CODEX_HOME: join(home, 'codex'), CLAUDE_CONFIG_DIR: join(home, 'claude') };
  const config = resolveConfig({ home, env });
  assert.equal(setupConfig({ config }).created, true);
  writeFileSync(config.configPath, 'agent = codex\n');
  assert.equal(setupConfig({ config }).created, false);
  assert.equal(readFileSync(config.configPath, 'utf8'), 'agent = codex\n');
  const options = { home, env, providers: ['codex'] };
  const installed = manageSkills('install', options);
  assert.equal(installed.length, 2);
  assert.ok(installed.every(({ path }) => path.startsWith(env.CODEX_HOME)));
  assert.equal(existsSync(join(env.CLAUDE_CONFIG_DIR, 'skills')), false);
  assert.ok(manageSkills('install', options).every(({ status }) => status === 'installed'));
  writeFileSync(installed[0].path, 'user customization');
  const removed = manageSkills('uninstall', options);
  assert.equal(removed[0].status, 'preserved or absent');
  assert.equal(readFileSync(installed[0].path, 'utf8'), 'user customization');
  assert.equal(existsSync(installed[1].path), false);
  assert.ok(manageSkills('uninstall', options).every(({ status }) => status === 'preserved or absent'));
});

test('hook removal respects client overrides, unrelated handlers, and unowned shell sources', (t) => {
  const home = temporary(t);
  const options = { home, env: { CODEX_HOME: join(home, 'custom-codex') }, providers: ['codex'] };
  const [installed] = installAgentHooks(options);
  assert.equal(installed.path, join(home, 'custom-codex', 'hooks.json'));
  const settings = JSON.parse(readFileSync(installed.path, 'utf8'));
  settings.theme = 'keep';
  settings.hooks.Stop[0].hooks.push({ type: 'command', command: 'unrelated' });
  writeFileSync(installed.path, JSON.stringify(settings));
  assert.equal(uninstallAgentHooks(options)[0].removed, 5);
  assert.equal(uninstallAgentHooks(options)[0].removed, 0);
  assert.equal(agentHookStatus(options)[0].installed, false);
  const remaining = JSON.parse(readFileSync(installed.path, 'utf8'));
  assert.equal(remaining.theme, 'keep');
  assert.deepEqual(remaining.hooks.Stop[0].hooks, [{ type: 'command', command: 'unrelated' }]);
  assert.ok(existsSync(`${installed.path}.fritzworks-backup`));
  const shellOptions = { home, configHome: join(home, 'config') };
  writeFileSync(join(home, '.zshrc'), '# keep\n');
  const shell = installShellHooks(shellOptions);
  assert.equal(uninstallShellHooks(shellOptions).removed, true);
  assert.equal(existsSync(shell.path), false);
  assert.match(readFileSync(join(home, '.zshrc'), 'utf8'), /# keep/);
  assert.equal(uninstallShellHooks(shellOptions).removed, false);
});

test('doctor explains a missing native module and missing prerequisites without starting the daemon', async (t) => {
  const home = temporary(t);
  const env = { PATH: '', XDG_CONFIG_HOME: home, XDG_DATA_HOME: home };
  const config = resolveConfig({ home, env });
  const result = await diagnose({ config, env,
    loadPty() { throw new Error('missing binary'); },
    status: async () => ({ running: false }),
  });
  assert.equal(result.ok, false);
  assert.match(result.checks.find(({ name }) => name === 'node-pty').detail, /npm rebuild node-pty/);
  assert.equal(result.checks.find(({ name }) => name === 'Git').level, 'error');
  assert.equal(existsSync(config.paths.data), false);
});


test('checkout setup detects clients, merges integrations, and preserves MCP registrations on rerun', (t) => {
  const home = temporary(t);
  const env = { PATH: '', SHELL: '/bin/zsh', CODEX_HOME: join(home, 'codex'), XDG_CONFIG_HOME: join(home, 'config') };
  const program = join(home, 'codex-cli');
  writeFileSync(program, '#!/bin/sh\n', { mode: 0o755 });
  const config = resolveConfig({ home, env });
  config.commands.codex = [program];
  let registered = false;
  const calls = [];
  const run = (command, args) => {
    calls.push([command, args]);
    if (args[1] === 'get') return { status: registered ? 0 : 1 };
    registered = true;
    return { status: 0 };
  };
  const first = setupCheckout({ config, env, run });
  assert.deepEqual(first.providers, ['codex']);
  assert.equal(first.hooks[0].added, 5);
  assert.equal(first.registrations[0].status, 'MCP registered');
  assert.equal(first.shellHooks.installed, true);
  const second = setupCheckout({ config, env, run });
  assert.equal(second.config.created, false);
  assert.equal(second.hooks[0].added, 0);
  assert.equal(second.shellHooks.added, 0);
  assert.equal(second.registrations[0].status, 'existing MCP registration preserved');
  assert.equal(calls.filter(([, args]) => args[1] === 'add').length, 1);
  assert.ok(calls.find(([, args]) => args[1] === 'add')[1].includes(process.execPath));
  assert.ok(first.commands.every(({ path, target }) => readlinkSync(path) === target));
  assert.equal(existsSync(join(home, '.claude')), false);
});

test('checkout setup refuses command collisions before editing integrations', (t) => {
  const home = temporary(t);
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  const path = join(home, '.local', 'bin', 'fw');
  writeFileSync(path, 'unrelated command');
  assert.throws(() => installCommandLinks({ home }), /preserving existing command/);
  assert.equal(readFileSync(path, 'utf8'), 'unrelated command');
  assert.equal(existsSync(join(home, '.local', 'bin', 'fw-mcp')), false);
});
