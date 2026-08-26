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

import { AGENT_PROVIDERS, CONFIG, PANEL_ROLES } from './config.js';
import { WS_SESSION, computeTabName, isScratch } from './core.js';

const progress = (msg) => process.stderr.write(`${msg}\n`);

export const inZellij = () => Boolean(process.env.ZELLIJ);

function zellij(args, opts = {}) {
  return spawnSync('zellij', args, { encoding: 'utf8', ...opts });
}

function tabNames() {
  const r = zellij(['action', 'query-tab-names']);
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

// Non-plugin panes across the whole session, with the tab each belongs to and
// its assigned name (`title`, from the layout's `pane name="..."`). Used to
// check whether e.g. the "nvim" pane in a given tab is currently open.
function panes() {
  const r = zellij(['action', 'list-panes', '--json', '--all']);
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

function findPane(tabName, kind) {
  const titles = paneTitles(kind);
  return panes().find((pane) => pane.tab_name === tabName && titles.includes(pane.title));
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
  const lightweight = isScratch(row) || row.id === 'dotfiles' || row.id === 'notes';
  return config.models[provider][lightweight ? 'scratch' : 'default'];
}

// Produce the interactive agent command used by both full layouts and panes
// opened later. Claude and Codex both resume the most recent session scoped to
// the pane's cwd, then fall back to a new session when no prior one exists.
export function agentCommand(row, opts = {}, config = CONFIG) {
  const provider = providerFor(opts, config);
  const model = modelFor(row, provider, opts, config);
  const base = [...config.commands[provider], ...(model ? ['--model', model] : [])];
  if (opts.seed) {
    return shellCommand([...base, `Read the seed document at ${opts.seed} and do what it says.`]);
  }
  const resume = provider === 'claude'
    ? [...base, '--continue']
    : [...base, 'resume', '--last'];
  return `${shellCommand(resume)} || ${shellCommand(base)}`;
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
  const provider = providerFor(opts, config);
  return commandPane(provider, ['sh', '-c', agentCommand(row, opts, config)]);
}

// Names of sessions that are currently running (excludes EXITED/resurrectable ones).
function runningSessions() {
  const r = zellij(['list-sessions', '--no-formatting']);
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout.split('\n')
    .filter((l) => l.trim() && !l.includes('EXITED'))
    .map((l) => l.trim().split(/\s+/)[0]);
}

export function renderLayout(row, opts = {}, config = CONFIG) {
  const tabName = computeTabName(row);
  const renderedPanels = selectedPanels(opts, config)
    .map((role) => `            ${renderPane(role, row, opts, config)}`)
    .join('\n');
  // Include the tab-bar plugin pane explicitly: a layout passed to `new-tab`
  // replaces that tab's whole template, so without it this tab would lose the
  // top tab row that default tabs show. We deliberately omit the bottom
  // status-bar (shortcut) pane to keep the tab clean.
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

function writeLayout(row, opts = {}) {
  const file = join(tmpdir(), `ws-layout-${process.pid}-${row.id}.kdl`);
  const kdl = renderLayout(row, opts);
  writeFileSync(file, kdl);
  return file;
}

// Open (or focus) the workstream's tab. Inside a Zellij session this adds/focuses
// the tab in place; from outside it attaches to (or starts) the WS_SESSION session.
export function openTab(row, opts = {}) {
  const tabName = computeTabName(row);
  const file = writeLayout(row, opts);

  // Inside a session already: add (or focus) the tab in that session. These
  // `zellij action` calls capture their output (the default) rather than inheriting
  // stdio: when openTab runs from the MCP server, stdout is the JSON-RPC stream and
  // any child output on it would corrupt the protocol. They talk to the running
  // session over its socket, so no TTY is needed.
  if (inZellij()) {
    if (tabNames().includes(tabName)) {
      zellij(['action', 'go-to-tab-name', tabName]);
      return;
    }
    const r = zellij(['action', 'new-tab', '--layout', file]);
    if (r.status !== 0) throw new Error('failed to create Zellij tab');
    zellij(['action', 'go-to-tab-name', tabName]);
    return;
  }

  // Outside any session: land the user in the ws session with this tab open.
  // `--layout` only *adds a tab* and errors ("There is no active session!") if the
  // session doesn't exist yet, so when it's not running we create it with
  // `--new-session-with-layout` (which creates the session and attaches in one go).
  if (runningSessions().includes(WS_SESSION)) {
    progress(`Attaching to Zellij session "${WS_SESSION}" for "${tabName}"...`);
    // Add the tab to the running session, then attach so the user lands in it.
    zellij(['--session', WS_SESSION, 'action', 'new-tab', '--layout', file]);
    spawnSync('zellij', ['attach', WS_SESSION], { stdio: 'inherit' });
  } else {
    progress(`Starting Zellij session "${WS_SESSION}" for "${tabName}"...`);
    // Create the session detached first so it inherits Zellij's built-in default
    // layout — and with it a proper new-tab template (tab-bar + status-bar) for the
    // tabs the user later opens with Ctrl-t n. Starting the session *from* our
    // layout file (--new-session-with-layout) instead leaves those new tabs blank,
    // since the file defines no default tab template. We then reshape the session's
    // single placeholder tab into our (deliberately status-bar-less) ws tab with
    // `override-layout`, which — unlike a tab born from the startup layout — is used
    // as-is rather than wrapped by the default template.
    zellij(['attach', '--create-background', WS_SESSION]);
    const r = zellij(['--session', WS_SESSION, 'action', 'override-layout', file]);
    if (r.status !== 0) throw new Error('failed to lay out Zellij tab');
    spawnSync('zellij', ['attach', WS_SESSION], { stdio: 'inherit' });
  }
}

export function closeTab(row) {
  const tabName = computeTabName(row);
  if (inZellij() && tabNames().includes(tabName)) {
    zellij(['action', 'go-to-tab-name', tabName]);
    zellij(['action', 'close-tab']);
  }
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

  const provider = kind === 'agent' ? providerFor(opts) : null;
  const name = provider || kind;
  const command = kind === 'shell'
    ? CONFIG.commands.shell
    : kind === 'editor'
      ? [...CONFIG.commands.editor, ...(opts.editorFile || opts.nvimFile ? [opts.editorFile || opts.nvimFile] : [])]
      : ['sh', '-c', agentCommand(row, opts)];
  const args = ['action', 'new-pane', '--direction', 'right', '--name', name, '--cwd', row.path, '--', ...command];
  const r = zellij(args);
  if (r.status !== 0) throw new Error(`failed to open "${kind}" pane`);
  return true;
}

// Close the named panel role (shell | editor | agent) in a workstream's tab if it's
// open. Never touches any other pane. Returns whether it closed one.
export function closePane(row, kind) {
  const tabName = computeTabName(row);
  const pane = findPane(tabName, kind);
  if (!pane) return false;
  const r = zellij(['action', 'close-pane', '--pane-id', String(pane.id)]);
  return r.status === 0;
}
