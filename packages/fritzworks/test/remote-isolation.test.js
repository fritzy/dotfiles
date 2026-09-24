import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createApplicationContext } from '../lib/context.js';
import { resolveConfig } from '../lib/config.js';
import { createApiService } from '../lib/api.js';
import { fileIdentityStore, requestDaemonService } from '../lib/client.js';
import { run } from '../cli.js';
import { createMcpServer } from '../mcp.js';
import { boundedJson, endpoint } from '../shared/transport.js';
import { createConnections, targetStateKey } from '../web-v2/src/connections.js';
import { resourcePreviewUrl } from '../web-v2/src/api.js';

const urls = ['http://127.0.0.1:7440', 'http://127.0.0.1:7441', 'http://127.0.0.1:7442'];
const code = (value) => (error) => error.code === value || error.details?.code === value;
function http(service, url, options = {}) {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const req = Readable.from(options.body ? [Buffer.from(options.body)] : []);
    Object.assign(req, { method: options.method || 'GET', url: parsed.pathname + parsed.search,
      headers: { host: parsed.host, ...Object.fromEntries(Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value])) } });
    let status, headers = {};
    service.server.emit('request', req, {
      setHeader(key, value) { headers[key.toLowerCase()] = value; },
      writeHead(value, extra) { status = value; headers = { ...headers, ...extra }; },
      end(body) { resolve(new Response(status === 204 ? null : body, { status, headers })); },
    });
  });
}
function fixture(t) {
  const home = mkdtempSync(join(tmpdir(), 'fw-remotes-'));
  const nodes = urls.map((url, index) => {
    const configPath = join(home, `config-${index}.json`);
    writeFileSync(configPath, JSON.stringify({ configVersion: 2, paths: { data: `./data-${index}` },
      daemons: index === 0 ? { one: { url: urls[1] }, two: { url: urls[2] }, disabled: { enabled: false } } : { unrelated: { url: 'http://127.0.0.1:7555' } } }));
    const config = resolveConfig({ configPath, env: {}, home });
    const forbidden = () => { throw new Error('External processes forbidden'); };
    const context = createApplicationContext({ config, runProcess: forbidden, adapters: { commandAvailable: () => true, providerAvailable: () => true, nativeOpenAvailable: () => false } });
    context.operations.createScratchpad({ name: `machine-${index}`, panels: ['shell', 'agent'] });
    const service = createApiService({ context, pollInterval: 0, checkGit: async () => null, checkPr: async () => ({ added: false }),
      ensureTerminalSession: forbidden, spawnTerminalAttach: forbidden, killTerminalSession: forbidden, resetTerminalSession: forbidden });
    return { url, config, context, service };
  });
  t.after(async () => { for (const node of nodes) { await node.service.close(); await node.context.close(); } rmSync(home, { recursive: true, force: true }); });
  const routes = new Map(nodes.map((node) => [node.url, node]));
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url, urls[0]);
    requests.push({ url: parsed.href, ...options });
    const node = routes.get(parsed.origin);
    if (!node) throw new Error('offline');
    return http(node.service, parsed.href, options);
  };
  const identityStore = new Map();
  const request = (path, options = {}) => requestDaemonService(path, { config: nodes[0].config,
    start: async () => ({ url: urls[0] }), status: async () => ({ running: true, url: urls[0] }), fetchImpl, identityStore, ...options });
  return { nodes, routes, requests, fetchImpl, request, identityStore };
}

test('local and two remotes isolate overlapping IDs; remote directories never replace local discovery', async (t) => {
  const f = fixture(t);
  for (const [index, daemon] of ['local', 'one', 'two'].entries()) {
    const response = await f.request('/fw/1?status=all', { daemon });
    assert.equal(response.result.items[0].name, `machine-${index}`);
    assert.equal(response.daemon.instanceId, f.nodes[index].context.instanceId);
  }
  await assert.rejects(f.request('/fw/all', { daemon: 'unrelated' }), code('unknown_target'));
  await assert.rejects(f.request('/fw/all', { daemon: 'disabled' }), code('disabled_target'));
  f.routes.delete(urls[1]);
  await assert.rejects(f.request('/fw/all', { daemon: 'one' }), code('unreachable_target'));
  assert.equal((await f.request('/fw/1?status=all', { daemon: 'two' })).result.items[0].name, 'machine-2');
  assert.equal((await f.request('/fw/1?status=all')).result.items[0].name, 'machine-0');
});

