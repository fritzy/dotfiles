#!/usr/bin/env -S node --no-warnings
// fw CLI — command-line client for the FritzWorks workstream service.
// Domain decisions and persistence belong to the daemon.

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

import { CONFIG } from './lib/config.js';
import {
  daemonFiles, daemonStatus, openWebPage, runForeground, startDaemon, stopDaemon,
} from './lib/daemon.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { requestDaemonService as localRequest, listWorkstreams, resolveContext, repositorySelector } from './lib/client.js';
const clientScope = new AsyncLocalStorage();
const requestLocalService = async (path, options = {}) => {
  const scope = clientScope.getStore() || {};
  const selected = scope.daemon ? { daemon: scope.daemon } : {};
  if (scope.daemon && scope.daemon !== 'local' && path === '/context/resolve') options = { ...options, body: { ...options.body, cwd: undefined, sessionId: undefined, remote: true } };
  const binding = scope.bindings?.get(scope.daemon || 'local');
  const service = await (scope.request || localRequest)(path, { ...options, ...binding, ...selected, ...(scope.acknowledgeInstance ? { acknowledgeInstance: scope.acknowledgeInstance } : {}), ...(scope.expectedInstance ? { expectedInstance: scope.expectedInstance } : {}), ...(scope.config ? { config: scope.config } : {}) });
  if (!binding && service.daemon.instanceId) scope.bindings?.set(scope.daemon || 'local', { expectedInstance: service.daemon.instanceId, expectedEndpoint: service.daemon.url });
  return service;
};
const workstreamCommand = (id, command, body = {}) => requestLocalService(`/fw/${encodeURIComponent(id)}/${command}`, { method: 'POST', body });
const isScratch = (row) => row.type === 'scratchpad' || row.scratch === true;
import {
  agentHookStatus,
  installAgentHooks,
  installShellHooks,
  uninstallAgentHooks,
  uninstallShellHooks,
  recordAgentHook,
  recordShellHook,
  shellHookStatus,
} from './lib/hooks.js';

import { diagnose } from './lib/doctor.js';
import { manageSkills, setupCheckout } from './lib/setup.js';

const PACKAGE = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
export const VERSION = PACKAGE.version;

// ---------------------------------------------------------------- utilities

const die = (msg) => { console.error(`fw: ${msg}`); process.exit(1); };

async function prompt(question, fallback) {
  if (clientScope.getStore()?.prompt) return clientScope.getStore().prompt(question, fallback);
  if (!stdin.isTTY) {
    const error = new Error(`interactive input required: ${question.trim()}; pass an explicit selector or reviewed --preview-revision with --confirm`);
    error.code = 'input_required';
    throw error;
  }
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = (await rl.question(question)).trim();
    return answer || fallback || '';
  } finally {
    rl.close();
  }
}

async function confirm(question) {
  const answer = (await prompt(`${question} [y/N] `)).toLowerCase();
  return answer === 'y' || answer === 'yes';
}

// Read a `--flag value` (or `--flag=value`) option out of an argv array.
function flagValue(args, name) {
  const i = args.indexOf(name);
  if (i !== -1 && args[i + 1]) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : null;
}

// Positional args, with flags removed — including the value that follows a
// value-taking flag like `--fw X` (so it isn't mistaken for a positional).
function positionals(args, valueFlags = ['--fw', '--seed', '--parent', '--agent', '--panels', '--link', '--preview-revision', '--idempotency-key']) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (valueFlags.includes(args[i])) { i++; continue; }
    if (args[i].startsWith('--')) continue;
    out.push(args[i]);
  }
  return out;
}

function flagValues(args, name) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
      values.push(value);
      i += 1;
      continue;
    }
    if (args[i].startsWith(`${name}=`)) {
      const value = args[i].slice(name.length + 1);
      if (!value) throw new Error(`${name} requires a value`);
      values.push(value);
    }
  }
  return values;
}

function agentFlag(args) {
  const shorthands = ['claude', 'codex'].filter((name) => args.includes(`--${name}`));
  const explicit = flagValue(args, '--agent');
  if (shorthands.length > 1 || (explicit && shorthands.length && explicit !== shorthands[0])) {
    die('choose one agent: --agent claude|codex, --claude, or --codex');
  }
  const agent = explicit || shorthands[0];
  return agent;
}

function browserPanels(args) {
  const panels = flagValue(args, '--panels');
  let selected = panels
    ? panels.split(',').map((part) => part.trim()).filter(Boolean)
    : undefined;
  if (args.includes('--no-editor') || args.includes('--no-vim')) selected = ['shell', 'agent'];
  return selected;
}

function browserRequestBody(args, extra = {}) {
  const body = { ...extra };
  const idempotencyKey = flagValue(args, '--idempotency-key');
  if (idempotencyKey) body.idempotencyKey = idempotencyKey;
  const agent = agentFlag(args);
  if (agent) body.agent = agent;
  const panels = browserPanels(args);
  if (panels) body.panels = panels;
  const seedFile = flagValue(args, '--seed');
  if (seedFile) {
    if (!existsSync(seedFile)) die(`seed file not found: ${seedFile}`);
    body.seed = readFileSync(seedFile, 'utf8');
  }
  return body;
}

export function creationRequestBody(args, extra = {}) {
  const links = flagValues(args, '--link');
  return browserRequestBody(args, {
    ...extra,
    ...(links.length ? { links } : {}),
  });
}

function openedInBrowser(row, daemon) {
  console.log(`Opened FritzWorks workspace #${row.id} (${daemon.url})`);
}

async function printIssues(workstreamId) {
  const { result } = await requestLocalService(`/fw/${encodeURIComponent(workstreamId)}?status=all`);
  const issues = result.items[0]?.issues || [];
  if (issues.length === 0) { console.log('  (no issues linked)'); return; }
  for (const it of issues) console.log(`  ${String(it.id).padStart(3)}  [${it.kind}] ${it.ref}`);
}

