import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

import { AGENT_PROVIDERS, CONFIG, PANEL_ROLES } from './config.js';
import {
  addIssue,
  addLog,
  configuredLocationAgentStatus,
  configuredLocationGitClean,
  createScratchpad,
  ensureWeeklyNote,
  existingNoteDir,
  expandIssueReference,
  isScratch,
  latestWorkstreamEventSequence,
  listWorkstreams,
  materializeWorktree,
  now,
  openDb,
  parseSelector,
  removeIssue,
  removeWorktree,
  renameWorkstream,
  resolveRow,
  selectedAgent,
  setPath,
  setSelectedAgent,
  setCachedGitClean,
  setStatus,
  upsertWorkstream,
  worktreeDirty,
  worktreeCleanAsync,
  workstreamEventsAfter,
  workstreamView,
} from './core.js';
import {
  closeTabInSession,
  focusAgentInSession,
  openTabNames,
  openTabInSession,
  panelStatesInSession,
  replaceAgentInSession,
  togglePanelInSession,
} from './zellij.js';
import { focusTerminalForZellij } from './terminal.js';

const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));
const WEB_ICONS = new Set([
  'claude.svg', 'folder.svg', 'git-branch.svg', 'git-pull-request.svg', 'github.svg', 'linear.svg', 'notes.svg', 'openai.svg',
]);
const TYPES = ['repo', 'scratchpad', 'misc'];
const STATUSES = ['active', 'paused', 'closed', 'all', 'active_paused'];
export const API_COMMANDS = [
  'pause', 'resume', 'close', 'rename', 'log', 'issue-add', 'issue-remove', 'panel-toggle', 'open-path',
  'open-notes', 'focus-agent', 'agent-set',
];

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function integerQuery(value, name, fallback, { min, max }) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) throw new ApiError(400, `${name} must be an integer`);
  const number = Number(value);
  if (number < min || number > max) {
    throw new ApiError(400, `${name} must be from ${min} to ${max}`);
  }
  return number;
}

function miscWorkstreams(db, config, tabNames = []) {
  const openTabs = new Set(tabNames);
  return Object.values(config.locations || {}).map((item) => ({
    ...item,
    repoUrl: `https://github.com/${item.repo}`,
    type: 'misc',
    closeable: false,
    scratch: false,
    status: openTabs.has(item.id) ? 'active' : 'paused',
    agentStatus: configuredLocationAgentStatus(db, item.id),
    agent: selectedAgent(db, item.id, config.agent || CONFIG.agent),
    source: 'configured',
    worktreePresent: existsSync(item.path),
    gitClean: configuredLocationGitClean(db, item.id),
    current: undefined,
    createdAt: null,
    lastJoined: null,
    stackedOn: null,
    stackedBy: [],
    issues: [],
  }));
}

function apiWorkstreamView(db, row, { cwd, config = CONFIG } = {}) {
  return {
    ...workstreamView(db, row, cwd),
    agent: selectedAgent(db, row.id, config.agent || CONFIG.agent),
    notesPath: existingNoteDir(row, config.paths.notes),
  };
}

export function stateItems(db, { cwd = process.cwd(), config = CONFIG, tabNames = [] } = {}) {
  const workstreams = listWorkstreams(db, { all: true })
    .sort((left, right) => right.id - left.id)
    .map((row) => ({
      type: isScratch(row) ? 'scratchpad' : 'repo',
      ...apiWorkstreamView(db, row, { cwd, config }),
    }));
  return [...miscWorkstreams(db, config, tabNames), ...workstreams];
}