test('CLI and MCP select the same remote transport and exclude local cwd/session context', async (t) => {
  const f = fixture(t);
  const original = console.log;
  console.log = () => {};
  try {
    await run(['list', '--daemon', 'one'], { request: f.request });
    await run(['rename', 'cli-remote', '--fw', '1', '--daemon=one'], { request: f.request });
  }
  finally { console.log = original; }
  const tools = new Map();
  createMcpServer({ config: f.nodes[0].config, cwd: '/client', env: { FRITZWORKS_ID: '1' }, request: f.request,
    server: { registerTool(name, definition, call) { tools.set(name, call); } } });
  await tools.get('fw_rename')({ name: 'mcp-remote', workstream: '1', daemon: 'two' });
  assert.equal(f.nodes[1].context.db.prepare('SELECT COALESCE(label, branch) AS name FROM workstreams WHERE id=1').get().name, 'cli-remote');
  assert.equal(f.nodes[2].context.db.prepare('SELECT COALESCE(label, branch) AS name FROM workstreams WHERE id=1').get().name, 'mcp-remote');
  assert.equal(f.nodes[0].context.db.prepare('SELECT COALESCE(label, branch) AS name FROM workstreams WHERE id=1').get().name, 'machine-0');
  for (const request of f.requests.filter((item) => item.url.endsWith('/context/resolve'))) {
    const body = JSON.parse(request.body);
    assert.equal(body.cwd, undefined); assert.equal(body.sessionId, undefined); assert.equal(body.remote, true);
  }
  for (const args of [['setup'], ['daemon', 'restart'], ['config', 'validate'], ['storage', 'rebind'], ['web'], ['hooks']]) {
    assert.throws(() => run(['--daemon', 'one', ...args], { request: f.request }), code('local_only'));
  }
  assert.throws(() => run(['--daemon']), /requires a value/);
});

test('identity replacement blocks mutations until exact acknowledgement and HTTP binds against handshake races', async (t) => {
  const f = fixture(t);
  await f.request('/capabilities', { daemon: 'one' });
  f.routes.set(urls[1], f.nodes[2]);
  const observed = await f.request('/capabilities', { daemon: 'one' });
  assert.equal(observed.daemon.identityChanged, true);
  await assert.rejects(f.request('/fw/1/rename', { daemon: 'one', method: 'POST', body: { name: 'wrong' } }), code('identity_changed'));
  await assert.rejects(f.request('/capabilities', { daemon: 'one', expectedInstance: f.nodes[1].context.instanceId }), code('identity_changed'));
  await f.request('/capabilities', { daemon: 'one', acknowledgeInstance: f.nodes[2].context.instanceId });
  await f.request('/fw/1/rename', { daemon: 'one', method: 'POST', body: { name: 'acknowledged' } });
  const response = await http(f.nodes[2].service, `${urls[2]}/fw/1/rename`, { method: 'POST', headers: { 'X-FritzWorks-Instance': f.nodes[1].context.instanceId }, body: JSON.stringify({ name: 'raced' }) });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).details.code, 'identity_changed');
  assert.equal(f.nodes[2].context.db.prepare('SELECT COALESCE(label, branch) AS name FROM workstreams WHERE id=1').get().name, 'acknowledged');
});

