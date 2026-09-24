import { connections } from './connections.js';
export { connections, subscribeConnections } from './connections.js';
export const prepareSocket = (path, target) => connections.prepareSocket(path, target);

import { browserClientId } from './browser-client.js';

export function wsUrl(path, target) {
  if (!target?.instanceId) throw new Error('Daemon identity must be verified before WebSocket connection');
  path += `${path.includes('?') ? '&' : '?'}instance=${encodeURIComponent(target.instanceId)}`;
  if (target?.url) {
    const url = new URL(target.url);
    const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${url.host}${path}`;
  }
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}${path}`;
}

// Always the daemon that served this page, regardless of which target is
// currently focused — otherwise switching to a daemon whose own config
// doesn't happen to list "back to where you came from" could strand the
// connection tabs with no way to switch back.
export async function listDaemons(signal) {
  return connections.directory(signal);
}

export function readBrowserState(scope, signal, target) {
  return request(`/browser/state?scope=${encodeURIComponent(scope)}`, { signal }, target);
}

export function writeBrowserState(scope, state, target) {
  return request('/browser/state', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client: browserClientId(), scope, state }),
  }, target);
}

export function readPanelLayout(signal, target) {
  return request('/panel-layout', { signal }, target);
}

function panelMutation(path, method, revision, body = {}, target) {
  return request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client: browserClientId(), revision, ...body }),
  }, target);
}

export const activatePanelGroup = (groupId, revision, target) => panelMutation(
  `/panel-layout/groups/${encodeURIComponent(groupId)}/activate`, 'POST', revision, {}, target,
);

export const createTerminalGroup = (revision, target) => panelMutation(
  '/panel-layout/groups', 'POST', revision, { type: 'terminal', activate: true }, target,
);

export const changePanelGroup = (groupId, changes, revision, target) => panelMutation(
  `/panel-layout/groups/${encodeURIComponent(groupId)}`, 'PUT', revision, changes, target,
);

export const createGroupPanel = (groupId, kind, revision, target, options = {}) => panelMutation(
  `/panel-layout/groups/${encodeURIComponent(groupId)}/panels`, 'POST', revision,
  { kind, ...options }, target,
);

export const mergeTerminalGroups = (sourceGroupId, destinationGroupId, revision, target) => panelMutation(
  `/panel-layout/groups/${encodeURIComponent(destinationGroupId)}/merge`, 'POST', revision,
  { sourceGroupId }, target,
);

export const changePanel = (panelId, changes, revision, target) => panelMutation(
  `/panel-layout/panels/${encodeURIComponent(panelId)}`, 'PUT', revision, changes, target,
);

export const closePanel = (panelId, revision, target) => panelMutation(
  `/panel-layout/panels/${encodeURIComponent(panelId)}/close`, 'POST', revision, {}, target,
);

export const savePanelOrder = (groupId, panelIds, widths, revision, target) => panelMutation(
  `/panel-layout/groups/${encodeURIComponent(groupId)}/order`, 'PUT', revision,
  { panelIds, widths }, target,
);

export const associateResource = (groupId, resource, revision, target) => panelMutation(
  `/panel-layout/groups/${encodeURIComponent(groupId)}/resources`, 'POST', revision, resource, target,
);

export const disassociateResource = (resourceId, options, revision, target) => panelMutation(
  `/panel-layout/resources/${encodeURIComponent(resourceId)}/disassociate`, 'POST', revision, options, target,
);

export const openPanelResource = (resourceId, revision, target, options = {}) => panelMutation(
  `/panel-layout/resources/${encodeURIComponent(resourceId)}/open`, 'POST', revision, options, target,
);

export function readPullRequest(resourceId, signal, target) {
  return request(`/panel-layout/resources/${encodeURIComponent(resourceId)}/pull-request`, { signal }, target);
}

function request(path, options = {}, target) {
  return connections.request(path, options, target);
}

export function listWorkstreams({ type, status, page, perpage }, signal, target) {
  const query = new URLSearchParams({
    status,
    page: String(page),
    perpage: String(perpage),
  });
  if (type) query.set('type', type);
  return request(`/fw/all/?${query}`, { signal }, target);
}

