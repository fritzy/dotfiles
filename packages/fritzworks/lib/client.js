import { resolve, join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { boundedJson, directoryEntries, endpoint, connectionError, validateCapabilities, observeIdentity, assertAccepted, isMutation, assertRequestCapabilities } from '../shared/transport.js';
import { CONFIG } from './config.js';
import { startDaemon, daemonStatus } from './daemon.js';

const injectedIdentityStores = new WeakMap();
function identityPreferences(config, fetchImpl) {
  if (fetchImpl === globalThis.fetch) return fileIdentityStore(config);
  if (!injectedIdentityStores.has(config)) injectedIdentityStores.set(config, new Map());
  return injectedIdentityStores.get(config);
}

export function daemonTargets(config = CONFIG) {
  return [{ id: 'local', name: 'Local', url: null, local: true },
    ...Object.values(config.daemonDirectory || config.daemons || {}).map((daemon) => ({ ...daemon, local: false }))];
}

export function resolveDaemonTarget(selector = 'local', config = CONFIG) {
  const id = selector || 'local';
  const selected = daemonTargets(config).find((target) => target.id === id);
  if (!selected) throw connectionError('unknown_target', `Unknown daemon "${id}"`, { target: id });
  if (selected.enabled === false) throw connectionError('disabled_target', `Daemon "${id}" is disabled`, { target: id });
  return selected;
}

// Client preferences live separately from daemon-owned data and survive CLI invocations.
export function fileIdentityStore(config, { stateRoot = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state') } = {}) {
  const key = createHash('sha256').update(config.configPath || config.paths?.data || 'default').digest('hex').slice(0, 24);
  const pathFor = (id) => join(stateRoot, 'fritzworks', 'clients', key, `${createHash('sha256').update(id).digest('hex')}.json`);
  return {
    get(id) {
      try { return JSON.parse(readFileSync(pathFor(id), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return undefined; throw connectionError('client_state_unavailable', `Cannot read client identity preferences: ${error.message}`); }
    },
    set(id, value) {
      const path = pathFor(id);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
      renameSync(temporary, path);
    },
  };
}

export async function requestDaemonService(path, {
  method = 'GET', body, daemon: daemonSelector = 'local', config = CONFIG,
  start = startDaemon, status = daemonStatus, fetchImpl = fetch, signal, timeoutMs,
  identityStore, acknowledgeInstance, expectedInstance, expectedEndpoint,
} = {}) {
  if (!path.startsWith('/') || path.startsWith('//')) throw connectionError('invalid_request', 'Service paths must be root relative');
  const local = daemonSelector === 'local' || !daemonSelector;
  // Remote selection must never launch or replace the local daemon.
  const running = local && start !== false ? await start({ config }) : await status(config);
  if (!running?.url || running.running === false) throw connectionError('unreachable_target', 'Local connection directory is unavailable; start the local daemon explicitly');
  const localUrl = endpoint(running.url);
  const transport = { fetchImpl, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
  const fetchJson = async (url, options = {}) => {
    try { return await boundedJson(url, { signal, ...options }, transport); }
    catch (error) {
      error.details = { ...error.details, target: daemonSelector, endpoint: new URL(url).origin };
      if (!error.status) error.message = `Daemon "${daemonSelector}": ${error.message}`;
      throw error;
    }
  };
  let selected = { id: 'local', name: 'Local', local: true, url: localUrl };
  if (!local) {
    const directory = await fetchJson(`${localUrl}/daemons`);
    selected = resolveDaemonTarget(daemonSelector, { daemonDirectory: Object.fromEntries(directoryEntries(directory).map((item) => [item.id, item])) });
    selected.url = endpoint(selected.url);
  }
  if (expectedEndpoint && selected.url !== expectedEndpoint) throw connectionError('target_changed', 'Daemon endpoint changed; pending action was not sent', { target: selected.id, expectedEndpoint, endpoint: selected.url });
  const capabilities = validateCapabilities(await fetchJson(`${selected.url}/capabilities`));
  const store = identityStore || identityPreferences(config, fetchImpl);
  const identity = observeIdentity(store.get(selected.id), capabilities, { acknowledgeInstance, expectedInstance });
  store.set(selected.id, identity);
  selected = { ...selected, instanceId: identity.instanceId, identityChanged: identity.instanceId !== identity.acceptedInstanceId };
  if (isMutation(path, method)) assertAccepted(identity);
  assertRequestCapabilities(capabilities, path, method, body);
  if (path === '/capabilities' && method === 'GET') return { daemon: selected, result: capabilities };
  if (path === '/context/resolve' && !local) body = { ...body, cwd: undefined, sessionId: undefined, remote: true };
  const result = await fetchJson(`${selected.url}${path}`, {
    method,
    headers: { 'X-FritzWorks-Instance': identity.instanceId, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { daemon: selected, result };
}

export function requestLocalService(path, options = {}) {
  return requestDaemonService(path, { ...options, daemon: 'local' });
}

export function workstreamCommand(id, command, body = {}, options = {}) {
  return requestDaemonService(
    `/fw/${encodeURIComponent(id)}/${encodeURIComponent(command)}`,
    { ...options, method: 'POST', body },
  );
}

export function resolveContext(body = {}, { request = requestDaemonService, ...options } = {}) {
  const selected = { local: !options.daemon || options.daemon === 'local' };
  return request('/context/resolve', { ...options, method: 'POST', body: {
    ...body,
    ...(selected.local ? {} : { cwd: undefined, sessionId: undefined, remote: true }),
  } });
}

export async function listWorkstreams(status = 'active_paused', { request = requestDaemonService, ...options } = {}) {
  const items = [];
  let service;
  for (let page = 0; ; page += 1) {
    service = await request(`/fw/all?status=${encodeURIComponent(status)}&perpage=100&page=${page}`, options);
    items.push(...service.result.items);
    if (service.result.items.length < 100 || items.length >= service.result.total) break;
  }
  return { ...service, result: { ...service.result, items } };
}

export function repositorySelector(value, { cwd = process.cwd(), local = true } = {}) {
  return local && /^\.\.?\//.test(value) ? resolve(cwd, value) : value;
}
