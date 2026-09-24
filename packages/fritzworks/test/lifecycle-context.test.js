import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createApiService } from '../lib/api.js';
import { resolveConfig } from '../lib/config.js';
import { createApplicationContext } from '../lib/context.js';
import { createScratchpad, openDb, readBrowserUiState } from '../lib/core.js';
import { addPanel, ensureSessionPanelGroup, readPanelLayout, terminalPanelsForOwner } from '../lib/panels.js';

function configFixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'fw-lifecycle-context-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const configPath = join(home, 'config.ini');
  writeFileSync(configPath, '[paths]\ndata = ./data\nscratchpads = ./scratchpads\nnotes = ./notes\n');
  return resolveConfig({ env: {}, home, configPath });
}

function request(service, path, { method = 'POST', body = {} } = {}) {
  return new Promise((resolve) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.method = method;
    req.url = path;
    req.headers = { host: 'localhost' };
    let status;
    service.server.emit('request', req, {
      writeHead(value) { status = value; },
      end(value) { resolve({ status, body: JSON.parse(value) }); },
    });
  });
}

function attachedClient(service, row, descriptor) {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.writable = true;
  socket.write = () => true;
  socket.end = () => { socket.destroyed = true; };
  socket.destroy = socket.end;
  const terminal = { killed: 0, kill() { this.killed++; } };
  service.terminalClients.set(socket, {
    sessionId: String(row.id), role: descriptor.identity.role,
    identity: descriptor.identity, managedPanel: true,
    terminal, terminalSession: descriptor.panel.id, registered: false,
  });
  return { socket, terminal };
}

for (const selectorKind of ['uuid', 'branch']) {
  test(`${selectorKind} lifecycle actions use canonical terminal descriptors and workspace ownership`, async (t) => {
    const config = configFixture(t);
    const stopped = [];
    const reset = [];
    const service = createApiService({ config, pollInterval: 0,
      checkGit: async () => null, checkPr: async () => ({ added: false }),
      killTerminalSession: (identity) => { stopped.push(identity); return true; },
      resetTerminalSession: (identity) => { reset.push(identity); return { reset: true }; },
    });
    t.after(() => service.close());
    const row = service.context.operations.createScratchpad({ name: 'ideas' }).workstream;
    const other = service.context.operations.createScratchpad({ name: 'other' }).workstream;
    const selector = selectorKind === 'uuid' ? row.uuid : row.branch;
    const action = async (command, body = {}) => {
      if (command === 'terminal-reset') {
        const preview = await request(service, '/intents/preview', { body: { kind: 'action', target: selector, command, body } });
        assert.equal(preview.status, 200);
        body = { ...body, previewRevision: preview.body.revision, confirm: true };
      }
      return request(service, `/fw/${encodeURIComponent(selector)}/${command}`, { body });
    };
    assert.equal((await action('resume')).status, 200);
    let layout = readPanelLayout(service.db);
    const group = layout.groups.find(({ ownerId }) => ownerId === String(row.id));
    assert.equal(layout.activeGroupId, group.id);
    assert.equal(readBrowserUiState(service.db, 'workspaces').state.activeWorkspaceId, String(row.id));
    addPanel(service.db, group.id, { kind: 'terminal' }, layout.revision);
    const descriptors = terminalPanelsForOwner(service.db, row.id);
    assert.equal(descriptors.length, 3);
    const agent = descriptors.find(({ identity }) => identity.role === 'agent');
    const shell = descriptors.find(({ identity }) => identity.role === 'shell');
    const agentClient = attachedClient(service, row, agent);
    const shellClient = attachedClient(service, row, shell);
    const otherClient = attachedClient(service, other, { ...shell, identity: { ...shell.identity, sessionId: String(other.id) } });
    const changed = await action('agent-set', { agent: 'codex' });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.result.replaced, true);
    assert.equal(changed.body.result.browserTerminalRestart, true);
    assert.equal(agentClient.terminal.killed, 1);
    assert.equal(shellClient.terminal.killed, 0);
    assert.deepEqual(stopped.splice(0), [agent.identity]);

    assert.equal((await action('terminal-reset')).status, 200);
    assert.deepEqual(reset.splice(0), descriptors.map(({ identity }) => identity));
    assert.equal(shellClient.terminal.killed, 1);
    assert.equal(otherClient.terminal.killed, 0);
    const resumedAgent = attachedClient(service, row, agent);
    assert.equal((await action('resume', { seed: 'new task' })).status, 200);
    assert.equal(resumedAgent.terminal.killed, 1);
    assert.deepEqual(stopped.splice(0), [agent.identity]);

    for (const command of ['pause', 'archive', 'close']) {
      assert.equal((await action('resume')).status, 200);
      const connected = attachedClient(service, row, shell);
      const result = await action(command);
      assert.equal(result.status, 200);
      assert.deepEqual(stopped.splice(0), descriptors.map(({ identity }) => identity));
      assert.equal(connected.terminal.killed, 1);
      assert.equal(otherClient.terminal.killed, 0);
      assert.equal(readPanelLayout(service.db).activeGroupId, null);
      const state = readBrowserUiState(service.db, 'workspaces').state;
      assert.equal(state.workspaces.some(({ id }) => id === String(row.id) || id === selector), false);
      assert.equal(state.activeWorkspaceId, null);
    }
  });
}

test('legacy ownership blocks terminal effects without invoking any injected terminal action', async (t) => {
  const config = configFixture(t);
  const db = openDb(join(config.paths.data, 'workstreams.db'));
  const row = createScratchpad(db, 'legacy', config);
  ensureSessionPanelGroup(db, { id: row.id, type: 'scratchpad', name: row.branch, path: row.path }, { roles: ['shell', 'agent'] });
  const context = createApplicationContext({ config, db });
  const calls = [];
  const terminalAction = () => { calls.push('called'); throw new Error('must not touch legacy sessions'); };
  const service = createApiService({ context, pollInterval: 0,
    checkGit: async () => null, checkPr: async () => ({ added: false }),
    ensureTerminalSession: terminalAction, killTerminalSession: terminalAction,
    resetTerminalSession: terminalAction, resetAllTerminalSessions: terminalAction,
    spawnTerminalAttach: terminalAction,
  });
  t.after(async () => { await service.close(); await context.close(); db.close(); });
  for (const path of [`/fw/${row.uuid}/pause`, `/fw/${row.branch}/resume`, '/fw/terminal-reset']) {
    const result = await request(service, path);
    assert.equal(result.status, 409);
    assert.equal(result.body.details.code, 'terminal_ownership_migration_required');
  }
  const health = await request(service, '/health', { method: 'GET' });
  assert.equal(health.body.terminalOwnership.status, 'migration_required');
  const socket = new EventEmitter();
  socket.remoteAddress = '127.0.0.1';
  socket.write = (value) => { assert.match(value, /^HTTP\/1.1 409/); };
  socket.destroy = () => {};
  service.server.emit('upgrade', { url: `/fw/terminal?session=${row.id}`, headers: {
    host: 'localhost', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
  } }, socket, Buffer.alloc(0));
  assert.deepEqual(calls, []);
});
