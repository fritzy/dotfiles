import { browserClientId } from './browser-client.js';

export function wsUrl(path, target) {
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
  const response = await fetch('/daemons', { signal });
  return response.json();
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

async function request(path, options = {}, target) {
  const response = await fetch(`${target?.url || ''}${path}`, options);
  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    throw new Error(body?.message || body?.error || `HTTP ${response.status}`);
  }
  return body;
}

export function listWorkstreams({ type, status, page, perpage }, signal, target) {
  const query = new URLSearchParams({
    status,
    page: String(page),
    perpage: String(perpage),
  });
  if (type) query.set('type', type);
  return request(`/ws/all/?${query}`, { signal }, target);
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
  const body = await request(`/ws/${encodeURIComponent(id)}/?status=all`, { signal }, target);
  if (!body.items?.[0]) throw new Error(`Session ${id} is no longer available`);
  return body.items[0];
}

export function getNewSessionDefaults(signal, target) {
  return request('/ws/new', { signal }, target);
}

export function getLinkSuggestions(provider, query = '', signal, target) {
  const suffix = query ? `?q=${encodeURIComponent(query)}` : '';
  return request(`/ws/link-suggestions/${encodeURIComponent(provider)}${suffix}`, { signal }, target);
}

export function postCommand(id, command, body = {}, target) {
  return request(`/ws/${encodeURIComponent(id)}/${command}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, target);
}

export function createRepoSession(body, target) {
  return request('/ws', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, target);
}

export function createScratchpadSession(body, target) {
  return request('/ws/scratchpad', {
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
