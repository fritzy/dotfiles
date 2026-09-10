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
  const relay = createServer((request, response) => {
    requests.push(request.url);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ items: [{ id: 99, branch: 'remote-work' }] }));
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

  const response = await client.callTool({ name: 'ws_daemons', arguments: {} });
  const result = JSON.parse(response.content[0].text);
  assert.deepEqual(result.selected, { id: 'local', name: 'Local', url: null, local: true });
  assert.equal(result.daemons[0].id, 'local');
  assert.ok(result.daemons.some((daemon) => daemon.id === 'relay'));

  const relayedResponse = await client.callTool({
    name: 'ws_list', arguments: { daemon: 'relay', all: true },
  });
  const relayed = JSON.parse(relayedResponse.content[0].text);
  assert.equal(relayed.daemon.id, 'relay');
  assert.equal(relayed.current, null);
  assert.deepEqual(relayed.workstreams, [{ id: 99, branch: 'remote-work' }]);
  assert.deepEqual(requests, ['/ws/all?status=all&perpage=100']);
});
