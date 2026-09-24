import { assertAccepted, assertFeature, assertRequestCapabilities, boundedJson, directoryEntries, connectionError, endpoint, isMutation, observeIdentity, requiredFeature, validateCapabilities } from '../../shared/transport.js';

export function targetStateKey(target, entity = '') {
  return `${target?.instanceId || 'unverified'}:${entity}`;
}

function browserStorage() {
  try { return typeof window === 'undefined' ? undefined : window.localStorage; } catch { return undefined; }
}

function cancellable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(connectionError('request_cancelled', 'Daemon request cancelled'));
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(connectionError('request_cancelled', 'Daemon request cancelled'));
    signal.addEventListener('abort', abort, { once: true });
  });
  return Promise.race([promise, cancelled]).finally(() => signal.removeEventListener('abort', abort));
}

export function createConnections({ fetchImpl = (...args) => fetch(...args), storage = browserStorage(), timeoutMs, onChange = () => {} } = {}) {
  const targets = new Map([['local', { id: 'local', name: 'Local', url: null }]]);
  const identities = new Map();
  const handshakes = new Map();
  let directoryFlight;
  const get = (url, options) => boundedJson(url, options, { fetchImpl, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  const identityKey = (id) => `fritzworks-target-identity:${id}`;
  function previous(id) {
    if (identities.has(id)) return identities.get(id);
    try { return JSON.parse(storage?.getItem(identityKey(id)) || 'null'); } catch { return null; }
  }
  function save(id, value) {
    identities.set(id, value);
    try { storage?.setItem(identityKey(id), JSON.stringify(value)); } catch { /* optional persistence */ }
  }
  function update(id, patch) {
    const current = targets.get(id);
    if (!current) return;
    const next = { ...current, ...patch };
    if (JSON.stringify(current) === JSON.stringify(next)) return;
    targets.set(id, next);
    onChange([...targets.values()]);
  }
  async function loadDirectory() {
    const result = await get('/daemons');
    const incoming = new Map(directoryEntries(result).map((item) => [item.id, { ...item, enabled: item.enabled !== false, url: item.url ?? null }]));
    for (const [id] of targets) if (id !== 'local' && !incoming.has(id)) update(id, { removed: true, ready: false, error: 'Target removed from the local connection directory' });
    for (const [id, item] of incoming) {
      if (id === 'local') continue;
      const current = targets.get(id);
      if (!current) { targets.set(id, { ...item, ready: false }); onChange([...targets.values()]); }
      else if (current.url !== item.url || current.enabled !== item.enabled || current.removed) update(id, { ...item, removed: false, ready: false, error: '' });
    }
    return result;
  }
  function directory(signal) {
    if (signal?.aborted) return Promise.reject(connectionError('request_cancelled', 'Daemon request cancelled'));
    directoryFlight ||= loadDirectory().finally(() => { directoryFlight = null; });
    return cancellable(directoryFlight, signal);
  }
  function handshake(base, signal) {
    if (signal?.aborted) return Promise.reject(connectionError('request_cancelled', 'Daemon request cancelled'));
    if (!handshakes.has(base)) handshakes.set(base, get(`${base}/capabilities`).finally(() => handshakes.delete(base)));
    return cancellable(handshakes.get(base), signal);
  }
  function selected(target) {
    const id = target?.id || 'local';
    const current = targets.get(id);
    if (!current || current.removed) throw connectionError('unknown_target', `Daemon "${id}" is no longer configured`);
    if (current.enabled === false) throw connectionError('disabled_target', `Daemon "${id}" is disabled`);
    if (target?.url !== undefined && target.url !== current.url) throw connectionError('target_changed', `Daemon "${id}" endpoint changed; refresh before acting`);
    return current;
  }
  async function inspect(target, { signal, acknowledgeInstance, refresh = true } = {}) {
    const id = target?.id || 'local';
    try {
      if (refresh && id !== 'local') await directory(signal);
      const current = selected(target);
      const base = current.url ? endpoint(current.url) : '';
      const capabilities = validateCapabilities(await handshake(base, signal));
      // Directory removal or URL edits may occur while the handshake is pending.
      selected(current);
      const identity = observeIdentity(previous(id), capabilities, { acknowledgeInstance });
      save(id, identity);
      const changed = identity.instanceId !== identity.acceptedInstanceId;
      update(id, { instanceId: identity.instanceId, identityChanged: changed, capabilities, ready: !changed, error: changed ? 'Daemon identity changed. Review and acknowledge the new instance before continuing.' : '' });
      if (target?.instanceId && target.instanceId !== identity.instanceId) throw connectionError('identity_changed', 'Daemon identity changed; pending action was not sent', { instanceId: identity.instanceId, previousInstanceId: target.instanceId });
      return { target: targets.get(id), identity, capabilities, base };
    } catch (error) {
      const endpointChanged = target?.url !== undefined && target.url !== targets.get(id)?.url;
      if (!endpointChanged && !['request_cancelled', 'identity_changed', 'target_changed'].includes(error.code)) update(id, { ready: false, error: error.message });
      throw error;
    }
  }
  async function request(path, options = {}, target) {
    const current = targets.get(target?.id || 'local');
    if (isMutation(path, options.method) && target?.instanceId && current?.ready === false && current.instanceId === target.instanceId && !current.removed && !current.identityChanged && current.enabled !== false) throw connectionError('target_unavailable', 'Daemon unavailable; pending changes are retained locally');
    const state = await inspect(target, { signal: options.signal });
    if (isMutation(path, options.method)) assertAccepted(state.identity);
    let body;
    try { body = options.body ? JSON.parse(options.body) : undefined; } catch { throw connectionError('invalid_request', 'Invalid JSON request body'); }
    assertRequestCapabilities(state.capabilities, path, options.method, body);
    if (path === '/capabilities') return state.capabilities;
    return get(`${state.base}${path}`, { ...options, headers: { ...options.headers, 'X-FritzWorks-Instance': state.identity.instanceId } });
  }
  async function prepareSocket(path, target) {
    const state = await inspect(target);
    assertAccepted(state.identity);
    assertFeature(state.capabilities, requiredFeature(path));
    return state.target;
  }
  async function acknowledge(target, instanceId) {
    const observed = await inspect({ id: target.id, url: target.url });
    if (observed.identity.instanceId !== instanceId) throw connectionError('identity_changed', 'Identity changed again; review the current instance');
    save(target.id, { instanceId, acceptedInstanceId: instanceId });
    update(target.id, { identityChanged: false, ready: true, error: '' });
  }
  return { directory, inspect, request, prepareSocket, acknowledge, snapshot: () => [...targets.values()] };
}

const listeners = new Set();
export const connections = createConnections({ onChange: (targets) => { for (const listener of listeners) listener(targets); } });
export function subscribeConnections(listener) { listeners.add(listener); listener(connections.snapshot()); return () => listeners.delete(listener); }