// Resolve which workstream a command acts on, in priority order:
//   1. an explicit selector (positional arg or --fw),
//   2. the workstream whose worktree contains the current directory,
//   3. interactive pick from the list.
async function resolveTarget(selector, verb) {
  const resolved = await resolveContext({ selector, cwd: process.cwd(), sessionId: process.env.FRITZWORKS_ID }, { request: requestLocalService });
  if (resolved.result.workstream) return resolved.result.workstream;
  await cmdList([]);
  const picked = await prompt(`\nWorkstream to ${verb} (id or branch): `);
  const selected = await resolveContext({ selector: picked }, { request: requestLocalService });
  if (!selected.result.workstream) throw new Error(`no workstream matching "${picked}"`);
  return selected.result.workstream;
}

async function previewIntent(intent) {
  return (await requestLocalService('/intents/preview', { method: 'POST', body: intent })).result;
}

// ---------------------------------------------------------------- commands

async function cmdList(args) {
  const status = args.includes('--all') ? 'all' : 'active_paused';
  const { result } = await listWorkstreams(status, { request: requestLocalService });
  const rows = result.items;
  if (rows.length === 0) {
    console.log('No workstreams yet. Create one with: fw new <org/repo> <branch>');
    return;
  }
  const current = clientScope.getStore()?.daemon && clientScope.getStore().daemon !== 'local' ? null : (await resolveContext({ cwd: process.cwd(), sessionId: process.env.FRITZWORKS_ID }, { request: requestLocalService })).result.workstream;
  const fmt = (s, w) => String(s ?? '').padEnd(w);
  const useColor = process.stdout.isTTY;
  const dim = (s) => (useColor ? `\x1b[2m${s}\x1b[0m` : s);
  console.log([fmt('ID', 4), fmt('', 3), fmt('REPO', 28), fmt('BRANCH', 24), fmt('STATUS', 8), 'LAST JOINED'].join(' '));
  rows.forEach((r, i) => {
    // "▸" marks the workstream containing the current directory; ●/○ = worktree present.
    const mark = (current && String(current.id) === String(r.id) ? '▸' : ' ')
      + (r.worktreePresent ? '●' : '○');
    const last = r.lastJoined ? r.lastJoined.replace('T', ' ').slice(0, 16) : '—';
    const repoLabel = r.repo;
    const line = [
      fmt(r.id, 4), fmt(mark, 3), fmt(repoLabel, 28),
      fmt(r.branch, 24), fmt(r.status === 'closed' ? 'archived' : r.status, 8), last,
    ].join(' ');
    console.log(i % 2 === 1 ? dim(line) : line);
    const parent = r.stackedOn;
    if (parent) {
      const stackLabel = `         ↳ stacked on #${parent.id} (${parent.branch})`;
      console.log(i % 2 === 1 ? dim(stackLabel) : stackLabel);
    }
    for (const it of r.issues || []) {
      const issueLine = `         ↳ [${it.kind}] ${it.ref}`;
      console.log(i % 2 === 1 ? dim(issueLine) : issueLine);
    }
  });
}

async function panelLayout() {
  return (await requestLocalService('/panel-layout')).result;
}

async function panelMutation(path, method, body = {}) {
  const layout = await panelLayout();
  return (await requestLocalService(path, {
    method,
    body: { client: 'cli', revision: layout.revision, ...body },
  })).result;
}

async function cmdPanels() {
  const layout = await panelLayout();
  console.log(`revision ${layout.revision}${layout.activeGroupId ? ` · active ${layout.activeGroupId}` : ''}`);
  for (const group of layout.groups) {
    console.log(`${group.id}  [${group.type}] ${group.label}`);
    for (const panel of group.panels) {
      console.log(`  ${panel.id}  ${panel.kind}${panel.minimized ? ' (minimized)' : ''}  ${panel.label}`);
    }
    for (const resource of group.resources) {
      console.log(`  ${resource.id}  ${resource.kind} [${resource.source}]  ${resource.value}`);
    }
  }
}

async function cmdPanel(args) {
  const [action, first, second, ...rest] = positionals(args, ['--label']);
  if (!action || action === 'list') return cmdPanels();
  if (action === 'group') {
    return console.log(JSON.stringify(await panelMutation('/panel-layout/groups', 'POST', {
      type: 'terminal', ...(first ? { label: [first, second, ...rest].filter(Boolean).join(' ') } : {}),
    }), null, 2));
  }
  if (action === 'add') {
    if (!first || !['terminal', 'ai'].includes(second)) {
      die('usage: fw panel add <group-id> <terminal|ai> [--label <name>]');
    }
    return console.log(JSON.stringify(await panelMutation(
      `/panel-layout/groups/${encodeURIComponent(first)}/panels`, 'POST',
      { kind: second, ...(flagValue(args, '--label') ? { label: flagValue(args, '--label') } : {}) },
    ), null, 2));
  }
  if (['minimize', 'restore'].includes(action)) {
    if (!first) die(`usage: fw panel ${action} <panel-id>`);
    return console.log(JSON.stringify(await panelMutation(
      `/panel-layout/panels/${encodeURIComponent(first)}`, 'PUT',
      { minimized: action === 'minimize' },
    ), null, 2));
  }
  if (action === 'rename') {
    const label = flagValue(args, '--label') || [second, ...rest].filter(Boolean).join(' ');
    if (!first || !label) die('usage: fw panel rename <panel-id> <name>');
    return console.log(JSON.stringify(await panelMutation(
      `/panel-layout/panels/${encodeURIComponent(first)}`, 'PUT', { label },
    ), null, 2));
  }
  if (action === 'close') {
    if (!first) die('usage: fw panel close <panel-id>');
    return console.log(JSON.stringify(await panelMutation(
      `/panel-layout/panels/${encodeURIComponent(first)}/close`, 'POST',
    ), null, 2));
  }
  die(`unknown panel action "${action}" (try: list | group | add | minimize | restore | rename | close)`);
}

