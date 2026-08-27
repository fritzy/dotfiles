// Zellij integration for configurable workstream tabs.
//
// Shared by the CLI and the MCP server. Like core.js, this writes diagnostics to
// stderr only (never stdout) so it's safe to use from the stdio MCP server whose
// stdout carries the JSON-RPC stream. Functions throw Error on failure rather than
// exiting, so callers decide how to surface the problem.

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { AGENT_PROVIDERS, CONFIG, PANEL_ROLES } from './config.js';
import { WS_SESSION, computeTabName, isScratch } from './core.js';

const progress = (msg) => process.stderr.write(`${msg}\n`);

export const inZellij = () => Boolean(process.env.ZELLIJ);

function zellij(args, opts = {}) {
  return spawnSync('zellij', args, { encoding: 'utf8', ...opts });
}

function detachedZellij(args, opts = {}) {
  const env = { ...process.env };
  delete env.ZELLIJ;
  delete env.ZELLIJ_PANE_ID;
  delete env.ZELLIJ_SESSION_NAME;
  return zellij(args, { ...opts, env });
}

const lines = (value) => String(value || '').split('\n').map((line) => line.trim()).filter(Boolean);
const regexEscape = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function sessionNotFound(output, session) {
  return new RegExp(`session ["']?${regexEscape(session)}["']? not found`, 'i')
    .test(stripVTControlCharacters(output));
}

