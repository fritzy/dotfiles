import assert from 'node:assert/strict';
import test from 'node:test';

import { agentCommand, renderLayout } from '../lib/zellij.js';

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
};

const row = { id: 7, org: 'example', repo: 'project', branch: 'feature/test', source: 'origin', path: '/tmp/project' };

test('Claude and Codex commands resume cwd-scoped sessions and fall back to new sessions', () => {
  assert.equal(
    agentCommand(row, {}, baseConfig),
    "'claude' '--model' 'opus' '--continue' || 'claude' '--model' 'opus'",
  );
  assert.equal(
    agentCommand(row, { agent: 'codex', model: 'gpt-test' }, baseConfig),
    "'codex' '--model' 'gpt-test' 'resume' '--last' || 'codex' '--model' 'gpt-test'",
  );
});

test('seeded sessions start fresh and shell-quote the seed path', () => {
  const command = agentCommand(row, { agent: 'codex', seed: "/tmp/user's seed.md" }, baseConfig);
  assert.match(command, /^'codex' /);
  assert.doesNotMatch(command, /resume/);
  assert.match(command, /user/);
  assert.match(command, /seed document/);
});

test('layout honors configured panels, commands, provider, and editor file', () => {
  const layout = renderLayout(row, {
    agent: 'codex',
    panels: ['editor', 'agent'],
    editorFile: '/tmp/weekly note.md',
  }, baseConfig);

  assert.doesNotMatch(layout, /name="shell"/);
  assert.match(layout, /name="editor" command="nvim"/);
  assert.match(layout, /args "--clean" "\/tmp\/weekly note.md"/);
  assert.match(layout, /name="codex" command="sh"/);
  assert.match(layout, /'codex' 'resume' '--last'/);
});

test('noEditor removes the editor from the configured panel list', () => {
  const layout = renderLayout(row, { noEditor: true }, baseConfig);
  assert.match(layout, /name="shell"/);
  assert.doesNotMatch(layout, /name="editor"/);
  assert.match(layout, /name="claude"/);
});

