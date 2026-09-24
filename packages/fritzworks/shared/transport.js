export const PROTOCOL_VERSION = 1;
export const TRANSPORT_CONTRACT = 'instance-bound-v1';
export const REQUEST_TIMEOUT_MS = 10000;

export function connectionError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details: { code, ...details } });
}

export function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw connectionError('incompatible_target', 'Invalid daemon endpoint'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) {
    throw connectionError('incompatible_target', 'Daemon endpoints must be root HTTP URLs without credentials');
  }
  if (!['localhost', '[::1]'].includes(url.hostname) && !/^127(?:\.\d{1,3}){3}$/.test(url.hostname)) {
    throw connectionError('incompatible_target', 'Daemon endpoints must use loopback; configure an SSH forward separately');
  }
  return url.origin;
}

export async function boundedJson(url, options = {}, { fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  let timer;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const cancel = () => {
    controller.abort();
    rejectAbort(connectionError('request_cancelled', 'Daemon request cancelled'));
  };
  options.signal?.addEventListener('abort', cancel, { once: true });
  timer = setTimeout(() => {
    controller.abort();
    rejectAbort(connectionError('target_timeout', 'Daemon request deadline exceeded', { timeoutMs }));
  }, timeoutMs);
  try {
    if (options.signal?.aborted) throw connectionError('request_cancelled', 'Daemon request cancelled');
    return await Promise.race([aborted, (async () => {
      const response = await fetchImpl(url, { ...options, signal: controller.signal, redirect: 'error' });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw Object.assign(connectionError(body?.details?.code || 'daemon_error', body?.message || `HTTP ${response.status}`, body?.details), { status: response.status });
      if (!body) throw connectionError('incompatible_target', 'Daemon returned an invalid JSON response');
      return body;
    })()]);
  } catch (cause) {
    if (cause.details?.code) throw cause;
    throw connectionError('unreachable_target', `Could not reach daemon: ${cause.message}`);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}

export function validateCapabilities(capabilities) {
  if (capabilities?.protocolVersion !== PROTOCOL_VERSION || typeof capabilities.instanceId !== 'string' || !capabilities.instanceId
      || !Array.isArray(capabilities.contracts) || !capabilities.contracts.includes(TRANSPORT_CONTRACT)) {
    throw connectionError('incompatible_target', 'Daemon does not support the required protocol and instance binding', { requiredProtocol: PROTOCOL_VERSION, requiredContract: TRANSPORT_CONTRACT });
  }
  return capabilities;
}

export function directoryEntries(result) {
  const ids = new Set(['local']);
  if (!Array.isArray(result?.daemons)) throw connectionError('incompatible_target', 'Local daemon returned an invalid connection directory');
  for (const target of result.daemons) {
    if (typeof target?.id !== 'string' || !target.id || ids.has(target.id)) throw connectionError('incompatible_target', 'Local daemon returned invalid or duplicate target IDs');
    ids.add(target.id);
  }
  return result.daemons;
}

export function observeIdentity(previous, capabilities, { acknowledgeInstance, expectedInstance } = {}) {
  const instanceId = capabilities.instanceId;
  if ((acknowledgeInstance && acknowledgeInstance !== instanceId) || (expectedInstance && expectedInstance !== instanceId)) throw connectionError('identity_changed', `Daemon identity changed to ${instanceId}; refresh and explicitly acknowledge this instance`, { previousInstanceId: expectedInstance, instanceId });
  return {
    instanceId,
    acceptedInstanceId: acknowledgeInstance === instanceId ? instanceId : previous?.acceptedInstanceId || instanceId,
  };
}

export function assertAccepted(identity) {
  if (identity.instanceId !== identity.acceptedInstanceId) throw connectionError('identity_changed', `Daemon identity changed from ${identity.acceptedInstanceId} to ${identity.instanceId}; explicitly acknowledge this instance before actions`, { previousInstanceId: identity.acceptedInstanceId, instanceId: identity.instanceId });
}

export function isMutation(path, method = 'GET') {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) && !['/context/resolve', '/intents/preview'].includes(path.split('?')[0]);
}

export function requiredFeature(path, method = 'GET') {
  if (path === '/fw/terminal') return 'terminals';
  if (path.endsWith('/open-path')) return 'nativeOpen';
  if (path.startsWith('/jobs')) return 'jobs';
  if (isMutation(path, method) && path === '/notes/weekly') return 'weeklyNotes';
  return null;
}

export function assertRequestCapabilities(capabilities, path, method = 'GET', body) {
  assertFeature(capabilities, requiredFeature(path, method));
  if (!isMutation(path, method)) return;
  if (path === '/fw') { assertFeature(capabilities, 'git'); assertFeature(capabilities, 'jobs'); }
  if (path === '/fw/scratchpad') { assertFeature(capabilities, 'shell'); assertFeature(capabilities, 'jobs'); }
  if (body?.async || /\/stack-(link|rebase)$/.test(path)) assertFeature(capabilities, 'jobs');
  if (path === '/fw/digest' && body?.write) assertFeature(capabilities, 'weeklyNotes');
}

export function assertFeature(capabilities, feature) {
  if (feature && !capabilities.features?.[feature]?.available) throw connectionError('capability_unavailable', capabilities.features?.[feature]?.reason || `Daemon does not support ${feature}`, { feature });
}