async function cmdResource(args) {
  const [action, first, second, ...rest] = positionals(args, ['--label']);
  if (action === 'add') {
    if (!first || !['link', 'markdown', 'html'].includes(second) || rest.length === 0) {
      die('usage: fw resource add <group-id> <link|markdown|html> <value> [--label <name>] [--open]');
    }
    return console.log(JSON.stringify(await panelMutation(
      `/panel-layout/groups/${encodeURIComponent(first)}/resources`, 'POST', {
        kind: second,
        value: rest.join(' '),
        ...(args.includes('--open') ? { open: true } : {}),
        ...(flagValue(args, '--label') ? { label: flagValue(args, '--label') } : {}),
      },
    ), null, 2));
  }
  if (action === 'remove') {
    if (!first) die('usage: fw resource remove <resource-id>');
    return console.log(JSON.stringify(await panelMutation(
      `/panel-layout/resources/${encodeURIComponent(first)}/disassociate`, 'POST',
    ), null, 2));
  }
  if (action === 'open') {
    if (!first) die('usage: fw resource open <resource-id>');
    return console.log(JSON.stringify(await panelMutation(
      `/panel-layout/resources/${encodeURIComponent(first)}/open`, 'POST',
    ), null, 2));
  }
  die('unknown resource action (try: add | open | remove)');
}

async function cmdNew(args) {
  const positional = positionals(args);
  const orgRepo = positional[0] || await prompt('Repository path, clone URL, or owner/repo: ');
  if (!orgRepo) die('a repository is required');
  const selector = positional[1] || await prompt('Branch, #PR, or owner:branch: ');
  if (!selector) die('a branch, PR number, or owner:branch is required');


  const parent = flagValue(args, '--parent');
  const { daemon, result } = await requestLocalService('/fw', {
    method: 'POST',
    body: creationRequestBody(args, {
      repository: repositorySelector(orgRepo, { local: !clientScope.getStore()?.daemon || clientScope.getStore().daemon === 'local' }),
      async: true,
      selector,
      ...(parent ? { parent } : {}),
    }),
  });
  if (result.job) return console.log(`Job ${result.job.id}: ${result.job.status} (fw job show ${result.job.id})`);
  const row = result.workstream;
  console.log(`Workstream #${row.id}: ${row.org}/${row.repo} @ ${row.branch}`);
  console.log(`  worktree: ${row.path}`);
  if (parent) console.log(`  stacked on ${parent}`);
  openedInBrowser(row, daemon);
}

// Create a scratchpad and make it the active FritzWorks workspace.
// With no name, a random one is generated.
async function cmdScratch(args) {
  const name = positionals(args)[0];
  const { daemon, result } = await requestLocalService('/fw/scratchpad', {
    method: 'POST',
    body: creationRequestBody(args, { ...(name ? { name } : {}) }),
  });
  if (result.job) return console.log(`Job ${result.job.id}: ${result.job.status} (fw job show ${result.job.id})`);
  const row = result.workstream;
  console.log(`Scratchpad #${row.id}: ${row.branch}`);
  console.log(`  dir: ${row.path}`);
  openedInBrowser(row, daemon);
}

async function cmdConfiguredLocation(id, args) {
  if (args.includes('--close')) {
    const idempotencyKey = flagValue(args, '--idempotency-key');
    const { result } = await workstreamCommand(id, 'pause', idempotencyKey ? { idempotencyKey, async: true } : {});
    if (result.job) return console.log(`Job ${result.job.id}: ${result.job.status}`);
    console.log(`Closed configured location "${id}" in FritzWorks.`);
    return;
  }
  const { daemon, result } = await workstreamCommand(id, 'resume', browserRequestBody(args, { async: true }));
  if (result.job) return console.log(`Job ${result.job.id}: ${result.job.status} (fw job show ${result.job.id})`);
  openedInBrowser(result.workstream, daemon);
}

// Reconstitute a worktree if needed and make it the active FritzWorks workspace.
async function cmdJoin(args, verb = 'join') {
  const positional = positionals(args);
  const row = await resolveTarget(positional[0] || flagValue(args, '--fw'), verb);


  const { daemon, result } = await workstreamCommand(row.id, 'resume', browserRequestBody(args, { async: true }));
  if (result.job) return console.log(`Job ${result.job.id}: ${result.job.status} (fw job show ${result.job.id})`);
  console.log(`  worktree: ${result.workstream.path}`);
  openedInBrowser(result.workstream, daemon);
}

// Stop working on a workstream for now: close its web workspace, keep the worktree.
async function cmdPause(args) {
  const positional = positionals(args);
  const row = await resolveTarget(positional[0] || flagValue(args, '--fw'), 'pause');
  const idempotencyKey = flagValue(args, '--idempotency-key');
  const { result } = await workstreamCommand(row.id, 'pause', idempotencyKey ? { idempotencyKey, async: true } : {});
  if (result.job) return console.log(`Job ${result.job.id}: ${result.job.status}`);
  console.log(`Paused workstream #${row.id} (${row.org}/${row.repo} @ ${row.branch}); worktree kept at ${row.path}`);
}

async function cmdConfig(args = []) {
  if (args.length && !['validate', 'active'].includes(args[0])) die('usage: fw config [validate|active]');
  if (args[0] === 'active') {
    const running = async () => {
      const status = await daemonStatus(CONFIG);
      if (!status.running) throw new Error('daemon is not running');
      return status;
    };
    const [{ result: config }, { result: status }] = await Promise.all([
      requestLocalService('/config', { start: running }), requestLocalService('/config/status', { start: running }),
    ]);
    console.log(JSON.stringify({ config, status }, null, 2));
    return;
  }
  if (args[0] !== 'validate') { console.log(JSON.stringify((await requestLocalService('/config')).result, null, 2)); return; }
  console.log(JSON.stringify(args[0] === 'validate'
    ? { valid: true, configVersion: CONFIG.configVersion, configPath: CONFIG.configPath, diagnostics: CONFIG.diagnostics }
    : CONFIG, null, 2));
}

async function cmdRefresh() {
  const { result: response } = await requestLocalService('/fw/refresh', {
    method: 'POST', body: {},
  });
  const { result } = response;
  console.log(`Checked ${result.checked} workstream${result.checked === 1 ? '' : 's'} against ${result.terminalSessionCount} browser terminal session${result.terminalSessionCount === 1 ? '' : 's'}.`);
  if (!result.activated.length && !result.paused.length) {
    console.log('No statuses changed.');
    return;
  }
  for (const row of result.activated) {
    const repo = isScratch(row) ? 'scratch' : `${row.org}/${row.repo}`;
    console.log(`Activated #${row.id} (${repo} @ ${row.branch}); browser terminals are connected.`);
  }
  for (const row of result.paused) {
    const repo = isScratch(row) ? 'scratch' : `${row.org}/${row.repo}`;
    console.log(`Paused #${row.id} (${repo} @ ${row.branch}); no browser terminals are connected.`);
  }
}

