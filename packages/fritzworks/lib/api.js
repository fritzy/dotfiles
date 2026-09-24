import { createApplicationContext } from './context.js';
import { ApiError } from './operation-error.js';
export { ApiError } from './operation-error.js';
import {
  API_COMMANDS,
  panelModeFor,
  stateItems as rawStateItems,
  queryWorkstreams as rawQueryWorkstreams,
  openPathWithXdg,
} from './operations.js';
export {
  stateItems, queryWorkstreams, createRepoWorkstream, createScratchpadWorkstream,
  openPathWithXdg, executeWorkstreamCommand, workstreamStack, setWorkstreamStack,
  linkWorkstreamStack, createWorkstreamNote, workstreamNotes, syncWorkstreamSession,
  workstreamDigest, API_COMMANDS,
} from './operations.js';
import { createHash } from 'node:crypto';

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import chokidar from 'chokidar';

import { serveHtmlResourceFile } from './html-files.js';
import { readGithubPullRequest } from './github-pr.js';
import { githubPullRequestUrl } from './github-pr-url.js';

import { CONFIG, PANEL_ROLES } from './config.js';
import {
  dayHeading,
  expandIssueReference,
  isScratch,
  latestWorkstreamEventSequence,
  linkPrAsync,
  listIssues,
  noteDir,
  now,
  parseSelector,
  readBrowserUiState,
  recentRepositories,
  removeIssue,
  refreshWorkstreamStatuses,
  resolveRow,
  setCachedGitClean,
  setStatus,
  worktreeCleanAsync,
  workstreamEventsAfter,
  writeBrowserUiState,
} from './core.js';
import {
  agentCommand,
  agentInvocation,
  browserTerminalConfigFile,
  browserTerminalSessionName as terminalSessionName,
  ensureBrowserTerminalSession,
  killBrowserTerminalSession,
  resetAllBrowserTerminalSessions,
  resetBrowserTerminalSession,
} from './zellij.js';
import { githubWorkSuggestions, linearSearchSuggestions as searchLinearSuggestions, linearWorkSuggestions } from './suggestions.js';
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
const MAX_WEBSOCKET_PAYLOAD = 1024 * 1024;
const BROWSER_UI_SCOPES = new Set(['workspaces', 'bottom-terminals']);
const BROWSER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DEFAULT_BROWSER_PANELS = ['shell', 'agent'];


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

// The client may be talking to us cross-origin (the daemon-selector switches
// a page served by one loopback alias to fetch/WebSocket a different one, e.g.
// the fw-tunnel's 127.1.1.2). A real remote attacker's page can never present
// a loopback Origin, so trusting one here is no broader than trusting the
// same-origin case this server was already built for.
function loopbackHostname(hostname) {
  return hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || /^127(\.\d{1,3}){3}$/.test(hostname);
}

