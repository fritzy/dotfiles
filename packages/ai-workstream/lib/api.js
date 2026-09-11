import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import chokidar from 'chokidar';

import { AGENT_PROVIDERS, CONFIG, PANEL_ROLES } from './config.js';
import {
  addNote,
  addIssue,
  addLog,
  appendDayEntry,
  briefStackRow,
  collectDayActivity,
  configuredLocationAgentStatus,
  configuredLocationGitClean,
  configuredLocationShellStatus,
  createScratchpad,
  dayHeading,
  existingNoteDir,
  expandIssueReference,
  ghStackLink,
  hasGitHubPullRequest,
  isScratch,
  latestWorkstreamEventSequence,
  linkPrAsync,
  linkedSessionSeed,
  listIssues,
  listNotes,
  listWorkstreams,
  materializeWorktree,
  noteDir,
  now,
  openDb,
  parseSelector,
  parentOf,
  readBrowserUiState,
  recentRepositories,
  removeIssue,
  removeWorktree,
  renderDigest,
  refreshWorkstreamStatuses,
  resolveRow,
  selectedAgent,
  setPath,
  setParent,
  setSelectedAgent,
  setCachedGitClean,
  setConfiguredLocationShellStatus,
  setShellStatus,
  setWorkstreamLabel,
  setStatus,
  stackCheck,
  stackLine,
  stackTree,
  touchLastJoined,
  upsertWorkstream,
  worktreeDirty,
  worktreeCleanAsync,
  workstreamEventsAfter,
  workstreamView,
  writeBrowserUiState,
  writeSeed,
} from './core.js';
import {
  agentCommand,
  agentInvocation,
  browserTerminalConfigFile,
  browserTerminalSessionName,
  ensureBrowserTerminalSession,
  killBrowserTerminalSession,
  resetAllBrowserTerminalSessions,
  resetBrowserTerminalSession,
} from './zellij.js';
import {
  githubWorkSuggestions,
  linearSearchSuggestions as searchLinearSuggestions,
  linearWorkSuggestions,
} from './suggestions.js';
import {
  completeMarkdownPath,
  createMarkdownFile,
  NotesFileError,
  listNotesFiles,
  notesRelativePath,
  openWeeklyNote,
  readEditorTabs,
  readMarkdownFile,
  readNotesFile,
  resolveMarkdownFile,
  resolveNotesFile,
  weeklyNotePath,
  writeEditorTabs,
  writeMarkdownFile,
  writeNotesFile,
} from './notes-files.js';
import { DAEMON_REVISION } from './daemon.js';
import { spawnZellijAttachTerminal } from './pty.js';
import {
  PanelModelError,
  activatePanelGroup,
  addPanel,
  addResource,
  createPanelGroup,
  deactivatePanelGroup,
  ensureSessionPanelGroup,
  mergeTerminalGroups,
  migrateLegacyPanelState,
  openResourcePanel,
  panelLayoutRevision,
  readPanelLayout,
  removePanel,
  removeResource,
  reorderPanels,
  syncDiscoveredSessionNotes,
  syncIssueResources,
  syncSessionPanelGroups,
  terminalPanelDescriptor,
  terminalPanelsForOwner,
  updatePanelGroup,
  updatePanel,
} from './panels.js';

const PACKAGE = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const WEB_ROOT = fileURLToPath(new URL('../web/', import.meta.url));
const WEB_ICONS = new Set([
  'check.svg', 'claude.svg', 'folder.svg', 'git-branch.svg', 'git-pull-request.svg', 'github.svg', 'linear.svg', 'local.svg', 'notes.svg', 'openai.svg', 'remote.svg',
]);
const V2_ASSET_TYPES = new Map([
  ['css', 'text/css; charset=utf-8'],
  ['js', 'text/javascript; charset=utf-8'],
  ['map', 'application/json; charset=utf-8'],
]);
const V2_FONT_TYPES = new Map([
  ['woff2', 'font/woff2'],
  ['txt', 'text/plain; charset=utf-8'],
]);
const TYPES = ['repo', 'scratchpad', 'misc'];
const STATUSES = ['active', 'paused', 'closed', 'all', 'active_paused'];
const MAX_WEBSOCKET_PAYLOAD = 1024 * 1024;
const MAX_SEED_BYTES = 64 * 1024;
const BROWSER_UI_SCOPES = new Set(['workspaces', 'bottom-terminals']);
const BROWSER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DEFAULT_BROWSER_PANELS = ['shell', 'agent'];
export const API_COMMANDS = [
  'pause', 'resume', 'archive', 'close', 'rename', 'log', 'issue-add', 'issue-remove', 'open-path',
  'open-notes', 'agent-set', 'terminal-reset',
];

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function browserTerminalLaunch(role, workstream, config, seedContent = null) {
  if (role === 'agent') {
    if (seedContent) {
      const launch = agentInvocation(workstream, { agent: workstream.agent }, config);
      return { command: launch.command, args: [...launch.args, seedContent] };
    }
    return {
      command: 'sh',
      args: ['-c', agentCommand(workstream, { agent: workstream.agent }, config)],
    };
  }
  const configured = role === 'editor' ? config.commands.editor : config.commands.shell;
  return { command: configured[0], args: configured.slice(1) };
}

function browserId(value, name, fallback = null) {
  const id = value == null || value === '' ? fallback : String(value);
  if (id === null || !BROWSER_ID_PATTERN.test(id)) {
    throw new ApiError(400, `${name} must contain only letters, numbers, dots, underscores, and dashes`);
  }
  return id;
}