export function queryWorkstreams(db, query = {}, context = {}) {
  const id = String(query.id ?? 'all');
  const type = query.type || null;
  const status = query.status || 'active_paused';
  if (type && !TYPES.includes(type)) {
    throw new ApiError(400, `type must be one of: ${TYPES.join(', ')}`);
  }
  if (!STATUSES.includes(status)) {
    throw new ApiError(400, `status must be one of: ${STATUSES.join(', ')}`);
  }
  const page = integerQuery(query.page, 'page', 0, { min: 0, max: 1_000_000 });
  const perpage = integerQuery(query.perpage, 'perpage', 25, { min: 1, max: 100 });
  let items = stateItems(db, context);

  if (id !== 'all') {
    const selected = items.find((item) => String(item.id) === id)
      || (() => {
        const row = resolveRow(db, id);
        return row && items.find((item) => item.type !== 'misc' && item.id === row.id);
      })();
    if (!selected) throw new ApiError(404, `no workstream matching "${id}"`);
    items = [selected];
  }
  if (type) items = items.filter((item) => item.type === type);
  if (status === 'active_paused') items = items.filter((item) => item.status === 'active' || item.status === 'paused');
  else if (status !== 'all') items = items.filter((item) => item.status === status);

  const total = items.length;
  const start = page * perpage;
  return {
    id,
    type: type || 'all',
    status,
    page,
    perpage,
    total,
    items: items.slice(start, start + perpage),
  };
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiError(400, `${name} must be a non-empty string`);
  }
  return value.trim();
}

function requiredAgent(value) {
  const agent = requiredString(value, 'agent');
  if (!AGENT_PROVIDERS.includes(agent)) {
    throw new ApiError(400, `agent must be one of: ${AGENT_PROVIDERS.join(', ')}`);
  }
  return agent;
}

function commandRow(db, id) {
  if (id === 'all') {
    throw new ApiError(400, 'commands require a repository or scratchpad id, not "all"');
  }
  const row = resolveRow(db, id);
  if (!row) throw new ApiError(404, `no workstream matching "${id}"`);
  return row;
}

function configuredLocationRow(id, config = CONFIG) {
  const location = config.locations?.[id];
  if (!location) return null;
  return { ...location, id, tab_name: id, path: location.path };
}

function repositoryParts(value) {
  const repository = requiredString(value, 'repository');
  const parts = repository.split('/');
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')) {
    throw new ApiError(400, 'repository must be in owner/repository form');
  }
  return parts;
}

function requestedPanels(value, fallback) {
  const panels = value === undefined ? fallback : value;
  if (!Array.isArray(panels) || panels.length === 0) {
    throw new ApiError(400, 'panels must contain at least one panel');
  }
  const unique = [...new Set(panels.map((panel) => requiredString(panel, 'panel')))];
  const invalid = unique.find((panel) => !PANEL_ROLES.includes(panel));
  if (invalid) throw new ApiError(400, `panel must be one of: ${PANEL_ROLES.join(', ')}`);
  return unique;
}

export function createRepoWorkstream(db, body = {}, context = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'request body must be a JSON object');
  }
  const config = context.config || CONFIG;
  const [org, repo] = repositoryParts(body.repository);
  const selector = requiredString(body.selector, 'branch or ref');
  const agent = requiredAgent(body.agent ?? config.agent);
  const panels = requestedPanels(body.panels, config.panels);
  const links = body.links ?? [];
  if (!Array.isArray(links)) throw new ApiError(400, 'links must be an array');

  let parsed;
  try {
    parsed = (context.parseSelector || parseSelector)(org, repo, selector);
  } catch (error) {
    throw new ApiError(422, `could not resolve branch or ref: ${error.message}`);
  }
  const branch = requiredString(parsed?.branch, 'resolved branch');
  const source = requiredString(parsed?.source, 'resolved source');
  let expandedLinks;
  try {
    const expand = context.expandIssue || expandIssueReference;
    expandedLinks = [...new Set(links.map((ref) => expand(
      { org, repo, branch, source },
      requiredString(ref, 'associated link'),
    )))];
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, error.message);
  }

  const existing = resolveRow(db, `${org}/${repo}:${branch}`);
  let path;
  try {
    path = (context.materialize || materializeWorktree)(org, repo, branch, source);
  } catch (error) {
    throw new ApiError(502, `could not create worktree: ${error.message}`);
  }
  const timestamp = (context.now || now)();
  let row = upsertWorkstream(db, {
    org, repo, branch, source, path,
    created_at: timestamp,
    last_joined_at: timestamp,
  });
  setSelectedAgent(db, row.id, agent);
  for (const ref of expandedLinks) addIssue(db, row.id, ref);

  let tab;
  try {
    tab = (context.openTab || openTabInSession)(row, { agent, panels });
  } catch (error) {
    setStatus(db, row.id, 'paused');
    throw new ApiError(502, `workstream #${row.id} was created, but its Zellij tab could not be opened: ${error.message}`, {
      id: row.id,
    });
  }
  row = resolveRow(db, String(row.id));
  return {
    ok: true,
    created: !existing,
    tab,
    workstream: {
      type: 'repo',
      ...apiWorkstreamView(db, row, { cwd: context.cwd, config }),
    },
  };
}