async function cmdSync(args) {
  const positional = positionals(args);
  const row = await resolveTarget(positional[0] || flagValue(args, '--fw'), 'sync');
  const { result } = await requestLocalService(`/fw/${encodeURIComponent(row.id)}/sync`, {
    method: 'POST', body: {},
  });
  console.log(`Synced ${result.notes.count} Markdown resource${result.notes.count === 1 ? '' : 's'} for #${row.id}.`);
  if (result.pullRequest.checked) {
    console.log(result.pullRequest.associated
      ? `Associated PR: ${result.pullRequest.pr.url}`
      : 'No PR found for the current branch.');
  } else if (result.pullRequest.associated) {
    console.log('PR already associated.');
  }
}

function daemonOptions(args) {
  const host = flagValue(args, '--host') || CONFIG.server.host;
  const rawPort = flagValue(args, '--port');
  const port = rawPort === null ? CONFIG.server.port : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    die('--port must be an integer from 1 to 65535');
  }
  return { config: CONFIG, host, port };
}

async function cmdDaemon(args) {
  const positional = positionals(args, ['--host', '--port']);
  const action = positional[0] || 'start';
  const options = daemonOptions(args);
  switch (action) {
    case 'start': {
      const status = await startDaemon(options);
      console.log(status.alreadyRunning
        ? `API daemon already running (pid ${status.info.pid}) at ${status.url}`
        : status.restarted
          ? `Restarted outdated API daemon (pid ${status.info.pid}) at ${status.url}`
          : `Started API daemon (pid ${status.info.pid}) at ${status.url}`);
      console.log(`  log: ${status.log}`);
      return;
    }
    case 'stop': {
      const result = await stopDaemon(CONFIG);
      console.log(result.stopped ? `Stopped API daemon (pid ${result.pid})` : `API daemon ${result.reason}`);
      return;
    }
    case 'restart': {
      await stopDaemon(CONFIG);
      const status = await startDaemon(options);
      console.log(`Restarted API daemon (pid ${status.info.pid}) at ${status.url}`);
      console.log(`  log: ${status.log}`);
      return;
    }
    case 'status': {
      const status = await daemonStatus(CONFIG);
      if (status.running) {
        console.log(`API daemon running (pid ${status.info.pid}) at ${status.url}`);
        console.log(`  uptime: ${Math.floor(status.health.uptime)}s`);
        console.log(`  source: ${status.outdated ? 'outdated; fw web start will restart it' : 'current'}`);
        console.log(`  config: ${status.health.configRevision || 'unknown'}${status.configChanged ? '; fw daemon restart required' : ''}`);
        console.log(`  log: ${status.log}`);
      } else if (status.stale) {
        console.log(`API daemon not responding (stale pid ${status.info.pid})`);
      } else {
        console.log('API daemon is not running');
      }
      return;
    }
    case 'foreground':
      console.log(`Starting API server in foreground at http://${options.host}:${options.port}`);
      return runForeground(options);
    case 'log':
      console.log(daemonFiles(CONFIG).log);
      return;
    default:
      die(`unknown daemon action "${action}" (try: start | stop | restart | status | foreground | log)`);
  }
}

function cmdHooks(args) {
  const action = positionals(args, ['--provider'])[0] || 'status';
  const provider = flagValue(args, '--provider');
  const options = provider ? { providers: [provider] } : {};
  if (action === 'uninstall') {
    for (const result of uninstallAgentHooks(options)) console.log(`${result.provider}: removed ${result.removed} hooks (${result.path})`);
    if (args.includes('--shell')) console.log(JSON.stringify(uninstallShellHooks()));
    return;
  }
  if (action === 'install') {
    for (const result of installAgentHooks(options)) {
      console.log(`${result.provider}: ${result.added ? `installed ${result.added} hooks` : 'already installed'} (${result.path})`);
    }
    if (!args.includes('--shell')) return;
    const shell = installShellHooks();
    console.log(`${shell.provider}: ${shell.added || shell.updated ? 'installed shell hooks' : 'already installed'} (${shell.path})`);
    return;
  }
  if (action === 'status') {
    for (const result of agentHookStatus(options)) {
      console.log(`${result.provider}: ${result.installed ? 'installed' : 'not installed'} (${result.path})`);
    }
    const shell = shellHookStatus();
    console.log(`${shell.provider}: ${shell.installed ? 'installed' : 'not installed'} (${shell.path})`);
    return;
  }
  die(`unknown hooks action "${action}" (try: install | status | uninstall)`);
}

async function cmdAgentHook(args) {
  const report = (result) => {
    if (args.includes('--json')) console.log(JSON.stringify(result));
    else if (args.includes('--verbose') || process.env.FRITZWORKS_HOOK_DEBUG === '1') console.error(JSON.stringify(result));
  };
  if (args[0] === 'shell-status') {
    try {
      report(await recordShellHook(args[1]));
    } catch (error) {
      console.error(`fw hook shell-status: ${error.message}`);
    }
    return;
  }
  if (args[0] !== 'agent-status') die('unknown internal hook');
  try {
    const payload = JSON.parse(readFileSync(0, 'utf8'));
    report(await recordAgentHook(payload));
  } catch (error) {
    // Hooks are observational and must never prevent a prompt, permission, or
    // completed turn from proceeding if their local state update fails.
    console.error(`fw hook agent-status: ${error.message}`);
  }
}

async function cmdWeb(args) {
  const positional = positionals(args, ['--host', '--port']);
  const action = positional[0] || 'start';
  if (action !== 'start') die(`unknown web action "${action}" (try: fw web start)`);
  const status = await startDaemon(daemonOptions(args));
  console.log(status.alreadyRunning
    ? `API daemon already running (pid ${status.info.pid}) at ${status.url}`
    : status.restarted
      ? `Restarted outdated API daemon (pid ${status.info.pid}) at ${status.url}`
      : `Started API daemon (pid ${status.info.pid}) at ${status.url}`);
  const opened = openWebPage(status.url);
  console.log(`Opened ${opened.url} with ${opened.opener}`);
}