export async function listActivePausedWorkstreams(signal, target) {
  const perpage = 100;
  const first = await listWorkstreams({
    type: '', status: 'active_paused', page: 0, perpage,
  }, signal, target);
  const pageCount = Math.ceil(first.total / perpage);
  if (pageCount <= 1) return first.items;
  const remaining = await Promise.all(
    Array.from({ length: pageCount - 1 }, (_, index) => listWorkstreams({
      type: '', status: 'active_paused', page: index + 1, perpage,
    }, signal, target)),
  );
  return [first, ...remaining].flatMap((page) => page.items);
}

export async function getWorkstream(id, signal, target) {
  const body = await request(`/fw/${encodeURIComponent(id)}/?status=all`, { signal }, target);
  if (!body.items?.[0]) throw new Error(`Session ${id} is no longer available`);
  return body.items[0];
}

export function getNewSessionDefaults(signal, target) {
  return request('/fw/new', { signal }, target);
}

export function getLinkSuggestions(provider, query = '', signal, target) {
  const suffix = query ? `?q=${encodeURIComponent(query)}` : '';
  return request(`/fw/link-suggestions/${encodeURIComponent(provider)}${suffix}`, { signal }, target);
}

export function postCommand(id, command, body = {}, target) {
  return request(`/fw/${encodeURIComponent(id)}/${command}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, target);
}

export function syncWorkstream(id, target) {
  return postCommand(id, 'sync', {}, target);
}

export async function resetAllTerminalSessions(target) {
  const preview = await previewIntent({ kind: 'terminal-reset-all', body: {} }, undefined, target);
  if (!window.confirm(preview.consequences.join('\n'))) return { cancelled: true };
  return request('/fw/terminal-reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ previewRevision: preview.revision, confirm: true }),
  }, target);
}

export function createRepoSession(body, target) {
  return request('/fw', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, target);
}

export function createScratchpadSession(body, target) {
  return request('/fw/scratchpad', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, target);
}

export function listNotesFiles(signal, target) {
  return request('/notes/files', { signal }, target);
}

export function readNotesFile(path, signal, target) {
  return request(`/notes/file?path=${encodeURIComponent(path)}`, { signal }, target);
}

export function writeNotesFile({ path, content, version }, target) {
  return request('/notes/file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content, version }),
  }, target);
}

export function readMarkdownFile(path, signal, target) {
  return request(`/markdown/file?path=${encodeURIComponent(path)}`, { signal }, target);
}

export function completeMarkdownPath(path, signal, target) {
  return request(`/markdown/complete?path=${encodeURIComponent(path)}`, { signal }, target);
}

export function writeMarkdownFile({ path, content, version }, target) {
  return request('/markdown/file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content, version }),
  }, target);
}

export function openWeeklyNote(kind, target) {
  return request('/notes/weekly', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind }),
  }, target);
}

export function readEditorTabs(scope = 'global', signal, target) {
  return request(`/notes/tabs?scope=${encodeURIComponent(scope)}`, { signal }, target);
}

export function writeEditorTabs(scope, tabs, activePath, target) {
  return request('/notes/tabs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, tabs, activePath }),
  }, target);
}

export function resourcePreviewUrl(resource, target) {
  if (resource?.kind !== 'html') return resource?.value;
  if (!target?.instanceId) throw new Error('Verify the owning daemon before opening an HTML resource');
  const name = resource.value.split('/').pop();
  return `${target?.url || ''}/resource-files/${encodeURIComponent(target.instanceId)}/${encodeURIComponent(resource.id)}/${encodeURIComponent(name)}`;
}

export function previewIntent(intent, signal, target) {
  return request('/intents/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(intent), signal }, target);
}

export async function awaitJob(response, target) {
  if (!response.job) return response;
  let job = response.job;
  while (['queued', 'running', 'cancel_requested'].includes(job.status)) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    ({ job } = await request(`/jobs/${encodeURIComponent(job.id)}`, {}, target));
  }
  if (job.status !== 'succeeded') throw Object.assign(new Error(job.error?.message || `Operation ${job.status}; inspect job ${job.id}`), { job, details: job.error?.details });
  return job.result;
}
