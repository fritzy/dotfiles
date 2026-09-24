import { assertRemovableNotes } from './removal-policy.js';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { repositoryInput } from './git-storage.js';
import { createSessionNotes } from './session-notes.js';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { AGENT_PROVIDERS, CONFIG, PANEL_ROLES } from './config.js';
import { ApiError } from './operation-error.js';
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
  existingNoteDir,
  expandIssueReference,
  ghStackLink,
  hasGitHubPullRequest,
  isScratch,
  linkPrAsync,
  linkedSessionSeed,
  listIssues,
  listNotes,
  listWorkstreams,
  materializeWorktree,
  now,
  parseSelector,
  parentOf,
  removeIssue,
  removeWorktree,
  renderDigest,
  resolveRow,
  selectedAgent,
  setPath,
  setParent,
  setSelectedAgent,
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
  workstreamView,
  writeSeed,
} from './core.js';
import {
  ensureSessionPanelGroup,
  syncDiscoveredSessionNotes,
  syncIssueResources,
  readPanelLayout,
} from './panels.js';

const TYPES = ['repo', 'scratchpad', 'misc'];
const STATUSES = ['active', 'paused', 'closed', 'all', 'active_paused'];
const MAX_SEED_BYTES = 64 * 1024;
const DEFAULT_BROWSER_PANELS = ['shell', 'agent'];
export const API_COMMANDS = [
  'pause', 'resume', 'archive', 'close', 'rename', 'log', 'issue-add', 'issue-remove', 'open-path',
  'open-notes', 'agent-set', 'terminal-reset',
];

export function integerQuery(value, name, fallback, { min, max }) {
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
    repoUrl: item.repo ? `https://github.com/${item.repo}` : null,
    gitPresent: existsSync(`${item.path}/.git`),
    type: 'misc',
    closeable: false,
    scratch: false,
    status: activeSessions.has(String(item.id)) ? 'active' : 'paused',
    agentStatus: configuredLocationAgentStatus(db, item.id),
    shellStatus: configuredLocationShellStatus(db, item.id),
    agent: selectedAgent(db, item.id, config.agent || CONFIG.agent),
    source: 'configured',
    worktreePresent: existsSync(item.path),
    gitClean: item.repo || existsSync(`${item.path}/.git`) ? configuredLocationGitClean(db, item.id) : null,
    current: undefined,
    createdAt: null,
    lastJoined: null,
    stackedOn: null,
    stackedBy: [],
    issues: [],
  }));
}

export function apiWorkstreamView(db, row, { cwd, config = CONFIG } = {}) {
  return {
    ...workstreamView(db, row, cwd, config),
    agent: selectedAgent(db, row.id, config.agent || CONFIG.agent),
    repoUrl: ['local', 'url'].includes(row.source) ? null : workstreamView(db, row, cwd, config).repoUrl,
    notesPath: createSessionNotes(db, config).describe(row.id).path,
    noteStorage: createSessionNotes(db, config).describe(row.id),
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

export function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ApiError(400, `${name} must be a non-empty string`);
  }
  return value.trim();
}

