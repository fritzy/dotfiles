import assert from 'node:assert/strict';
import test from 'node:test';

import {
  agentCommand,
  closePane,
  closeTabInSession,
  focusAgentInSession,
  openTabInSession,
  openTabNames,
  panelStatesInSession,
  replaceAgentInSession,
  renderLayout,
  togglePanelInSession,
} from '../lib/zellij.js';

const baseConfig = {
  panels: ['shell', 'editor', 'agent'],
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

test('Claude and Codex commands resume cwd-scoped sessions and fall back to new sessions', () => {
  assert.equal(
    agentCommand(row, {}, baseConfig),
    "AI_WORKSTREAM_ID='7' 'claude' '--model' 'opus' '--continue' || AI_WORKSTREAM_ID='7' 'claude' '--model' 'opus'",
  );
  assert.equal(
    agentCommand(row, { agent: 'codex', model: 'gpt-test' }, baseConfig),
    "AI_WORKSTREAM_ID='7' 'codex' '--model' 'gpt-test' 'resume' '--last' || AI_WORKSTREAM_ID='7' 'codex' '--model' 'gpt-test'",
  );
});

test('seeded sessions start fresh and shell-quote the seed path', () => {
  const command = agentCommand(row, { agent: 'codex', seed: "/tmp/user's seed.md" }, baseConfig);
  assert.match(command, /^AI_WORKSTREAM_ID='7' 'codex' /);
  assert.doesNotMatch(command, /resume/);
  assert.match(command, /user/);
  assert.match(command, /seed document/);
});

test('configured locations use the lightweight agent model without hardcoded names', () => {
  const configured = { id: 'savefiles', tab_name: 'savefiles', path: '/tmp/savefiles' };
  assert.equal(
    agentCommand(configured, {}, baseConfig),
    "AI_WORKSTREAM_ID='savefiles' 'claude' '--model' 'sonnet' '--continue' || AI_WORKSTREAM_ID='savefiles' 'claude' '--model' 'sonnet'",
  );
});

test('startup layout contains only the first panel outside a nested pane container', () => {
  const layout = renderLayout(row, {
    agent: 'codex',
    panels: ['editor', 'agent'],
    editorFile: '/tmp/weekly note.md',
  }, baseConfig);

  assert.doesNotMatch(layout, /name="shell"/);
  assert.match(layout, /name="editor" command="nvim"/);
  assert.match(layout, /args "--clean" "\/tmp\/weekly note.md"/);
  assert.doesNotMatch(layout, /name="codex"/);
  assert.doesNotMatch(layout, /pane split_direction=/);
});

test('noEditor removes the editor from the configured panel list', () => {
  const layout = renderLayout(row, { noEditor: true }, baseConfig);
  assert.match(layout, /name="shell"/);
  assert.doesNotMatch(layout, /name="editor"/);
  assert.doesNotMatch(layout, /name="claude"/);
});

test('openTabNames collects tabs from every active Zellij session', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'list-sessions') return { status: 0, stdout: 'alpha\nbeta\n', stderr: '' };
    if (args[1] === 'alpha') return { status: 0, stdout: 'one\nshared\n', stderr: '' };
    return { status: 0, stdout: 'two\nshared\n', stderr: '' };
  };
  assert.deepEqual(openTabNames({ run }), ['one', 'shared', 'two']);
  assert.deepEqual(calls[0], ['list-sessions', '--no-formatting']);
  assert.deepEqual(calls[1], ['--session', 'alpha', 'action', 'query-tab-names']);
  assert.deepEqual(calls[2], ['--session', 'beta', 'action', 'query-tab-names']);
});

test('openTabNames ignores exited, resurrectable Zellij sessions', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'list-sessions') {
      return {
        status: 0,
        stdout: 'old-session [Created 2days ago] (EXITED - attach to resurrect)\nws [Created 5m ago] (current)\n',
        stderr: '',
      };
    }
    return { status: 0, stdout: '7:project:feature-test\n', stderr: '' };
  };

  assert.deepEqual(openTabNames({ run }), ['7:project:feature-test']);
  assert.equal(calls.some((args) => args[1] === 'old-session'), false);
  assert.equal(calls.some((args) => args[1] === 'ws'), true);
});

test('openTabNames tolerates a session closing during the scan but rejects persistent failures', () => {
  let lists = 0;
  const closedDuringScan = (args) => {
    if (args[0] === 'list-sessions') {
      lists++;
      return { status: 0, stdout: lists === 1 ? 'gone\nstill\n' : 'still\n', stderr: '' };
    }
    if (args[1] === 'gone') return { status: 1, stdout: '', stderr: 'not found' };
    return { status: 0, stdout: 'tab\n', stderr: '' };
  };
  assert.deepEqual(openTabNames({ run: closedDuringScan }), ['tab']);

  const persistentFailure = (args) => args[0] === 'list-sessions'
    ? { status: 0, stdout: 'broken\n', stderr: '' }
    : { status: 1, stdout: '', stderr: 'socket error' };
  assert.throws(() => openTabNames({ run: persistentFailure }), /cannot query tabs.*broken/);
});