test('multi-request CLI and MCP actions retain their original instance despite a concurrent acknowledgement', async (t) => {
  const f = fixture(t);
  const request = async (path, options) => {
    const result = await f.request(path, options);
    if (path === '/context/resolve') {
      f.routes.set(urls[1], f.nodes[2]);
      f.identityStore.set('one', { instanceId: f.nodes[2].context.instanceId, acceptedInstanceId: f.nodes[2].context.instanceId });
    }
    return result;
  };
  await assert.rejects(run(['--daemon', 'one', 'rename', 'wrong', '--fw', '1'], { request }), code('identity_changed'));
  f.routes.set(urls[1], f.nodes[1]);
  f.identityStore.set('one', { instanceId: f.nodes[1].context.instanceId, acceptedInstanceId: f.nodes[1].context.instanceId });
  const tools = new Map();
  createMcpServer({ config: f.nodes[0].config, request, server: { registerTool(name, _definition, call) { tools.set(name, call); } } });
  const response = await tools.get('fw_rename')({ daemon: 'one', workstream: '1', name: 'wrong' });
  assert.equal(response.isError, true);
  assert.equal(JSON.parse(response.content[0].text).error, 'identity_changed');
  assert.equal(f.nodes[2].context.db.prepare('SELECT COALESCE(label, branch) AS name FROM workstreams WHERE id=1').get().name, 'machine-2');
  await assert.rejects(f.request('/fw/1/rename', { daemon: 'one', expectedEndpoint: urls[2], method: 'POST', body: { name: 'wrong' } }), code('target_changed'));
});

test('protocol mismatch, deadline, cancellation, and unsafe endpoints fail without actions', async (t) => {
  const f = fixture(t);
  const badFetch = async (url, options) => url.endsWith('/capabilities') ? new Response(JSON.stringify({ protocolVersion: 999, instanceId: 'wrong' })) : f.fetchImpl(url, options);
  await assert.rejects(f.request('/fw/1/rename', { method: 'POST', body: { name: 'wrong' }, fetchImpl: badFetch }), code('incompatible_target'));
  assert.equal(f.nodes[0].context.db.prepare('SELECT COALESCE(label, branch) AS name FROM workstreams WHERE id=1').get().name, 'machine-0');
  await assert.rejects(boundedJson(urls[0], {}, { timeoutMs: 5, fetchImpl: () => new Promise(() => {}) }), code('target_timeout'));
  await assert.rejects(boundedJson(urls[0], {}, { timeoutMs: 5, fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }) }), code('target_timeout'));
  const controller = new AbortController();
  const pending = boundedJson(urls[0], { signal: controller.signal }, { fetchImpl: () => new Promise(() => {}) });
  controller.abort(); await assert.rejects(pending, code('request_cancelled'));
  let called = false;
  await assert.rejects(boundedJson(urls[0], { signal: controller.signal }, { fetchImpl: () => { called = true; } }), code('request_cancelled'));
  assert.equal(called, false);
  for (const url of ['https://public.example', `${urls[0]}/prefix`, 'http://user:pass@localhost', `${urls[0]}?q=1`]) assert.throws(() => endpoint(url), code('incompatible_target'));
});

test('browser discovery removal and identity changes invalidate pinned actions and scope preferences', async (t) => {
  const f = fixture(t);
  let directory;
  const browser = createConnections({ storage: undefined, fetchImpl: async (url, options) => url === '/daemons' && directory ? new Response(JSON.stringify(directory)) : f.fetchImpl(url, options) });
  await browser.directory();
  const first = await browser.inspect({ id: 'one' });
  const second = await browser.inspect({ id: 'two' });
  assert.notEqual(targetStateKey(first.target, 1), targetStateKey(second.target, 1));
  assert.equal((await browser.request('/fw/1?status=all', {}, first.target)).items[0].name, 'machine-1');
  directory = { daemons: [{ id: 'two', url: urls[2] }] };
  await assert.rejects(browser.request('/fw/1/rename', { method: 'POST', body: '{}' }, first.target), code('unknown_target'));
  assert.equal(browser.snapshot().find((item) => item.id === 'one').ready, false);
  assert.equal((await browser.request('/fw/1?status=all', {}, second.target)).items[0].name, 'machine-2');
  directory = undefined;
  f.routes.set(urls[1], f.nodes[2]);
  await assert.rejects(browser.request('/fw/1/rename', { method: 'POST', body: '{}' }, first.target), code('identity_changed'));
  const changed = browser.snapshot().find((item) => item.id === 'one');
  assert.equal(changed.identityChanged, true); assert.equal(changed.ready, false);
  await browser.acknowledge(changed, changed.instanceId);
  await assert.rejects(browser.request('/fw/1/rename', { method: 'POST', body: '{}' }, first.target), code('identity_changed'));
  const accepted = browser.snapshot().find((item) => item.id === 'one');
  assert.equal((await browser.prepareSocket('/fw/events', accepted)).instanceId, changed.instanceId);
  directory = { daemons: [{ id: 'one', enabled: false }, { id: 'two', url: urls[2] }] };
  await assert.rejects(browser.request('/fw/1?status=all', {}, accepted), code('disabled_target'));
  directory = undefined;
  await browser.directory();
  const reenabled = await browser.inspect({ id: 'one' });
  assert.equal(reenabled.target.ready, true);
  assert.equal(reenabled.target.enabled, true);
  directory = { daemons: [{ id: 'one', url: urls[2] }, { id: 'two', url: urls[2] }] };
  await browser.directory();
  const moved = await browser.inspect({ id: 'one', url: urls[2] });
  await assert.rejects(browser.request('/fw/1/rename', { method: 'POST', body: '{}' }, reenabled.target), code('target_changed'));
  assert.equal(browser.snapshot().find((item) => item.id === 'one').ready, true);
  assert.equal((await browser.request('/fw/1?status=all', {}, moved.target)).items[0].name, 'machine-2');
});