export function requiredAgent(value) {
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

export function configuredLocationRow(id, config = CONFIG) {
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

export function requestedPanels(value, fallback = DEFAULT_BROWSER_PANELS) {
  const panels = value === undefined ? fallback : value;
  if (!Array.isArray(panels) || panels.length === 0) {
    throw new ApiError(400, 'panels must contain at least one panel');
  }
  const unique = [...new Set(panels.map((panel) => requiredString(panel, 'panel')))];
  const invalid = unique.find((panel) => !PANEL_ROLES.includes(panel));
  if (invalid) throw new ApiError(400, `panel must be one of: ${PANEL_ROLES.join(', ')}`);
  if (!unique.includes('shell')) throw new ApiError(400, 'panels must include shell');
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

export const panelModeFor = (panels) => panels.length === 1 ? 'shell' : panels.includes('editor') ? 'three' : 'two';

export function createRepoWorkstream(db, body = {}, context = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ApiError(400, 'request body must be a JSON object');
  }
  const config = context.config || CONFIG;
  const input = context.gitStorage && !context.legacyGitAdapter ? repositoryInput(body.repository, config) : null;
  const [org, repo] = input ? [input.org, input.repo] : repositoryParts(body.repository);
  const selector = requiredString(body.selector, 'branch or ref');
  const agent = requiredAgent(body.agent ?? config.agent);
  const panels = requestedPanels(body.panels, context.defaultPanels);
  const seed = requestedSeed(body.seed);
  const links = body.links ?? [];
  if (!Array.isArray(links)) throw new ApiError(400, 'links must be an array');

  let parsed;
  try {
    parsed = input && input.kind !== 'github' ? { branch: selector, source: input.kind }
      : (context.parseSelector || parseSelector)(org, repo, selector);
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
  if (existing && input && !context.gitStorage.record(existing.uuid)) throw new ApiError(409, 'existing worktree requires explicit storage migration', { code: 'storage_migration_required' });
  const uuid = existing?.uuid || (input && context.gitStorage.pendingUuid(input, branch)) || randomUUID();
  try {
    path = input ? context.gitStorage.materialize({ uuid, org, repo, branch, source }, { input, ...(sameRepoParent ? { base: parent.branch } : {}) })
      : (context.materialize || materializeWorktree)(
      org, repo, branch, source, { ...(sameRepoParent ? { base: parent.branch } : {}), config },
    );
  } catch (error) {
    throw new ApiError(502, `could not create worktree: ${error.message}`);
  }
  const timestamp = (context.now || now)();
  let row = upsertWorkstream(db, {
    uuid, org, repo, branch, source, path,
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
      (context.writeSeed || writeSeed)(row, briefing, config);
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
    browserWorkspace: { opened: true, panelMode: panelModeFor(panels), panels },
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
  const panels = requestedPanels(body.panels, context.defaultPanels);
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
    row = (context.createScratchpad || createScratchpad)(db, name, config);
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
      (context.writeSeed || writeSeed)(row, briefing, config);
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
    browserWorkspace: { opened: true, panelMode: panelModeFor(panels), panels },
    seeded: Boolean(briefing),
    workstream: {
      type: 'scratchpad',
      ...apiWorkstreamView(db, row, { cwd: context.cwd, config }),
    },
  };
}

export function openPathWithXdg(path, { run = spawnSync, platform = process.platform } = {}) {
  const opener = platform === 'darwin' ? 'open' : 'xdg-open';
  const result = run(opener, [path], { stdio: 'ignore' });
  if (result.error) throw new Error(`could not run ${opener}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${opener} exited with status ${result.status}`);
  return { opener, path };
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
    const row = configuredLocationRow(id, config) || commandRow(db, id);
    const path = context.sessionNotes ? context.sessionNotes.allocation(id).notes_path : existingNoteDir(row, config.paths.notes);
    if (path && !existsSync(path)) throw new ApiError(409, `notes directory is unavailable or has not been created: ${path}`, { code: 'storage_unavailable', path });
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
        if (config.configVersion === 2 && !existsSync(configuredRow.path)) throw new ApiError(404, `path does not exist: ${configuredRow.path}`);
        const panels = requestedPanels(body.panels, context.defaultPanels);
        const previous = selectedAgent(db, id, defaultAgent);
        const agent = body.agent === undefined
          ? previous
          : requiredAgent(body.agent);
        const seed = requestedSeed(body.seed);
        setSelectedAgent(db, id, agent);
        if (seed) (context.writeSeed || writeSeed)(configuredRow, seed, config);
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
      if (!isScratch(row) && context.gitStorage && !context.legacyGitAdapter) {
        const path = context.gitStorage.materialize(row);
        if (path !== row.path) { setPath(db, row.id, path); row.path = path; }
      } else if (!existsSync(row.path)) {
        const path = isScratch(row) ? (mkdirSync(row.path, { recursive: true }), row.path)
          : context.gitStorage && !context.legacyGitAdapter
            ? context.gitStorage.materialize(row)
            : (context.materialize || materializeWorktree)(row.org, row.repo, row.branch, row.source, { config });
        if (path !== row.path) {
          setPath(db, row.id, path);
          row.path = path;
        }
      }
      const panels = requestedPanels(body.panels, context.defaultPanels);
      const previous = selectedAgent(db, row.id, defaultAgent);
      const agent = body.agent === undefined
        ? previous
        : requiredAgent(body.agent);
      const seed = requestedSeed(body.seed);
      setSelectedAgent(db, row.id, agent);
      if (seed) (context.writeSeed || writeSeed)(row, seed, config);
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
        assertRemovableNotes(db, row);
        const dirty = !isScratch(row) ? (context.worktreeDirty || worktreeDirty)(row.path) : null;
        if (dirty && body.force !== true) {
          throw new ApiError(409, 'worktree has uncommitted changes; pass force:true to remove it', {
            dirty: dirty.split('\n'),
          });
        }
      }
      if (remove && existsSync(row.path)) {
        if (!isScratch(row) && (context.gitStorage && !context.legacyGitAdapter)) context.gitStorage.remove(row);
        else (context.removeWorktree || removeWorktree)(row.org, row.repo, row.path, config);
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

function stackLinearity(db, row, config) {
  try {
    const chain = stackLine(db, row);
    const check = stackCheck(chain, config);
    return { chain, ...check };
  } catch (error) {
    return { chain: null, ok: false, reason: error.message };
  }
}

export function workstreamStack(db, id, { config = CONFIG } = {}) {
  const row = commandRow(db, id);
  const { chain, ok, reason, repo } = stackLinearity(db, row, config);
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

export function linkWorkstreamStack(db, id, body = {}, { config = CONFIG } = {}) {
  const row = commandRow(db, id);
  let chain;
  try {
    chain = stackLine(db, row);
  } catch (error) {
    throw new ApiError(409, error.message);
  }
  const check = stackCheck(chain, config);
  if (!check.ok) throw new ApiError(409, check.reason);
  let linked;
  try {
    linked = ghStackLink(chain, { open: body.open === true, config });
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

function requireSessionNotes(root) {
  if (!root) throw new ApiError(409, 'session-note storage requires phase 3 allocation/migration support; use an explicit Markdown file path', { code: 'storage_phase_3_required' });
}

export function createWorkstreamNote(db, id, body = {}, { notesRoot = CONFIG.paths.notes, sessionNotes, config = CONFIG } = {}) {
  if (!sessionNotes) requireSessionNotes(notesRoot);
  const row = configuredLocationRow(id, config) || commandRow(db, id);
  if (typeof body.body !== 'string' || body.body.trim() === '') {
    throw new ApiError(400, 'body must be a non-empty string');
  }
  if (body.title !== undefined && typeof body.title !== 'string') {
    throw new ApiError(400, 'title must be a string');
  }
  const { file, path } = sessionNotes ? sessionNotes.create(id, body.body, { title: body.title })
    : addNote(row, body.body, { title: body.title, root: notesRoot });
  return { workstream: briefWorkstream(row), file, path };
}

export function workstreamNotes(db, id, { notesRoot = CONFIG.paths.notes, sessionNotes, config = CONFIG } = {}) {
  if (!sessionNotes) requireSessionNotes(notesRoot);
  const row = configuredLocationRow(id, config) || commandRow(db, id);
  return { workstream: briefWorkstream(row), notes: sessionNotes ? sessionNotes.scan(id) : listNotes(row, notesRoot) };
}

export async function syncWorkstreamSession(db, id, {
  notesRoot = CONFIG.paths.notes, sessionNotes, defaultPanels,
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
  }, { roles: db.prepare('SELECT 1 FROM panel_groups WHERE owner_id=?').get(String(row.id)) ? [] : defaultPanels || ['shell', 'agent'], bump: true });
  const noteSync = syncDiscoveredSessionNotes(db, notesRoot, { ownerId: row.id, sessionNotes });
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
      ...(noteSync.unavailable ? { unavailable: noteSync.unavailable } : {}),
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

export function workstreamDigest(db, body = {}, { notesRoot = CONFIG.paths.notes, config = CONFIG } = {}) {
  const weeklyRoot = config.notes?.weekly?.enabled === false ? null : config.notes?.weekly?.root || notesRoot;
  if (body.write === true && !weeklyRoot) throw new ApiError(409, 'weekly notes are disabled; configure notes.weekly.enabled and notes.weekly.root', { code: 'weekly_notes_disabled' });
  if (body.date !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    throw new ApiError(400, 'date must use YYYY-MM-DD');
  }
  const activity = collectDayActivity(db, { date: body.date });
  const markdown = renderDigest(activity);
  const result = { date: activity.dateIso, markdown, workstreams: activity.workstreams };
  if (body.write === true && markdown) {
    const { file, heading } = appendDayEntry(markdown, activity.date, weeklyRoot);
    result.written = { file, heading };
  }
  return result;
}
