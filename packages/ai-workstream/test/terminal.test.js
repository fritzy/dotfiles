import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { focusTerminalForZellij } from '../lib/terminal.js';

function processEntry(root, pid, { parent = 1, command = [], environment = {} } = {}) {
  const path = join(root, String(pid));
  mkdirSync(path);
  writeFileSync(join(path, 'cmdline'), Buffer.from(`${command.join('\0')}\0`));
  writeFileSync(join(path, 'status'), `Name:\ttest\nPPid:\t${parent}\n`);
  writeFileSync(join(path, 'environ'), Buffer.from(
    `${Object.entries(environment).map(([key, value]) => `${key}=${value}`).join('\0')}\0`,
  ));
}

test('Kitty focus targets the exact Zellij client process through its socket', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ai-workstream-proc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  processEntry(root, 100, {
    parent: 90,
    command: ['/usr/bin/zellij', 'attach', 'ws'],
  });
  processEntry(root, 90, {
    environment: {
      KITTY_WINDOW_ID: '7',
      KITTY_LISTEN_ON: 'unix:/tmp/kitty-123',
    },
  });
  const calls = [];
  const run = (...args) => {
    calls.push(args);
    return { status: 0, stdout: '', stderr: '' };
  };

  assert.deepEqual(focusTerminalForZellij('ws', { procRoot: root, run }), {
    focused: true,
    terminal: 'kitty',
  });
  assert.deepEqual(calls, [[
    'kitty',
    ['@', '--to', 'unix:/tmp/kitty-123', 'focus-window', '--match', 'id:7'],
    { encoding: 'utf8' },
  ]]);
});

test('Kitty focus reports when remote control is unavailable', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ai-workstream-proc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  processEntry(root, 100, {
    parent: 90,
    command: ['/usr/bin/zellij', 'attach', 'ws'],
  });
  processEntry(root, 90, { environment: { KITTY_WINDOW_ID: '7' } });

  assert.deepEqual(focusTerminalForZellij('ws', { procRoot: root }), {
    focused: false,
    terminal: 'kitty',
    reason: 'Kitty remote control has no listen socket',
  });
});

test('Kitty focus maps a bare Zellij client through its sole server session', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'ai-workstream-proc-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  processEntry(root, 100, {
    command: ['zellij'],
    parent: 90,
    environment: {
      KITTY_WINDOW_ID: '9',
      KITTY_LISTEN_ON: 'unix:/tmp/kitty-456',
    },
  });
  processEntry(root, 101, {
    command: ['zellij', '--server', '/run/user/1001/zellij/contract_version_1/chatty-lemur'],
  });
  processEntry(root, 90);
  const calls = [];
  const run = (...args) => {
    calls.push(args);
    return { status: 0, stdout: '', stderr: '' };
  };

  assert.deepEqual(focusTerminalForZellij('chatty-lemur', { procRoot: root, run }), {
    focused: true,
    terminal: 'kitty',
  });
  assert.deepEqual(calls, [[
    'kitty',
    ['@', '--to', 'unix:/tmp/kitty-456', 'focus-window', '--match', 'id:9'],
    { encoding: 'utf8' },
  ]]);
});
