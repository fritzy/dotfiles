import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  agentCommand,
  agentInvocation,
  browserAgentSessionName,
  browserTerminalSessionName,
  ensureBrowserTerminalSession,
  killBrowserTerminalSession,
  resetAllBrowserTerminalSessions,
  resetBrowserTerminalSession,
} from '../lib/zellij.js';

const baseConfig = {
  commands: {
    shell: ['fish', '--login'],
    editor: ['nvim', '--clean'],
    claude: ['claude'],
    codex: ['codex'],
  },
  agent: 'claude',
  models: {
    claude: { default: 'opus', scratch: 'sonnet' },
    codex: { default: null, scratch: null },
  },
  locations: {
    savefiles: { id: 'savefiles', path: '/tmp/savefiles' },
  },
};

const row = { id: 7, org: 'example', repo: 'project', branch: 'feature/test', source: 'origin', path: '/tmp/project' };

test('browser agent commands resume cwd-scoped sessions and fall back to new sessions', () => {
  assert.equal(
    agentCommand(row, {}, baseConfig),
    "FRITZWORKS_ID='7' 'claude' '--model' 'opus' '--continue' || FRITZWORKS_ID='7' 'claude' '--model' 'opus'",
  );
  assert.equal(
    agentCommand(row, { agent: 'codex', model: 'gpt-test' }, baseConfig),
    "FRITZWORKS_ID='7' 'codex' '--model' 'gpt-test' 'resume' '--last' || FRITZWORKS_ID='7' 'codex' '--model' 'gpt-test'",
  );
});

test('browser agent invocations resolve the provider and model without a shell', () => {
  assert.deepEqual(agentInvocation(row, { agent: 'codex', model: 'gpt-test' }, baseConfig), {
    provider: 'codex', command: 'codex', args: ['--model', 'gpt-test'],
  });
});

test('configured locations use the lightweight agent model', () => {
  const configured = { id: 'savefiles', path: '/tmp/savefiles' };
  assert.equal(
    agentCommand(configured, {}, baseConfig),
    "FRITZWORKS_ID='savefiles' 'claude' '--model' 'sonnet' '--continue' || FRITZWORKS_ID='savefiles' 'claude' '--model' 'sonnet'",
  );
});

test('browser terminal session names are stable and compact', () => {
  assert.equal(browserTerminalSessionName({ sessionId: 7, role: 'shell' }), 'fw-browser-shell-7');
  assert.equal(browserAgentSessionName(7), 'fw-browser-agent-7');
  assert.equal(
    browserTerminalSessionName({ terminalId: 'terminal-client-42' }),
    'fw-browser-terminal-terminal-client-42',
  );
  const long = browserTerminalSessionName({
    terminalId: 'terminal-7b1d9222-8f54-4aed-9a64-c8d1fa67b6ef',
  });
  assert.equal(Buffer.byteLength(long) <= 48, true);
  assert.match(long, /^fw-browser-terminal-h-[a-f0-9]{24}$/);
});

test('browser terminals recreate a missing session and reuse a live one', () => {
  const identity = { terminalId: 'terminal-restart' };
  const session = browserTerminalSessionName(identity);
  const calls = [];
  let live = false;
  const run = (args, options) => {
    calls.push({ args, options });
    if (args[0] === 'list-sessions') {
      return live
        ? { status: 0, stdout: `${session}\n`, stderr: '' }
        : { status: 1, stdout: '', stderr: 'No active zellij sessions found.' };
    }
    if (args.includes('--create-background')) live = true;
    if (args[0] === 'kill-session') live = false;
    return { status: 0, stdout: '', stderr: '' };
  };

  assert.deepEqual(
    ensureBrowserTerminalSession(identity, { command: ['zsh', '-l'], cwd: '/tmp', run }),
    { session, created: true },
  );
  assert.deepEqual(calls[1], { args: ['delete-session', session], options: undefined });
  assert.deepEqual(calls[2], {
    args: ['--config', '/tmp/fw-browser-terminal-config.kdl', 'attach', '--create-background', session],
    options: { cwd: '/tmp' },
  });
  assert.deepEqual(
    ensureBrowserTerminalSession(identity, { command: ['zsh', '-l'], cwd: '/tmp', run }),
    { session, created: false },
  );
  assert.equal(killBrowserTerminalSession(identity, { run }), true);
});

test('failed browser layout creation deletes the stock session snapshot', () => {
  const identity = { sessionId: 'broken', role: 'agent' };
  const session = browserTerminalSessionName(identity);
  const calls = [];
  assert.throws(
    () => ensureBrowserTerminalSession(identity, {
      command: ['claude'],
      cwd: '/tmp/broken',
      run: (args, options) => {
        calls.push({ args, options });
        if (args[0] === 'list-sessions') {
          return { status: 1, stdout: '', stderr: 'No active zellij sessions found.' };
        }
        if (args.includes('override-layout')) return { status: 1, stdout: '', stderr: 'layout rejected' };
        return { status: 0, stdout: '', stderr: '' };
      },
    }),
    /failed to lay out browser terminal session.*layout rejected/,
  );
  assert.deepEqual(calls.at(-1), {
    args: ['delete-session', '--force', session],
    options: undefined,
  });
});

test('browser terminals reconnect to legacy sessions, including hashed panel names', () => {
  const panelId = 'panel-7b1d9222-8f54-4aed-9a64-c8d1fa67b6ef';
  const digest = createHash('sha256').update(`ws-browser-panel-dotfiles-${panelId}`).digest('hex').slice(0, 24);
  for (const [identity, session] of [
    [{ sessionId: 'dotfiles', role: 'agent' }, 'ws-browser-agent-dotfiles'],
    [{ sessionId: 'dotfiles', panelId }, `ws-browser-panel-h-${digest}`],
  ]) {
    const calls = [];
    const run = (args) => {
      calls.push(args);
      return { status: 0, stdout: `${session} [Created 5days ago]\n`, stderr: '' };
    };
    assert.deepEqual(ensureBrowserTerminalSession(identity, { run }), { session, created: false });
    assert.deepEqual(calls, [['list-sessions', '--no-formatting']]);
    assert.equal(killBrowserTerminalSession(identity, { run }), true);
    assert.deepEqual(calls.at(-1), ['kill-session', session]);
  }
});

test('browser terminal resets only FritzWorks persistence sessions', () => {
  const oneCalls = [];
  assert.deepEqual(
    resetBrowserTerminalSession({ sessionId: 'dotfiles', role: 'agent' }, {
      run: (args) => { oneCalls.push(args); return { status: 0, stdout: '', stderr: '' }; },
    }),
    { session: 'fw-browser-agent-dotfiles', reset: true },
  );
  assert.deepEqual(oneCalls, [
    ['delete-session', '--force', 'fw-browser-agent-dotfiles'],
    ['delete-session', '--force', 'ws-browser-agent-dotfiles'],
  ]);

  const calls = [];
  const all = resetAllBrowserTerminalSessions({
    run: (args) => {
      calls.push(args);
      if (args[0] === 'list-sessions') {
        return {
          status: 0,
          stdout: [
            'fw-browser-shell-7 [Created 1m ago] (current)',
            'ordinary-zellij [Created 2m ago]',
            'fw-browser-agent-7 [Created 3m ago] (EXITED - attach to resurrect)',
            'ws-browser-agent-dotfiles [Created 5days ago]',
          ].join('\n'),
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(all.sessions, ['fw-browser-shell-7', 'fw-browser-agent-7', 'ws-browser-agent-dotfiles']);
  assert.equal(calls.flat().includes('ordinary-zellij'), false);
});