function loopbackOrigin(req) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return null;
  try {
    const parsed = new URL(origin);
    return ['http:', 'https:'].includes(parsed.protocol) && loopbackHostname(parsed.hostname) ? origin : null;
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

function staticFile(res, path, contentType, headOnly = false, config = CONFIG) {
  const body = readFileSync(path);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    // img-src is widened so markdown previews can show images a note links to;
    // everything else stays same-origin (plus the configured daemons above).
    'Content-Security-Policy': `default-src 'self'; connect-src 'self' ws: wss: ${Object.values(config.daemons || {}).map((daemon) => daemon.url).join(' ')}; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; frame-src 'self' https: http:`,
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
        socket.emit('fw-close-frame');
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
  context: suppliedContext,
  db: suppliedDb,
  config = suppliedContext?.config || CONFIG,
  webRoot = WEB_ROOT,
  cwd = process.cwd(),
  pollInterval = config.server.pollInterval,
  openPath = openPathWithXdg,
  checkGit = worktreeCleanAsync,
  checkPr = linkPrAsync,
  materialize,
  parseRepoSelector = parseSelector,
  expandIssue = expandIssueReference,
  writeSeed: writeSessionSeed,
  clock = suppliedContext?.clock || now,
  createScratchpadEntry,
  linearSuggestions = linearWorkSuggestions,
  linearSearch = searchLinearSuggestions,
  githubSuggestions = githubWorkSuggestions,
  readPullRequest = readGithubPullRequest,
  suggestionCacheMs = 60_000,
  spawnTerminalAttach = spawnZellijAttachTerminal,
  ensureTerminalSession,
  killTerminalSession,
  resetTerminalSession,
  resetAllTerminalSessions,
  terminalSessionConfigFile,
  createMarkdownWatcher = (path, options) => chokidar.watch(path, options),
  notesRoot = config.paths.notes ?? null,
  dataDir = config.paths.data,
} = {}) {
  const context = suppliedContext || createApplicationContext({
    config, db: suppliedDb, clock,
    adapters: Object.fromEntries(Object.entries({
      materialize, writeSeed: writeSessionSeed, createScratchpad: createScratchpadEntry,
      parseSelector: parseRepoSelector, expandIssue, openPath,
    }).filter(([, value]) => value !== undefined)),
  });
  config = context.config;
  const weeklyRoot = config.notes?.weekly?.enabled === false ? null : config.notes?.weekly?.root || notesRoot;
  const requireWeeklyNotes = () => {
    if (!weeklyRoot) throw new ApiError(409, 'weekly notes are disabled; configure notes.weekly.enabled and notes.weekly.root', { code: 'weekly_notes_disabled' });
  };
  const db = context.db;
  const operations = context.operations;
  const annotate = (item) => ({ ...item, defaultPanels: context.policy.defaultPanels(), availableActions: context.policy.actions(context.resolveTarget(String(item.id))) });
  const stateItems = (...args) => rawStateItems(...args).map(annotate);
  const queryWorkstreams = (...args) => { const result = rawQueryWorkstreams(...args); return { ...result, items: result.items.map(annotate) }; };
  const managedRead = (path, options = {}) => {
    const resolved = resolveMarkdownFile(path, { cwd, home: config.home, ...options });
    const owner = resolved && context.sessionNotes.ownerForPath(resolved);
    return owner != null ? context.sessionNotes.read(owner, resolved) : readMarkdownFile(path, options);
  };
  const managedWrite = (path, content, options = {}) => {
    const resolved = resolveMarkdownFile(path, { cwd, home: config.home, ...options });
    const owner = resolved && context.sessionNotes.ownerForPath(resolved);
    return owner != null ? context.sessionNotes.write(owner, resolved, content, options) : writeMarkdownFile(path, content, options);
  };
  const terminalIdentity = (identity) => context.terminalMigration.mappedIdentity(identity);
  const browserTerminalSessionName = (identity) => terminalSessionName(terminalIdentity(identity));
  const runtimeDir = join(config.paths.data, 'runtime');
  ensureTerminalSession ||= (identity, options) => ensureBrowserTerminalSession(terminalIdentity(identity), {
    ...options, runtimeDir, env: context.environment,
  });
  killTerminalSession ||= (identity) => {
    const result = killBrowserTerminalSession(terminalIdentity(identity));
    context.terminalMigration.release(identity);
    return result;
  };
  resetTerminalSession ||= (identity) => {
    const result = resetBrowserTerminalSession(terminalIdentity(identity));
    context.terminalMigration.release(identity);
    return result;
  };
  resetAllTerminalSessions ||= () => {
    const descriptors = db.prepare("SELECT id FROM panels WHERE kind IN ('terminal','ai')").all()
      .map(({ id }) => terminalPanelDescriptor(db, id));
    // Verify every adopted owner before resetting any process.
    descriptors.forEach(({ identity }) => terminalIdentity(identity));
    const reset = descriptors.map(({ identity }) => { context.hooks.revokeIdentity(identity); return resetTerminalSession(identity); });
    return { count: reset.filter((result) => result.reset).length, sessions: reset.map((result) => result.session) };
  };
  terminalSessionConfigFile ||= () => browserTerminalConfigFile({ runtimeDir });
  const ownedTerminalAction = (action) => (...args) => {
    context.assertTerminalOwnership();
    return action(...args);
  };
  ensureTerminalSession = ownedTerminalAction(ensureTerminalSession);
  killTerminalSession = ownedTerminalAction(killTerminalSession);
  resetTerminalSession = ownedTerminalAction(resetTerminalSession);
  resetAllTerminalSessions = ownedTerminalAction(resetAllTerminalSessions);
  const operationOptions = () => ({ cwd, notesRoot, terminalSessionIds: terminalSessionIds() });
  migrateLegacyPanelState(db, { dataDir, config, cwd });
  syncSessionPanelGroups(db, stateItems(db, { cwd, config, terminalSessionIds: [] }));
  syncIssueResources(db);
  syncDiscoveredSessionNotes(db, notesRoot, { sessionNotes: context.sessionNotes });
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
      ? () => linearSearch(query, { config })
      : provider === 'linear'
        ? () => linearSuggestions({ reference: clock(), config })
      : () => githubSuggestions({ config });
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
  const previousPublish = context.publish;
  const broadcast = (message) => {
    previousPublish(message);
    let recipients = 0;
    for (const socket of clients) if (send(socket, message)) recipients += 1;
    return recipients;
  };
  context.publish = broadcast;
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
        if (!closing) process.stderr.write(`fritzworks Markdown watcher: ${error.message}\n`);
      });
    }
  };
  const markdownWatchPath = ({ path: requested, source }) => {
    if (source === 'notes') {
      requireWeeklyNotes();
      const path = resolveNotesFile(weeklyRoot, requested);
      if (!path) throw new ApiError(400, 'path must be a Markdown file inside the notes root');
      readNotesFile(weeklyRoot, path, { date: new Date(clock()) });
      return path;
    }
    if (source !== 'file') throw new ApiError(400, 'Markdown source must be file or notes');
    const path = resolveMarkdownFile(requested, { cwd, home: config.home });
    if (!path) throw new ApiError(400, 'path must be a Markdown file');
    managedRead(path, { cwd, home: config.home });
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
    if (open) workspaces.push({ id, panelMode: panelModeFor(panels), panels });
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
      const roles = panels;
      const { group } = ensureSessionPanelGroup(db, item, { roles, bump: true });
      if (open) activatePanelGroup(db, group.id, readPanelLayout(db).revision);
      else deactivatePanelGroup(db, group.id, readPanelLayout(db).revision);
      syncIssueResources(db);
      broadcastPanelLayout();
    }
    return saved;
  };
  const completeAction = (result, target, command) => {
    const ownerId = context.ownerId(target);
    const browserAgentConnected = command === 'agent-set' && browserTerminalConnected(ownerId, 'agent');
    if (command === 'agent-set' && result.result.changed) {
      result.result.replaced = browserAgentConnected;
      result.result.browserTerminalRestart = browserAgentConnected;
    }
    if (command === 'pause' || command === 'archive' || command === 'close') {
      stopPersistentTerminalSessions(ownerId);
      closeBrowserTerminals(ownerId);
    }
    if (command === 'agent-set' && result.result.changed) {
      closeBrowserTerminals(ownerId, 'agent');
      stopPersistentTerminalSessions(ownerId, 'agent');
    }
    if (command === 'resume' && (result.result.agentChanged || result.result.seeded)) {
      closeBrowserTerminals(ownerId, 'agent');
      stopPersistentTerminalSessions(ownerId, 'agent');
    }
    if (command === 'terminal-reset') {
      closeBrowserTerminals(ownerId);
      try {
        result.result.terminals = resetPersistentTerminalSessions(ownerId);
      } catch (error) {
        throw new ApiError(502, `could not reset browser terminals: ${error.message}`);
      }
    }
    if (command === 'resume') {
      setBrowserWorkspaceOpen(ownerId, true, result.result.panels);
      result.browserWorkspace = {
        opened: true,
        panelMode: panelModeFor(result.result.panels),
      };
    } else if (command === 'pause' || command === 'archive' || command === 'close') {
      setBrowserWorkspaceOpen(ownerId, false);
      result.browserWorkspace = { opened: false };
    }
    broadcastChanges();
    if (command === 'rename') {
      const groupSync = syncSessionPanelGroups(db, [result.workstream]);
      if (groupSync.changed) broadcastPanelLayout();
    }
    if (command === 'issue-add' || command === 'issue-remove') {
      syncIssueResources(db);
      broadcastPanelLayout();
    }
    if (result.workstream.type === 'misc') broadcastMiscChanges();
    scheduleGitRefresh([result.workstream]);
    return result;
  };
  context.jobCompleted = (result, intent) => {
    if (!result?.workstream) return;
    if (intent.kind === 'action') { completeAction(result, intent.target, intent.command); return; }
    const ownerId = String(result.workstream.id);
    if (result.agentChanged || result.seeded) {
      closeBrowserTerminals(ownerId, 'agent'); stopPersistentTerminalSessions(ownerId, 'agent');
    }
    setBrowserWorkspaceOpen(ownerId, true, result.browserWorkspace?.panels || context.policy.defaultPanels());
    broadcastChanges(); broadcastMiscChanges(); broadcastPanelLayout();
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
      if (!closing) process.stderr.write(`fritzworks terminal status: ${error.message}\n`);
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
      if (!closing) process.stderr.write(`fritzworks terminal status: ${error.message}\n`);
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
      try { context.hooks.revokeIdentity(identity); killTerminalSession(identity); }
      catch (error) {
        process.stderr.write(`fritzworks: could not stop terminal session for "${sessionId}": ${error.message}\n`);
      }
    }
  };

  const resetPersistentTerminalSessions = (sessionId) => {
    const descriptors = terminalPanelsForOwner(db, sessionId);
    const identities = descriptors.length
      ? descriptors.map(({ identity }) => identity)
      : PANEL_ROLES.map((role) => ({ sessionId: String(sessionId), role }));
    return identities.map((identity) => { context.hooks.revokeIdentity(identity); return resetTerminalSession(identity); });
  };

  const terminateBrowserTerminal = (terminalSession, identity) => {
    for (const [clientSocket, current] of [...terminalClients]) {
      if (current.terminalSession !== terminalSession) continue;
      disposeTerminalClient(clientSocket, { claim: false });
      if (!clientSocket.destroyed) clientSocket.end(encodeWebSocketFrame('', 0x8));
    }
    try { context.hooks.revokeIdentity(identity); killTerminalSession(identity); }
    catch (error) {
      process.stderr.write(`fritzworks: could not terminate browser terminal "${terminalSession}": ${error.message}\n`);
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
        prepareCommand: (command) => {
          if (!current.sessionId) return command;
          context.hooks.revokeIdentity(current.identity);
          const provider = command.find((part) => part.startsWith('FRITZWORKS_PROVIDER='))?.split('=')[1] || 'shell';
          const environment = context.hooks.environment(current.sessionId, provider, current.identity);
          return command.map((part) => part.startsWith('FRITZWORKS_GENERATION=') ? `FRITZWORKS_GENERATION=${environment.FRITZWORKS_GENERATION}` : part);
        },
      });
      if (ensured?.created && current.seedFile) {
        try { unlinkSync(current.seedFile); } catch { /* the agent already has the inline prompt */ }
        current.seedFile = null;
      }
      const terminal = spawnTerminalAttach({
        session: ensured.session,
        configFile: terminalSessionConfigFile(),
        cwd: current.cwd,
        cols: current.cols,
        rows: current.rows,
        env: context.environment,
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
      process.stderr.write(`fritzworks terminal: ${error.message}\n`);
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
    if (configured) return configured.repo || existsSync(join(configured.path, '.git')) ? { id: String(id), path: configured.path } : null;
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
      process.stderr.write(`fritzworks API Git status: ${error.message}\n`);
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
            if (!closing) process.stderr.write(`fritzworks API Git status: ${error.message}\n`);
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

  const sessionMarkdownDirectory = (group) => {
    if (!group.ownerId || group.type === 'terminal') return null;
    return context.sessionNotes.describe(group.ownerId).path;
  };

  const panelLayoutResponse = () => {
    const layout = readPanelLayout(db);
    return {
      ...layout,
      groups: layout.groups.map((group) => {
        const markdownDirectory = sessionMarkdownDirectory(group);
        const noteStorage = group.ownerId && group.type !== 'terminal' ? context.sessionNotes.describe(group.ownerId) : null;
        return { ...group, markdownDirectory, noteStorage };
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
    if (!directory && !body.value && config.configVersion === 2) {
      throw new ApiError(409, 'session-note storage requires explicit migration', { code: 'storage_migration_required' });
    }
    if (!directory && !body.value) {
      throw new PanelModelError(400, 'a path is required for a group without a session notes directory');
    }
    const content = title ? `# ${title}\n\n${body.content}` : body.content;
    const file = body.value ? createMarkdownFile(body.value, content, {
      cwd: group.path || cwd, home: config.home,
    }) : context.sessionNotes.create(group.ownerId, body.content, { title });
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
      if (segment !== 'tabs') requireWeeklyNotes();
      if (req.method === 'GET' && segment === 'files') {
        // Only the work tree: journal entries and per-session resource files are
        // written elsewhere and are not what this editor is for.
        const date = notesDate();
        const { path: weekPath, iso } = weeklyNotePath(weeklyRoot, 'work', date);
        return json(res, 200, {
          root: weeklyRoot,
          today: dayHeading(date),
          weekly: [{
            kind: 'work',
            week: iso,
            path: notesRelativePath(weeklyRoot, weekPath),
            exists: existsSync(weekPath),
          }],
          files: listNotesFiles(weeklyRoot, { subtree: 'work' }),
        });
      }
      if (req.method === 'GET' && segment === 'file') {
        return json(res, 200, readNotesFile(weeklyRoot, url.searchParams.get('path'), { date: notesDate() }));
      }
      if (req.method === 'PUT' && segment === 'file') {
        const body = await jsonBody(req);
        const saved = writeNotesFile(weeklyRoot, body.path, body.content, { version: body.version ?? null });
        return json(res, 200, saved);
      }
      if (req.method === 'POST' && segment === 'weekly') {
        const body = await jsonBody(req);
        return json(res, 200, openWeeklyNote(weeklyRoot, body.kind, { date: notesDate() }));
      }
      if (req.method === 'GET' && segment === 'tabs') {
        return json(res, 200, readEditorTabs(dataDir, url.searchParams.get('scope') || 'global'));
      }
      if (req.method === 'PUT' && segment === 'tabs') {
        const body = await jsonBody(req);
        if (body.tabs?.some((tab) => (tab.source || 'notes') === 'notes')) requireWeeklyNotes();
        return json(res, 200, writeEditorTabs(dataDir, body.scope || 'global', body, {
          root: weeklyRoot, cwd,
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
        return json(res, 200, managedRead(url.searchParams.get('path'), { cwd }));
      }
      if (req.method === 'PUT' && segment === 'file') {
        const body = await jsonBody(req);
        return json(res, 200, managedWrite(body.path, body.content, {
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
        const noteSync = syncDiscoveredSessionNotes(db, notesRoot, { sessionNotes: context.sessionNotes });
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
      } else if (req.method === 'GET' && parts[1] === 'resources' && parts[3] === 'pull-request' && parts.length === 4) {
        const { resource } = associatedResource(parts[2]);
        const prUrl = resource.kind === 'link' && githubPullRequestUrl(resource.value);
        if (!prUrl) throw new PanelModelError(400, 'resource must be a GitHub pull request link');
        try {
          return json(res, 200, await readPullRequest(prUrl));
        } catch (error) {
          throw new ApiError(502, error.message);
        }
      } else if (req.method === 'GET' && parts[1] === 'resources' && parts.length === 3) {
        const { group, resource } = associatedResource(parts[2]);
        if (resource.kind !== 'markdown') {
          throw new PanelModelError(400, 'only Markdown resources have readable content');
        }
        return json(res, 200, {
          resource,
          group: { id: group.id, ownerId: group.ownerId, label: group.label },
          file: managedRead(resource.value, { cwd }),
        });
      } else if (req.method === 'PUT' && parts[1] === 'resources' && parts.length === 3) {
        const { group, resource } = associatedResource(parts[2]);
        if (resource.kind !== 'markdown') {
          throw new PanelModelError(400, 'only Markdown resources have writable content');
        }
        return json(res, 200, {
          resource,
          group: { id: group.id, ownerId: group.ownerId, label: group.label },
          file: managedWrite(resource.value, body.content, {
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
      let hostname;
      try { hostname = new URL(`http://${req.headers.host}`).hostname; }
      catch { throw new ApiError(403, 'invalid Host header'); }
      if (!loopbackHostname(hostname)) throw new ApiError(403, 'Host must be a loopback address');
      const corsOrigin = loopbackOrigin(req);
      if (req.headers.origin !== undefined && !corsOrigin) throw new ApiError(403, 'Origin must be a loopback HTTP origin');
      if ((Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding'])
          && req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new ApiError(415, 'request body must use Content-Type: application/json');
      }
      if (corsOrigin) {
        res.setHeader('Access-Control-Allow-Origin', corsOrigin);
        res.setHeader('Vary', 'Origin');
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET, POST, PUT, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-FritzWorks-Instance',
          'Access-Control-Max-Age': '600',
        });
        res.end();
        return;
      }
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const expectedInstance = req.headers['x-fritzworks-instance'] || url.searchParams.get('instance');
      if (expectedInstance && expectedInstance !== context.instanceId) throw new ApiError(409, 'daemon identity changed', { code: 'identity_changed', instanceId: context.instanceId, previousInstanceId: expectedInstance });
      const canSubmitJob = url.pathname === '/fw' || url.pathname === '/fw/scratchpad' || (url.pathname.split('/').length === 4 && [...API_COMMANDS, 'stack-link', 'stack-rebase'].includes(url.pathname.split('/')[3]));
      if (!['GET', 'HEAD'].includes(req.method) && !canSubmitJob && /^\/(?:storage|migrations|fw|panel-layout|markdown|notes)(?:\/|$)/.test(url.pathname)
          && context.jobs.list().some((job) => ['running', 'cancel_requested'].includes(job.status))) {
        throw new ApiError(409, 'a daemon job is using managed state; retry after it settles', { code: 'job_in_progress' });
      }
      const headOnly = req.method === 'HEAD';
      const htmlAsset = url.pathname.match(/^\/resource-files\/([^/]+)\/([^/]+)\/(.+)$/);
      if (url.pathname.startsWith('/resource-files/') && !htmlAsset) throw new ApiError(409, 'HTML resources require an instance-bound path', { code: 'instance_required' });
      if ((req.method === 'GET' || headOnly) && htmlAsset) {
        try {
          const resourceInstance = decodeURIComponent(htmlAsset[1]);
          if (resourceInstance !== context.instanceId) throw new ApiError(409, 'daemon identity changed', { code: 'identity_changed', instanceId: context.instanceId, previousInstanceId: resourceInstance });
          const { resource } = associatedResource(decodeURIComponent(htmlAsset[2]));
          return serveHtmlResourceFile(res, resource, decodeURIComponent(htmlAsset[3]), headOnly);
        } catch (error) {
          if (error instanceof URIError) throw new ApiError(400, 'invalid HTML asset path');
          if (error instanceof PanelModelError) throw new ApiError(error.status, error.message);
          throw error;
        }
      }
      if ((req.method === 'GET' || headOnly) && (url.pathname === '/' || url.pathname === '/v2' || url.pathname === '/v2/')) {
        return staticFile(res, `${webRoot}/v2/index.html`, 'text/html; charset=utf-8', headOnly, config);
      }
      const v2Asset = url.pathname.match(/^\/v2\/assets\/([A-Za-z0-9_.-]+\.(css|js|map))$/);
      if ((req.method === 'GET' || headOnly) && v2Asset) {
        return staticFile(res, `${webRoot}/v2/assets/${v2Asset[1]}`, V2_ASSET_TYPES.get(v2Asset[2]), headOnly, config);
      }
      const v2Font = url.pathname.match(/^\/v2\/fonts\/([A-Za-z0-9_.-]+\.(woff2|txt))$/);
      if ((req.method === 'GET' || headOnly) && v2Font) {
        return staticFile(res, `${webRoot}/v2/fonts/${v2Font[1]}`, V2_FONT_TYPES.get(v2Font[2]), headOnly, config);
      }
      const iconName = url.pathname.match(/^\/icons\/([^/]+)$/)?.[1];
      if ((req.method === 'GET' || headOnly) && WEB_ICONS.has(iconName)) {
        return staticFile(res, `${webRoot}/icons/${iconName}`, 'image/svg+xml', headOnly, config);
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, {
          service: 'fritzworks',
          version: PACKAGE.version,
          pid: process.pid,
          uptime: process.uptime(),
          revision: DAEMON_REVISION,
          instanceId: context.instanceId,
          configRevision: context.configRevision,
          terminalOwnership: context.terminalOwnership,
          configuration: context.configurationStatus(),
          websocket: '/fw/events',
        });
      }
      if (url.pathname === '/migrations/storage' && req.method === 'GET') {
        return json(res, 200, context.storageMigration.inventory({ legacyConfigPath: url.searchParams.get('legacyConfigPath') || undefined }));
      }
      if (url.pathname === '/migrations' && req.method === 'GET') {
        return json(res, 200, { migrations: context.storageMigration.ledger() });
      }
      if (['/migrations/storage/apply', '/migrations/storage/recover'].includes(url.pathname) && req.method === 'POST') {
        const action = url.pathname.endsWith('/recover') ? 'recover' : 'apply';
        const result = context.storageMigration[action](await jsonBody(req));
        migrateLegacyPanelState(db, { dataDir, config, cwd });
        return json(res, 200, result);
      }
      if (url.pathname.startsWith('/storage/location/') && req.method === 'POST') {
        const action = url.pathname.split('/').at(-1);
        if (!['preview', 'apply', 'recover'].includes(action)) throw new ApiError(404, 'unknown location migration action');
        if (action !== 'recover') context.assertTerminalOwnership();
        return json(res, 200, context.locationMigration[action](await jsonBody(req)));
      }
      if (url.pathname.startsWith('/storage/relocate/') && req.method === 'POST') {
        context.assertTerminalOwnership();
        const action = url.pathname.split('/').at(-1);
        if (!['preview', 'apply', 'recover'].includes(action)) throw new ApiError(404, 'unknown relocation action');
        const result = context.storageRelocation[action](await jsonBody(req));
        if (action !== 'preview') {
          for (const [socket, subscriptions] of markdownSubscriptions) for (const subscription of [...subscriptions.values()]) {
            if (result.source && (subscription.path === result.source || subscription.path.startsWith(result.source + '/'))) {
              removeMarkdownSubscription(socket, subscription.watchId);
              send(socket, { type: 'markdown_watch_error', watchId: subscription.watchId, message: 'storage relocated; reopen the resource to watch its new path' });
            }
          }
          broadcastPanelLayout();
        }
        return json(res, 200, result);
      }
      if (url.pathname.match(/^\/fw\/[^/]+\/note-file$/) && ['GET', 'PUT'].includes(req.method)) {
        const owner = context.ownerId(decodeURIComponent(url.pathname.split('/')[2]));
        if (req.method === 'GET') return json(res, 200, context.sessionNotes.read(owner, url.searchParams.get('path')));
        const body = await jsonBody(req);
        return json(res, 200, context.sessionNotes.write(owner, body.path, body.content, { version: body.version }));
      }
      if (url.pathname === '/migrations/terminals' && req.method === 'GET') {
        return json(res, 200, context.terminalMigration.inventory());
      }
      if (url.pathname === '/migrations/terminals/apply' && req.method === 'POST') {
        return json(res, 200, context.terminalMigration.apply(await jsonBody(req)));
      }
      if (url.pathname === '/migrations/terminals/recover' && req.method === 'POST') {
        return json(res, 200, context.terminalMigration.recover(await jsonBody(req)));
      }
      if (req.method === 'GET' && url.pathname === '/capabilities') return json(res, 200, context.policy.capabilities());
      if (req.method === 'POST' && url.pathname === '/context/resolve') return json(res, 200, context.policy.resolveContext(await jsonBody(req)));
      if (req.method === 'POST' && url.pathname === '/intents/preview') return json(res, 200, context.policy.preview(await jsonBody(req)));
      if (req.method === 'GET' && url.pathname === '/hooks/status') return json(res, 200, context.hooks.diagnostics());
      if (req.method === 'POST' && url.pathname === '/hooks/events') {
        const result = context.hooks.ingest(await jsonBody(req));
        if (result.updated) { broadcastChanges(); broadcastMiscChanges(); }
        return json(res, 200, result);
      }
      if (req.method === 'GET' && url.pathname === '/jobs') return json(res, 200, { jobs: context.jobs.list() });
      if (req.method === 'POST' && url.pathname === '/jobs') {
        const body = await jsonBody(req);
        return json(res, 202, { job: context.jobs.submit(body.intent, { idempotencyKey: body.idempotencyKey }) });
      }
      if (url.pathname.startsWith('/jobs/')) {
        const [, , id, action] = url.pathname.split('/');
        if (req.method === 'GET' && !action) return json(res, 200, { job: context.jobs.get(id) });
        if (req.method === 'POST' && action === 'cancel') return json(res, 200, { job: context.jobs.cancel(id) });
      }
      if (req.method === 'GET' && url.pathname === '/config/status') {
        return json(res, 200, context.configurationStatus());
      }
      if (req.method === 'GET' && url.pathname === '/config') {
        return json(res, 200, config);
      }
      if (req.method === 'GET' && url.pathname === '/daemons') {
        return json(res, 200, { instanceId: context.instanceId, configRevision: context.configRevision, daemons: Object.values(config.daemonDirectory || config.daemons || {}) });
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
              roles: spec.panels || (spec.panelMode === 'shell' ? ['shell'] : spec.panelMode === 'three' ? ['shell', 'editor', 'agent'] : context.policy.defaultPanels()),
              bump: true,
            });
          }
          broadcastPanelLayout(clientId);
        }
        return json(res, 200, result);
      }
      if (req.method === 'GET' && url.pathname === '/fw/events') {
        return json(res, 426, { error: 'upgrade_required', websocket: '/fw/events' }, { Upgrade: 'websocket' });
      }
      if (req.method === 'GET' && url.pathname === '/fw/terminal') {
        return json(res, 426, { error: 'upgrade_required', websocket: '/fw/terminal' }, { Upgrade: 'websocket' });
      }
      if (req.method === 'GET' && url.pathname === '/fw/terminal-sessions') {
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
      if (req.method === 'POST' && url.pathname === '/fw/terminal-reset') {
        context.assertTerminalOwnership();
        const body = await jsonBody(req);
        context.policy.validate({ kind: 'terminal-reset-all', body }, body.previewRevision, { confirm: body.confirm });
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
      if (req.method === 'POST' && url.pathname === '/fw/refresh') {
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
        if (!['GET', 'HEAD'].includes(req.method)) context.assertTerminalOwnership();
        return await panelRoute(req, res, url);
      }

      const parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
      if (req.method === 'POST' && parts[0] === 'fw' && parts[1] === 'digest' && parts.length === 2) {
        const body = await jsonBody(req);
        return json(res, 200, operations.digest(body, { notesRoot }));
      }
      if (req.method === 'GET' && parts[0] === 'fw' && parts[2] === 'stack' && parts.length === 3) {
        return json(res, 200, operations.stack(parts[1]));
      }
      if (req.method === 'POST' && parts[0] === 'fw' && parts[2] === 'sync' && parts.length === 3) {
        await jsonBody(req);
        const result = await operations.sync(parts[1], {
          notesRoot, checkPr, checkedAt: clock(),
        });
        if (result.layout.changed) broadcastPanelLayout();
        broadcastChanges();
        result.workstream = queryWorkstreams(db, {
          id: result.workstream.id, status: 'all',
        }, { cwd, config, terminalSessionIds: terminalSessionIds() }).items[0];
        return json(res, 200, { ok: true, ...result });
      }
      if (req.method === 'POST' && parts[0] === 'fw' && parts[2] === 'stack-set' && parts.length === 3) {
        const body = await jsonBody(req);
        const result = operations.setStack(parts[1], body);
        const changed = new Set([
          result.workstream.id, result.stackedOn?.id, result.wasStackedOn?.id,
        ].filter((id) => id !== undefined));
        for (const id of changed) broadcast({ id, type: 'update_session' });
        return json(res, 200, result);
      }
      if (req.method === 'POST' && parts[0] === 'fw' && ['stack-link', 'stack-rebase'].includes(parts[2]) && parts.length === 3) {
        const body = await jsonBody(req);
        const intent = { kind: parts[2], target: parts[1], body };
        return json(res, 202, { job: context.jobs.submit(intent, { idempotencyKey: body.idempotencyKey }) });
      }
      if (req.method === 'POST' && parts[0] === 'fw' && parts[2] === 'note' && parts.length === 3) {
        const body = await jsonBody(req);
        const result = operations.createNote(parts[1], body, { notesRoot });
        broadcast({ id: result.workstream.id, type: 'update_session' });
        if (syncDiscoveredSessionNotes(db, notesRoot, { sessionNotes: context.sessionNotes }).changed) broadcastPanelLayout();
        return json(res, 201, result);
      }
      if (req.method === 'GET' && parts[0] === 'fw' && parts[2] === 'notes' && parts.length === 3) {
        return json(res, 200, operations.notes(parts[1], { notesRoot }));
      }
      if (req.method === 'GET' && parts[0] === 'fw' && parts[1] === 'link-suggestions' && parts.length === 3) {
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
      if (req.method === 'GET' && parts[0] === 'fw' && parts[1] === 'new' && parts.length === 2) {
        return json(res, 200, {
          repositoryRoot: config.configVersion === 2 ? null : config.paths.repositories,
          worktreeRoot: config.paths.worktrees || config.paths.repositories,
          repositoryCreation: context.policy.capabilities().creation.repository,
          scratchpadCreation: context.policy.capabilities().creation.scratchpad,
          scratchpadRoot: config.paths.scratchpads,
          recentRepositories: recentRepositories(db, { reference: clock() }),
          agent: config.agent,
          panels: context.policy.defaultPanels(),
          providers: context.policy.capabilities().providers,
        });
      }
      if (req.method === 'GET' && parts[0] === 'fw' && parts.length <= 2) {
        const result = operations.list({
          id: parts[1] || 'all',
          type: url.searchParams.get('type') || undefined,
          page: url.searchParams.get('page') || undefined,
          perpage: url.searchParams.get('perpage') || undefined,
          status: url.searchParams.get('status') || undefined,
        }, operationOptions());
        json(res, 200, result);
        scheduleGitRefresh(result.items);
        return;
      }
      if (req.method === 'POST' && parts[0] === 'fw' && parts.length === 1) {
        const body = await jsonBody(req);
        const intent = { kind: 'create-repo', body };
        return json(res, 202, { job: context.jobs.submit(intent, { idempotencyKey: body.idempotencyKey }) });
      }
      if (req.method === 'POST' && parts[0] === 'fw' && parts[1] === 'scratchpad' && parts.length === 2) {
        const body = await jsonBody(req);
        if (body.async === true || body.idempotencyKey) return json(res, 202, { job: context.jobs.submit({ kind: 'create-scratchpad', body }, { idempotencyKey: body.idempotencyKey }) });
        context.assertMutationAvailable();
        const result = operations.createScratchpad(body, operationOptions());
        result.workstream = await refreshGitBeforeResponse(result.workstream);
        broadcastChanges();
        setBrowserWorkspaceOpen(
          result.workstream.id,
          true,
          result.browserWorkspace.panels,
        );
        json(res, 201, result);
        return;
      }
      if (req.method === 'POST' && parts[0] === 'fw' && parts.length === 3) {
        const body = await jsonBody(req);
        const actionTarget = context.resolveTarget(parts[1]);
        const selected = actionTarget.kind === 'session' ? db.prepare('SELECT source FROM workstreams WHERE uuid=?').get(actionTarget.id) : null;
        const requiresJob = selected && selected.source !== 'scratch' && (parts[2] === 'resume' || (['archive', 'close'].includes(parts[2]) && (body.remove || body.discard || body.retention === 'automatic') && !body.keep));
        if (body.async === true || requiresJob) {
          const intent = { kind: 'action', target: parts[1], command: parts[2], body };
          return json(res, 202, { job: context.jobs.submit(intent, { idempotencyKey: body.idempotencyKey }) });
        }
        context.assertMutationAvailable();
        const target = context.resolveTarget(parts[1]);
        const ownerId = context.ownerId(target);
        if (['pause', 'resume', 'archive', 'close', 'agent-set', 'terminal-reset'].includes(parts[2])) {
          context.assertTerminalOwnership();
        }
        const result = operations.execute(target, parts[2], body, operationOptions());
        completeAction(result, target, parts[2]);
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
      if (status === 500) process.stderr.write(`fritzworks API: ${error.stack || error}\n`);
    });
  });

  server.on('upgrade', (req, socket, head) => {
    let requestUrl;
    try { requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`); }
    catch { socket.destroy(); return; }
    if (!loopbackHostname(requestUrl.hostname)) { socket.destroy(); return; }
    const expectedInstance = requestUrl.searchParams.get('instance');
    if (expectedInstance && expectedInstance !== context.instanceId) {
      socket.write('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');
      socket.destroy(); return;
    }
    const key = req.headers['sec-websocket-key'];
    const origin = req.headers.origin;
    let originAllowed = true;
    if (typeof origin === 'string') {
      try {
        const originUrl = new URL(origin);
        originAllowed = ['http:', 'https:'].includes(originUrl.protocol) && loopbackHostname(originUrl.hostname);
      } catch { originAllowed = false; }
    }
    const terminalUpgrade = requestUrl.pathname === '/fw/terminal';
    const eventUpgrade = requestUrl.pathname === '/fw/events';
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
        context.assertTerminalOwnership();
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
        const capabilities = context.policy.capabilities();
        const feature = terminalRole === 'agent'
          ? capabilities.providers.find((provider) => provider.id === (workstream?.agent || config.agent))
          : capabilities.commands[terminalRole === 'editor' ? 'editor' : 'shell'];
        if (!feature?.available) throw new ApiError(409, feature?.reason || 'terminal command is unavailable');
        if (!capabilities.commands.zellij.available) throw new ApiError(409, capabilities.commands.zellij.reason);
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
          ...(terminalSessionId ? Object.entries(context.hooks.environment(terminalSessionId, terminalRole === 'agent' ? workstream.agent : 'shell', identity)).map(([key, value]) => `${key}=${value}`) : []),
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
        if (status === 500) process.stderr.write(`fritzworks terminal: ${error.message}\n`);
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
      socket.on('fw-close-frame', disposeEventClient);
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
    socket.on('fw-close-frame', disposeTerminal);
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
      process.stderr.write(`fritzworks API poll: ${error.message}\n`);
    }
  }, pollInterval) : null;
  timer?.unref();

  return {
    server,
    context,
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
      if (!suppliedContext) await context.close();
      else await context.jobs?.close();
      context.publish = previousPublish;

    },
  };
}