function browserUiScope(value) {
  const scope = String(value || '');
  if (!BROWSER_UI_SCOPES.has(scope)) {
    throw new ApiError(400, `scope must be one of: ${[...BROWSER_UI_SCOPES].join(', ')}`);
  }
  return scope;
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

function miscWorkstreams(db, config, terminalSessionIds = []) {
  const activeSessions = new Set([...terminalSessionIds].map(String));
  return Object.values(config.locations || {}).map((item) => ({
    ...item,
    repoUrl: `https://github.com/${item.repo}`,
    type: 'misc',
    closeable: false,
    scratch: false,
    status: activeSessions.has(String(item.id)) ? 'active' : 'paused',
    agentStatus: configuredLocationAgentStatus(db, item.id),
    shellStatus: configuredLocationShellStatus(db, item.id),
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

export function stateItems(db, { cwd = process.cwd(), config = CONFIG, terminalSessionIds = [] } = {}) {
  const workstreams = listWorkstreams(db, { all: true })
    .sort((left, right) => right.id - left.id)
    .map((row) => ({
      type: isScratch(row) ? 'scratchpad' : 'repo',
      ...apiWorkstreamView(db, row, { cwd, config }),
    }));
  return [...miscWorkstreams(db, config, terminalSessionIds), ...workstreams];
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
  return { ...location, id, path: location.path };
}

function repositoryParts(value) {
  const repository = requiredString(value, 'repository');
  const parts = repository.split('/');
  if (parts.length !== 2 || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')) {
    throw new ApiError(400, 'repository must be in owner/repository form');
  }
  return parts;
}

function requestedPanels(value, fallback = DEFAULT_BROWSER_PANELS) {
  const panels = value === undefined ? fallback : value;
  if (!Array.isArray(panels) || panels.length === 0) {
    throw new ApiError(400, 'panels must contain at least one panel');
  }
  const unique = [...new Set(panels.map((panel) => requiredString(panel, 'panel')))];
  const invalid = unique.find((panel) => !PANEL_ROLES.includes(panel));
  if (invalid) throw new ApiError(400, `panel must be one of: ${PANEL_ROLES.join(', ')}`);
  const selected = new Set(unique);
  if (!selected.has('shell') || !selected.has('agent')
      || (unique.length !== 2 && unique.length !== 3)
      || (unique.length === 3 && !selected.has('editor'))) {
    throw new ApiError(400, 'browser panels must be shell,agent or shell,editor,agent');
  }
  return unique;
}

function requestedSeed(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new ApiError(400, 'seed must be markdown text');
  const seed = value.trimEnd();
  if (Buffer.byteLength(seed) > MAX_SEED_BYTES) {
    throw new ApiError(400, `seed must be at most ${MAX_SEED_BYTES / 1024} KiB`);
  }
  return seed;
}

function combinedSeed(explicit, linked) {
  return [explicit, linked].filter(Boolean).join('\n\n');
}

const panelModeFor = (panels) => panels.includes('editor') ? 'three' : 'two';

export function createRepoWorkstream(db, body = {}, context = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'request body must be a JSON object');
  }
  const config = context.config || CONFIG;
  const [org, repo] = repositoryParts(body.repository);
  const selector = requiredString(body.selector, 'branch or ref');
  const agent = requiredAgent(body.agent ?? config.agent);
  const panels = requestedPanels(body.panels);
  const seed = requestedSeed(body.seed);
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
  const previousAgent = existing ? selectedAgent(db, existing.id, config.agent) : agent;
  let parent = null;
  if (body.parent !== undefined && body.parent !== null && body.parent !== '') {
    parent = resolveRow(db, requiredString(body.parent, 'parent'));
    if (!parent) throw new ApiError(404, `no workstream matching parent "${body.parent}"`);
    if (isScratch(parent)) {
      throw new ApiError(400, `parent #${parent.id} is a scratchpad, so it has no branch to build on`);
    }
  }
  const sameRepoParent = parent && parent.org === org && parent.repo === repo;
  let path;
  try {
    path = (context.materialize || materializeWorktree)(
      org, repo, branch, source, sameRepoParent ? { base: parent.branch } : {},
    );
  } catch (error) {
    throw new ApiError(502, `could not create worktree: ${error.message}`);
  }
  const timestamp = (context.now || now)();
  let row = upsertWorkstream(db, {
    org, repo, branch, source, path,
    status: existing?.status === 'active' ? 'active' : 'paused',
    created_at: timestamp,
    last_joined_at: timestamp,
  });
  if (parent) row = setParent(db, row, parent);
  setSelectedAgent(db, row.id, agent);
  if (!panels.includes('shell')) setShellStatus(db, row.id, null);
  for (const ref of expandedLinks) addIssue(db, row.id, ref);

  const associatedLinks = listIssues(db, row.id).map((issue) => issue.ref);
  const briefing = combinedSeed(seed, linkedSessionSeed('repo', associatedLinks));
  if (briefing) {
    try {
      (context.writeSeed || writeSeed)(row, briefing);
    } catch (error) {
      setStatus(db, row.id, 'paused');
      throw new ApiError(502, `workstream #${row.id} was created, but its agent seed could not be written: ${error.message}`, {
        id: row.id,
      });
    }
  }

  row = resolveRow(db, String(row.id));
  return {
    ok: true,
    created: !existing,
    browserWorkspace: { opened: true, panelMode: panelModeFor(panels) },
    branchedOffParent: Boolean(sameRepoParent),
    agentChanged: Boolean(existing && previousAgent !== agent),
    seeded: Boolean(briefing),
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
  const panels = requestedPanels(body.panels);
  const seed = requestedSeed(body.seed);
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
  if (row.status !== 'paused') {
    setStatus(db, row.id, 'paused');
    row = resolveRow(db, String(row.id));
  }
  setSelectedAgent(db, row.id, agent);
  if (!panels.includes('shell')) setShellStatus(db, row.id, null);
  for (const ref of expandedLinks) addIssue(db, row.id, ref);

  const associatedLinks = listIssues(db, row.id).map((issue) => issue.ref);
  const briefing = combinedSeed(seed, linkedSessionSeed('scratchpad', associatedLinks));
  if (briefing) {
    try {
      (context.writeSeed || writeSeed)(row, briefing);
    } catch (error) {
      setStatus(db, row.id, 'paused');
      throw new ApiError(502, `scratchpad #${row.id} was created, but its agent seed could not be written: ${error.message}`, {
        id: row.id,
      });
    }
  }

  row = resolveRow(db, String(row.id));
  return {
    ok: true,
    created: true,
    browserWorkspace: { opened: true, panelMode: panelModeFor(panels) },
    seeded: Boolean(briefing),
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
    if (command === 'archive' || command === 'close') {
      throw new ApiError(400, `configured location "${id}" cannot be archived; pause its browser workspace instead`);
    }
    if (!['pause', 'resume', 'agent-set', 'terminal-reset'].includes(command)) {
      throw new ApiError(400, `configured location "${id}" only supports pause, resume, open-path, agent-set, and terminal-reset`);
    }
    let result = {};
    try {
      if (command === 'pause') {
        result = { browserTerminals: 'pause_requested' };
      } else if (command === 'resume') {
        const panels = requestedPanels(body.panels);
        const previous = selectedAgent(db, id, defaultAgent);
        const agent = body.agent === undefined
          ? previous
          : requiredAgent(body.agent);
        const seed = requestedSeed(body.seed);
        setSelectedAgent(db, id, agent);
        if (seed) (context.writeSeed || writeSeed)(configuredRow, seed);
        result = {
          browserTerminals: 'resume_requested', panels, agent,
          ...(agent !== previous ? { agentChanged: true } : {}),
          seeded: Boolean(seed),
        };
        if (!panels.includes('shell')) setConfiguredLocationShellStatus(db, id, null);
      } else if (command === 'terminal-reset') {
        setSelectedAgent(db, id, selectedAgent(db, id, defaultAgent));
        setConfiguredLocationShellStatus(db, id, null);
        result = { browserTerminals: 'reset_requested' };
      } else {
        const agent = requiredAgent(body.agent);
        const previous = selectedAgent(db, id, defaultAgent);
        if (agent === previous) {
          result = { agent, previous, changed: false, replaced: false };
        } else {
          setSelectedAgent(db, id, agent);
          result = { agent, previous, changed: true, replaced: false };
        }
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      const action = command === 'pause'
        ? 'pause browser terminals'
        : command === 'resume'
          ? 'resume browser terminals'
          : command === 'terminal-reset'
            ? 'reset browser terminals'
            : 'change agent';
      throw new ApiError(502, `could not ${action}: ${error.message}`);
    }
    const terminalSessionIds = command === 'pause'
      ? [...(context.terminalSessionIds || [])].filter((sessionId) => String(sessionId) !== id)
      : context.terminalSessionIds;
    const workstream = miscWorkstreams(db, config, terminalSessionIds)
      .find((item) => item.id === id);
    return { ok: true, command, result, workstream };
  }
  let row = commandRow(db, id);
  let result = {};

  switch (command) {
    case 'pause':
      setStatus(db, row.id, 'paused');
      result = { browserTerminals: 'pause_requested' };
      break;
    case 'resume': {
      if (!existsSync(row.path)) {
        const path = materializeWorktree(row.org, row.repo, row.branch, row.source);
        if (path !== row.path) {
          setPath(db, row.id, path);
          row.path = path;
        }
      }
      const panels = requestedPanels(body.panels);
      const previous = selectedAgent(db, row.id, defaultAgent);
      const agent = body.agent === undefined
        ? previous
        : requiredAgent(body.agent);
      const seed = requestedSeed(body.seed);
      setSelectedAgent(db, row.id, agent);
      if (seed) (context.writeSeed || writeSeed)(row, seed);
      if (!panels.includes('shell')) setShellStatus(db, row.id, null);
      if (row.status === 'closed') setStatus(db, row.id, 'paused', true);
      else touchLastJoined(db, row.id);
      result = {
        browserTerminals: 'resume_requested', panels, agent,
        ...(agent !== previous ? { agentChanged: true } : {}),
        seeded: Boolean(seed),
      };
      break;
    }
    case 'terminal-reset':
      setSelectedAgent(db, row.id, selectedAgent(db, row.id, defaultAgent));
      setShellStatus(db, row.id, null);
      result = { browserTerminals: 'reset_requested' };
      break;
    case 'archive':
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
      if (remove && existsSync(row.path)) {
        removeWorktree(row.org, row.repo, row.path);
      }
      setStatus(db, row.id, 'closed');
      result = { removed: remove };
      break;
    }
    case 'rename': {
      const name = requiredString(body.name, 'name');
      row = setWorkstreamLabel(db, row, name);
      result = { renamed: true };
      break;
    }
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
    case 'agent-set': {
      const agent = requiredAgent(body.agent);
      const previous = selectedAgent(db, row.id, defaultAgent);
      if (agent === previous) {
        result = { agent, previous, changed: false, replaced: false };
        break;
      }
      setSelectedAgent(db, row.id, agent);
      result = { agent, previous, changed: true, replaced: false };
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

const briefWorkstream = (row) => ({
  id: row.id, repo: `${row.org}/${row.repo}`, branch: row.branch,
});

const stackNode = (node) => ({
  ...briefStackRow(node.row),
  repo: isScratch(node.row) ? 'scratch' : `${node.row.org}/${node.row.repo}`,
  stackedBy: node.children.map(stackNode),
});

function stackLinearity(db, row) {
  try {
    const chain = stackLine(db, row);
    const check = stackCheck(chain);
    return { chain, ...check };
  } catch (error) {
    return { chain: null, ok: false, reason: error.message };
  }
}

export function workstreamStack(db, id) {
  const row = commandRow(db, id);
  const { chain, ok, reason, repo } = stackLinearity(db, row);
  return {
    workstream: briefWorkstream(row),
    stackedOn: parentOf(db, row) ? briefStackRow(parentOf(db, row)) : null,
    stack: stackNode(stackTree(db, row)),
    linear: Boolean(chain),
    bottomToTop: chain ? chain.map((item) => ({ ...briefStackRow(item), path: item.path })) : null,
    canLinkOnGitHub: ok,
    reason: ok ? undefined : reason,
    githubRepo: ok ? repo : undefined,
  };
}

export function setWorkstreamStack(db, id, body = {}) {
  const row = commandRow(db, id);
  if (body.clear) {
    const previous = parentOf(db, row);
    const updated = setParent(db, row, null);
    return {
      workstream: briefWorkstream(updated),
      cleared: true,
      wasStackedOn: previous ? briefStackRow(previous) : null,
    };
  }
  const selector = requiredString(body.parent, 'parent');
  const parent = resolveRow(db, selector);
  if (!parent) throw new ApiError(404, `no workstream matching parent "${selector}"`);
  let updated;
  try {
    updated = setParent(db, row, parent);
  } catch (error) {
    throw new ApiError(400, error.message);
  }
  return {
    workstream: briefWorkstream(updated),
    stackedOn: briefStackRow(parent),
    stack: stackNode(stackTree(db, updated)),
  };
}

export function linkWorkstreamStack(db, id, body = {}) {
  const row = commandRow(db, id);
  let chain;
  try {
    chain = stackLine(db, row);
  } catch (error) {
    throw new ApiError(409, error.message);
  }
  const check = stackCheck(chain);
  if (!check.ok) throw new ApiError(409, check.reason);
  let linked;
  try {
    linked = ghStackLink(chain, { open: body.open === true });
  } catch (error) {
    throw new ApiError(502, error.message);
  }
  return {
    workstream: briefWorkstream(row),
    repo: check.repo,
    bottomToTop: chain.map((item) => item.branch),
    command: linked.command,
    ok: linked.ok,
    output: linked.output,
  };
}

export function createWorkstreamNote(db, id, body = {}, { notesRoot = CONFIG.paths.notes } = {}) {
  const row = commandRow(db, id);
  if (typeof body.body !== 'string' || body.body.trim() === '') {
    throw new ApiError(400, 'body must be a non-empty string');
  }
  if (body.title !== undefined && typeof body.title !== 'string') {
    throw new ApiError(400, 'title must be a string');
  }
  const { file, path } = addNote(row, body.body, { title: body.title, root: notesRoot });
  return { workstream: briefWorkstream(row), file, path };
}

export function workstreamNotes(db, id, { notesRoot = CONFIG.paths.notes } = {}) {
  const row = commandRow(db, id);
  return { workstream: briefWorkstream(row), notes: listNotes(row, notesRoot) };
}

export async function syncWorkstreamSession(db, id, {
  notesRoot = CONFIG.paths.notes,
  checkPr = linkPrAsync,
  checkedAt = now(),
} = {}) {
  const row = commandRow(db, id);
  const groupSync = ensureSessionPanelGroup(db, {
    id: row.id,
    type: isScratch(row) ? 'scratchpad' : 'repo',
    name: row.label || row.branch,
    path: row.path,
    source: row.source,
  }, { bump: true });
  const noteSync = syncDiscoveredSessionNotes(db, notesRoot, { ownerId: row.id });
  const hadPullRequest = hasGitHubPullRequest(db, row.id);
  const pullRequestResult = !isScratch(row) && !hadPullRequest
    ? await checkPr(db, row, { checkedAt })
    : null;
  const issueSync = syncIssueResources(db);
  const layout = readPanelLayout(db);
  const group = layout.groups.find((item) => item.ownerId === String(row.id));
  return {
    workstream: briefWorkstream(resolveRow(db, String(row.id))),
    notes: {
      changed: groupSync.changed || noteSync.changed,
      count: group?.resources.filter((resource) => resource.kind === 'markdown').length || 0,
    },
    pullRequest: {
      checked: !isScratch(row) && !hadPullRequest,
      associated: hasGitHubPullRequest(db, row.id),
      added: pullRequestResult?.added === true,
      pr: pullRequestResult?.pr || null,
    },
    layout: {
      changed: groupSync.changed || noteSync.changed || issueSync.changed,
      revision: layout.revision,
    },
  };
}

export function workstreamDigest(db, body = {}, { notesRoot = CONFIG.paths.notes } = {}) {
  if (body.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    throw new ApiError(400, 'date must use YYYY-MM-DD');
  }
  const activity = collectDayActivity(db, { date: body.date });
  const markdown = renderDigest(activity);
  const result = { date: activity.dateIso, markdown, workstreams: activity.workstreams };
  if (body.write === true && markdown) {
    const { file, heading } = appendDayEntry(markdown, activity.date, notesRoot);
    result.written = { file, heading };
  }
  return result;
}

// The client may be talking to us cross-origin (the daemon-selector switches
// a page served by one loopback alias to fetch/WebSocket a different one, e.g.
// the ws-tunnel's 127.1.1.2). A real remote attacker's page can never present
// a loopback Origin, so trusting one here is no broader than trusting the
// same-origin case this server was already built for.
function loopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '::1' || /^127(\.\d{1,3}){3}$/.test(hostname);
}

function loopbackOrigin(req) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return null;
  try {
    const parsed = new URL(origin);
    return loopbackHostname(parsed.hostname) ? origin : null;
  } catch {
    return null;
  }
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

// ws:/wss: as bare schemes already allow a WebSocket to any host, which is
// how /ws/terminal and /ws/events reach another daemon; plain fetch() has no
// such scheme-source, so each configured daemon's origin is listed here too
// — otherwise the daemon-selector's switch to it is blocked by CSP before
// CORS is ever evaluated.
const DAEMON_CONNECT_SRC = Object.values(CONFIG.daemons).map((daemon) => daemon.url).join(' ');

function staticFile(res, path, contentType, headOnly = false) {
  const body = readFileSync(path);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    // img-src is widened so markdown previews can show images a note links to;
    // everything else stays same-origin (plus the configured daemons above).
    'Content-Security-Policy': `default-src 'self'; connect-src 'self' ws: wss: ${DAEMON_CONNECT_SRC}; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; frame-src 'self' https: http:`,
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

function consumeWebSocketFrames(socket, initial = Buffer.alloc(0), onMessage = null) {
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
      if (length > MAX_WEBSOCKET_PAYLOAD) return socket.destroy();
      if (!masked) return socket.destroy();
      if (buffered.length < offset + 4 + length) return;
      const mask = buffered.subarray(offset, offset + 4);
      const payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      const opcode = buffered[0] & 0x0f;
      buffered = buffered.subarray(offset + 4 + length);
      if (opcode === 0x8) {
        socket.emit('ws-close-frame');
        socket.write(encodeWebSocketFrame(payload, 0x8));
        return socket.end();
      }
      if (opcode === 0x9) socket.write(encodeWebSocketFrame(payload, 0xA));
      if ((opcode === 0x1 || opcode === 0x2) && onMessage) onMessage(payload, opcode);
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
  openPath = openPathWithXdg,
  checkGit = worktreeCleanAsync,
  checkPr = linkPrAsync,
  materialize = materializeWorktree,
  parseRepoSelector = parseSelector,
  expandIssue = expandIssueReference,
  writeSeed: writeSessionSeed = writeSeed,
  clock = now,
  createScratchpadEntry = createScratchpad,
  linearSuggestions = linearWorkSuggestions,
  linearSearch = searchLinearSuggestions,
  githubSuggestions = githubWorkSuggestions,
  suggestionCacheMs = 60_000,
  spawnTerminalAttach = spawnZellijAttachTerminal,
  ensureTerminalSession = ensureBrowserTerminalSession,
  killTerminalSession = killBrowserTerminalSession,
  resetTerminalSession = resetBrowserTerminalSession,
  resetAllTerminalSessions = resetAllBrowserTerminalSessions,
  terminalSessionConfigFile = browserTerminalConfigFile,
  createMarkdownWatcher = (path, options) => chokidar.watch(path, options),
  notesRoot = config.paths.notes,
  dataDir = config.paths.data,
} = {}) {
  const db = suppliedDb || openDb();
  const ownsDb = !suppliedDb;
  migrateLegacyPanelState(db, { dataDir, config, cwd });
  syncSessionPanelGroups(db, stateItems(db, { cwd, config, terminalSessionIds: [] }));
  syncIssueResources(db);
  syncDiscoveredSessionNotes(db, notesRoot);
  const clients = new Set();
  const terminalClients = new Map();
  const terminalOwners = new Map();
  const browserTerminalCounts = new Map();
  const pendingGitRefreshes = new Map();
  const suggestionCaches = new Map();
  const markdownSubscriptions = new Map();
  const markdownWatchers = new Map();
  let closing = false;
  refreshWorkstreamStatuses(db, []);
  let lastEventSequence = latestWorkstreamEventSequence(db);
  let lastMiscStatuses = new Map(Object.keys(config.locations || {}).map((id) => [id, 'paused']));

  const linkSuggestions = async (provider, query = '') => {
    const key = `${provider}:${query.toLowerCase()}`;
    const cached = suggestionCaches.get(key);
    if (cached?.items && Date.now() - cached.loadedAt < suggestionCacheMs) return cached.items;
    if (cached?.pending) return cached.pending;
    const load = provider === 'linear' && query
      ? () => linearSearch(query)
      : provider === 'linear'
        ? () => linearSuggestions({ reference: clock() })
      : () => githubSuggestions();
    const pending = Promise.resolve().then(load).then((items) => {
      suggestionCaches.set(key, { items, loadedAt: Date.now() });
      return items;
    }).catch((cause) => {
      suggestionCaches.delete(key);
      throw new ApiError(502, cause.message);
    });
    suggestionCaches.set(key, { pending });
    return pending;
  };

  const terminalSessionIds = () => browserTerminalCounts.keys();

  const miscStatuses = () => {
    return new Map(Object.keys(config.locations || {}).map((id) => [
      id, browserTerminalCounts.has(id) ? 'active' : 'paused',
    ]));
  };

  const send = (socket, message) => {
    if (socket.destroyed || !socket.writable) return false;
    socket.write(encodeWebSocketFrame(JSON.stringify(message)));
    return true;
  };
  const broadcast = (message) => {
    let recipients = 0;
    for (const socket of clients) if (send(socket, message)) recipients += 1;
    return recipients;
  };
  const removeMarkdownSubscription = (socket, watchId = null) => {
    const subscriptions = markdownSubscriptions.get(socket);
    if (!subscriptions) return;
    const removed = watchId
      ? [subscriptions.get(watchId)].filter(Boolean)
      : [...subscriptions.values()];
    if (removed.length === 0) return;
    if (watchId) subscriptions.delete(watchId);
    else subscriptions.clear();
    if (subscriptions.size === 0) markdownSubscriptions.delete(socket);
    for (const subscription of removed) {
      const entry = markdownWatchers.get(subscription.path);
      if (!entry) continue;
      const stillSubscribed = [...subscriptions.values()]
        .some((candidate) => candidate.path === subscription.path);
      if (!stillSubscribed) entry.sockets.delete(socket);
      if (entry.sockets.size > 0) continue;
      markdownWatchers.delete(subscription.path);
      Promise.resolve(entry.watcher.close()).catch((error) => {
        if (!closing) process.stderr.write(`ai-workstream Markdown watcher: ${error.message}\n`);
      });
    }
  };
  const markdownWatchPath = ({ path: requested, source }) => {
    if (source === 'notes') {
      const path = resolveNotesFile(notesRoot, requested);
      if (!path) throw new ApiError(400, 'path must be a Markdown file inside the notes root');
      readNotesFile(notesRoot, path, { date: new Date(clock()) });
      return path;
    }
    if (source !== 'file') throw new ApiError(400, 'Markdown source must be file or notes');
    const path = resolveMarkdownFile(requested, { cwd, home: config.home });
    if (!path) throw new ApiError(400, 'path must be a Markdown file');
    readMarkdownFile(path, { cwd, home: config.home });
    return path;
  };
  const addMarkdownSubscription = (socket, message) => {
    let watchId;
    let path;
    try {
      watchId = browserId(message.watchId, 'watch id');
      removeMarkdownSubscription(socket, watchId);
      path = markdownWatchPath(message);
    } catch (error) {
      send(socket, {
        type: 'markdown_watch_error', watchId: watchId || null, message: error.message,
      });
      return;
    }
    let entry = markdownWatchers.get(path);
    if (!entry) {
      let watcher;
      try {
        watcher = createMarkdownWatcher(path, { atomic: true, ignoreInitial: true });
      } catch (error) {
        send(socket, {
          type: 'markdown_watch_error', watchId,
          message: `could not watch Markdown file: ${error.message}`,
        });
        return;
      }
      entry = { path, ready: false, sockets: new Set(), watcher };
      markdownWatchers.set(path, entry);
      watcher.on('ready', () => {
        entry.ready = true;
        for (const client of entry.sockets) {
          for (const subscription of markdownSubscriptions.get(client)?.values() || []) {
            if (subscription.path === path) {
              send(client, { type: 'markdown_watch', watchId: subscription.watchId, path });
            }
          }
        }
      });
      watcher.on('all', (event) => {
        if (!['add', 'change', 'unlink'].includes(event)) return;
        for (const client of entry.sockets) {
          for (const subscription of markdownSubscriptions.get(client)?.values() || []) {
            if (subscription.path === path) {
              send(client, {
                type: 'markdown_changed', watchId: subscription.watchId, path, event,
              });
            }
          }
        }
      });
      watcher.on('error', (error) => {
        for (const client of entry.sockets) {
          for (const subscription of markdownSubscriptions.get(client)?.values() || []) {
            if (subscription.path === path) {
              send(client, {
                type: 'markdown_watch_error', watchId: subscription.watchId,
                message: `could not watch Markdown file: ${error.message}`,
              });
            }
          }
        }
      });
    }
    entry.sockets.add(socket);
    let subscriptions = markdownSubscriptions.get(socket);
    if (!subscriptions) {
      subscriptions = new Map();
      markdownSubscriptions.set(socket, subscriptions);
    }
    subscriptions.set(watchId, { path, watchId });
    if (entry.ready) send(socket, { type: 'markdown_watch', watchId, path });
  };
  const broadcastPanelLayout = (clientId = 'service') => {
    broadcast({ type: 'panel_layout', clientId, revision: readPanelLayout(db).revision });
  };
  const setBrowserWorkspaceOpen = (sessionId, open, panels = DEFAULT_BROWSER_PANELS) => {
    const id = String(sessionId);
    const current = readBrowserUiState(db, 'workspaces').state;
    const existing = Array.isArray(current.workspaces) ? current.workspaces : [];
    const workspaces = existing.filter((workspace) => String(workspace?.id) !== id);
    if (open) workspaces.push({ id, panelMode: panelModeFor(panels) });
    const remembered = current.activeWorkspaceId == null ? null : String(current.activeWorkspaceId);
    const activeWorkspaceId = open
      ? id
      : remembered === id
        ? (workspaces.at(-1)?.id ?? null)
        : workspaces.some((workspace) => String(workspace?.id) === remembered)
          ? remembered
          : (workspaces.at(-1)?.id ?? null);
    const state = { ...current, workspaces, activeWorkspaceId };
    const saved = writeBrowserUiState(db, 'workspaces', state, { updatedAt: clock() });
    broadcast({ type: 'browser_state', scope: 'workspaces', clientId: 'service' });
    const item = stateItems(db, { cwd, config, terminalSessionIds: terminalSessionIds() })
      .find((candidate) => String(candidate.id) === id);
    if (item) {
      const roles = panels.includes('editor') ? ['shell', 'editor', 'agent'] : ['shell', 'agent'];
      const { group } = ensureSessionPanelGroup(db, item, { roles, bump: true });
      if (open) activatePanelGroup(db, group.id, readPanelLayout(db).revision);
      else deactivatePanelGroup(db, group.id, readPanelLayout(db).revision);
      syncIssueResources(db);
      broadcastPanelLayout();
    }
    return saved;
  };
  const broadcastChanges = () => {
    const events = workstreamEventsAfter(db, lastEventSequence);
    if (events.length) lastEventSequence = events.at(-1).sequence;
    const changes = events.map(({ sequence, ...event }) => event);
    for (const message of changes) broadcast(message);
    return changes;
  };
  const broadcastMiscChanges = () => {
    const current = miscStatuses();
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

  const registerBrowserTerminal = (sessionId) => {
    if (!sessionId) return;
    const id = String(sessionId);
    const count = browserTerminalCounts.get(id) || 0;
    browserTerminalCounts.set(id, count + 1);
    if (count > 0) return;
    try {
      if (config.locations?.[id]) {
        broadcastMiscChanges();
        return;
      }
      const row = resolveRow(db, id);
      if (!row || row.status === 'closed') return;
      setStatus(db, row.id, 'active', true);
      broadcastChanges();
    } catch (error) {
      // Terminal ownership is authoritative even if a short-lived hook has the
      // database locked. The poller will reconcile the display status later;
      // failing this bookkeeping must never tear down a healthy terminal.
      if (!closing) process.stderr.write(`ai-workstream terminal status: ${error.message}\n`);
    }
  };

  const unregisterBrowserTerminal = (sessionId) => {
    if (!sessionId) return;
    const id = String(sessionId);
    const count = browserTerminalCounts.get(id) || 0;
    if (count > 1) {
      browserTerminalCounts.set(id, count - 1);
      return;
    }
    browserTerminalCounts.delete(id);
    try {
      if (config.locations?.[id]) {
        broadcastMiscChanges();
        return;
      }
      const row = resolveRow(db, id);
      if (!row || row.status !== 'active') return;
      setStatus(db, row.id, 'paused');
      broadcastChanges();
    } catch (error) {
      if (!closing) process.stderr.write(`ai-workstream terminal status: ${error.message}\n`);
    }
  };

  const disposeTerminalClient = (socket, { kill = true, claim = true } = {}) => {
    const current = terminalClients.get(socket);
    if (!current) return;
    terminalClients.delete(socket);
    if (current.registered) {
      current.registered = false;
      unregisterBrowserTerminal(current.sessionId);
    }
    if (terminalOwners.get(current.terminalSession)?.socket === socket) {
      terminalOwners.delete(current.terminalSession);
    }
    if (kill && current.terminal) {
      try { current.terminal.kill(); } catch { /* already exited */ }
    }
    if (claim) queueMicrotask(() => claimWaitingTerminal(current.terminalSession));
  };

  const detachTerminalClient = (socket) => {
    const current = terminalClients.get(socket);
    if (!current?.terminal) return false;
    const terminal = current.terminal;
    current.terminal = null;
    current.waiting = true;
    if (terminalOwners.get(current.terminalSession)?.socket === socket) {
      terminalOwners.delete(current.terminalSession);
    }
    send(socket, { type: 'busy', message: 'Active on another client' });
    try { terminal.kill(); } catch { /* already exited */ }
    return true;
  };

  const suspendTerminalClient = (socket) => {
    const current = terminalClients.get(socket);
    if (!current || socket.destroyed) return false;
    current.suspended = true;
    current.waiting = false;
    const terminal = current.terminal;
    current.terminal = null;
    const released = terminalOwners.get(current.terminalSession)?.socket === socket;
    if (released) terminalOwners.delete(current.terminalSession);
    if (terminal) {
      try { terminal.kill(); } catch { /* already exited */ }
    }
    send(socket, { type: 'suspended' });
    if (released) queueMicrotask(() => claimWaitingTerminal(current.terminalSession));
    return true;
  };

  const browserTerminalConnected = (sessionId, role = null) => {
    const id = String(sessionId);
    return [...terminalClients.values()].some((current) => (
      current.terminal && current.sessionId === id && (role === null || current.role === role)
    ));
  };

  const closeBrowserTerminals = (sessionId, role = null) => {
    const id = String(sessionId);
    for (const [socket, current] of [...terminalClients]) {
      if (current.sessionId !== id || (role !== null && current.role !== role)) continue;
      disposeTerminalClient(socket, { claim: false });
      if (!socket.destroyed) socket.end(encodeWebSocketFrame('', 0x8));
    }
  };

  const closeAllBrowserTerminals = () => {
    for (const [socket] of [...terminalClients]) {
      disposeTerminalClient(socket, { claim: false });
      if (!socket.destroyed) socket.end(encodeWebSocketFrame('', 0x8));
    }
  };

  // Disconnecting a websocket only detaches its Zellij client. Deliberate
  // workstream lifecycle actions stop every persistent role session; changing
  // agents stops only the agent role. Best-effort cleanup must not make the
  // original command fail.
  const stopPersistentTerminalSessions = (sessionId, role = null) => {
    const descriptors = terminalPanelsForOwner(db, sessionId, { role });
    const legacyClient = [...terminalClients.values()].some((current) => (
      current.sessionId === String(sessionId) && !current.managedPanel
    ));
    const identities = descriptors.map(({ identity }) => identity);
    if (!descriptors.length || legacyClient) {
      identities.push(...(role ? [role] : PANEL_ROLES).map((terminalRole) => ({
        sessionId: String(sessionId), role: terminalRole,
      })));
    }
    const unique = new Map(identities.map((identity) => [browserTerminalSessionName(identity), identity]));
    for (const identity of unique.values()) {
      try { killTerminalSession(identity); }
      catch (error) {
        process.stderr.write(`ai-workstream: could not stop terminal session for "${sessionId}": ${error.message}\n`);
      }
    }
  };

  const resetPersistentTerminalSessions = (sessionId) => {
    const descriptors = terminalPanelsForOwner(db, sessionId);
    const identities = descriptors.length
      ? descriptors.map(({ identity }) => identity)
      : PANEL_ROLES.map((role) => ({ sessionId: String(sessionId), role }));
    return identities.map((identity) => resetTerminalSession(identity));
  };

  const terminateBrowserTerminal = (terminalSession, identity) => {
    for (const [clientSocket, current] of [...terminalClients]) {
      if (current.terminalSession !== terminalSession) continue;
      disposeTerminalClient(clientSocket, { claim: false });
      if (!clientSocket.destroyed) clientSocket.end(encodeWebSocketFrame('', 0x8));
    }
    try { killTerminalSession(identity); }
    catch (error) {
      process.stderr.write(`ai-workstream: could not terminate browser terminal "${terminalSession}": ${error.message}\n`);
    }
  };

  const attachTerminalClient = (socket) => {
    const current = terminalClients.get(socket);
    if (!current || current.suspended || current.terminal || socket.destroyed) return false;
    const owner = terminalOwners.get(current.terminalSession);
    if (owner && terminalClients.has(owner.socket) && !owner.socket.destroyed) {
      // After a dropped connection (especially across a daemon restart), every
      // browser races to reconnect. The browser that actually held this terminal
      // marks that fact. Let it displace an opportunistic reconnect exactly once;
      // once a returning owner holds the terminal, other stale ownership claims
      // wait normally instead of bouncing the attachment back and forth.
      if (current.reconnectOwner && !owner.reconnectOwner) {
        detachTerminalClient(owner.socket);
        return attachTerminalClient(socket);
      }
      current.waiting = true;
      send(socket, {
        type: 'busy',
        message: owner.clientId === current.clientId
          ? 'Waiting for this terminal’s previous view to detach…'
          : 'Active on another client',
      });
      return false;
    }
    if (owner) terminalOwners.delete(current.terminalSession);
    try {
      const ensured = ensureTerminalSession(current.identity, {
        command: current.command,
        cwd: current.cwd,
      });
      if (ensured?.created && current.seedFile) {
        try { unlinkSync(current.seedFile); } catch { /* the agent already has the inline prompt */ }
        current.seedFile = null;
      }
      const terminal = spawnTerminalAttach({
        session: current.terminalSession,
        configFile: terminalSessionConfigFile(),
        cwd: current.cwd,
        cols: current.cols,
        rows: current.rows,
      });
      current.terminal = terminal;
      current.waiting = false;
      terminalOwners.set(current.terminalSession, {
        socket,
        clientId: current.clientId,
        reconnectOwner: current.reconnectOwner,
      });
      terminal.onData((data) => {
        if (terminalClients.get(socket)?.terminal !== terminal) return;
        send(socket, { type: 'output', data });
      });
      terminal.onExit(({ exitCode, signal }) => {
        // Ignore the exit of an attachment deliberately displaced by a manual
        // takeover. That websocket is still alive and waiting for ownership.
        if (terminalClients.get(socket)?.terminal !== terminal) return;
        disposeTerminalClient(socket, { kill: false, claim: false });
        send(socket, { type: 'exit', exitCode, signal: signal ?? null });
        if (!socket.destroyed) socket.end(encodeWebSocketFrame('', 0x8));
      });
      send(socket, { type: 'claimed' });
      return true;
    } catch (error) {
      send(socket, { type: 'error', message: error.message });
      disposeTerminalClient(socket, { claim: false });
      if (!socket.destroyed) socket.end(encodeWebSocketFrame('', 0x8));
      process.stderr.write(`ai-workstream terminal: ${error.message}\n`);
      return false;
    }
  };

  const claimWaitingTerminal = (terminalSession) => {
    if (terminalOwners.has(terminalSession)) return false;
    const waiting = [...terminalClients].find(([socket, current]) => (
      current.terminalSession === terminalSession && !current.suspended
      && !current.terminal && !socket.destroyed
    ));
    return waiting ? attachTerminalClient(waiting[0]) : false;
  };

  const takeOverTerminal = (socket) => {
    const current = terminalClients.get(socket);
    if (!current || current.suspended || current.terminal || socket.destroyed) return false;
    const owner = terminalOwners.get(current.terminalSession);
    if (owner && owner.socket !== socket
        && terminalClients.has(owner.socket) && !owner.socket.destroyed) {
      detachTerminalClient(owner.socket);
    }
    return attachTerminalClient(socket);
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

  // ---------------------------------------------------------------- notes editor
  //
  // The browser markdown editor reads and writes files under the configured notes
  // root only, and remembers its open tabs server-side so the tab strip survives a
  // reload. `notesDate` is derived from `clock` so tests can pin "today".
  const notesDate = () => new Date(clock());

  const resourceGroup = (groupId) => {
    const group = readPanelLayout(db).groups.find((item) => item.id === String(groupId));
    if (!group) throw new PanelModelError(404, `no panel group "${groupId}"`);
    return group;
  };

  const sessionMarkdownDirectory = (group, date = notesDate()) => {
    if (!group.ownerId || group.type === 'terminal') return null;
    const row = resolveRow(db, String(group.ownerId));
    if (row) return noteDir(row, date, notesRoot);
    const slug = (value) => String(value || '').trim().toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    const owner = slug(group.ownerId) || 'session';
    const label = slug(group.label);
    return join(notesRoot, 'work', String(date.getFullYear()), 'workstream',
      label && label !== owner ? `${owner}-${label}` : owner);
  };

  const panelLayoutResponse = () => {
    const layout = readPanelLayout(db);
    return {
      ...layout,
      groups: layout.groups.map((group) => {
        const markdownDirectory = sessionMarkdownDirectory(group);
        return markdownDirectory ? { ...group, markdownDirectory } : group;
      }),
    };
  };

  const associatedResource = (resourceId) => {
    for (const group of readPanelLayout(db).groups) {
      const resource = group.resources.find((item) => item.id === String(resourceId));
      if (resource) return { group, resource };
    }
    throw new PanelModelError(404, `no associated resource "${resourceId}"`);
  };

  const createAssociatedMarkdown = (group, body) => {
    if (group.type === 'terminal') {
      throw new PanelModelError(400, 'terminal groups cannot have associated resources');
    }
    if (body.kind !== undefined && body.kind !== 'markdown') {
      throw new PanelModelError(400, 'content can only create a Markdown resource');
    }
    if (typeof body.content !== 'string' || body.content.trim() === '') {
      throw new PanelModelError(400, 'content must be a non-empty string');
    }
    if (body.title !== undefined && typeof body.title !== 'string') {
      throw new PanelModelError(400, 'title must be a string');
    }
    const title = body.title?.trim();
    const date = notesDate();
    const directory = sessionMarkdownDirectory(group, date);
    if (!directory && !body.value) {
      throw new PanelModelError(400, 'a path is required for a group without a session notes directory');
    }
    const pad = (value, length = 2) => String(value).padStart(length, '0');
    const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-`
      + `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}${pad(date.getMilliseconds(), 3)}`;
    const titleSlug = title?.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '').slice(0, 40);
    const generatedName = `${stamp}${titleSlug ? `-${titleSlug}` : ''}.md`;
    const requested = body.value || join(directory, generatedName);
    const content = title ? `# ${title}\n\n${body.content}` : body.content;
    const file = createMarkdownFile(requested, content, {
      cwd: group.path || cwd,
      home: config.home,
    });
    return {
      file,
      directory: body.value ? dirname(file.path) : directory,
      resourceBody: {
        ...body,
        kind: 'markdown',
        value: file.path,
        label: body.label || title || basename(file.path),
      },
    };
  };

  const notesRoute = async (req, res, url) => {
    const segment = url.pathname.slice('/notes/'.length);
    try {
      if (req.method === 'GET' && segment === 'files') {
        // Only the work tree: journal entries and per-session resource files are
        // written elsewhere and are not what this editor is for.
        const date = notesDate();
        const { path: weekPath, iso } = weeklyNotePath(notesRoot, 'work', date);
        return json(res, 200, {
          root: notesRoot,
          today: dayHeading(date),
          weekly: [{
            kind: 'work',
            week: iso,
            path: notesRelativePath(notesRoot, weekPath),
            exists: existsSync(weekPath),
          }],
          files: listNotesFiles(notesRoot, { subtree: 'work' }),
        });
      }
      if (req.method === 'GET' && segment === 'file') {
        return json(res, 200, readNotesFile(notesRoot, url.searchParams.get('path'), { date: notesDate() }));
      }
      if (req.method === 'PUT' && segment === 'file') {
        const body = await jsonBody(req);
        const saved = writeNotesFile(notesRoot, body.path, body.content, { version: body.version ?? null });
        return json(res, 200, saved);
      }
      if (req.method === 'POST' && segment === 'weekly') {
        const body = await jsonBody(req);
        return json(res, 200, openWeeklyNote(notesRoot, body.kind, { date: notesDate() }));
      }
      if (req.method === 'GET' && segment === 'tabs') {
        return json(res, 200, readEditorTabs(dataDir, url.searchParams.get('scope') || 'global'));
      }
      if (req.method === 'PUT' && segment === 'tabs') {
        const body = await jsonBody(req);
        return json(res, 200, writeEditorTabs(dataDir, body.scope || 'global', body, {
          root: notesRoot, cwd,
        }));
      }
    } catch (error) {
      if (error instanceof NotesFileError) throw new ApiError(error.status, error.message);
      throw error;
    }
    throw new ApiError(404, 'not found');
  };

  // General Markdown files use a separate route so the long-standing notes API
  // remains confined to notesRoot. Paths returned here are normalized absolute
  // paths and can therefore be restored without depending on the launch cwd.
  const markdownRoute = async (req, res, url) => {
    const segment = url.pathname.slice('/markdown/'.length);
    try {
      if (req.method === 'GET' && segment === 'complete') {
        return json(res, 200, completeMarkdownPath(url.searchParams.get('path'), { cwd }));
      }
      if (req.method === 'GET' && segment === 'file') {
        return json(res, 200, readMarkdownFile(url.searchParams.get('path'), { cwd }));
      }
      if (req.method === 'PUT' && segment === 'file') {
        const body = await jsonBody(req);
        return json(res, 200, writeMarkdownFile(body.path, body.content, {
          version: body.version ?? null, cwd,
        }));
      }
    } catch (error) {
      if (error instanceof NotesFileError) throw new ApiError(error.status, error.message);
      throw error;
    }
    throw new ApiError(404, 'not found');
  };

  const panelRoute = async (req, res, url) => {
    const parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    const body = req.method === 'GET' ? {} : await jsonBody(req);
    const clientId = browserId(body.client, 'client', 'service');
    try {
      let result;
      if (req.method === 'GET' && parts.length === 1) {
        const sessionSync = syncSessionPanelGroups(db, stateItems(db, {
          cwd, config, terminalSessionIds: terminalSessionIds(),
        }));
        const issueSync = syncIssueResources(db);
        const noteSync = syncDiscoveredSessionNotes(db, notesRoot);
        if (sessionSync.changed || issueSync.changed || noteSync.changed) broadcastPanelLayout();
        return json(res, 200, panelLayoutResponse());
      }
      if (req.method === 'POST' && parts[1] === 'groups' && parts.length === 2) {
        result = createPanelGroup(db, body, body.revision);
      } else if (req.method === 'PUT' && parts[1] === 'groups' && parts.length === 3) {
        result = updatePanelGroup(db, parts[2], body, body.revision);
      } else if (req.method === 'POST' && parts[1] === 'groups' && parts[3] === 'activate' && parts.length === 4) {
        result = activatePanelGroup(db, parts[2], body.revision);
      } else if (req.method === 'POST' && parts[1] === 'groups' && parts[3] === 'panels' && parts.length === 4) {
        result = addPanel(db, parts[2], body, body.revision);
      } else if (req.method === 'POST' && parts[1] === 'groups' && parts[3] === 'merge' && parts.length === 4) {
        result = mergeTerminalGroups(db, body.sourceGroupId, parts[2], body.revision);
      } else if (req.method === 'PUT' && parts[1] === 'groups' && parts[3] === 'order' && parts.length === 4) {
        result = reorderPanels(db, parts[2], body, body.revision);
      } else if (req.method === 'POST' && parts[1] === 'groups' && parts[3] === 'resources' && parts.length === 4) {
        let created = null;
        try {
          if (body.content !== undefined) {
            const revision = panelLayoutRevision(db);
            if (!Number.isInteger(body.revision)) {
              throw new PanelModelError(400, 'revision must be an integer');
            }
            if (body.revision !== revision) {
              throw new PanelModelError(409, 'panel layout changed on another client', { revision });
            }
            created = createAssociatedMarkdown(resourceGroup(parts[2]), body);
          }
          result = addResource(db, parts[2], created?.resourceBody || body, body.revision, {
            cwd, home: config.home, activeSessionIds: terminalSessionIds(),
          });
          if (created) {
            result = { ...result, file: created.file, markdownDirectory: created.directory };
          }
        } catch (error) {
          if (created?.file?.path) {
            try { unlinkSync(created.file.path); } catch { /* best-effort rollback */ }
          }
          throw error;
        }
      } else if (req.method === 'PUT' && parts[1] === 'panels' && parts.length === 3) {
        result = updatePanel(db, parts[2], body, body.revision);
      } else if (req.method === 'POST' && parts[1] === 'panels' && parts[3] === 'close' && parts.length === 4) {
        const descriptor = terminalPanelDescriptor(db, parts[2]);
        result = removePanel(db, parts[2], body.revision);
        terminateBrowserTerminal(browserTerminalSessionName(descriptor.identity), descriptor.identity);
      } else if (req.method === 'POST' && parts[1] === 'resources' && parts[3] === 'open' && parts.length === 4) {
        result = openResourcePanel(db, parts[2], body, body.revision);
      } else if (req.method === 'POST' && parts[1] === 'resources' && parts[3] === 'disassociate' && parts.length === 4) {
        result = removeResource(db, parts[2], body, body.revision);
        if (result.resource.kind === 'link' && result.resource.source === 'legacy') {
          const group = readPanelLayout(db).groups.find((item) => item.id === result.resource.groupId);
          if (group?.ownerId && /^\d+$/.test(group.ownerId)) {
            for (const issue of listIssues(db, Number(group.ownerId))) {
              let normalized = issue.ref;
              try { normalized = new URL(issue.ref).href; } catch { /* non-URL legacy reference */ }
              if (normalized === result.resource.value) removeIssue(db, Number(group.ownerId), issue.ref);
            }
            broadcastChanges();
          }
        }
      } else if (req.method === 'GET' && parts[1] === 'resources' && parts.length === 3) {
        const { group, resource } = associatedResource(parts[2]);
        if (resource.kind !== 'markdown') {
          throw new PanelModelError(400, 'only Markdown resources have readable content');
        }
        return json(res, 200, {
          resource,
          group: { id: group.id, ownerId: group.ownerId, label: group.label },
          file: readMarkdownFile(resource.value, { cwd }),
        });
      } else if (req.method === 'PUT' && parts[1] === 'resources' && parts.length === 3) {
        const { group, resource } = associatedResource(parts[2]);
        if (resource.kind !== 'markdown') {
          throw new PanelModelError(400, 'only Markdown resources have writable content');
        }
        return json(res, 200, {
          resource,
          group: { id: group.id, ownerId: group.ownerId, label: group.label },
          file: writeMarkdownFile(resource.value, body.content, {
            version: body.version ?? null, cwd,
          }),
        });
      } else {
        throw new ApiError(404, 'not found');
      }
      broadcastPanelLayout(clientId);
      return json(res, 200, { ok: true, ...result });
    } catch (error) {
      if (error instanceof PanelModelError) {
        throw new ApiError(error.status, error.message, error.details);
      }
      if (error instanceof NotesFileError) throw new ApiError(error.status, error.message);
      throw error;
    }
  };

  const server = createServer((req, res) => {
    Promise.resolve().then(async () => {
      const corsOrigin = loopbackOrigin(req);
      if (corsOrigin) {
        res.setHeader('Access-Control-Allow-Origin', corsOrigin);
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, POST, PUT, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '600',
        });
        res.end();
        return;
      }
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const headOnly = req.method === 'HEAD';
      if ((req.method === 'GET' || headOnly) && (url.pathname === '/' || url.pathname === '/v2' || url.pathname === '/v2/')) {
        return staticFile(res, `${webRoot}/v2/index.html`, 'text/html; charset=utf-8', headOnly);
      }
      const v2Asset = url.pathname.match(/^\/v2\/assets\/([A-Za-z0-9_.-]+\.(css|js|map))$/);
      if ((req.method === 'GET' || headOnly) && v2Asset) {
        return staticFile(res, `${webRoot}/v2/assets/${v2Asset[1]}`, V2_ASSET_TYPES.get(v2Asset[2]), headOnly);
      }
      const v2Font = url.pathname.match(/^\/v2\/fonts\/([A-Za-z0-9_.-]+\.(woff2|txt))$/);
      if ((req.method === 'GET' || headOnly) && v2Font) {
        return staticFile(res, `${webRoot}/v2/fonts/${v2Font[1]}`, V2_FONT_TYPES.get(v2Font[2]), headOnly);
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
          revision: DAEMON_REVISION,
          websocket: '/ws/events',
        });
      }
      if (req.method === 'GET' && url.pathname === '/config') {
        return json(res, 200, config);
      }
      if (req.method === 'GET' && url.pathname === '/daemons') {
        return json(res, 200, { daemons: Object.values(config.daemons || {}) });
      }
      if (req.method === 'POST' && url.pathname === '/browser/refresh') {
        await jsonBody(req);
        broadcast({ type: 'full_page_refresh' });
        return json(res, 200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/browser/state') {
        return json(res, 200, readBrowserUiState(db, browserUiScope(url.searchParams.get('scope'))));
      }
      if (req.method === 'PUT' && url.pathname === '/browser/state') {
        const body = await jsonBody(req);
        const scope = browserUiScope(body.scope);
        const clientId = browserId(body.client, 'client', 'legacy-ui');
        if (!body.state || typeof body.state !== 'object' || Array.isArray(body.state)) {
          throw new ApiError(400, 'state must be an object');
        }
        if (JSON.stringify(body.state).length > 64 * 1024) {
          throw new ApiError(400, 'browser state must be at most 64 KiB');
        }
        const result = writeBrowserUiState(db, scope, body.state);
        broadcast({ type: 'browser_state', scope, clientId });
        if (scope === 'workspaces') {
          for (const spec of Array.isArray(body.state.workspaces) ? body.state.workspaces : []) {
            const item = stateItems(db, { cwd, config, terminalSessionIds: terminalSessionIds() })
              .find((candidate) => String(candidate.id) === String(spec?.id));
            if (!item) continue;
            ensureSessionPanelGroup(db, item, {
              roles: spec.panelMode === 'three' ? ['shell', 'editor', 'agent'] : ['shell', 'agent'],
              bump: true,
            });
          }
          broadcastPanelLayout(clientId);
        }
        return json(res, 200, result);
      }
      if (req.method === 'GET' && url.pathname === '/ws/events') {
        return json(res, 426, { error: 'upgrade_required', websocket: '/ws/events' }, { Upgrade: 'websocket' });
      }
      if (req.method === 'GET' && url.pathname === '/ws/terminal') {
        return json(res, 426, { error: 'upgrade_required', websocket: '/ws/terminal' }, { Upgrade: 'websocket' });
      }
      if (req.method === 'GET' && url.pathname === '/ws/terminal-sessions') {
        const response = {
          sessions: [...browserTerminalCounts].map(([id, count]) => ({
            id: /^\d+$/.test(id) ? Number(id) : id,
            count,
          })),
        };
        if (url.searchParams.get('diagnostics') === '1') {
          response.socketCount = terminalClients.size;
          response.attachmentCount = [...terminalClients.values()]
            .filter((current) => current.terminal).length;
          response.clients = [...terminalClients.values()].map((current) => ({
            clientId: current.clientId,
            terminalSession: current.terminalSession,
            state: current.suspended ? 'suspended'
              : current.terminal ? 'owned'
                : current.waiting ? 'waiting' : 'disconnected',
          }));
        }
        return json(res, 200, response);
      }
      if (req.method === 'POST' && url.pathname === '/ws/terminal-reset') {
        await jsonBody(req);
        closeAllBrowserTerminals();
        let result;
        try {
          result = resetAllTerminalSessions();
        } catch (error) {
          throw new ApiError(502, `could not reset browser terminals: ${error.message}`);
        }
        broadcastChanges();
        broadcastMiscChanges();
        return json(res, 200, { ok: true, result });
      }
      if (req.method === 'POST' && url.pathname === '/ws/refresh') {
        await jsonBody(req);
        const result = refreshWorkstreamStatuses(db, terminalSessionIds());
        broadcastChanges();
        broadcastMiscChanges();
        return json(res, 200, { ok: true, result });
      }

      if (url.pathname.startsWith('/notes/')) {
        return await notesRoute(req, res, url);
      }
      if (url.pathname.startsWith('/markdown/')) {
        return await markdownRoute(req, res, url);
      }
      if (url.pathname === '/panel-layout' || url.pathname.startsWith('/panel-layout/')) {
        return await panelRoute(req, res, url);
      }

      const parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
      if (req.method === 'POST' && parts[0] === 'ws' && parts[1] === 'digest' && parts.length === 2) {
        const body = await jsonBody(req);
        return json(res, 200, workstreamDigest(db, body, { notesRoot }));
      }
      if (req.method === 'GET' && parts[0] === 'ws' && parts[2] === 'stack' && parts.length === 3) {
        return json(res, 200, workstreamStack(db, parts[1]));
      }
      if (req.method === 'POST' && parts[0] === 'ws' && parts[2] === 'sync' && parts.length === 3) {
        await jsonBody(req);
        const result = await syncWorkstreamSession(db, parts[1], {
          notesRoot, checkPr, checkedAt: clock(),
        });
        if (result.layout.changed) broadcastPanelLayout();
        broadcastChanges();
        result.workstream = queryWorkstreams(db, {
          id: result.workstream.id, status: 'all',
        }, { cwd, config, terminalSessionIds: terminalSessionIds() }).items[0];
        return json(res, 200, { ok: true, ...result });
      }
      if (req.method === 'POST' && parts[0] === 'ws' && parts[2] === 'stack-set' && parts.length === 3) {
        const body = await jsonBody(req);
        const result = setWorkstreamStack(db, parts[1], body);
        const changed = new Set([
          result.workstream.id, result.stackedOn?.id, result.wasStackedOn?.id,
        ].filter((id) => id !== undefined));
        for (const id of changed) broadcast({ id, type: 'update_session' });
        return json(res, 200, result);
      }
      if (req.method === 'POST' && parts[0] === 'ws' && parts[2] === 'stack-link' && parts.length === 3) {
        const body = await jsonBody(req);
        return json(res, 200, linkWorkstreamStack(db, parts[1], body));
      }
      if (req.method === 'POST' && parts[0] === 'ws' && parts[2] === 'note' && parts.length === 3) {
        const body = await jsonBody(req);
        const result = createWorkstreamNote(db, parts[1], body, { notesRoot });
        broadcast({ id: result.workstream.id, type: 'update_session' });
        if (syncDiscoveredSessionNotes(db, notesRoot).changed) broadcastPanelLayout();
        return json(res, 201, result);
      }
      if (req.method === 'GET' && parts[0] === 'ws' && parts[2] === 'notes' && parts.length === 3) {
        return json(res, 200, workstreamNotes(db, parts[1], { notesRoot }));
      }
      if (req.method === 'GET' && parts[0] === 'ws' && parts[1] === 'link-suggestions' && parts.length === 3) {
        const provider = parts[2];
        if (provider !== 'linear' && provider !== 'github') {
          throw new ApiError(400, 'link suggestion provider must be linear or github');
        }
        const query = (url.searchParams.get('q') || '').trim();
        const suggestions = await linkSuggestions(provider, query);
        const items = query && provider !== 'linear'
          ? suggestions.filter((item) => [item.id, item.title, item.repository, item.group]
            .some((value) => String(value || '').toLowerCase().includes(query.toLowerCase())))
          : suggestions;
        return json(res, 200, { provider, items: items.slice(0, 100) });
      }
      if (req.method === 'GET' && parts[0] === 'ws' && parts[1] === 'new' && parts.length === 2) {
        return json(res, 200, {
          repositoryRoot: config.paths.repositories,
          scratchpadRoot: config.paths.scratchpads,
          recentRepositories: recentRepositories(db, { reference: clock() }),
          agent: config.agent,
          panels: DEFAULT_BROWSER_PANELS,
        });
      }
      if (req.method === 'GET' && parts[0] === 'ws' && parts.length <= 2) {
        const result = queryWorkstreams(db, {
          id: parts[1] || 'all',
          type: url.searchParams.get('type') || undefined,
          page: url.searchParams.get('page') || undefined,
          perpage: url.searchParams.get('perpage') || undefined,
          status: url.searchParams.get('status') || undefined,
        }, { cwd, config, terminalSessionIds: terminalSessionIds() });
        json(res, 200, result);
        scheduleGitRefresh(result.items);
        return;
      }
      if (req.method === 'POST' && parts[0] === 'ws' && parts.length === 1) {
        const body = await jsonBody(req);
        const result = createRepoWorkstream(db, body, {
          cwd, config, materialize, parseSelector: parseRepoSelector, expandIssue,
          writeSeed: writeSessionSeed, now: clock,
        });
        result.workstream = queryWorkstreams(db, {
          id: result.workstream.id, status: 'all',
        }, { cwd, config, terminalSessionIds: terminalSessionIds() }).items[0];
        result.workstream = await refreshGitBeforeResponse(result.workstream);
        if (!result.created && (result.agentChanged || result.seeded)) {
          closeBrowserTerminals(result.workstream.id, 'agent');
          stopPersistentTerminalSessions(result.workstream.id, 'agent');
        }
        broadcastChanges();
        setBrowserWorkspaceOpen(
          result.workstream.id,
          true,
          result.browserWorkspace.panelMode === 'three' ? PANEL_ROLES : DEFAULT_BROWSER_PANELS,
        );
        json(res, result.created ? 201 : 200, result);
        return;
      }
      if (req.method === 'POST' && parts[0] === 'ws' && parts[1] === 'scratchpad' && parts.length === 2) {
        const body = await jsonBody(req);
        const result = createScratchpadWorkstream(db, body, {
          cwd, config, createScratchpad: createScratchpadEntry, expandIssue,
          writeSeed: writeSessionSeed,
        });
        result.workstream = await refreshGitBeforeResponse(result.workstream);
        broadcastChanges();
        setBrowserWorkspaceOpen(
          result.workstream.id,
          true,
          result.browserWorkspace.panelMode === 'three' ? PANEL_ROLES : DEFAULT_BROWSER_PANELS,
        );
        json(res, 201, result);
        return;
      }
      if (req.method === 'POST' && parts[0] === 'ws' && parts.length === 3) {
        const body = await jsonBody(req);
        const browserAgentConnected = parts[2] === 'agent-set'
          && browserTerminalConnected(parts[1], 'agent');
        const result = executeWorkstreamCommand(db, parts[1], parts[2], body, {
          cwd, config, terminalSessionIds: terminalSessionIds(),
          openPath, writeSeed: writeSessionSeed,
        });
        if (parts[2] === 'agent-set' && result.result.changed) {
          result.result.replaced = browserAgentConnected;
          result.result.browserTerminalRestart = browserAgentConnected;
        }
        if (parts[2] === 'pause' || parts[2] === 'archive' || parts[2] === 'close') {
          stopPersistentTerminalSessions(parts[1]);
          closeBrowserTerminals(parts[1]);
        }
        if (parts[2] === 'agent-set' && result.result.changed) {
          closeBrowserTerminals(parts[1], 'agent');
          stopPersistentTerminalSessions(parts[1], 'agent');
        }
        if (parts[2] === 'resume' && (result.result.agentChanged || result.result.seeded)) {
          closeBrowserTerminals(parts[1], 'agent');
          stopPersistentTerminalSessions(parts[1], 'agent');
        }
        if (parts[2] === 'terminal-reset') {
          closeBrowserTerminals(parts[1]);
          try {
            result.result.terminals = resetPersistentTerminalSessions(parts[1]);
          } catch (error) {
            throw new ApiError(502, `could not reset browser terminals: ${error.message}`);
          }
        }
        if (parts[2] === 'resume') {
          setBrowserWorkspaceOpen(parts[1], true, result.result.panels);
          result.browserWorkspace = {
            opened: true,
            panelMode: panelModeFor(result.result.panels),
          };
        } else if (parts[2] === 'pause' || parts[2] === 'archive' || parts[2] === 'close') {
          setBrowserWorkspaceOpen(parts[1], false);
          result.browserWorkspace = { opened: false };
        }
        broadcastChanges();
        if (parts[2] === 'rename') {
          const groupSync = syncSessionPanelGroups(db, [result.workstream]);
          if (groupSync.changed) broadcastPanelLayout();
        }
        if (parts[2] === 'issue-add' || parts[2] === 'issue-remove') {
          syncIssueResources(db);
          broadcastPanelLayout();
        }
        if (result.workstream.type === 'misc') broadcastMiscChanges();
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
    let requestUrl;
    try { requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`); }
    catch { socket.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    const origin = req.headers.origin;
    let originAllowed = true;
    if (typeof origin === 'string') {
      try {
        const originUrl = new URL(origin);
        originAllowed = originUrl.host === req.headers.host || loopbackHostname(originUrl.hostname);
      } catch { originAllowed = false; }
    }
    const terminalUpgrade = requestUrl.pathname === '/ws/terminal';
    const eventUpgrade = requestUrl.pathname === '/ws/events';
    const remoteAddress = socket.remoteAddress || '';
    const loopback = remoteAddress === '127.0.0.1' || remoteAddress === '::1'
      || remoteAddress === '::ffff:127.0.0.1';
    if ((!eventUpgrade && !terminalUpgrade) || req.headers.upgrade?.toLowerCase() !== 'websocket'
        || typeof key !== 'string' || !originAllowed) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    if (terminalUpgrade && !loopback) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    let terminalDescriptor = null;
    if (terminalUpgrade) {
      try {
        const requestedPanelId = requestUrl.searchParams.get('panel');
        const requestedSessionId = requestUrl.searchParams.get('session');
        const requestedRole = requestUrl.searchParams.get('role');
        if (requestedRole && !PANEL_ROLES.includes(requestedRole)) {
          throw new ApiError(400, `role must be one of: ${PANEL_ROLES.join(', ')}`);
        }
        if (requestedRole && !requestedSessionId && !requestedPanelId) {
          throw new ApiError(400, 'role requires a workstream session');
        }
        const clientId = browserId(requestUrl.searchParams.get('client'), 'client', 'legacy');
        const terminalId = browserId(requestUrl.searchParams.get('terminal'), 'terminal', 'default');
        const reconnectOwner = requestUrl.searchParams.get('owner') === '1';
        const suspended = requestUrl.searchParams.get('suspended') === '1';
        let terminalCwd = process.env.HOME || cwd;
        let workstream = null;
        let terminalSessionId = null;
        let terminalRole = requestedRole || 'shell';
        let identity = null;
        if (requestedPanelId) {
          const descriptor = terminalPanelDescriptor(db, browserId(requestedPanelId, 'panel'));
          identity = descriptor.identity;
          terminalRole = descriptor.panel.terminalRole || (descriptor.panel.kind === 'ai' ? 'agent' : 'shell');
          terminalSessionId = descriptor.group.owner_id == null ? null : String(descriptor.group.owner_id);
          terminalCwd = descriptor.group.path || terminalCwd;
          if (terminalSessionId != null) {
            workstream = queryWorkstreams(db, { id: terminalSessionId, status: 'all' }, {
              cwd, config, terminalSessionIds: terminalSessionIds(),
            }).items[0];
            if (!workstream) throw new ApiError(404, `no session for panel "${requestedPanelId}"`);
          }
        } else if (requestedSessionId) {
          workstream = queryWorkstreams(db, { id: requestedSessionId, status: 'all' }, {
            cwd, config, terminalSessionIds: terminalSessionIds(),
          }).items[0];
          if (!workstream?.path) throw new ApiError(404, `no directory for workstream "${requestedSessionId}"`);
          if (workstream.status === 'closed') {
            throw new ApiError(409, `workstream "${requestedSessionId}" must be reopened before starting a terminal`);
          }
          if (!existsSync(workstream.path)) {
            throw new ApiError(409, `workstream directory does not exist: ${workstream.path}`);
          }
          terminalSessionId = String(workstream.id);
          terminalCwd = workstream.path;
        }
        if (workstream?.status === 'closed') {
          throw new ApiError(409, `workstream "${terminalSessionId}" must be reopened before starting a terminal`);
        }
        if (!existsSync(terminalCwd)) {
          throw new ApiError(409, `terminal directory does not exist: ${terminalCwd}`);
        }
        const seedFile = terminalRole === 'agent' && workstream
          ? join(dataDir, 'seeds', `${workstream.id}.md`)
          : null;
        const seedContent = seedFile && existsSync(seedFile)
          ? readFileSync(seedFile, 'utf8')
          : null;
        const launch = browserTerminalLaunch(terminalRole, workstream, config, seedContent);
        identity ||= { sessionId: terminalSessionId, role: terminalRole, terminalId };
        // The daemon is commonly launched from a desktop entry, where TERM is
        // either absent or "dumb". These commands run in a real xterm.js-backed
        // PTY, so give shells and terminal UIs the capabilities they actually
        // have instead of inheriting the graphical launcher's environment.
        const command = [
          'env',
          'TERM=xterm-256color',
          'COLORTERM=truecolor',
          ...(terminalSessionId && workstream?.type !== 'misc'
            ? [`AI_WORKSTREAM_ID=${terminalSessionId}`] : []),
          launch.command,
          ...launch.args,
        ];
        terminalDescriptor = {
          clientId,
          command,
          cwd: terminalCwd,
          identity,
          managedPanel: Boolean(requestedPanelId),
          role: terminalRole,
          reconnectOwner,
          suspended,
          seedFile: seedContent ? seedFile : null,
          sessionId: terminalSessionId,
          terminalSession: browserTerminalSessionName(identity),
        };
      } catch (error) {
        const status = error instanceof ApiError ? error.status : 500;
        const reason = status === 400 ? 'Bad Request'
          : status === 404 ? 'Not Found'
            : status === 409 ? 'Conflict' : 'Internal Server Error';
        socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
        socket.destroy();
        if (status === 500) process.stderr.write(`ai-workstream terminal: ${error.message}\n`);
        return;
      }
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
    if (eventUpgrade) {
      clients.add(socket);
      const disposeEventClient = () => {
        clients.delete(socket);
        removeMarkdownSubscription(socket);
      };
      socket.on('close', disposeEventClient);
      socket.on('error', disposeEventClient);
      socket.on('ws-close-frame', disposeEventClient);
      consumeWebSocketFrames(socket, head, (payload, opcode) => {
        if (opcode !== 0x1) return;
        let message;
        try { message = JSON.parse(payload.toString('utf8')); }
        catch { return; }
        if (message?.type === 'markdown_watch') {
          addMarkdownSubscription(socket, message);
        } else if (message?.type === 'markdown_unwatch') {
          removeMarkdownSubscription(socket, message.watchId || null);
        }
      });
      return;
    }

    const terminalClient = {
      ...terminalDescriptor,
      cols: 80,
      rows: 24,
      registered: true,
      terminal: null,
      waiting: false,
    };
    terminalClients.set(socket, terminalClient);
    registerBrowserTerminal(terminalClient.sessionId);
    const disposeTerminal = () => {
      disposeTerminalClient(socket);
    };
    socket.on('end', disposeTerminal);
    socket.on('close', disposeTerminal);
    socket.on('error', disposeTerminal);
    socket.on('ws-close-frame', disposeTerminal);
    consumeWebSocketFrames(socket, head, (payload, opcode) => {
      if (opcode !== 0x1) return;
      let message;
      try { message = JSON.parse(payload.toString('utf8')); }
      catch { send(socket, { type: 'error', message: 'invalid terminal message' }); return; }
      const current = terminalClients.get(socket);
      if (message?.type === 'claim') {
        if (current) current.suspended = false;
        attachTerminalClient(socket);
        return;
      }
      if (message?.type === 'suspend') {
        suspendTerminalClient(socket);
        return;
      }
      if (message?.type === 'resume') {
        if (!current) return;
        current.suspended = false;
        if (current.terminal) send(socket, { type: 'claimed' });
        else attachTerminalClient(socket);
        return;
      }
      if (message?.type === 'takeover') {
        takeOverTerminal(socket);
        return;
      }
      if (message?.type === 'terminate' && current) {
        terminateBrowserTerminal(current.terminalSession, current.identity);
        return;
      }
      if (message?.type === 'input' && typeof message.data === 'string') {
        if (!current?.terminal) return;
        current.terminal.write(message.data);
        return;
      }
      if (message?.type === 'resize'
          && Number.isInteger(message.cols) && message.cols >= 2 && message.cols <= 500
          && Number.isInteger(message.rows) && message.rows >= 1 && message.rows <= 300) {
        if (!current) return;
        current.cols = message.cols;
        current.rows = message.rows;
        if (!current.terminal) return;
        try { current.terminal.resize(message.cols, message.rows); }
        catch (error) { send(socket, { type: 'error', message: error.message }); }
        return;
      }
      send(socket, { type: 'error', message: 'unsupported terminal message' });
    });
    // Let the 101 response reach the browser before Zellij startup work. This
    // keeps the socket out of WebSocket.CONNECTING while a new persistent
    // session is being created and gives the client a chance to report/retry a
    // slow terminal startup separately from the network handshake.
    setImmediate(() => {
      const current = terminalClients.get(socket);
      if (!current) return;
      if (current.suspended) send(socket, { type: 'suspended' });
      else attachTerminalClient(socket);
    });
  });

  const timer = pollInterval > 0 ? setInterval(() => {
    try {
      refreshWorkstreamStatuses(db, terminalSessionIds());
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
    terminalClients,
    broadcastChanges,
    broadcastMiscChanges,
    scheduleGitRefresh,
    async close() {
      closing = true;
      if (timer) clearInterval(timer);
      const markdownWatcherClosures = [...markdownWatchers.values()]
        .map(({ watcher }) => Promise.resolve(watcher.close()));
      markdownWatchers.clear();
      markdownSubscriptions.clear();
      for (const socket of clients) socket.destroy();
      clients.clear();
      for (const [socket] of [...terminalClients]) {
        disposeTerminalClient(socket, { claim: false });
        socket.destroy();
      }
      terminalClients.clear();
      terminalOwners.clear();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      await Promise.allSettled(markdownWatcherClosures);
      await Promise.allSettled([...pendingGitRefreshes.values()].map(({ promise }) => promise));
      if (ownsDb) db.close();
    },
  };
}
