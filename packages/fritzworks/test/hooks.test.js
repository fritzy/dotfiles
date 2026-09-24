import assert from 'node:assert/strict';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  AGENT_HOOK_COMMAND,
  agentHookStatus,
  installAgentHooks,
  installShellHooks,
  recordAgentHook,
  recordShellHook,
  shellHookStatus,
} from '../lib/hooks.js';

test('hook installation preserves existing hooks and is idempotent', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'fritzworks-hooks-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const claudeDir = join(home, '.claude');
  mkdirSync(claudeDir);
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
    theme: 'existing',
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'existing-stop-hook' }] }],
    },
  }));

  const command = 'fw hook agent-status';
  const installed = installAgentHooks({ home, env: {}, command });
  assert.deepEqual(installed.map(({ provider, added }) => ({ provider, added })), [
    { provider: 'claude', added: 6 },
    { provider: 'codex', added: 5 },
  ]);
  assert.deepEqual(installAgentHooks({ home, env: {}, command }).map(({ added }) => added), [0, 0]);
  assert.deepEqual(agentHookStatus({ home, env: {}, command }).map(({ provider, installed: present }) => ({
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
  assert.match(readFileSync(join(home, '.zshrc'), 'utf8'), /fritzworks\/shell\.zsh/);
  assert.equal(lstatSync(join(home, '.zshrc')).isSymbolicLink(), true);
});

test('activity hooks send only inherited identity with a bounded daemon request', async () => {
  const sent = [];
  const env = { FRITZWORKS_ID: 'location-custom', FRITZWORKS_INSTANCE_ID: 'instance-a',
    FRITZWORKS_TERMINAL_ID: 'terminal-a', FRITZWORKS_GENERATION: 'generation-a', FRITZWORKS_DAEMON_URL: 'http://127.0.0.1:9999',
    FRITZWORKS_PROVIDER: 'codex', FRITZWORKS_HOOK_EMITTER: 'shell-1', FRITZWORKS_HOOK_SEQUENCE: '42' };
  const fetchImpl = async (url, options) => {
    sent.push({ url: String(url), ...options, body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ updated: true }) };
  };
  assert.deepEqual(await recordAgentHook({ hook_event_name: 'UserPromptSubmit', cwd: '/work/custom' }, { env, fetchImpl }), { updated: true });
  assert.equal(sent[0].url, 'http://127.0.0.1:9999/hooks/events');
  assert.equal(sent[0].body.provider, 'codex');
  assert.equal(sent[0].body.sessionId, 'location-custom');
  assert.equal(sent[0].body.generation, 'generation-a');
  assert.equal(sent[0].body.status, 'working');
  assert.equal(sent[0].body.terminalId, 'terminal-a');
  assert.notEqual(sent[0].body.sequence, 42);
  assert.equal(sent[0].body.emitterId, 'codex:terminal-a');
  await recordShellHook('ready', { env, fetchImpl });
  assert.equal(sent[1].body.provider, 'shell');
  assert.equal(sent[1].body.sequence, 42);
  assert.equal(sent[1].body.emitterId, 'shell-1');
  assert.notEqual(sent[0].body.eventId, sent[1].body.eventId);
  const stalled = await recordShellHook('ready', { env, timeoutMs: 5, fetchImpl: () => new Promise(() => {}) });
  assert.equal(stalled.reason, 'daemon unavailable');
  assert.deepEqual(await recordShellHook('idle', { env, fetchImpl }), { updated: false, reason: 'unsupported status' });
});

test('hook upgrades replace legacy commands and shell sources without duplicating handlers', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'fritzworks-hook-upgrade-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  installAgentHooks({ home, env: {}, command: 'ws hook agent-status' });
  assert.deepEqual(installAgentHooks({ home, env: {} }).map(({ added }) => added), [0, 0]);
  assert.ok(agentHookStatus({ home, env: {} }).every(({ installed }) => installed));
  for (const file of ['.claude/settings.json', '.codex/hooks.json']) {
    const settings = readFileSync(join(home, file), 'utf8');
    assert.doesNotMatch(settings, /ws hook/);
    assert.ok(settings.includes(JSON.stringify(AGENT_HOOK_COMMAND).slice(1, -1)));
  }
  const configHome = join(home, '.config');
  writeFileSync(join(home, '.zshrc'), `# keep this\n# ai-workstream shell status hook\nsource '${configHome}/ai-workstream/shell.zsh'\n`);
  installShellHooks({ home, configHome });
  assert.equal(installShellHooks({ home, configHome }).added, 0);
  const rc = readFileSync(join(home, '.zshrc'), 'utf8');
  assert.match(rc, /# keep this/);
  assert.doesNotMatch(rc, /ai-workstream/);
  assert.equal(rc.split('\n').filter((line) => line.startsWith('source ')).length, 1);
  assert.equal(shellHookStatus({ home, configHome }).installed, true);
});

test('hooks without generation evidence never fall back to local persistence or launch a daemon', async () => {
  const options = { env: { AI_WORKSTREAM_ID: 'old-location' }, fetchImpl: () => { throw new Error('must not send'); } };
  assert.deepEqual(await recordAgentHook({ hook_event_name: 'PostToolUse', cwd: '/elsewhere' }, options), { updated: false, reason: 'missing daemon identity' });
  assert.deepEqual(await recordShellHook('ready', options), { updated: false, reason: 'missing daemon identity' });
});

test('shell installation recognizes the conditional source already in dotfiles', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'fritzworks-shell-source-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const rc = '[ -f "$HOME/.config/fritzworks/shell.zsh" ] && source "$HOME/.config/fritzworks/shell.zsh"\n';
  writeFileSync(join(home, '.zshrc'), rc);
  const options = { home, configHome: join(home, '.config') };
  assert.equal(installShellHooks(options).added, 0);
  assert.equal(readFileSync(join(home, '.zshrc'), 'utf8'), rc);
  assert.equal(shellHookStatus(options).installed, true);
});


test('setup replaces its recorded hook command after changing Node paths', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'fritzworks-hook-node-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const options = { home, env: {}, providers: ['codex'] };
  const oldCommand = "'/old/node' --no-warnings '/checkout/cli.js' hook agent-status";
  const [first] = installAgentHooks({ ...options, command: oldCommand });
  assert.equal(installAgentHooks(options)[0].added, 0);
  const settings = JSON.parse(readFileSync(first.path, 'utf8'));
  assert.equal(settings.hooks.Stop.length, 1);
  assert.equal(settings.hooks.Stop[0].hooks[0].command, AGENT_HOOK_COMMAND);
  assert.equal(readFileSync(`${first.path}.fritzworks-command`, 'utf8'), AGENT_HOOK_COMMAND);
});
