import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('MCP exposes daemon discovery and a daemon selector on every tool', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-workstream-mcp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const requests = [];
  const requestDetails = [];
  const relay = createServer(async (request, response) => {
    requests.push(request.url);
    let rawBody = '';
    for await (const chunk of request) rawBody += chunk;
    requestDetails.push({
      url: request.url,
      method: request.method,
      body: rawBody ? JSON.parse(rawBody) : null,
    });
    const result = request.url === '/browser/refresh'
      ? { ok: true }
      : request.url === '/panel-layout'
      ? {
          version: 1,
          revision: 7,
          activeGroupId: null,
          groups: [{
            id: 'session-1', ownerId: '99', label: 'remote-work',
            markdownDirectory: '/notes/work/2026/workstream/550e8400-e29b-41d4-a716-446655440000',
            resources: [{ id: 'resource-1', kind: 'markdown', label: 'notes.md', value: '/notes/notes.md' }],
          }],
        }
      : request.url === '/ws/99/sync'
        ? {
            ok: true,
            notes: { changed: true, count: 2 },
            pullRequest: { checked: true, associated: true, added: true },
          }
      : request.url.endsWith('/resources')
        ? { ok: true, revision: 8, opened: true, resource: { id: 'resource-1' } }
        : request.url === '/panel-layout/resources/resource-1'
          ? request.method === 'PUT'
            ? { resource: { id: 'resource-1' }, file: { path: '/notes/notes.md', version: 'v2' } }
            : { resource: { id: 'resource-1' }, file: { path: '/notes/notes.md', content: '# Notes\n', version: 'v1' } }
        : { items: [{ id: 99, branch: 'remote-work' }] };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(result));
  });
  try {
    await new Promise((resolve, reject) => {
      relay.once('error', reject);
      relay.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.skip(`local sockets unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  t.after(() => new Promise((resolve) => relay.close(resolve)));
  const configPath = join(dir, 'config.ini');
  writeFileSync(configPath, [
    '[daemons.relay]',
    `url = http://127.0.0.1:${relay.address().port}`,
    'name = Test relay',
    '',
  ].join('\n'));

  const serverPath = fileURLToPath(new URL('../mcp.js', import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--no-warnings', serverPath],
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { AI_WORKSTREAM_CONFIG: configPath },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'ai-workstream-test', version: '1.0.0' });
  t.after(async () => transport.close());
  await client.connect(transport);

  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === 'ws_daemons'));
  for (const tool of tools) {
    assert.ok(tool.inputSchema.properties.daemon, `${tool.name} must accept daemon`);
    assert.deepEqual(tool.inputSchema.properties.daemon.enum, ['local', 'workstation', 'relay']);
  }
  const resourceAdd = tools.find((tool) => tool.name === 'ws_resource_add');
  assert.equal(resourceAdd.inputSchema.properties.open.type, 'boolean');
  assert.match(resourceAdd.inputSchema.properties.open.description, /owning session is active/);
  assert.ok(tools.some((tool) => tool.name === 'ws_resource_list'));
  assert.ok(tools.some((tool) => tool.name === 'ws_resource_read'));
  assert.ok(tools.some((tool) => tool.name === 'ws_resource_write'));
  assert.ok(tools.some((tool) => tool.name === 'ws_sync'));
  assert.ok(tools.some((tool) => tool.name === 'ws_browser_refresh'));
  assert.equal(tools.some((tool) => tool.name === 'ws_note'), false);
  assert.equal(tools.some((tool) => tool.name === 'ws_note_list'), false);

  const response = await client.callTool({ name: 'ws_daemons', arguments: {} });
  const result = JSON.parse(response.content[0].text);
  assert.deepEqual(result.selected, { id: 'local', name: 'Local', url: null, local: true });
  assert.equal(result.daemons[0].id, 'local');
  assert.ok(result.daemons.some((daemon) => daemon.id === 'relay'));

  const browserRefreshResponse = await client.callTool({
    name: 'ws_browser_refresh', arguments: { daemon: 'relay' },
  });
  const browserRefresh = JSON.parse(browserRefreshResponse.content[0].text);
  assert.equal(browserRefresh.ok, true);
  assert.deepEqual(requestDetails.at(-1), {
    url: '/browser/refresh', method: 'POST', body: {},
  });

  const relayedResponse = await client.callTool({
    name: 'ws_list', arguments: { daemon: 'relay', all: true },
  });
  const relayed = JSON.parse(relayedResponse.content[0].text);
  assert.equal(relayed.daemon.id, 'relay');
  assert.equal(relayed.current, null);
  assert.deepEqual(relayed.workstreams, [{ id: 99, branch: 'remote-work' }]);
  assert.deepEqual(requests.slice(-1), ['/ws/all?status=all&perpage=100']);

  const syncResponse = await client.callTool({
    name: 'ws_sync', arguments: { daemon: 'relay', workstream: '99' },
  });
  const synced = JSON.parse(syncResponse.content[0].text);
  assert.equal(synced.notes.count, 2);
  assert.equal(synced.pullRequest.associated, true);
  assert.deepEqual(requestDetails.at(-1), {
    url: '/ws/99/sync', method: 'POST', body: {},
  });

  const resourceResponse = await client.callTool({
    name: 'ws_resource_add',
    arguments: {
      daemon: 'relay', group: 'session-1', content: 'Session context.', title: 'Context', open: true,
    },
  });
  const resource = JSON.parse(resourceResponse.content[0].text);
  assert.equal(resource.opened, true);
  assert.deepEqual(requests.slice(-2), [
    '/panel-layout', '/panel-layout/groups/session-1/resources',
  ]);
  assert.deepEqual(requestDetails.at(-1), {
    url: '/panel-layout/groups/session-1/resources',
    method: 'POST',
    body: {
      client: 'mcp', revision: 7, kind: 'markdown', content: 'Session context.', title: 'Context', open: true,
    },
  });

  const listedResponse = await client.callTool({
    name: 'ws_resource_list', arguments: { daemon: 'relay', group: 'session-1' },
  });
  const listed = JSON.parse(listedResponse.content[0].text);
  assert.equal(listed.groups[0].markdownDirectory, '/notes/work/2026/workstream/550e8400-e29b-41d4-a716-446655440000');
  assert.equal(listed.groups[0].resources[0].id, 'resource-1');

  const readResponse = await client.callTool({
    name: 'ws_resource_read', arguments: { daemon: 'relay', resource: 'resource-1' },
  });
  assert.equal(JSON.parse(readResponse.content[0].text).file.content, '# Notes\n');
  const writeResponse = await client.callTool({
    name: 'ws_resource_write',
    arguments: { daemon: 'relay', resource: 'resource-1', content: '# Updated', version: 'v1' },
  });
  assert.equal(JSON.parse(writeResponse.content[0].text).file.version, 'v2');
  assert.deepEqual(requestDetails.at(-1), {
    url: '/panel-layout/resources/resource-1',
    method: 'PUT',
    body: { content: '# Updated', version: 'v1' },
  });
});