// Rename the display name shown by FritzWorks. Scratchpads retain their stable
// directory and internal branch key; git branch names are never changed.
async function cmdRename(args) {
  const positional = positionals(args);
  // Two positionals -> [selector, newName]; one -> newName against context/--fw.
  const [selector, explicitName] = positional.length >= 2 ? positional : [flagValue(args, '--fw'), positional[0]];
  const row = await resolveTarget(selector, 'rename');
  const newName = explicitName || await prompt('New name: ');
  if (!newName) die('a new name is required');
  const { result } = await workstreamCommand(row.id, 'rename', { name: newName });
  console.log(`Renamed #${result.workstream.id} to "${result.workstream.name || result.workstream.label}"`);
}

async function cmdArchive(args) {
  const row = await resolveTarget(positionals(args)[0] || flagValue(args, '--fw'), 'archive');
  const intent = { kind: 'action', target: String(row.id), command: 'archive', body: {
    ...(flagValue(args, '--idempotency-key') ? { idempotencyKey: flagValue(args, '--idempotency-key') } : {}),
    retention: 'automatic', keep: args.includes('--keep'), discard: args.includes('--delete') || args.includes('--discard'), force: args.includes('--force'),
  } };
  const revision = flagValue(args, '--preview-revision');
  if (revision && args.includes('--confirm')) {
    const { result } = await workstreamCommand(row.id, 'archive', { ...intent.body, async: true, force: args.includes('--force'), previewRevision: revision, confirm: true });
    if (result.job) return console.log(`Job ${result.job.id}: ${result.job.status}`);
    console.log(`Archived workstream #${row.id}`);
    return;
  }
  const preview = await previewIntent(intent);
  if (args.includes('--preview')) { console.log(JSON.stringify(preview, null, 2)); return; }
  if (preview.confirmationRequired) {
    console.log(JSON.stringify(preview.consequences, null, 2));
    if (!await confirm('Apply these changes?')) return;
  }
  const { result } = await workstreamCommand(row.id, 'archive', { ...preview.intent.body, ...(intent.body.idempotencyKey ? { idempotencyKey: intent.body.idempotencyKey } : {}), async: true, previewRevision: preview.revision, confirm: true });
  if (result.job) return console.log(`Job ${result.job.id}: ${result.job.status}`);
  console.log(`Archived workstream #${row.id}`);
}

// fw stack [show|on|off|link|rebase] — the parent/child chain and its GitHub stack.
const STACK_SUBS = ['show', 'view', 'on', 'set', 'off', 'unset', 'detach', 'link', 'rebase'];

async function cmdStack(args) {
  // `fw stack` defaults to show, including when what follows is a flag or a bare
  // selector (`fw stack 52`, `fw stack --fw 52`) rather than a subcommand.
  const [first, ...rest] = args;
  const sub = STACK_SUBS.includes(first) ? first : 'show';
  const subArgs = STACK_SUBS.includes(first) ? rest : args;
  switch (sub) {
    case 'show': case 'view': return cmdStackShow(subArgs);
    case 'on': case 'set': return cmdStackOn(subArgs);
    case 'off': case 'unset': case 'detach': return cmdStackOff(subArgs);
    case 'link': return cmdStackLink(subArgs);
    case 'rebase': return cmdStackRebase(subArgs);
  }
}

// Render the chain as a tree, marking the workstream in question.
function printStackTree(node, focusId, depth = 0) {
  console.log(`  ${node.id === focusId ? '▸' : ' '} ${'  '.repeat(depth)}#${node.id} ${node.repo}:${node.branch} [${node.status}]`);
  for (const child of node.stackedBy || []) printStackTree(child, focusId, depth + 1);
}

async function cmdStackShow(args) {
  const row = await resolveTarget(positionals(args)[0] || flagValue(args, '--fw'), 'show the stack for');
  const { result } = await requestLocalService(`/fw/${encodeURIComponent(row.id)}/stack`);
  printStackTree(result.stack, row.id);
  console.log(result.canLinkOnGitHub ? `Can link on GitHub: ${result.githubRepo}` : result.reason || '');
}

async function cmdStackOn(args) {
  const positional = positionals(args);
  const [childSel, parentSel] = positional.length >= 2 ? positional : [flagValue(args, '--fw'), positional[0]];
  const row = await resolveTarget(childSel, 'stack');
  const parent = parentSel || await prompt('Stack it on (id or branch): ');
  if (!parent) die('a parent workstream is required');
  const { result } = await workstreamCommand(row.id, 'stack-set', { parent });
  console.log(`#${row.id} is now stacked on #${result.stackedOn.id}`);
}

async function cmdStackOff(args) {
  const row = await resolveTarget(positionals(args)[0] || flagValue(args, '--fw'), 'unstack');
  await workstreamCommand(row.id, 'stack-set', { clear: true });
  console.log(`#${row.id} is no longer stacked on a parent`);
}

async function submitStackJob(args, command) {
  const row = await resolveTarget(positionals(args)[0] || flagValue(args, '--fw'), command);
  const body = { ...(command === 'stack-link' ? { open: args.includes('--open') } : { trunk: args.includes('--trunk') }),
    ...(flagValue(args, '--idempotency-key') ? { idempotencyKey: flagValue(args, '--idempotency-key') } : {}) };
  const suppliedRevision = flagValue(args, '--preview-revision');
  if (suppliedRevision && args.includes('--confirm')) {
    const { result } = await workstreamCommand(row.id, command, { ...body, previewRevision: suppliedRevision, confirm: true });
    console.log(`Job ${result.job.id}: ${result.job.status}`);
    return;
  }
  const preview = await previewIntent({ kind: command, target: String(row.id), body });
  if (args.includes('--preview')) { console.log(JSON.stringify(preview, null, 2)); return; }
  console.log(JSON.stringify(preview.consequences, null, 2));
  if (preview.confirmationRequired && !await confirm('Apply these changes?')) return;
  const { result } = await workstreamCommand(row.id, command, { ...preview.intent.body, ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}), previewRevision: preview.revision, confirm: true });
  console.log(`Job ${result.job.id}: ${result.job.status} (fw job show ${result.job.id})`);
}
const cmdStackLink = (args) => submitStackJob(args, 'stack-link');
const cmdStackRebase = (args) => submitStackJob(args, 'stack-rebase');

