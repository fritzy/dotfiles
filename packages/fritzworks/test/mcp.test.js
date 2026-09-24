import assert from 'node:assert/strict';
import test from 'node:test';
import { createMcpServer } from '../mcp.js';

const daemon = { id: 'local', name: 'Local', url: 'http://test', local: true };
const unwrap = (value) => JSON.parse(value.content[0].text);
function fixture(handler, config = { daemons: {} }) {
  const tools = new Map();
  const requests = [];
  createMcpServer({ config, cwd: '/client/cwd', env: { FRITZWORKS_ID: '19' },
    server: { registerTool: (name, definition, call) => tools.set(name, { definition, call }) },
    request: async (path, options) => {
      requests.push({ path, ...options });
      return { daemon, result: await handler(path, options) };
    },
  });
  return { tools, requests, call: async (name, args = {}) => unwrap(await tools.get(name).call(args)) };
}

test('MCP resolves daemon context and custom locations without SQLite or startup location enums', async () => {
  const f = fixture((path) => path === '/context/resolve'
    ? { target: { kind: 'location', id: 'fresh-location' } }
    : { workstream: { id: 'fresh-location' } });
  const result = await f.call('fw_pause', { workstream: 'fresh-location' });
  assert.equal(result.workstream.id, 'fresh-location');
  assert.equal(f.requests[0].body.selector, 'fresh-location');
  assert.equal(f.requests[1].path, '/fw/fresh-location/pause');
  for (const { definition } of f.tools.values()) assert.ok(definition.inputSchema.daemon);
});

test('MCP remote context never forwards client cwd or inherited local session', async () => {
  const f = fixture((path) => path === '/context/resolve' ? { target: { id: '99' } } : { workstream: { id: 99 } },
    { daemons: { relay: { id: 'relay', url: 'http://relay' } } });
  await f.call('fw_pause', { workstream: 'branch', daemon: 'relay' });
  assert.equal(f.requests[0].body.cwd, undefined);
  assert.equal(f.requests[0].body.sessionId, undefined);
  assert.equal(f.requests[0].body.remote, true);
});

test('MCP lists every page and asks daemon for current identity', async () => {
  const f = fixture((path) => path === '/context/resolve' ? { target: { id: 'uuid-19' }, workstream: { id: 19 } } : {
    total: 121, items: Array.from({ length: path.endsWith('page=0') ? 100 : 21 }, (_, id) => ({ id })),
  });
  const result = await f.call('fw_list');
  assert.equal(result.workstreams.length, 121);
  assert.equal(result.current, 19);
  assert.equal(f.requests.filter((r) => r.path.startsWith('/fw/all')).length, 2);
});

test('MCP destructive actions expose a preview and never invent confirmation', async () => {
  const f = fixture((path) => {
    if (path === '/context/resolve') return { target: { id: 19 } };
    if (path === '/intents/preview') return { revision: 'reviewed', confirmationRequired: true, intent: { body: { remove: true } } };
    return { job: { id: 'job-1', status: 'queued' } };
  });
  const preview = await f.call('fw_close', { workstream: '19', discard: true });
  assert.equal(preview.executed, false);
  assert.equal(f.requests.length, 2);
  const execution = await f.call('fw_close', { workstream: '19', discard: true, previewRevision: 'reviewed', confirm: true });
  assert.equal(execution.job.id, 'job-1');
  assert.equal(f.requests.at(-1).body.previewRevision, 'reviewed');
  assert.equal(f.requests.at(-1).body.confirm, true);
  assert.equal(f.requests.at(-1).body.async, true);
});

test('MCP stale preview errors propagate without retrying against a new preview', async () => {
  const f = fixture((path) => {
    if (path === '/context/resolve') return { target: { id: 19 } };
    throw Object.assign(new Error('stale preview'), { status: 409 });
  });
  await assert.rejects(f.call('fw_stack_rebase', { workstream: '19', previewRevision: 'old', confirm: true }), /stale preview/);
  assert.deepEqual(f.requests.map((r) => r.path), ['/context/resolve', '/fw/19/stack-rebase']);
});

test('MCP creation sends local repository paths to daemon and returns jobs', async () => {
  const f = fixture(() => ({ job: { id: 'create-1', status: 'queued' } }));
  const result = await f.call('fw_new', { repo: './project', ref: 'feature' });
  assert.equal(result.job.id, 'create-1');
  assert.equal(f.requests[0].body.repository, '/client/cwd/project');
  assert.equal(f.requests[0].body.async, true);
});

test('MCP advertises and validates schemas over an in-memory protocol transport', async (t) => {
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ config: { daemons: {} }, request: async (path, options) => ({ daemon, result: { path, received: options.body } }) });
  const client = new Client({ name: 'phase4-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  assert.ok(tools.some((tool) => tool.name === 'fw_capabilities'));
  assert.ok(tools.some((tool) => tool.name === 'fw_job_cancel'));
  for (const tool of tools) assert.equal(tool.inputSchema.properties.daemon.type, 'string');
  const preview = await client.callTool({ name: 'fw_preview', arguments: { kind: 'action', target: '7', command: 'close', body: { remove: true } } });
  assert.equal(preview.isError, undefined);
  assert.equal(unwrap(preview).preview.received.body.remove, true);
});

test('MCP remote repository paths remain in daemon coordinates', async () => {
  const f = fixture(() => ({ job: { id: 'remote-create', status: 'queued' } }),
    { daemons: { relay: { id: 'relay', url: 'http://relay' } } });
  await f.call('fw_new', { repo: './project', ref: 'feature', daemon: 'relay' });
  assert.equal(f.requests[0].body.repository, './project');
});

test('MCP creation and lifecycle expose and retain explicit idempotency keys', async () => {
  const f = fixture((path) => path === '/context/resolve' ? { target: { id: 19 } } : { job: { id: 'retryable', status: 'queued' } });
  for (const tool of ['fw_new', 'fw_scratch', 'fw_resume', 'fw_pause', 'fw_close', 'fw_stack_link', 'fw_stack_rebase']) {
    assert.ok(f.tools.get(tool).definition.inputSchema.idempotencyKey, tool);
  }
  await f.call('fw_scratch', { name: 'named', idempotencyKey: 'scratch-key' });
  assert.equal(f.requests.at(-1).body.idempotencyKey, 'scratch-key');
  await f.call('fw_new', { repo: 'team/project', ref: 'branch', idempotencyKey: 'repo-key' });
  assert.equal(f.requests.at(-1).body.idempotencyKey, 'repo-key');
  await f.call('fw_resume', { workstream: '19', idempotencyKey: 'resume-key' });
  assert.equal(f.requests.at(-1).body.idempotencyKey, 'resume-key');
  const before = f.requests.length;
  await f.call('fw_close', { workstream: '19', remove: true, previewRevision: 'exact', confirm: true, idempotencyKey: 'close-key' });
  assert.equal(f.requests.length - before, 2);
  assert.equal(f.requests.at(-1).body.idempotencyKey, 'close-key');
  assert.equal(f.requests.at(-1).body.previewRevision, 'exact');
  await f.call('fw_stack_link', { workstream: '19', previewRevision: 'exact-stack', confirm: true, idempotencyKey: 'stack-key' });
  assert.equal(f.requests.at(-1).body.idempotencyKey, 'stack-key');
  assert.equal(f.requests.at(-1).body.previewRevision, 'exact-stack');
});
