import { CONFIG } from './config.js';
import { startDaemon } from './daemon.js';

export function daemonTargets(config = CONFIG) {
  return [
    { id: 'local', name: 'Local', url: null, local: true },
    ...Object.values(config.daemons || {}).map((daemon) => ({ ...daemon, local: false })),
  ];
}

export function resolveDaemonTarget(selector = 'local', config = CONFIG) {
  const id = selector || 'local';
  if (id === 'local') return daemonTargets(config)[0];
  const daemon = config.daemons?.[id];
  if (daemon) return { ...daemon, local: false };
  throw new Error(`unknown daemon "${id}" (expected one of: ${daemonTargets(config).map((item) => item.id).join(', ')})`);
}

// Local calls start the daemon on demand. Remote calls are relayed only to
// configured endpoints; accepting arbitrary URLs here would turn MCP input into
// an unrestricted network proxy.
export async function requestDaemonService(path, {
  method = 'GET',
  body,
  daemon: daemonSelector = 'local',
  config = CONFIG,
  start = startDaemon,
  fetchImpl = fetch,
} = {}) {
  const selected = resolveDaemonTarget(daemonSelector, config);
  const daemon = selected.local
    ? { ...selected, ...await start({ config }) }
    : selected;
  let response;
  try {
    response = await fetchImpl(`${daemon.url}${path}`, {
      method,
      ...(body === undefined ? {} : {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    });
  } catch (cause) {
    throw new Error(`could not reach daemon "${daemon.id}" at ${daemon.url}: ${cause.message}`, { cause });
  }
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(result?.message || `FritzWorks request failed (HTTP ${response.status})`);
    error.status = response.status;
    error.details = result?.details;
    error.daemon = daemon;
    throw error;
  }
  return { daemon, result };
}

export function requestLocalService(path, options = {}) {
  return requestDaemonService(path, { ...options, daemon: 'local' });
}

export function workstreamCommand(id, command, body = {}, options = {}) {
  return requestDaemonService(
    `/ws/${encodeURIComponent(id)}/${encodeURIComponent(command)}`,
    { ...options, method: 'POST', body },
  );
}