async function cmdJob(args) {
  const [command = 'list', id] = args;
  if (!['list', 'show', 'cancel'].includes(command) || (command !== 'list' && !id)) throw new Error('usage: fw job list|show <id>|cancel <id>');
  const path = command === 'list' ? '/jobs' : `/jobs/${encodeURIComponent(id)}${command === 'cancel' ? '/cancel' : ''}`;
  const { result } = await requestLocalService(path, command === 'cancel' ? { method: 'POST', body: {} } : {});
  console.log(JSON.stringify(result, null, 2));
}

// fw issue add|remove|list — manage issues linked to a workstream.
async function cmdIssue(args) {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'add': return cmdIssueAdd(rest);
    case 'remove': case 'rm': return cmdIssueRemove(rest);
    case 'list': case 'ls': case undefined: return cmdIssueList(rest);
    default: die(`unknown 'issue' subcommand "${sub}" (try: add | remove | list)`);
  }
}

async function cmdIssueAdd(args) {
  // Workstream comes from --fw or the current worktree; positionals are issue refs.
  const row = await resolveTarget(flagValue(args, '--fw'), 'add an issue to');
  let refs = positionals(args);
  if (refs.length === 0) {
    const r = await prompt('Issue link or id: ');
    if (r) refs = [r];
  }
  if (refs.length === 0) die('no issue given');
  const { result } = await workstreamCommand(row.id, 'issue-add', { refs });
  for (const issue of result.result.issues) {
    console.log(issue.added ? `  + [${issue.kind}] ${issue.ref}` : `  (already linked) ${issue.ref}`);
  }
  console.log(`Issues on #${row.id} (${row.org}/${row.repo} @ ${row.branch}):`);
  await printIssues(row.id);
}

async function cmdIssueRemove(args) {
  const positional = positionals(args);
  const row = await resolveTarget(flagValue(args, '--fw'), 'remove an issue from');
  let target = positional[0];
  if (!target) {
    await printIssues(row.id);
    target = await prompt('\nIssue to remove (id or exact link): ');
  }
  if (!target) die('no issue given');
  const { result } = await workstreamCommand(row.id, 'issue-remove', { ref: target });
  const { removed } = result.result;
  console.log(removed ? `Removed issue "${target}" from #${row.id}` : `No matching issue "${target}" on #${row.id}`);
}

async function cmdIssueList(args) {
  const row = await resolveTarget(flagValue(args, '--fw'), 'list issues for');
  console.log(`#${row.id} ${row.org}/${row.repo} @ ${row.branch}`);
  await printIssues(row.id);
}

// fw log [msg...] [--done] — jot a one-line work note against a workstream.
// The workstream comes from --fw or the current worktree; positionals are the note.
async function cmdLog(args) {
  const done = args.includes('--done');
  const row = await resolveTarget(flagValue(args, '--fw'), 'log work against');
  let body = positionals(args).join(' ').trim();
  if (!body) body = (await prompt('What did you do? ')).trim();
  if (!body) die('nothing to log');
  const { result } = await workstreamCommand(row.id, 'log', { body, done });
  const entry = result.result;
  console.log(`  logged${entry.done ? ' [done]' : ''}: ${entry.body}`);
  console.log(`  on #${row.id} (${row.org}/${row.repo} @ ${row.branch})`);
}

// fw digest [YYYY-MM-DD] [--write] — assemble a day's activity (commits + work
// logs, with linked issues) into notes-format bullets. Prints them; --write also
// appends them under the day's heading in this week's configured work-notes file.
async function cmdDigest(args) {
  const date = positionals(args)[0];
  const { result } = await requestLocalService('/fw/digest', { method: 'POST', body: { ...(date ? { date } : {}), write: args.includes('--write') } });
  console.log(result.markdown || `No workstream activity on ${result.date || date || 'this day'}.`);
  if (result.written) console.log(JSON.stringify(result.written));
}

// fw note list|show — daemon-owned session notes.
async function cmdNote(args) {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'list': case 'ls': case undefined: return cmdNoteList(rest);
    case 'show': case 'cat': return cmdNoteShow(rest);
    default: die(`unknown 'note' subcommand "${sub}" (try: list | show)`);
  }
}

async function cmdNoteList(args) {
  const row = await resolveTarget(flagValue(args, '--fw'), 'list notes for');
  const { result } = await requestLocalService(`/fw/${encodeURIComponent(row.id)}/notes`);
  const notes = result.notes;
  console.log(`Notes on #${row.id} (${row.org}/${row.repo} @ ${row.branch}):`);
  if (notes.length === 0) { console.log('  (none)'); return; }
  for (const n of notes) console.log(`  ${n.year}/${n.file}`);
}

async function cmdNoteShow(args) {
  const positional = positionals(args);
  const row = await resolveTarget(flagValue(args, '--fw'), 'show a note for');
  const file = positional[0] || await prompt('Note filename (see: fw note list): ');
  if (!file) die('no note filename given');
  const { result } = await requestLocalService(`/fw/${encodeURIComponent(row.id)}/note-file?path=${encodeURIComponent(file)}`);
  console.log(result.content);
}