test('openTabNames trusts a targeted not-found error over a stale session list', () => {
  const run = (args) => {
    if (args[0] === 'list-sessions') {
      return { status: 0, stdout: 'implacable-lake\nws\n', stderr: '' };
    }
    if (args[1] === 'implacable-lake') {
      return {
        status: 1,
        stdout: '',
        stderr: "Session 'implacable-lake' not found. The following sessions are active:\nws\n",
      };
    }
    return { status: 0, stdout: '1:project:feature\n', stderr: '' };
  };

  assert.deepEqual(openTabNames({ run }), ['1:project:feature']);
});

test('openTabInSession creates and focuses a tab without attaching', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'list-sessions') return { status: 0, stdout: 'ws\n', stderr: '' };
    if (args.at(-1) === 'query-tab-names') return { status: 0, stdout: 'dotfiles\n', stderr: '' };
    if (args.includes('new-tab')) return { status: 0, stdout: '7\n', stderr: '' };
    if (args.includes('new-pane')) return { status: 0, stdout: 'terminal_42\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };

  assert.deepEqual(openTabInSession(row, { agent: 'codex' }, {
    run, session: 'ws', config: baseConfig,
  }), {
    tabName: '7:project:feature-test',
    session: 'ws',
    created: true,
    sessionCreated: false,
  });
  assert.equal(calls.some((args) => args.includes('new-tab')), true);
  assert.equal(calls.some((args) => args.includes('new-pane')
    && args.includes('editor') && args.includes('--tab-id') && args.includes('7')), true);
  assert.equal(calls.some((args) => args.includes('new-pane') && args.includes('agent')), true);
  assert.equal(calls.some((args) => args.includes('rename-pane')
    && args.includes('--pane-id') && args.includes('terminal_42') && args.includes('agent')), true);
  assert.equal(calls.some((args) => args.includes('go-to-tab-name')), true);
  assert.equal(calls.some((args) => args[0] === 'attach'), false);
});

test('openTabInSession prefers an attached session over an unattended configured session', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'list-sessions') {
      return { status: 0, stdout: 'chatty [Created 1m ago]\nws [Created 2m ago]\n', stderr: '' };
    }
    if (args.includes('list-clients')) {
      return args[1] === 'chatty'
        ? { status: 0, stdout: 'CLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND\n1 terminal_1 zsh\n', stderr: '' }
        : { status: 0, stdout: 'CLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND\n', stderr: '' };
    }
    if (args.includes('query-tab-names')) return { status: 0, stdout: 'dotfiles\n', stderr: '' };
    if (args.includes('new-tab')) return { status: 0, stdout: '7\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };

  assert.deepEqual(openTabInSession(row, {}, { run }), {
    tabName: '7:project:feature-test',
    session: 'chatty',
    created: true,
    sessionCreated: false,
  });
  assert.equal(calls.some((args) => args[1] === 'chatty' && args.includes('new-tab')), true);
  assert.equal(calls.some((args) => args[1] === 'ws' && args.includes('new-tab')), false);
});

test('focusAgentInSession finds the workstream across sessions and focuses its agent pane', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args[0] === 'list-sessions') return { status: 0, stdout: 'other\nws\n', stderr: '' };
    if (args.at(-1) === 'list-panes' || args.includes('list-panes')) {
      const panes = args[1] === 'other'
        ? [{ id: 42, title: 'codex', tab_name: '7:project:feature-test', is_plugin: false }]
        : [{ id: 3, title: 'shell', tab_name: 'unrelated', is_plugin: false }];
      return { status: 0, stdout: JSON.stringify(panes), stderr: '' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  assert.deepEqual(focusAgentInSession(row, { run, preferredSession: 'ws' }), {
    session: 'other',
    tabName: '7:project:feature-test',
    paneId: 'terminal_42',
  });
  assert.deepEqual(calls.at(-2), [
    '--session', 'other', 'action', 'go-to-tab-name', '7:project:feature-test',
  ]);
  assert.deepEqual(calls.at(-1), [
    '--session', 'other', 'action', 'focus-pane-id', 'terminal_42',
  ]);
});