function activeSessions(run = zellij) {
  const result = run(['list-sessions', '--no-formatting']);
  if (result.error) throw new Error(`cannot query Zellij sessions: ${result.error.message}`);
  if (result.status !== 0) {
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (/no active .*sessions?/i.test(output)) return [];
    throw new Error(`cannot query Zellij sessions${output.trim() ? `: ${output.trim()}` : ''}`);
  }
  return lines(result.stdout)
    .filter((line) => !/\(EXITED\b/i.test(line))
    .map((line) => line.replace(/\s+\[Created\b.*$/, '').trim())
    .filter(Boolean);
}

function sessionHasClients(session, run) {
  const result = run(['--session', session, 'action', 'list-clients']);
  if (result.error) return false;
  const output = zellijOutput(result);
  if (sessionNotFound(output, session) || result.status !== 0) return false;
  return lines(stripVTControlCharacters(result.stdout))
    .some((line) => !/^CLIENT_ID(?:\s|$)/.test(line));
}

function attachedSession(sessions, run, preferred = WS_SESSION) {
  const inherited = process.env.ZELLIJ_SESSION_NAME;
  const candidates = [...new Set([inherited, preferred, ...sessions].filter(Boolean))];
  return candidates.find((session) => sessions.includes(session) && sessionHasClients(session, run));
}

function sessionCandidates(run, explicitSession, attachedFirst = false, preferred = WS_SESSION) {
  if (explicitSession) return [explicitSession];
  const sessions = activeSessions(run);
  const inherited = process.env.ZELLIJ_SESSION_NAME;
  const first = attachedFirst
    ? attachedSession(sessions, run, preferred)
    : [inherited, preferred].find((session) => session && sessions.includes(session));
  return [...new Set([first, ...sessions].filter(Boolean))];
}

// Collect tab names across every running Zellij session. The DB does not record
// which session a tab was opened in, so checking only the configured `ws` session
// would incorrectly pause workstreams opened from another existing session.
export function openTabNames({ run = zellij } = {}) {
  const sessions = activeSessions(run);
  const names = new Set();
  const failed = [];
  for (const session of sessions) {
    const result = run(['--session', session, 'action', 'query-tab-names']);
    if (result.error) throw new Error(`cannot query Zellij session "${session}": ${result.error.message}`);
    if (result.status !== 0) {
      const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
      // Zellij's session list can briefly retain an entry after that session has
      // vanished. The targeted query is authoritative when it says exactly that
      // session no longer exists, even if a second list is also stale.
      if (!sessionNotFound(output, session)) failed.push({ session, output });
      continue;
    }
    for (const name of lines(result.stdout)) names.add(name);
  }

  if (failed.length) {
    // A session can legitimately close between list-sessions and query-tab-names.
    // Retry the session list and only fail if an unqueryable session is still live.
    const stillRunning = new Set(activeSessions(run));
    const persistent = failed.find(({ session }) => stillRunning.has(session));
    if (persistent) {
      throw new Error(`cannot query tabs for Zellij session "${persistent.session}"`
        + (persistent.output ? `: ${persistent.output}` : ''));
    }
  }
  return [...names];
}

function tabNames() {
  const r = zellij(['action', 'query-tab-names']);
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

// Non-plugin panes across the whole session, with the tab each belongs to and
// its assigned name (`title`, from the layout's `pane name="..."`). Used to
// check whether e.g. the "nvim" pane in a given tab is currently open.
function panes(run = zellij) {
  const r = run(['action', 'list-panes', '--json', '--all']);
  if (r.status !== 0 || !r.stdout) return [];
  try {
    return JSON.parse(r.stdout).filter((p) => !p.is_plugin);
  } catch {
    return [];
  }
}

function paneTitles(kind) {
  if (kind === 'shell') return ['shell', 'zsh'];
  if (kind === 'editor') return ['editor', 'nvim'];
  if (kind === 'agent') return ['agent', 'claude', 'codex'];
  return [kind];
}

function paneFor(paneList, tabName, kind) {
  const titles = paneTitles(kind);
  return paneList.find((pane) => pane.tab_name === tabName && titles.includes(pane.title));
}

function findPane(tabName, kind, run = zellij) {
  return paneFor(panes(run), tabName, kind);
}

const shellQuote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;
const shellCommand = (args) => args.map(shellQuote).join(' ');
const kdlString = (value) => JSON.stringify(String(value));

function providerFor(opts, config = CONFIG) {
  const provider = opts.agent || config.agent;
  if (!AGENT_PROVIDERS.includes(provider)) {
    throw new Error(`unknown agent "${provider}" (expected claude or codex)`);
  }
  return provider;
}

function modelFor(row, provider, opts, config = CONFIG) {
  if (opts.model !== undefined) return opts.model || null;
  const lightweight = isScratch(row) || Boolean(config.locations?.[String(row.id)]);
  return config.models[provider][lightweight ? 'scratch' : 'default'];
}

// Produce the interactive agent command used by both full layouts and panes
// opened later. Claude and Codex both resume the most recent session scoped to
// the pane's cwd, then fall back to a new session when no prior one exists.
export function agentCommand(row, opts = {}, config = CONFIG) {
  const provider = providerFor(opts, config);
  const model = modelFor(row, provider, opts, config);
  const base = [...config.commands[provider], ...(model ? ['--model', model] : [])];
  const trackedCommand = (args) => `AI_WORKSTREAM_ID=${shellQuote(String(row.id))} ${shellCommand(args)}`;
  if (opts.seed) {
    return trackedCommand([...base, `Read the seed document at ${opts.seed} and do what it says.`]);
  }
  const resume = provider === 'claude'
    ? [...base, '--continue']
    : [...base, 'resume', '--last'];
  return `${trackedCommand(resume)} || ${trackedCommand(base)}`;
}

function commandPane(name, command) {
  const [program, ...args] = command;
  const argsBlock = args.length ? ` {\n                args ${args.map(kdlString).join(' ')}\n            }` : '';
  return `pane name=${kdlString(name)} command=${kdlString(program)}${argsBlock}`;
}

function selectedPanels(opts, config = CONFIG) {
  let selected = opts.panels || config.panels;
  if (opts.noEditor || opts.noVim) selected = selected.filter((panel) => panel !== 'editor');
  const panels = [...new Set(selected)];
  const invalid = panels.find((panel) => !PANEL_ROLES.includes(panel));
  if (invalid) throw new Error(`unknown panel "${invalid}" (expected shell, editor, or agent)`);
  if (panels.length === 0) throw new Error('a tab needs at least one panel');
  return panels;
}

function renderPane(role, row, opts, config = CONFIG) {
  if (role === 'shell') return commandPane('shell', config.commands.shell);
  if (role === 'editor') {
    return commandPane('editor', [
      ...config.commands.editor,
      ...(opts.editorFile || opts.nvimFile ? [opts.editorFile || opts.nvimFile] : []),
    ]);
  }
  return commandPane('agent', ['sh', '-c', agentCommand(row, opts, config)]);
}

function panelCommand(row, kind, opts = {}, config = CONFIG) {
  if (kind === 'shell') return { name: 'shell', command: config.commands.shell };
  if (kind === 'editor') {
    return {
      name: 'editor',
      command: [...config.commands.editor, ...(opts.editorFile || opts.nvimFile ? [opts.editorFile || opts.nvimFile] : [])],
    };
  }
  return { name: 'agent', command: ['sh', '-c', agentCommand(row, opts, config)] };
}

export function renderLayout(row, opts = {}, config = CONFIG) {
  const tabName = computeTabName(row);
  const [initialPanel] = selectedPanels(opts, config);
  // Include the tab-bar plugin pane explicitly: a layout passed to `new-tab`
  // replaces that tab's whole template, so without it this tab would lose the
  // top tab row that default tabs show. Only the first terminal belongs in this
  // KDL tree. Zellij 0.44 corrupts sibling terminals when one pane is removed
  // from a nested container below a fixed one-row plugin; the remaining panels
  // are therefore added with `new-pane` after the tab exists.
  return `layout {
    tab name=${kdlString(tabName)} cwd=${kdlString(row.path)} {
        pane size=1 borderless=true {
            plugin location="zellij:tab-bar"
        }
        ${renderPane(initialPanel, row, opts, config)}
    }
}
`;
}

function renderCompleteLayout(row, opts = {}, config = CONFIG) {
  const tabName = computeTabName(row);
  const renderedPanels = selectedPanels(opts, config)
    .map((role) => `            ${renderPane(role, row, opts, config)}`)
    .join('\n');
  return `layout {
    tab name=${kdlString(tabName)} cwd=${kdlString(row.path)} {
        pane size=1 borderless=true {
            plugin location="zellij:tab-bar"
        }
        pane split_direction="vertical" {
${renderedPanels}
        }
    }
}
`;
}

function writeLayout(row, opts = {}, config = CONFIG, complete = false) {
  const file = join(tmpdir(), `ws-layout-${process.pid}-${row.id}.kdl`);
  const kdl = complete ? renderCompleteLayout(row, opts, config) : renderLayout(row, opts, config);
  writeFileSync(file, kdl);
  return file;
}

function zellijOutput(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`.trim();
}

function requireZellij(result, action) {
  if (result.error) throw new Error(`${action}: ${result.error.message}`);
  if (result.status !== 0) {
    const output = zellijOutput(result);
    throw new Error(`${action}${output ? `: ${output}` : ''}`);
  }
  return result;
}

function createdTabId(result) {
  const output = stripVTControlCharacters(String(result.stdout || '')).trim();
  return /^\d+$/.test(output) ? Number(output) : null;
}

function createdPaneId(result) {
  const output = stripVTControlCharacters(String(result.stdout || '')).trim();
  const match = output.match(/^(?:terminal_)?(\d+)$/);
  return match ? `terminal_${match[1]}` : null;
}

function pinPaneName(result, name, run, prefix = []) {
  const paneId = createdPaneId(result);
  if (!paneId) return;
  requireZellij(
    run([...prefix, 'action', 'rename-pane', '--pane-id', paneId, name]),
    `failed to pin Zellij pane name "${name}"`,
  );
}

function addRemainingPanels(
  row,
  opts,
  tabId,
  { run = zellij, session, config = CONFIG } = {},
) {
  const prefix = session ? ['--session', session] : [];
  for (const kind of selectedPanels(opts, config).slice(1)) {
    const { name, command } = panelCommand(row, kind, opts, config);
    const opened = requireZellij(
      run([
        ...prefix, 'action', 'new-pane', '--direction', 'right', '--tab-id', String(tabId),
        '--name', name, '--cwd', row.path, '--', ...command,
      ]),
      `failed to open "${kind}" panel in Zellij tab "${computeTabName(row)}"`,
    );
    // `new-pane --name` supplies an initial title, but applications can still
    // replace that title with OSC sequences. An explicit rename sets Zellij's
    // persistent pane name, matching the fixed `name=` behavior of KDL layouts.
    pinPaneName(opened, name, run, prefix);
  }
}

// Create or focus a workstream tab in the configured shared session without
// attaching the calling process. This is safe for the background web daemon and
// deliberately ignores any stale ZELLIJ environment it may have inherited.
export function openTabInSession(
  row,
  opts = {},
  { run = detachedZellij, session, config = CONFIG } = {},
) {
  const tabName = computeTabName(row);
  const file = writeLayout(row, opts, config);
  const sessions = activeSessions(run);
  const targetSession = session || attachedSession(sessions, run) || WS_SESSION;

  if (sessions.includes(targetSession)) {
    const queried = run(['--session', targetSession, 'action', 'query-tab-names']);
    if (queried.error) throw new Error(`cannot query Zellij session "${targetSession}": ${queried.error.message}`);
    if (queried.status === 0) {
      const existingTabs = lines(queried.stdout);
      const created = !existingTabs.includes(tabName);
      if (created) {
        const newTab = requireZellij(
          run(['--session', targetSession, 'action', 'new-tab', '--layout', file]),
          `failed to create Zellij tab "${tabName}"`,
        );
        const tabId = createdTabId(newTab)
          ?? panesInSession(targetSession, run).find((pane) => pane.tab_name === tabName)?.tab_id;
        if (tabId === undefined || tabId === null) {
          throw new Error(`cannot determine id of new Zellij tab "${tabName}"`);
        }
        addRemainingPanels(row, opts, tabId, {
          run, session: targetSession, config,
        });
      }
      requireZellij(
        run(['--session', targetSession, 'action', 'go-to-tab-name', tabName]),
        `failed to focus Zellij tab "${tabName}"`,
      );
      return { tabName, session: targetSession, created, sessionCreated: false };
    }
    const output = zellijOutput(queried);
    if (!sessionNotFound(output, targetSession)) {
      throw new Error(`cannot query tabs for Zellij session "${targetSession}"${output ? `: ${output}` : ''}`);
    }
  }

  requireZellij(
    run(['attach', '--create-background', targetSession]),
    `failed to start Zellij session "${targetSession}"`,
  );
  // Zellij 0.44 ignores `new-pane` while a background session has no attached
  // client. Initialize that one special case in a single layout; once a client
  // is attached, all subsequently opened tabs use the safe incremental topology.
  const completeFile = writeLayout(row, opts, config, true);
  requireZellij(
    run(['--session', targetSession, 'action', 'override-layout', completeFile]),
    `failed to lay out Zellij tab "${tabName}"`,
  );
  return { tabName, session: targetSession, created: true, sessionCreated: true };
}

export function closeTabInSession(row, { run = detachedZellij, session } = {}) {
  const tabName = computeTabName(row);
  const sessions = session ? [session] : activeSessions(run);
  let closed = false;
  for (const candidate of sessions) {
    const tabPane = panesInSession(candidate, run).find((pane) => pane.tab_name === tabName);
    if (!tabPane) continue;
    requireZellij(
      run(['--session', candidate, 'action', 'close-tab', '--tab-id', String(tabPane.tab_id)]),
      `failed to close Zellij tab "${tabName}"`,
    );
    closed = true;
  }
  return closed;
}

function panesInSession(session, run) {
  const result = run(['--session', session, 'action', 'list-panes', '--json', '--all']);
  if (result.error) throw new Error(`cannot query panes in Zellij session "${session}": ${result.error.message}`);
  const output = zellijOutput(result);
  // Zellij 0.44 can print this diagnostic and still exit zero for an exited,
  // resurrectable session returned by list-sessions.
  if (sessionNotFound(output, session)) return [];
  if (result.status !== 0) {
    throw new Error(`cannot query panes in Zellij session "${session}"${output ? `: ${output}` : ''}`);
  }
  try {
    return JSON.parse(stripVTControlCharacters(result.stdout || '[]')).filter((pane) => !pane.is_plugin);
  } catch (error) {
    throw new Error(`cannot parse panes in Zellij session "${session}": ${error.message}`);
  }
}

export function panelStatesInSession(row, { run = detachedZellij, session } = {}) {
  const tabName = computeTabName(row);
  let tabPanes = [];
  for (const candidate of sessionCandidates(run, session)) {
    tabPanes = panesInSession(candidate, run).filter((pane) => pane.tab_name === tabName);
    if (tabPanes.length) break;
  }
  return {
    tabOpen: tabPanes.length > 0,
    ...Object.fromEntries(PANEL_ROLES.map((kind) => [kind, Boolean(paneFor(tabPanes, tabName, kind))])),
  };
}

export function focusAgentInSession(
  row,
  { run = detachedZellij, preferredSession = WS_SESSION } = {},
) {
  const tabName = computeTabName(row);
  const sessions = sessionCandidates(run, undefined, true, preferredSession);
  let tabFound = false;
  for (const session of sessions) {
    const paneList = panesInSession(session, run);
    if (paneList.some((pane) => pane.tab_name === tabName)) tabFound = true;
    const pane = paneFor(paneList, tabName, 'agent');
    if (!pane) continue;
    requireZellij(
      run(['--session', session, 'action', 'go-to-tab-name', tabName]),
      `failed to focus Zellij tab "${tabName}"`,
    );
    const paneId = `terminal_${pane.id}`;
    const focused = run(['--session', session, 'action', 'focus-pane-id', paneId]);
    if (!/pane\s+\S+\s+is already focused/i.test(stripVTControlCharacters(zellijOutput(focused)))) {
      requireZellij(focused, `failed to focus agent pane in "${tabName}"`);
    }
    return { session, tabName, paneId };
  }
  if (tabFound) throw new Error(`tab "${tabName}" has no agent panel`);
  throw new Error(`tab "${tabName}" is not open`);
}

export function togglePanelInSession(
  row,
  kind,
  opts = {},
  { run = detachedZellij, session, config = CONFIG } = {},
) {
  if (!PANEL_ROLES.includes(kind)) throw new Error(`unknown panel "${kind}"`);
  const tabName = computeTabName(row);
  let targetSession;
  let tabPanes = [];
  for (const candidate of sessionCandidates(run, session, true)) {
    tabPanes = panesInSession(candidate, run).filter((pane) => pane.tab_name === tabName);
    if (tabPanes.length) {
      targetSession = candidate;
      break;
    }
  }
  if (tabPanes.length === 0) throw new Error(`tab "${tabName}" is not open`);
  const existing = paneFor(tabPanes, tabName, kind);
  if (existing) {
    if (tabPanes.length === 1) throw new Error('cannot close the last panel in a Zellij tab');
    requireZellij(
      run(['--session', targetSession, 'action', 'close-pane', '--pane-id', `terminal_${existing.id}`]),
      `failed to close "${kind}" panel`,
    );
    return { panel: kind, open: false };
  }

  const { name, command } = panelCommand(row, kind, opts, config);
  const opened = requireZellij(
    run([
      '--session', targetSession, 'action', 'new-pane', '--direction', 'right',
      '--tab-id', String(tabPanes[0].tab_id), '--name', name, '--cwd', row.path,
      '--', ...command,
    ]),
    `failed to open "${kind}" panel`,
  );
  pinPaneName(opened, name, run, ['--session', targetSession]);
  return { panel: kind, open: true };
}

export function replaceAgentInSession(
  row,
  agent,
  opts = {},
  { run = detachedZellij, session, config = CONFIG } = {},
) {
  if (!AGENT_PROVIDERS.includes(agent)) {
    throw new Error(`unknown agent "${agent}" (expected claude or codex)`);
  }
  const tabName = computeTabName(row);
  let targetSession;
  let tabPanes = [];
  for (const candidate of sessionCandidates(run, session, true)) {
    tabPanes = panesInSession(candidate, run).filter((pane) => pane.tab_name === tabName);
    if (tabPanes.length) {
      targetSession = candidate;
      break;
    }
  }
  if (tabPanes.length === 0) return { agent, tabOpen: false, panelOpen: false, replaced: false };
  const existing = paneFor(tabPanes, tabName, 'agent');
  if (!existing) return { agent, tabOpen: true, panelOpen: false, replaced: false };

  const { name, command } = panelCommand(row, 'agent', { ...opts, agent }, config);
  const prefix = ['--session', targetSession];
  const openReplacement = () => {
    const opened = requireZellij(
      run([
        ...prefix, 'action', 'new-pane', '--direction', 'right',
        '--tab-id', String(tabPanes[0].tab_id), '--name', name, '--cwd', row.path,
        '--', ...command,
      ]),
      `failed to start ${agent} agent panel`,
    );
    pinPaneName(opened, name, run, prefix);
    return createdPaneId(opened);
  };
  const closeExisting = () => requireZellij(
    run([...prefix, 'action', 'close-pane', '--pane-id', `terminal_${existing.id}`]),
    'failed to stop existing agent panel',
  );

  // Closing a tab's only terminal also closes the tab, so that edge case must
  // create the replacement first. Normal multi-panel workstreams stop the old
  // provider before starting the new provider.
  let paneId;
  if (tabPanes.length === 1) {
    paneId = openReplacement();
    closeExisting();
  } else {
    closeExisting();
    paneId = openReplacement();
  }
  return { agent, tabOpen: true, panelOpen: true, replaced: true, paneId };
}

// Open (or focus) the workstream's tab. Inside a Zellij session this adds/focuses
// the tab in place; from outside it attaches to (or starts) the WS_SESSION session.
export function openTab(row, opts = {}) {
  const tabName = computeTabName(row);

  // Inside a session already: add (or focus) the tab in that session. These
  // `zellij action` calls capture their output (the default) rather than inheriting
  // stdio: when openTab runs from the MCP server, stdout is the JSON-RPC stream and
  // any child output on it would corrupt the protocol. They talk to the running
  // session over its socket, so no TTY is needed.
  if (inZellij()) {
    const file = writeLayout(row, opts);
    if (tabNames().includes(tabName)) {
      zellij(['action', 'go-to-tab-name', tabName]);
      return;
    }
    const r = zellij(['action', 'new-tab', '--layout', file]);
    if (r.status !== 0) throw new Error('failed to create Zellij tab');
    const tabId = createdTabId(r) ?? panes().find((pane) => pane.tab_name === tabName)?.tab_id;
    if (tabId === undefined || tabId === null) throw new Error('cannot determine id of new Zellij tab');
    addRemainingPanels(row, opts, tabId);
    zellij(['action', 'go-to-tab-name', tabName]);
    return;
  }

  // Outside any session, create/focus without a TTY first, then attach this
  // interactive caller. The web API uses openTabInSession directly and stops
  // before this attach step.
  const opened = openTabInSession(row, opts);
  progress(`${opened.sessionCreated ? 'Started' : 'Attaching to'} Zellij session "${opened.session}" for "${tabName}"...`);
  spawnSync('zellij', ['attach', opened.session], { stdio: 'inherit' });
}

export function closeTab(row) {
  return closeTabInSession(row);
}

// Rename an open tab in place (e.g. after `ws rename`). No-op outside Zellij or
// if the old tab name isn't currently open. Returns whether it renamed anything.
export function renameTab(oldTabName, newTabName) {
  if (!inZellij() || oldTabName === newTabName || !tabNames().includes(oldTabName)) return false;
  zellij(['action', 'go-to-tab-name', oldTabName]);
  const r = zellij(['action', 'rename-tab', newTabName]);
  return r.status === 0;
}

// Add the named panel role (shell | editor | agent) to a workstream's tab if it isn't
// already there. Requires the tab to already be open — this never creates a
// tab, only adds a pane to one that exists. Returns whether it opened one.
export function openPane(row, kind, opts = {}) {
  if (!PANEL_ROLES.includes(kind)) throw new Error(`unknown panel "${kind}"`);
  const tabName = computeTabName(row);
  if (!tabNames().includes(tabName)) {
    throw new Error(`tab "${tabName}" isn't open — open it first with ws join/resume`);
  }
  zellij(['action', 'go-to-tab-name', tabName]);
  if (findPane(tabName, kind)) return false;

  const { name, command } = panelCommand(row, kind, opts);
  const args = ['action', 'new-pane', '--direction', 'right', '--name', name, '--cwd', row.path, '--', ...command];
  const r = zellij(args);
  if (r.status !== 0) throw new Error(`failed to open "${kind}" pane`);
  pinPaneName(r, name, zellij);
  return true;
}

// Close the named panel role (shell | editor | agent) in a workstream's tab if it's
// open. Never touches any other pane. Returns whether it closed one.
export function closePane(row, kind, { run = zellij } = {}) {
  const tabName = computeTabName(row);
  const tabPanes = panes(run).filter((candidate) => candidate.tab_name === tabName);
  const pane = paneFor(tabPanes, tabName, kind);
  if (!pane) return false;
  if (tabPanes.length === 1) throw new Error('cannot close the last panel in a Zellij tab');
  const r = run(['action', 'close-pane', '--pane-id', `terminal_${pane.id}`]);
  return r.status === 0;
}