async function cmdStorage(args) {
  const [command, action = 'preview'] = args;
  if (command === 'rebind') {
    const { rebindStorage } = await import('./lib/storage-rebind.js');
    const result = rebindStorage({ config: CONFIG, action,
      source: flagValue(args, '--source') || CONFIG.paths.data,
      destination: flagValue(args, '--destination'), revision: flagValue(args, '--revision'),
      migrationId: flagValue(args, '--migration'),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const legacyConfigPath = flagValue(args, '--legacy-config');
  let path, body;
  if (command === 'inventory') path = `/migrations/storage${legacyConfigPath ? `?legacyConfigPath=${encodeURIComponent(legacyConfigPath)}` : ''}`;
  else if (command === 'ledger') path = '/migrations';
  else if (command === 'apply') {
    path = '/migrations/storage/apply';
    body = { revision: flagValue(args, '--revision'), legacyConfigPath, applyConfiguration: args.includes('--write-config') };
  } else if (command === 'recover') {
    path = '/migrations/storage/recover'; body = { migrationId: flagValue(args, '--migration') };
  } else if (command === 'terminals' && ['preview', 'apply', 'recover'].includes(action)) {
    path = `/migrations/terminals${action === 'preview' ? '' : `/${action}`}`;
    if (action !== 'preview') body = { revision: flagValue(args, '--revision'), migrationId: flagValue(args, '--migration') };
    const approvals = flagValue(args, '--legacy-approvals');
    if (approvals) {
      if (action !== 'apply') die('--legacy-approvals requires storage terminals apply');
      body.legacyApprovals = JSON.parse(readFileSync(approvals, 'utf8'));
    }
  } else die('storage expects inventory, ledger, apply, recover, terminals, or rebind');
  const { result } = await requestLocalService(path, { start: false, ...(body ? { method: 'POST', body } : {}) });
  console.log(JSON.stringify(result, null, 2));
}

export function usageText() {
  return `fw — FritzWorks CLI (git worktrees + browser terminals + Claude Code or Codex)

Usage:
  fw list [--all]                  List active workstreams (--all includes archived)
  fw new <repository> <ref>          Create and open a FritzWorks workspace (alias: create)
                                   (--parent <id|branch>: branch off that workstream and stack on it)
  fw scratch [name]                Create a scratchpad under the configured root (alias: sp)
                                   (both take repeatable --link <ref> and --seed <file>)
  fw location <name> [--close]     Open any configured location in FritzWorks; --close pauses it
  fw <location-name> [--close]     Shorthand when the name is not another fw command
  fw join [id|branch]              Open in FritzWorks, reconstituting if needed (alias: rejoin)
  fw pause [id|branch]             Close browser terminals but keep the worktree
  fw resume [id|branch]            Open a paused workstream in FritzWorks
  fw archive [id|branch] [--keep]  Archive the session; remove worktree unless --keep
                                   (scratchpads keep their dir by default; --delete removes it)
                                   (aliases: close, rm)
  fw rename [id|branch] <name>     Rename the FritzWorks display name
  fw panels                        List panel groups, panels, resources, and revision
  fw panel group [label]           Create and select a terminal-only group
  fw panel add <group> <terminal|ai> [--label <name>]
  fw panel minimize|restore|close <panel-id>
  fw panel rename <panel-id> <name>
  fw resource add <group> <link|markdown|html> <value> [--label <name>] [--open]
  fw resource open|remove <resource-id>
  fw issue add <link...> [--fw X]       Link Linear/GitHub issues to a workstream
  fw issue remove <link> [--fw X]       Unlink an issue (by link or issue id)
  fw issue list [--fw X]                Show issues linked to a workstream
  fw stack [--fw X]                     Show the parent/child chain this workstream is in
  fw stack on <id|branch> [--fw X]      Record that it's stacked on another workstream
  fw stack off [--fw X]                 Detach it from its parent
  fw stack link [--open] [--fw X]       Push the chain and stack its PRs on GitHub (gh stack link)
  fw stack rebase [--trunk] [--fw X]    Cascade-rebase the chain, each branch in its own worktree
  # Retryable creation/lifecycle/stack jobs: --idempotency-key <key>
  # Destructive actions: --preview, then --preview-revision <hash> --confirm
  fw --daemon <id> <command>          Select a target from the local daemon directory
  fw capabilities                    Show selected daemon identity and capabilities
  fw daemons                         Refresh the local connection directory
  --acknowledge-instance <uuid>       Accept a changed target identity explicitly
  --expect-instance <uuid>            Require the specified target identity
  fw job list|show <id>|cancel <id>    Inspect or cancel daemon jobs
  fw log <msg...> [--done] [--fw X]     Jot a work note (--done marks it completed)
  fw note list [--fw X]                 List legacy per-session Markdown
  fw note show <file> [--fw X]          Print legacy per-session Markdown
  fw storage inventory [--legacy-config <file>]  Preview storage adoption and config translation
  fw storage apply --revision <hash> [--write-config]  Apply the reviewed inventory
  fw storage recover --migration <id>       Replay an interrupted storage migration
  fw storage terminals preview|apply|recover [--revision <hash>]
    apply --legacy-approvals <json>  Explicitly acknowledge reviewed legacy processes
  fw storage rebind preview|apply --destination <path> [--revision <hash>]
  fw storage rebind recover --source <old-data> --migration <id>
  fw storage ledger                        Show migration and backup records
  fw digest [YYYY-MM-DD] [--write]      Draft a day's notes from commits + work logs
                                        (--write appends to the configured weekly notes file)
  fw doctor [--json]               Check installation prerequisites and configuration
  fw setup [--provider claude|codex|all] [--shell|--no-shell] [--no-mcp]
                                   Link commands and install client integrations
  fw skills [install|status|uninstall] [--provider claude|codex]
                                   Manage bundled agent skills
  fw config [validate|active]      Validate or print effective settings and their sources
  fw sync [id|branch] [--fw X]     Sync session Markdown and discover its branch PR
  fw refresh                       Reconcile status with live browser terminal sessions
  fw hooks [install|status|uninstall]         Agent hooks; --provider claude|codex, --shell for Zsh
  fw daemon [start|stop|restart|status|foreground|log] [--host H] [--port P]
                                   Manage the local REST/WebSocket service (default: start)
  fw web start [--host H] [--port P]
                                   Start the daemon if needed and open its web client

Browser workspace options for new/scratch/join/resume/location:
  --agent claude|codex             Persist the agent provider (--claude/--codex shorthand)
  --panels shell,agent             Open the two-panel browser layout
  --panels shell,editor,agent      Open the three-panel browser layout
  --no-editor                      Select the two-panel layout (--no-vim is an alias)
  --seed <file>                    Seed the next newly-created browser agent terminal

Creation option for new/scratch:
  --link <ref>                     Associate a Linear/GitHub reference or URL (repeatable)

<ref> for "new" is one of:
  feature-x        a branch on origin (created off the default branch if new)
  123  or  #123    a pull request by number — works for fork PRs too
  owner:feature-x  a branch on someone's fork of this repo

Context: commands that act on a workstream take it from, in order: the given
selector (id, branch, or org/repo:branch) or --fw; else the worktree you're in;
else an interactive pick. Lifecycle commands start the local service if needed
and update the shared FritzWorks workspace inventory; they never manage terminal tabs.

Configuration: ${CONFIG.configPath}
An MCP server is available as fw-mcp.`;
}

function usage() {
  console.log(usageText());
}

// ---------------------------------------------------------------- entry

const runCommand = async (argv) => {
  const [cmd, ...rest] = argv;
  if (argv.some((arg) => arg === '--model' || arg.startsWith('--model='))) {
    die('--model was removed; configure the provider model in config.ini instead');
  }
  if (new Set([
    'open-shell', 'open-zsh', 'open-editor', 'open-nvim', 'open-agent', 'open-claude', 'open-codex',
    'close-shell', 'close-zsh', 'close-editor', 'close-nvim', 'close-agent', 'close-claude', 'close-codex',
  ]).has(cmd)) {
    die('terminal pane commands were removed; use --panels while opening a workspace or the FritzWorks layout control');
  }
  switch (cmd) {
    case 'list': case 'ls': return cmdList(rest);
    case 'new': case 'create': return cmdNew(rest);
    case 'scratch': case 'scratchpad': case 'sp': return cmdScratch(rest);
    case 'location': {
      const [id, ...locationArgs] = rest;
      if (!id) die('location requires a configured location name');
      return cmdConfiguredLocation(id, locationArgs);
    }
    case 'join': case 'rejoin': return cmdJoin(rest);
    case 'resume': return cmdJoin(rest, 'resume');
    case 'pause': return cmdPause(rest);
    case 'rename': return cmdRename(rest);
    case 'panels': return cmdPanels();
    case 'panel': return cmdPanel(rest);
    case 'resource': case 'resources': return cmdResource(rest);
    case 'archive': case 'close': case 'rm': return cmdArchive(rest);
    case 'issue': case 'issues': return cmdIssue(rest);
    case 'stack': return cmdStack(rest);
    case 'job': case 'jobs': return cmdJob(rest);
    case 'log': return cmdLog(rest);
    case 'note': return cmdNote(rest);
    case 'storage': return cmdStorage(rest);
    case 'digest': return cmdDigest(rest);
    case 'config': return cmdConfig(rest);
    case 'capabilities': return console.log(JSON.stringify(await requestLocalService('/capabilities'), null, 2));
    case 'daemons': return console.log(JSON.stringify((await (clientScope.getStore()?.request || localRequest)('/daemons', { daemon: 'local', ...(clientScope.getStore()?.config ? { config: clientScope.getStore().config } : {}) })).result, null, 2));
    case 'sync': return cmdSync(rest);
    case 'refresh': return cmdRefresh();
    case 'doctor': {
      const result = await diagnose();
      console.log(rest.includes('--json') ? JSON.stringify(result, null, 2)
        : result.checks.map(({ name, level, detail }) => `${level.toUpperCase()} ${name}: ${detail}`).join('\n'));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    case 'setup': {
      if (rest.includes('--help') || rest.includes('-h')) return usage();
      const provider = flagValue(rest, '--provider');
      if (rest.includes('--provider') && !provider) die('--provider requires claude, codex, or all');
      const result = setupCheckout({
        ...(provider ? { providers: provider === 'all' ? ['claude', 'codex'] : [provider] } : {}),
        ...(rest.includes('--shell') ? { shell: true } : {}),
        ...(rest.includes('--no-shell') ? { shell: false } : {}),
        mcp: !rest.includes('--no-mcp'),
      });
      console.log(`${result.config.created ? 'Created' : 'Using'} ${result.config.path}`);
      for (const command of result.commands) console.log(`${command.name}: ${command.path}`);
      for (const hook of result.hooks) console.log(`${hook.provider}: hooks configured (${hook.path})`);
      for (const skill of result.skills) console.log(`${skill.provider}: ${skill.status} (${skill.path})`);
      for (const registration of result.registrations) console.log(`${registration.provider}: ${registration.status}`);
      if (result.shellHooks) console.log(`Zsh hooks: ${result.shellHooks.rcPath}`);
      if (!result.providers.length) console.log('No AI clients detected. Install one and rerun setup, or select --provider claude|codex|all.');
      console.log('Keep ~/.local/bin on PATH. Restart AI clients to load integrations. Run npm start to open FritzWorks.');
      return;
    }
    case 'skills': {
      const provider = flagValue(rest, '--provider');
      const action = positionals(rest, ['--provider'])[0] || 'status';
      console.log(JSON.stringify(manageSkills(action, provider ? { providers: [provider] } : {}), null, 2));
      return;
    }
    case 'hooks': return cmdHooks(rest);
    case 'hook': return cmdAgentHook(rest);
    case 'daemon': case 'server': return cmdDaemon(rest);
    case 'web': return cmdWeb(rest);
    case 'version': case '-V': case '--version': return console.log(VERSION);
    case undefined: case 'help': case '-h': case '--help': return usage();
    default:
      const { result: capabilities } = await requestLocalService('/capabilities');
      if (capabilities.locations.some((location) => location.id === cmd)) return cmdConfiguredLocation(cmd, rest);
      die(`unknown command "${cmd}" (try: fw help)`);
  }
};

export const run = (argv = process.argv.slice(2), options = {}) => {
  const args = [];
  const globals = {};
  const names = { '--daemon': 'daemon', '--acknowledge-instance': 'acknowledgeInstance', '--expect-instance': 'expectedInstance' };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index].split('=')[0];
    if (!names[name]) { args.push(argv[index]); continue; }
    const value = argv[index].includes('=') ? argv[index].slice(name.length + 1) : argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    if (globals[names[name]]) throw new Error(`${name} may be specified only once`);
    globals[names[name]] = value;
  }
  const [command, subcommand] = args;
  const remote = globals.daemon && globals.daemon !== 'local';
  const bootstrap = ['setup', 'doctor', 'daemon', 'server', 'web', 'hooks', 'hook', 'skills'].includes(command)
    || (command === 'config' && subcommand === 'validate') || (command === 'storage' && subcommand === 'rebind');
  if (remote && bootstrap) throw Object.assign(new Error(`${command} is a local bootstrap operation; --daemon cannot select a remote`), { code: 'local_only', details: { code: 'local_only' } });
  return clientScope.run({ ...options, ...globals, bindings: new Map() }, () => runCommand(args));
};

const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) run().catch((e) => die(e.message || String(e)));
