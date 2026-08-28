async function request(path, options = {}) {
  const response = await fetch(path, options);
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

export function listWorkstreams({ type, status, page, perpage }, signal) {
  const query = new URLSearchParams({
    status,
    page: String(page),
    perpage: String(perpage),
  });
  if (type) query.set('type', type);
  return request(`/ws/all/?${query}`, { signal });
}

export async function listActivePausedWorkstreams(signal) {
  const perpage = 100;
  const first = await listWorkstreams({
    type: '', status: 'active_paused', page: 0, perpage,
  }, signal);
  const pageCount = Math.ceil(first.total / perpage);
  if (pageCount <= 1) return first.items;
  const remaining = await Promise.all(
    Array.from({ length: pageCount - 1 }, (_, index) => listWorkstreams({
      type: '', status: 'active_paused', page: index + 1, perpage,
    }, signal)),
  );
  return [first, ...remaining].flatMap((page) => page.items);
}

export async function getWorkstream(id, signal) {
  const body = await request(`/ws/${encodeURIComponent(id)}/?status=all`, { signal });
  if (!body.items?.[0]) throw new Error(`Session ${id} is no longer available`);
  return body.items[0];
}

export function getNewSessionDefaults(signal) {
  return request('/ws/new', { signal });
}

export function getLinkSuggestions(provider, query = '', signal) {
  const suffix = query ? `?q=${encodeURIComponent(query)}` : '';
  return request(`/ws/link-suggestions/${encodeURIComponent(provider)}${suffix}`, { signal });
}

export function postCommand(id, command, body = {}) {
  return request(`/ws/${encodeURIComponent(id)}/${command}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function createRepoSession(body) {
  return request('/ws', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function createScratchpadSession(body) {
  return request('/ws/scratchpad', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function listNotesFiles(signal) {
  return request('/notes/files', { signal });
}

export function readNotesFile(path, signal) {
  return request(`/notes/file?path=${encodeURIComponent(path)}`, { signal });
}

export function writeNotesFile({ path, content, version }) {
  return request('/notes/file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content, version }),
  });
}

export function openWeeklyNote(kind) {
  return request('/notes/weekly', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind }),
  });
}

export function readEditorTabs(scope = 'global', signal) {
  return request(`/notes/tabs?scope=${encodeURIComponent(scope)}`, { signal });
}

export function writeEditorTabs(scope, tabs, activePath) {
  return request('/notes/tabs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, tabs, activePath }),
  });
}