export function createScratchpadWorkstream(db, body = {}, context = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'request body must be a JSON object');
  }
  const config = context.config || CONFIG;
  if (body.name !== undefined && body.name !== null && typeof body.name !== 'string') {
    throw new ApiError(400, 'name must be a string');
  }
  const name = typeof body.name === 'string' ? body.name.trim() || undefined : undefined;
  const agent = requiredAgent(body.agent ?? config.agent);
  const panels = requestedPanels(body.panels, config.panels);
  const links = body.links ?? [];
  if (!Array.isArray(links)) throw new ApiError(400, 'links must be an array');

  let expandedLinks;
  try {
    const expand = context.expandIssue || expandIssueReference;
    expandedLinks = [...new Set(links.map((ref) => expand(
      { org: 'scratch', repo: 'scratch', source: 'scratch' },
      requiredString(ref, 'associated link'),
    )))];
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(422, error.message);
  }

  let row;
  try {
    row = (context.createScratchpad || createScratchpad)(db, name);
  } catch (error) {
    throw new ApiError(502, `could not create scratchpad: ${error.message}`);
  }
  setSelectedAgent(db, row.id, agent);
  for (const ref of expandedLinks) addIssue(db, row.id, ref);

  let tab;
  try {
    tab = (context.openTab || openTabInSession)(row, { agent, panels });
  } catch (error) {
    setStatus(db, row.id, 'paused');
    throw new ApiError(502, `scratchpad #${row.id} was created, but its Zellij tab could not be opened: ${error.message}`, {
      id: row.id,
    });
  }
  row = resolveRow(db, String(row.id));
  return {
    ok: true,
    created: true,
    tab,
    workstream: {
      type: 'scratchpad',
      ...apiWorkstreamView(db, row, { cwd: context.cwd, config }),
    },
  };
}