test('focusAgentInSession treats an already-focused agent pane as success', () => {
  const run = (args) => {
    if (args[0] === 'list-sessions') return { status: 0, stdout: 'ws\n', stderr: '' };
    if (args.includes('list-clients')) {
      return { status: 0, stdout: 'CLIENT_ID ZELLIJ_PANE_ID RUNNING_COMMAND\n1 terminal_1 zsh\n', stderr: '' };
    }
    if (args.includes('list-panes')) {
      return {
        status: 0,
        stdout: JSON.stringify([
          { id: 42, title: 'codex', tab_name: '7:project:feature-test', is_plugin: false },
        ]),
        stderr: '',
      };
    }
    if (args.includes('focus-pane-id')) {
      return { status: 1, stdout: '', stderr: 'Pane Terminal(42) is already focused' };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  assert.deepEqual(focusAgentInSession(row, { run }), {
    session: 'ws',
    tabName: '7:project:feature-test',
    paneId: 'terminal_42',
  });
});

test('closeTabInSession closes the named tab without attaching', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args.includes('list-panes')) {
      return {
        status: 0,
        stdout: JSON.stringify([
          { id: 9, tab_id: 3, title: 'shell', tab_name: 'dotfiles', is_plugin: false },
          { id: 10, tab_id: 7, title: 'shell', tab_name: '7:project:feature-test', is_plugin: false },
        ]),
        stderr: '',
      };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  assert.equal(closeTabInSession(row, { run, session: 'ws' }), true);
  assert.deepEqual(calls.at(-1), [
    '--session', 'ws', 'action', 'close-tab', '--tab-id', '7',
  ]);
  assert.equal(calls.some((args) => args.includes('go-to-tab-name')), false);
  assert.equal(calls.some((args) => args[0] === 'attach'), false);
});

test('detached panel state and toggles target the workstream tab', () => {
  const calls = [];
  const paneList = [
    { id: 10, tab_id: 7, title: 'shell', tab_name: '7:project:feature-test', is_plugin: false },
    { id: 11, tab_id: 7, title: 'claude', tab_name: '7:project:feature-test', is_plugin: false },
    { id: 12, tab_id: 8, title: 'editor', tab_name: 'another-tab', is_plugin: false },
  ];
  const run = (args) => {
    calls.push(args);
    if (args.includes('list-panes')) {
      return { status: 0, stdout: JSON.stringify(paneList), stderr: '' };
    }
    if (args.includes('new-pane')) return { status: 0, stdout: 'terminal_42\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };

  assert.deepEqual(panelStatesInSession(row, { run, session: 'ws' }), {
    tabOpen: true, shell: true, editor: false, agent: true,
  });
  assert.deepEqual(togglePanelInSession(row, 'editor', {}, { run, session: 'ws', config: baseConfig }), {
    panel: 'editor', open: true,
  });
  assert.equal(calls.some((args) => args.includes('go-to-tab-name')), false);
  assert.equal(calls.some((args) => args.includes('new-pane')
    && args.includes('editor') && args.includes('--tab-id') && args.includes('7')), true);
  assert.equal(calls.some((args) => args.includes('rename-pane')
    && args.includes('--pane-id') && args.includes('terminal_42') && args.includes('editor')), true);

  assert.deepEqual(togglePanelInSession(row, 'shell', {}, { run, session: 'ws', config: baseConfig }), {
    panel: 'shell', open: false,
  });
  assert.equal(calls.some((args) => args.includes('close-pane') && args.includes('terminal_10')), true);
});

test('replaceAgentInSession stops the open agent pane and starts the other provider with resume', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args.includes('list-panes')) {
      return {
        status: 0,
        stdout: JSON.stringify([
          { id: 10, tab_id: 7, title: 'shell', tab_name: '7:project:feature-test', is_plugin: false },
          { id: 12, tab_id: 7, title: 'agent', tab_name: '7:project:feature-test', is_plugin: false },
        ]),
        stderr: '',
      };
    }
    if (args.includes('new-pane')) return { status: 0, stdout: 'terminal_99\n', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };

  assert.deepEqual(replaceAgentInSession(row, 'codex', {}, {
    run, session: 'ws', config: baseConfig,
  }), {
    agent: 'codex', tabOpen: true, panelOpen: true, replaced: true, paneId: 'terminal_99',
  });
  const closeIndex = calls.findIndex((args) => args.includes('close-pane'));
  const openIndex = calls.findIndex((args) => args.includes('new-pane'));
  assert.equal(closeIndex < openIndex, true);
  assert.equal(calls[closeIndex].includes('terminal_12'), true);
  assert.equal(calls[openIndex].some((arg) => typeof arg === 'string'
    && arg.includes("'codex' 'resume' '--last'")), true);
  assert.equal(calls.some((args) => args.includes('rename-pane')
    && args.includes('terminal_99') && args.includes('agent')), true);
});

test('closePane uses a typed terminal ID without issuing speculative layout repairs', () => {
  const calls = [];
  const run = (args) => {
    calls.push(args);
    if (args.includes('list-panes')) {
      return {
        status: 0,
        stdout: JSON.stringify([
          { id: 10, title: 'shell', tab_name: '7:project:feature-test', is_plugin: false },
          { id: 11, title: 'editor', tab_name: '7:project:feature-test', is_plugin: false },
          { id: 12, title: 'claude', tab_name: '7:project:feature-test', is_plugin: false },
        ]),
        stderr: '',
      };
    }
    return { status: 0, stdout: '', stderr: '' };
  };

  assert.equal(closePane(row, 'editor', { run }), true);
  assert.deepEqual(calls.find((args) => args.includes('close-pane')), [
    'action', 'close-pane', '--pane-id', 'terminal_11',
  ]);
  assert.equal(calls.some((args) => args.includes('resize')), false);
});