test('CLI identity preferences persist independently from daemon data and acknowledgement requires an exact UUID', async (t) => {
  const f = fixture(t);
  const stateRoot = mkdtempSync(join(tmpdir(), 'fw-client-preferences-'));
  t.after(() => rmSync(stateRoot, { recursive: true, force: true }));
  await f.request('/capabilities', { daemon: 'one', identityStore: fileIdentityStore(f.nodes[0].config, { stateRoot }) });
  f.routes.set(urls[1], f.nodes[2]);
  const identityStore = fileIdentityStore(f.nodes[0].config, { stateRoot });
  await assert.rejects(f.request('/fw/1/rename', { daemon: 'one', identityStore, method: 'POST', body: { name: 'wrong' } }), code('identity_changed'));
  await assert.rejects(f.request('/capabilities', { daemon: 'one', identityStore, acknowledgeInstance: 'incorrect' }), code('identity_changed'));
  await f.request('/capabilities', { daemon: 'one', identityStore, acknowledgeInstance: f.nodes[2].context.instanceId });
  assert.equal(fileIdentityStore(f.nodes[0].config, { stateRoot }).get('one').acceptedInstanceId, f.nodes[2].context.instanceId);
});

test('missing capabilities disable affected mutations and MCP returns structured target errors', async (t) => {
  const f = fixture(t);
  const fetchImpl = async (url, options) => {
    const response = await f.fetchImpl(url, options);
    if (!url.endsWith('/capabilities')) return response;
    const capabilities = await response.json();
    capabilities.features.jobs = { available: false, reason: 'Jobs unavailable' };
    return new Response(JSON.stringify(capabilities));
  };
  await assert.rejects(f.request('/fw', { fetchImpl, method: 'POST', body: { repository: 'org/repo' } }), code('capability_unavailable'));
  await assert.rejects(f.request('/fw/1/open-path', { method: 'POST', body: {} }), code('capability_unavailable'));
  const tools = new Map();
  createMcpServer({ config: f.nodes[0].config, request: f.request, server: { registerTool(name, _definition, call) { tools.set(name, call); } } });
  const result = await tools.get('fw_list')({ daemon: 'disabled' });
  assert.equal(result.isError, true);
  assert.equal(JSON.parse(result.content[0].text).error, 'disabled_target');
  const directory = JSON.parse((await tools.get('fw_daemons')({ daemon: 'two' })).content[0].text);
  assert.deepEqual(directory.daemons.map((target) => target.id), ['local', 'one', 'two', 'disabled']);
});