export function openPathWithXdg(path, { run = spawnSync } = {}) {
  const result = run('xdg-open', [path], { stdio: 'ignore' });
  if (result.error) throw new Error(`could not run xdg-open: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`xdg-open exited with status ${result.status}`);
  return { opener: 'xdg-open', path };
}

export function executeWorkstreamCommand(db, id, command, body = {}, context = {}) {
  if (!API_COMMANDS.includes(command)) {
    throw new ApiError(400, `unknown command "${command}"`, { commands: API_COMMANDS });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'request body must be a JSON object');
  }
  const config = context.config || CONFIG;
  if (command === 'open-notes') {
    const row = commandRow(db, id);
    const path = existingNoteDir(row, config.paths.notes);
    if (!path) throw new ApiError(404, `notes directory does not exist for workstream ${row.id}`);
    let result;
    try {
      result = (context.openPath || openPathWithXdg)(path);
    } catch (error) {
      throw new ApiError(502, `could not open notes directory: ${error.message}`);
    }
    return {
      ok: true,
      command,
      result,
      workstream: {
        type: isScratch(row) ? 'scratchpad' : 'repo',
        ...apiWorkstreamView(db, row, { cwd: context.cwd, config }),
      },
    };
  }
  if (command === 'open-path') {
    if (id === 'all') throw new ApiError(400, 'open-path requires a workstream id');
    const workstream = queryWorkstreams(db, { id, status: 'all' }, context).items[0];
    if (!workstream.worktreePresent) {
      throw new ApiError(404, `path does not exist: ${workstream.path}`);
    }
    let result;
    try {
      result = (context.openPath || openPathWithXdg)(workstream.path);
    } catch (error) {
      throw new ApiError(502, `could not open path: ${error.message}`);
    }
    return { ok: true, command, result, workstream };
  }
  const defaultAgent = config.agent || CONFIG.agent;
  const configuredRow = configuredLocationRow(id, config);
  if (configuredRow) {
    if (command === 'close') {
      throw new ApiError(400, `configured location "${id}" cannot be closed; pause its tab instead`);
    }
    if (!['pause', 'resume', 'focus-agent', 'panel-toggle', 'agent-set'].includes(command)) {
      throw new ApiError(400, `configured location "${id}" only supports pause, resume, open-path, focus-agent, panel-toggle, and agent-set`);
    }
    let result = {};
    try {
      if (command === 'pause') {
        (context.closeTab || closeTabInSession)(configuredRow);
      } else if (command === 'resume') {
        const opts = {
          agent: selectedAgent(db, id, defaultAgent),
          ...(configuredRow.weeklyNotes ? { editorFile: ensureWeeklyNote(configuredRow.path) } : {}),
        };
        (context.openTab || openTabInSession)(configuredRow, opts);
      } else if (command === 'focus-agent') {
        result = (context.focusAgent || focusAgentInSession)(configuredRow);
        result = {
          ...result,
          terminalFocus: (context.focusTerminal || focusTerminalForZellij)(result.session),
        };
      } else if (command === 'panel-toggle') {
        const panel = requiredString(body.panel, 'panel');
        if (!PANEL_ROLES.includes(panel)) {
          throw new ApiError(400, `panel must be one of: ${PANEL_ROLES.join(', ')}`);
        }
        const opts = {
          agent: selectedAgent(db, id, defaultAgent),
          ...(configuredRow.weeklyNotes && panel === 'editor'
            ? { editorFile: ensureWeeklyNote(configuredRow.path) }
            : {}),
        };
        result = (context.togglePanel || togglePanelInSession)(configuredRow, panel, opts);
      } else {
        const agent = requiredAgent(body.agent);
        const previous = selectedAgent(db, id, defaultAgent);
        if (agent === previous) {
          result = { agent, previous, changed: false, replaced: false };
        } else {
          result = (context.replaceAgent || replaceAgentInSession)(configuredRow, agent);
          setSelectedAgent(db, id, agent);
          result = { ...result, agent, previous, changed: true };
        }
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const action = command === 'pause'
        ? 'close Zellij tab'
        : command === 'resume'
          ? 'open Zellij tab'
          : command === 'focus-agent'
            ? 'focus agent panel'
            : command === 'panel-toggle'
              ? 'toggle Zellij panel'
              : 'change agent';
      throw new ApiError(502, `could not ${action}: ${error.message}`);
    }
    const tabNames = command === 'resume' ? [id] : command === 'pause' ? [] : context.tabNames;
    const workstream = miscWorkstreams(db, config, tabNames)
      .find((item) => item.id === id);
    return { ok: true, command, result, workstream };
  }
  let row = commandRow(db, id);
  let result = {};

  switch (command) {
    case 'pause':
      try {
        (context.closeTab || closeTabInSession)(row);
      } catch (error) {
        throw new ApiError(502, `could not close Zellij tab: ${error.message}`);
      }
      setStatus(db, row.id, 'paused');
      break;
    case 'resume': {
      if (!existsSync(row.path)) {
        const path = materializeWorktree(row.org, row.repo, row.branch, row.source);
        if (path !== row.path) {
          setPath(db, row.id, path);
          row.path = path;
        }
      }
      try {
        (context.openTab || openTabInSession)(row, {
          agent: selectedAgent(db, row.id, defaultAgent),
        });
      } catch (error) {
        throw new ApiError(502, `could not open Zellij tab: ${error.message}`);
      }
      setStatus(db, row.id, 'active', true);
      break;
    }
    case 'close': {
      const remove = body.remove === true;
      if (remove && existsSync(row.path)) {
        const dirty = !isScratch(row) ? worktreeDirty(row.path) : null;
        if (dirty && body.force !== true) {
          throw new ApiError(409, 'worktree has uncommitted changes; pass force:true to remove it', {
            dirty: dirty.split('\n'),
          });
        }
      }
      try {
        (context.closeTab || closeTabInSession)(row);
      } catch (error) {
        throw new ApiError(502, `could not close Zellij tab: ${error.message}`);
      }
      if (remove && existsSync(row.path)) {
        removeWorktree(row.org, row.repo, row.path);
      }
      setStatus(db, row.id, 'closed');
      result = { removed: remove };
      break;
    }
    case 'rename':
      row = renameWorkstream(db, row, requiredString(body.name, 'name'));
      break;
    case 'log':
      result = addLog(db, row.id, requiredString(body.body, 'body'), body.done === true);
      break;
    case 'issue-add': {
      const refs = body.refs ?? (body.ref === undefined ? [] : [body.ref]);
      if (!Array.isArray(refs) || refs.length === 0) {
        throw new ApiError(400, 'refs must be a non-empty array of issue references');
      }
      let expanded;
      try {
        expanded = refs.map((ref) => (context.expandIssue || expandIssueReference)(
          row,
          requiredString(ref, 'issue reference'),
        ));
      } catch (error) {
        throw new ApiError(422, error.message);
      }
      result = { issues: expanded.map((ref) => addIssue(db, row.id, ref)) };
      break;
    }
    case 'issue-remove':
      result = removeIssue(db, row.id, requiredString(body.ref, 'ref'));
      break;
    case 'panel-toggle': {
      const panel = requiredString(body.panel, 'panel');
      if (!PANEL_ROLES.includes(panel)) {
        throw new ApiError(400, `panel must be one of: ${PANEL_ROLES.join(', ')}`);
      }
      try {
        result = (context.togglePanel || togglePanelInSession)(row, panel, {
          agent: selectedAgent(db, row.id, defaultAgent),
        });
      } catch (error) {
        throw new ApiError(502, `could not toggle Zellij panel: ${error.message}`);
      }
      break;
    }
    case 'focus-agent':
      try {
        result = (context.focusAgent || focusAgentInSession)(row);
        result = {
          ...result,
          terminalFocus: (context.focusTerminal || focusTerminalForZellij)(result.session),
        };
      } catch (error) {
        throw new ApiError(502, `could not focus agent panel: ${error.message}`);
      }
      break;
    case 'agent-set': {
      const agent = requiredAgent(body.agent);
      const previous = selectedAgent(db, row.id, defaultAgent);
      if (agent === previous) {
        result = { agent, previous, changed: false, replaced: false };
        break;
      }
      try {
        result = (context.replaceAgent || replaceAgentInSession)(row, agent);
      } catch (error) {
        throw new ApiError(502, `could not change agent: ${error.message}`);
      }
      setSelectedAgent(db, row.id, agent);
      result = { ...result, agent, previous, changed: true };
      break;
    }
  }

  row = resolveRow(db, String(row.id));
  return {
    ok: true,
    command,
    result,
    workstream: {
      type: isScratch(row) ? 'scratchpad' : 'repo',
      ...apiWorkstreamView(db, row, { cwd: context.cwd, config }),
    },
  };
}

function json(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function staticFile(res, path, contentType, headOnly = false) {
  const body = readFileSync(path);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; script-src 'self'; style-src 'self' 'unsafe-inline'",
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(headOnly ? undefined : body);
}

async function jsonBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ApiError(413, 'request body exceeds 1 MiB');
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw new ApiError(400, `invalid JSON body: ${error.message}`);
  }
}

export function encodeWebSocketFrame(value, opcode = 0x1) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

function consumeWebSocketFrames(socket, initial = Buffer.alloc(0)) {
  let buffered = initial;
  const consume = (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 2) {
      const masked = Boolean(buffered[1] & 0x80);
      let length = buffered[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffered.length < 4) return;
        length = buffered.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffered.length < 10) return;
        const wide = buffered.readBigUInt64BE(2);
        if (wide > BigInt(Number.MAX_SAFE_INTEGER)) return socket.destroy();
        length = Number(wide);
        offset = 10;
      }
      if (!masked) return socket.destroy();
      if (buffered.length < offset + 4 + length) return;
      const mask = buffered.subarray(offset, offset + 4);
      const payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      const opcode = buffered[0] & 0x0f;
      buffered = buffered.subarray(offset + 4 + length);
      if (opcode === 0x8) {
        socket.write(encodeWebSocketFrame(payload, 0x8));
        return socket.end();
      }
      if (opcode === 0x9) socket.write(encodeWebSocketFrame(payload, 0xA));
    }
  };
  socket.on('data', consume);
  if (initial.length) consume(Buffer.alloc(0));
}

export function createApiService({
  db: suppliedDb,
  config = CONFIG,
  webRoot = WEB_ROOT,
  cwd = process.cwd(),
  pollInterval = config.server.pollInterval,
  openTab = openTabInSession,
  closeTab = closeTabInSession,
  panelState = panelStatesInSession,
  togglePanel = togglePanelInSession,
  replaceAgent = replaceAgentInSession,
  focusAgent = focusAgentInSession,
  focusTerminal = focusTerminalForZellij,
  openPath = openPathWithXdg,
  checkGit = worktreeCleanAsync,
  listOpenTabs = openTabNames,
  materialize = materializeWorktree,
  parseRepoSelector = parseSelector,
  expandIssue = expandIssueReference,
  clock = now,
  createScratchpadEntry = createScratchpad,
} = {}) {
  const db = suppliedDb || openDb();
  const ownsDb = !suppliedDb;
  const clients = new Set();
  const pendingGitRefreshes = new Map();
  let closing = false;
  let lastEventSequence = latestWorkstreamEventSequence(db);
  let lastTabNames = [];
  let lastMiscStatuses = null;

  const readOpenTabs = () => {
    try {
      lastTabNames = listOpenTabs();
    } catch (error) {
      // Preserve the last complete snapshot when Zellij is temporarily
      // unqueryable instead of making configured locations flicker to paused.
      process.stderr.write(`ai-workstream API Zellij poll: ${error.message}\n`);
    }
    return lastTabNames;
  };

  const miscStatuses = (tabNames) => {
    const openTabs = new Set(tabNames);
    return new Map(Object.keys(config.locations || {}).map((id) => [
      id, openTabs.has(id) ? 'active' : 'paused',
    ]));
  };

  const initialTabNames = readOpenTabs();
  lastMiscStatuses = miscStatuses(initialTabNames);

  const send = (socket, message) => {
    if (!socket.destroyed && socket.writable) socket.write(encodeWebSocketFrame(JSON.stringify(message)));
  };
  const broadcast = (message) => {
    for (const socket of clients) send(socket, message);
  };
  const broadcastChanges = () => {
    const events = workstreamEventsAfter(db, lastEventSequence);
    if (events.length) lastEventSequence = events.at(-1).sequence;
    const changes = events.map(({ sequence, ...event }) => event);
    for (const message of changes) broadcast(message);
    return changes;
  };
  const broadcastMiscChanges = () => {
    const current = miscStatuses(readOpenTabs());
    const changes = [];
    for (const [id, status] of current) {
      if (lastMiscStatuses.get(id) !== status) {
        const message = { id, type: 'update_session' };
        changes.push(message);
        broadcast(message);
      }
    }
    lastMiscStatuses = current;
    return changes;
  };

  const gitRefreshTarget = (id) => {
    const configured = config.locations?.[String(id)];
    if (configured?.repo) return { id: String(id), path: configured.path };
    const row = resolveRow(db, String(id));
    return row && !isScratch(row) ? { id: row.id, path: row.path } : null;
  };

  const refreshGitBeforeResponse = async (workstream) => {
    const target = gitRefreshTarget(workstream.id);
    if (!target) return workstream;
    try {
      const clean = await Promise.resolve(checkGit(target.path));
      setCachedGitClean(db, target.id, clean);
      return { ...workstream, gitClean: clean };
    } catch (error) {
      process.stderr.write(`ai-workstream API Git status: ${error.message}\n`);
      return workstream;
    }
  };

  const scheduleGitRefresh = (items) => {
    if (closing) return;
    for (const item of items || []) {
      const key = String(item.id);
      if (!gitRefreshTarget(item.id)) continue;
      const pending = pendingGitRefreshes.get(key);
      if (pending) {
        pending.rerun = true;
        continue;
      }
      const state = { rerun: false, promise: null };
      state.promise = new Promise((resolve) => {
        setImmediate(async () => {
          try {
            do {
              state.rerun = false;
              if (closing) break;
              const target = gitRefreshTarget(item.id);
              if (!target) break;
              const checkedPath = target.path;
              const clean = await Promise.resolve(checkGit(checkedPath));
              if (closing) break;
              const current = gitRefreshTarget(item.id);
              if (!current) break;
              if (current.path !== checkedPath) {
                state.rerun = true;
                continue;
              }
              if (setCachedGitClean(db, current.id, clean)) broadcastChanges();
            } while (state.rerun);
          } catch (error) {
            if (!closing) process.stderr.write(`ai-workstream API Git status: ${error.message}\n`);
          } finally {
            pendingGitRefreshes.delete(key);
            resolve();
          }
        });
      });
      pendingGitRefreshes.set(key, state);
    }
  };

  const server = createServer((req, res) => {
    Promise.resolve().then(async () => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const headOnly = req.method === 'HEAD';
      if ((req.method === 'GET' || headOnly) && url.pathname === '/') {
        return staticFile(res, `${webRoot}/index.html`, 'text/html; charset=utf-8', headOnly);
      }
      if ((req.method === 'GET' || headOnly) && url.pathname === '/webclient.js') {
        return staticFile(res, `${webRoot}/webclient.js`, 'text/javascript; charset=utf-8', headOnly);
      }
      const iconName = url.pathname.match(/^\/icons\/([^/]+)$/)?.[1];
      if ((req.method === 'GET' || headOnly) && WEB_ICONS.has(iconName)) {
        return staticFile(res, `${webRoot}/icons/${iconName}`, 'image/svg+xml', headOnly);
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, {
          service: 'ai-workstream',
          version: PACKAGE.version,
          pid: process.pid,
          uptime: process.uptime(),
          websocket: '/ws/events',
        });
      }
      if (req.method === 'GET' && url.pathname === '/ws/events') {
        return json(res, 426, { error: 'upgrade_required', websocket: '/ws/events' }, { Upgrade: 'websocket' });
      }

      const parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
      if (req.method === 'GET' && parts[0] === 'ws' && parts[1] === 'new' && parts.length === 2) {
        return json(res, 200, {
          repositoryRoot: config.paths.repositories,
          scratchpadRoot: config.paths.scratchpads,
          agent: config.agent,
          panels: config.panels,
        });
      }
      if (req.method === 'GET' && parts[0] === 'ws' && parts.length <= 2) {
        const result = queryWorkstreams(db, {
          id: parts[1] || 'all',
          type: url.searchParams.get('type') || undefined,
          page: url.searchParams.get('page') || undefined,
          perpage: url.searchParams.get('perpage') || undefined,
          status: url.searchParams.get('status') || undefined,
        }, { cwd, config, tabNames: readOpenTabs() });
        if (parts[1] && parts[1] !== 'all' && result.items[0]) {
          const item = result.items[0];
          const row = item.type === 'misc'
            ? configuredLocationRow(String(item.id), config)
            : resolveRow(db, String(item.id));
          try {
            result.items[0].panels = panelState(row);
          } catch (error) {
            result.items[0].panels = null;
            result.items[0].panelError = error.message;
          }
        }
        json(res, 200, result);
        scheduleGitRefresh(result.items);
        return;
      }
      if (req.method === 'POST' && parts[0] === 'ws' && parts.length === 1) {
        const body = await jsonBody(req);
        const result = createRepoWorkstream(db, body, {
          cwd, config, openTab, materialize, parseSelector: parseRepoSelector, expandIssue, now: clock,
        });
        result.workstream = await refreshGitBeforeResponse(result.workstream);
        broadcastChanges();
        json(res, result.created ? 201 : 200, result);
        return;
      }
      if (req.method === 'POST' && parts[0] === 'ws' && parts[1] === 'scratchpad' && parts.length === 2) {
        const body = await jsonBody(req);
        const result = createScratchpadWorkstream(db, body, {
          cwd, config, openTab, createScratchpad: createScratchpadEntry, expandIssue,
        });
        result.workstream = await refreshGitBeforeResponse(result.workstream);
        broadcastChanges();
        json(res, 201, result);
        return;
      }
      if (req.method === 'POST' && parts[0] === 'ws' && parts.length === 3) {
        const body = await jsonBody(req);
        const result = executeWorkstreamCommand(db, parts[1], parts[2], body, {
          cwd, config, tabNames: readOpenTabs(),
          openTab, closeTab, togglePanel, replaceAgent, focusAgent, focusTerminal, openPath,
        });
        broadcastChanges();
        if (result.workstream.type === 'misc') broadcastMiscChanges();
        if (parts[2] === 'panel-toggle') {
          broadcast({ id: result.workstream.id, type: 'update_session' });
        }
        json(res, 200, result);
        scheduleGitRefresh([result.workstream]);
        return;
      }
      throw new ApiError(404, 'not found');
    }).catch((error) => {
      const status = error instanceof ApiError ? error.status : 500;
      json(res, status, {
        error: status === 500 ? 'internal_server_error' : 'request_error',
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      });
      if (status === 500) process.stderr.write(`ai-workstream API: ${error.stack || error}\n`);
    });
  });

  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname; }
    catch { socket.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    const origin = req.headers.origin;
    let originAllowed = true;
    if (typeof origin === 'string') {
      try { originAllowed = new URL(origin).host === req.headers.host; }
      catch { originAllowed = false; }
    }
    if (pathname !== '/ws/events' || req.headers.upgrade?.toLowerCase() !== 'websocket'
        || typeof key !== 'string' || !originAllowed) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n'));
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.on('error', () => clients.delete(socket));
    consumeWebSocketFrames(socket, head);
  });

  const timer = pollInterval > 0 ? setInterval(() => {
    try {
      const changes = broadcastChanges();
      scheduleGitRefresh(changes);
      broadcastMiscChanges();
    } catch (error) {
      process.stderr.write(`ai-workstream API poll: ${error.message}\n`);
    }
  }, pollInterval) : null;
  timer?.unref();

  return {
    server,
    db,
    clients,
    broadcastChanges,
    broadcastMiscChanges,
    scheduleGitRefresh,
    async close() {
      closing = true;
      if (timer) clearInterval(timer);
      for (const socket of clients) socket.destroy();
      clients.clear();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      await Promise.allSettled([...pendingGitRefreshes.values()].map(({ promise }) => promise));
      if (ownsDb) db.close();
    },
  };
}
