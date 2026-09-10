import assert from 'node:assert/strict';
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
    "AI_WORKSTREAM_ID='7' 'claude' '--model' 'opus' '--continue' || AI_WORKSTREAM_ID='7' 'claude' '--model' 'opus'",
  );
  assert.equal(
    agentCommand(row, { agent: 'codex', model: 'gpt-test' }, baseConfig),
    "AI_WORKSTREAM_ID='7' 'codex' '--model' 'gpt-test' 'resume' '--last' || AI_WORKSTREAM_ID='7' 'codex' '--model' 'gpt-test'",
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
    "AI_WORKSTREAM_ID='savefiles' 'claude' '--model' 'sonnet' '--continue' || AI_WORKSTREAM_ID='savefiles' 'claude' '--model' 'sonnet'",
  );
});

test('browser terminal session names are stable and compact', () => {
  assert.equal(browserTerminalSessionName({ sessionId: 7, role: 'shell' }), 'ws-browser-shell-7');
  assert.equal(browserAgentSessionName(7), 'ws-browser-agent-7');
  assert.equal(
    browserTerminalSessionName({ terminalId: 'terminal-client-42' }),
    'ws-browser-terminal-terminal-client-42',
  );
  const long = browserTerminalSessionName({
    terminalId: 'terminal-7b1d9222-8f54-4aed-9a64-c8d1fa67b6ef',
  });
  assert.equal(Buffer.byteLength(long) <= 48, true);
  assert.match(long, /^ws-browser-terminal-h-[a-f0-9]{24}$/);
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
    args: ['--config', '/tmp/ws-browser-terminal-config.kdl', 'attach', '--create-background', session],
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

test('browser terminal resets only FritzWorks persistence sessions', () => {
  const oneCalls = [];
  assert.deepEqual(
    resetBrowserTerminalSession({ sessionId: 'dotfiles', role: 'agent' }, {
      run: (args) => { oneCalls.push(args); return { status: 0, stdout: '', stderr: '' }; },
    }),
    { session: 'ws-browser-agent-dotfiles', reset: true },
  );
  assert.deepEqual(oneCalls, [['delete-session', '--force', 'ws-browser-agent-dotfiles']]);

  const calls = [];
  const all = resetAllBrowserTerminalSessions({
    run: (args) => {
      calls.push(args);
      if (args[0] === 'list-sessions') {
        return {
          status: 0,
          stdout: [
            'ws-browser-shell-7 [Created 1m ago] (current)',
            'ordinary-zellij [Created 2m ago]',
            'ws-browser-agent-7 [Created 3m ago] (EXITED - attach to resurrect)',
          ].join('\n'),
          stderr: '',
        };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.deepEqual(all.sessions, ['ws-browser-shell-7', 'ws-browser-agent-7']);
  assert.equal(calls.flat().includes('ordinary-zellij'), false);
});