test('loopback forward Host/Origin and identity contracts apply to HTTP and WebSocket upgrades', async (t) => {
  const f = fixture(t);
  const service = f.nodes[1].service;
  const identity = f.nodes[1].context.instanceId;
  assert.equal((await http(service, `${urls[1]}/capabilities`, { headers: { Origin: urls[0] } })).status, 200);
  assert.equal((await http(service, `${urls[1]}/capabilities`, { headers: { Host: 'attacker.example' } })).status, 403);
  assert.equal((await http(service, `${urls[1]}/capabilities`, { headers: { Origin: 'https://attacker.example' } })).status, 403);
  const preflight = await http(service, `${urls[1]}/fw/1/rename`, { method: 'OPTIONS', headers: { Origin: urls[0] } });
  assert.match(preflight.headers.get('access-control-allow-headers'), /X-FritzWorks-Instance/);
  function upgrade(path, headers = {}) {
    const socket = new EventEmitter();
    let output = '';
    Object.assign(socket, { remoteAddress: '127.0.0.1', write(value) { output += String(value); }, destroy() { socket.emit('close'); }, end() { socket.emit('close'); } });
    service.server.emit('upgrade', { url: path, headers: { host: '127.0.0.1:7441', origin: urls[0], upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } }, socket, Buffer.alloc(0));
    socket.destroy();
    return output;
  }
  assert.match(upgrade(`/fw/events?instance=${identity}`), /101 Switching/);
  assert.match(upgrade('/fw/events?instance=wrong'), /409 Conflict/);
  assert.match(upgrade('/fw/terminal?instance=wrong'), /409 Conflict/);
  assert.match(upgrade('/fw/events', { origin: 'https://attacker.example' }), /404 Not Found/);
  assert.doesNotMatch(upgrade('/fw/events', { host: 'attacker.example' }), /101 Switching/);
});
test('HTML documents, nested pages and relative assets inherit the original instance binding', async (t) => {
  const f = fixture(t);
  for (const [index, node] of f.nodes.entries()) {
    const root = join(node.config.paths.data, 'html');
    mkdirSync(join(root, 'assets'), { recursive: true });
    mkdirSync(join(root, 'pages'), { recursive: true });
    writeFileSync(join(root, 'index.html'), '<script src="assets/app.js"></script><a href="pages/next.html">Next</a>');
    writeFileSync(join(root, 'pages/next.html'), '<link rel="stylesheet" href="../assets/style.css"><img src="../assets/image.svg">');
    writeFileSync(join(root, 'assets/app.js'), `machine${index}`);
    writeFileSync(join(root, 'assets/style.css'), `/* machine${index} */`);
    writeFileSync(join(root, 'assets/image.svg'), '<svg/>');
    writeFileSync(join(node.config.paths.data, 'outside.svg'), '<svg/>');
    symlinkSync(join(node.config.paths.data, 'outside.svg'), join(root, 'escape.svg'));
    node.context.db.prepare("INSERT INTO panel_groups (id,type,label,path,created_at) VALUES ('html-group','scratchpad','HTML',?,'now')").run(root);
    node.context.db.prepare("INSERT INTO resource_associations (id,group_id,kind,value,label,source,created_at) VALUES ('same-resource','html-group','html',?,'HTML','explicit','now')").run(join(root, 'index.html'));
  }
  const instanceId = f.nodes[1].context.instanceId;
  const page = resourcePreviewUrl({ id: 'same-resource', kind: 'html', value: '/html/index.html' }, { url: urls[1], instanceId });
  const nested = new URL('pages/next.html', page).href;
  const assets = [page, new URL('assets/app.js', page).href, nested, new URL('../assets/style.css', nested).href, new URL('../assets/image.svg', nested).href];
  for (const url of assets) {
    assert.match(url, new RegExp(`/resource-files/${instanceId}/same-resource/`));
    assert.equal((await f.fetchImpl(url)).status, 200);
  }
  assert.match((await f.fetchImpl(page)).headers.get('content-security-policy'), /sandbox allow-scripts/);
  assert.equal((await f.fetchImpl(new URL('escape.svg', page).href)).status, 403);
  assert.equal((await f.fetchImpl(page.replace('index.html', '..%2Foutside.svg'))).status, 403);
  assert.equal((await f.fetchImpl(page, { method: 'HEAD' })).status, 200);
  for (const legacy of ['/resource-files/same-resource/index.html', '/resource-files/same-resource/assets/app.js']) {
    assert.equal((await f.fetchImpl(`${urls[1]}${legacy}?instance=${instanceId}`)).status, 409);
  }
  f.routes.set(urls[1], f.nodes[2]);
  for (const url of assets) {
    const response = await f.fetchImpl(url);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).details.code, 'identity_changed');
  }
});
