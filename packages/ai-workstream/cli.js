#!/usr/bin/env -S node --no-warnings
// ws CLI — command-line client for the FritzWorks workstream service.
// Shared data/git logic lives in ./lib/core.js (also used by the MCP server).

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

import { AGENT_PROVIDERS, CONFIG, PANEL_ROLES } from './lib/config.js';
import {
  isScratch,
  openDb, resolveRow, currentWorkstream,
  listIssues,
  hasClone, worktreeDirty,
  listNotes, readNote,
  parentOf, setParent, stackTree, stackLine, stackCheck, ghStackLink, rebaseStack,
  NOTES_ROOT, appendDayEntry, collectDayActivity, renderDigest,
} from './lib/core.js';
import {
  daemonFiles, daemonStatus, openWebPage, runForeground, startDaemon, stopDaemon,
} from './lib/daemon.js';
import { requestLocalService, workstreamCommand } from './lib/client.js';
import {
  agentHookStatus,
  installAgentHooks,
  installShellHooks,
  recordAgentHook,
  recordShellHook,
  shellHookStatus,
} from './lib/hooks.js';

const PACKAGE = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
export const VERSION = PACKAGE.version;

// ---------------------------------------------------------------- utilities

const die = (msg) => { console.error(`ws: ${msg}`); process.exit(1); };

async function prompt(question, fallback) {
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
// value-taking flag like `--ws X` (so it isn't mistaken for a positional).
function positionals(args, valueFlags = ['--ws', '--seed', '--parent', '--agent', '--panels', '--link']) {
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
  if (agent && !AGENT_PROVIDERS.includes(agent)) die(`unknown agent "${agent}" (expected claude or codex)`);
  return agent;
}

function browserPanels(args) {
  const panels = flagValue(args, '--panels');
  let selected = panels
    ? panels.split(',').map((part) => part.trim()).filter(Boolean)
    : undefined;
  if (args.includes('--no-editor') || args.includes('--no-vim')) selected = ['shell', 'agent'];
  if (selected) {
    selected = [...new Set(selected)];
    const invalid = selected.find((panel) => !PANEL_ROLES.includes(panel));
    if (invalid) die(`unknown panel "${invalid}" (expected shell, editor, or agent)`);
    const set = new Set(selected);
    if (!set.has('shell') || !set.has('agent')
        || (selected.length !== 2 && selected.length !== 3)
        || (selected.length === 3 && !set.has('editor'))) {
      die('browser panels must be shell,agent or shell,editor,agent');
    }
  }
  return selected;
}

function browserRequestBody(args, extra = {}) {
  const body = { ...extra };
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

function printIssues(db, workstreamId) {
  const issues = listIssues(db, workstreamId);
  if (issues.length === 0) { console.log('  (no issues linked)'); return; }
  for (const it of issues) console.log(`  ${String(it.id).padStart(3)}  [${it.kind}] ${it.ref}`);
}

// Resolve which workstream a command acts on, in priority order:
//   1. an explicit selector (positional arg or --ws),
//   2. the workstream whose worktree contains the current directory,
//   3. interactive pick from the list.
async function resolveTarget(db, selector, verb) {
  if (selector) {
    const row = resolveRow(db, selector);
    if (!row) die(`no workstream matching "${selector}"`);
    return row;
  }
  const cur = currentWorkstream(db);
  if (cur) {
    console.log(`(current workstream: #${cur.id} ${cur.org}/${cur.repo} @ ${cur.branch})`);
    return cur;
  }
  await cmdList([]);
  const picked = await prompt(`\nWorkstream to ${verb} (id or branch): `);
  const row = resolveRow(db, picked);
  if (!row) die(`no workstream matching "${picked}"`);
  return row;
}

// ---------------------------------------------------------------- commands

async function cmdList(args) {
  const db = openDb();
  const status = args.includes('--all') ? 'all' : 'active_paused';
  const { result } = await requestLocalService(`/ws/all?status=${status}&perpage=100`);
  const rows = result.items;
  if (rows.length === 0) {
    console.log('No workstreams yet. Create one with: ws new <org/repo> <branch>');
    return;
  }
  const current = currentWorkstream(db);
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

async function cmdNew(args) {
  const positional = positionals(args);
  const orgRepo = positional[0] || await prompt('Repo (org/repo): ');
  if (!orgRepo || !orgRepo.includes('/')) die('expected org/repo');
  const [org, repo] = orgRepo.split('/');
  const selector = positional[1] || await prompt('Branch, #PR, or owner:branch: ');
  if (!selector) die('a branch, PR number, or owner:branch is required');

  if (!hasClone(org, repo)) {
    if (!await confirm(`No local clone of ${org}/${repo}. Clone it now?`)) die('aborted');
  }

  const db = openDb();
  // --parent stacks the new branch on another workstream: it's created off that
  // branch instead of the default branch, and the relationship is recorded.
  const parentSel = flagValue(args, '--parent');
  let parent = null;
  if (parentSel) {
    parent = resolveRow(db, parentSel);
    if (!parent) die(`no workstream matching --parent "${parentSel}"`);
    if (isScratch(parent)) die(`--parent #${parent.id} is a scratchpad, so it has no branch to build on`);
  }

  const { daemon, result } = await requestLocalService('/ws', {
    method: 'POST',
    body: creationRequestBody(args, {
      repository: orgRepo,
      selector,
      ...(parent ? { parent: String(parent.id) } : {}),
    }),
  });
  const row = result.workstream;
  console.log(`Workstream #${row.id}: ${org}/${repo} @ ${row.branch}`);
  console.log(`  worktree: ${row.path}`);
  if (parent) {
    console.log(`  stacked on #${parent.id} (${parent.branch})`
      + (result.branchedOffParent ? '' : ' — different repo, so recorded only (not branched off it)'));
  }
  openedInBrowser(row, daemon);
}

// Create a scratchpad and make it the active FritzWorks workspace.
// With no name, a random one is generated.
async function cmdScratch(args) {
  const name = positionals(args)[0];
  const { daemon, result } = await requestLocalService('/ws/scratchpad', {
    method: 'POST',
    body: creationRequestBody(args, { ...(name ? { name } : {}) }),
  });
  const row = result.workstream;
  console.log(`Scratchpad #${row.id}: ${row.branch}`);
  console.log(`  dir: ${row.path}`);
  openedInBrowser(row, daemon);
}

async function cmdConfiguredLocation(id, args) {
  const location = CONFIG.locations[id];
  if (!location) die(`unknown configured location "${id}"`);
  if (args.includes('--close')) {
    await workstreamCommand(id, 'pause');
    console.log(`Closed configured location "${id}" in FritzWorks.`);
    return;
  }
  const { daemon, result } = await workstreamCommand(id, 'resume', browserRequestBody(args));
  openedInBrowser(result.workstream, daemon);
}

// Reconstitute a worktree if needed and make it the active FritzWorks workspace.
async function cmdJoin(args, verb = 'join') {
  const positional = positionals(args);
  const db = openDb();
  const row = await resolveTarget(db, positional[0] || flagValue(args, '--ws'), verb);

  if (!existsSync(row.path)) console.log(`Worktree missing; reconstituting ${row.org}/${row.repo} @ ${row.branch}`);
  const { daemon, result } = await workstreamCommand(row.id, 'resume', browserRequestBody(args));
  console.log(`  worktree: ${result.workstream.path}`);
  openedInBrowser(result.workstream, daemon);
}

// Stop working on a workstream for now: close its web workspace, keep the worktree.
async function cmdPause(args) {
  const positional = positionals(args);
  const db = openDb();
  const row = await resolveTarget(db, positional[0] || flagValue(args, '--ws'), 'pause');
  await workstreamCommand(row.id, 'pause');
  console.log(`Paused workstream #${row.id} (${row.org}/${row.repo} @ ${row.branch}); worktree kept at ${row.path}`);
}

function cmdConfig() {
  console.log(JSON.stringify(CONFIG, null, 2));
}

async function cmdRefresh() {
  const { result: response } = await requestLocalService('/ws/refresh', {
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
        console.log(`  source: ${status.outdated ? 'outdated; ws web start will restart it' : 'current'}`);
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
  const action = positionals(args)[0] || 'status';
  if (action === 'install') {
    for (const result of installAgentHooks()) {
      console.log(`${result.provider}: ${result.added ? `installed ${result.added} hooks` : 'already installed'} (${result.path})`);
    }
    const shell = installShellHooks();
    console.log(`${shell.provider}: ${shell.added || shell.updated ? 'installed shell hooks' : 'already installed'} (${shell.path})`);
    return;
  }
  if (action === 'status') {
    for (const result of agentHookStatus()) {
      console.log(`${result.provider}: ${result.installed ? 'installed' : 'not installed'} (${result.path})`);
    }
    const shell = shellHookStatus();
    console.log(`${shell.provider}: ${shell.installed ? 'installed' : 'not installed'} (${shell.path})`);
    return;
  }
  die(`unknown hooks action "${action}" (try: install | status)`);
}

function cmdAgentHook(args) {
  if (args[0] === 'shell-status') {
    try {
      recordShellHook(args[1]);
    } catch (error) {
      console.error(`ws hook shell-status: ${error.message}`);
    }
    return;
  }
  if (args[0] !== 'agent-status') die('unknown internal hook');
  try {
    const payload = JSON.parse(readFileSync(0, 'utf8'));
    recordAgentHook(payload);
  } catch (error) {
    // Hooks are observational and must never prevent a prompt, permission, or
    // completed turn from proceeding if their local state update fails.
    console.error(`ws hook agent-status: ${error.message}`);
  }
}

async function cmdWeb(args) {
  const positional = positionals(args, ['--host', '--port']);
  const action = positional[0] || 'start';
  if (action !== 'start') die(`unknown web action "${action}" (try: ws web start)`);
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
  const db = openDb();
  // Two positionals -> [selector, newName]; one -> newName against context/--ws.
  const [selector, explicitName] = positional.length >= 2 ? positional : [flagValue(args, '--ws'), positional[0]];
  const row = await resolveTarget(db, selector, 'rename');
  const newName = explicitName || await prompt('New name: ');
  if (!newName) die('a new name is required');
  const { result } = await workstreamCommand(row.id, 'rename', { name: newName });
  console.log(`Renamed #${result.workstream.id} to "${result.workstream.name || result.workstream.label}"`);
}

async function cmdArchive(args) {
  const keep = args.includes('--keep');
  const discard = args.includes('--delete') || args.includes('--discard');
  const positional = positionals(args);
  const db = openDb();
  const row = await resolveTarget(db, positional[0] || flagValue(args, '--ws'), 'archive');
  const scratch = isScratch(row);
  const noun = scratch ? 'directory' : 'worktree';

  // Git worktrees are removed by default (commits/branch survive in the bare clone);
  // a scratchpad has no such backing, so its directory is kept by default and only
  // removed when explicitly discarded — either way, still confirmed interactively.
  const shouldRemove = scratch ? discard : !keep;
  let remove = false;
  let force = false;
  if (shouldRemove && existsSync(row.path)) {
    const dirty = scratch ? null : worktreeDirty(row.path);
    if (dirty) {
      const lines = dirty.split('\n');
      console.log(`\n⚠  Worktree at ${row.path} has uncommitted changes:`);
      for (const l of lines.slice(0, 10)) console.log(`    ${l}`);
      if (lines.length > 10) console.log(`    … and ${lines.length - 10} more`);
      console.log();
    }
    const question = dirty
      ? `Discard these changes and remove the worktree at ${row.path}?`
      : `Remove the ${noun} at ${row.path}?`;
    if (await confirm(question)) {
      remove = true;
      force = Boolean(dirty);
    } else {
      console.log(`Kept ${noun} at ${row.path}.`);
    }
  } else if (scratch && !discard && existsSync(row.path)) {
    console.log(`Kept scratchpad directory at ${row.path} (resume with: ws resume ${row.id}; --delete to remove).`);
  }
  await workstreamCommand(row.id, 'archive', { remove, force });
  console.log(`Archived workstream #${row.id} (${row.org}/${row.repo} @ ${row.branch})`);
}

// ws stack [show|on|off|link|rebase] — the parent/child chain and its GitHub stack.
const STACK_SUBS = ['show', 'view', 'on', 'set', 'off', 'unset', 'detach', 'link', 'rebase'];

async function cmdStack(args) {
  // `ws stack` defaults to show, including when what follows is a flag or a bare
  // selector (`ws stack 52`, `ws stack --ws 52`) rather than a subcommand.
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
  const r = node.row;
  const indent = '  '.repeat(depth);
  const mark = r.id === focusId ? '▸' : ' ';
  const where = isScratch(r) ? 'scratchpad' : `${r.repo}:${r.branch}`;
  console.log(`  ${mark} ${indent}#${r.id} ${where}  [${r.status === 'closed' ? 'archived' : r.status}]`);
  for (const c of node.children) printStackTree(c, focusId, depth + 1);
}

async function cmdStackShow(args) {
  const db = openDb();
  const row = await resolveTarget(db, positionals(args)[0] || flagValue(args, '--ws'), 'show the stack for');
  const parent = parentOf(db, row);
  const tree = stackTree(db, row);
  if (!parent && tree.children.length === 0) {
    console.log(`#${row.id} (${row.branch}) isn't stacked on anything, and nothing is stacked on it.`);
    console.log(`Stack it with: ws stack on <id|branch> --ws ${row.id}`);
    return;
  }
  console.log('Stack (bottom first):');
  printStackTree(tree, row.id);
  // Only report GitHub-stack eligibility when the chain is linear; a branch point
  // is a legitimate shape here, it just can't be one GitHub stack.
  try {
    const check = stackCheck(stackLine(db, row));
    console.log(check.ok
      ? `\nCan be a GitHub PR stack (${check.repo}): ws stack link --ws ${row.id}`
      : `\nNot a GitHub PR stack: ${check.reason}`);
  } catch (e) {
    console.log(`\nNot a single GitHub PR stack: ${e.message}`);
  }
}

async function cmdStackOn(args) {
  const positional = positionals(args);
  const db = openDb();
  // Two positionals -> [child, parent]; one -> parent against context/--ws.
  const [childSel, parentSel] = positional.length >= 2 ? positional : [flagValue(args, '--ws'), positional[0]];
  const row = await resolveTarget(db, childSel, 'stack');
  const target = parentSel || await prompt('Stack it on (id or branch): ');
  if (!target) die('a parent workstream is required');
  const parent = resolveRow(db, target);
  if (!parent) die(`no workstream matching "${target}"`);
  const updated = setParent(db, row, parent);
  console.log(`#${updated.id} (${updated.branch}) is now stacked on #${parent.id} (${parent.branch})`);
  // Recording the parent doesn't move any commits — say so, since the name suggests it might.
  console.log('  (this records the relationship only; run `ws stack rebase` to move commits)');
}

async function cmdStackOff(args) {
  const db = openDb();
  const row = await resolveTarget(db, positionals(args)[0] || flagValue(args, '--ws'), 'unstack');
  const parent = parentOf(db, row);
  if (!parent) { console.log(`#${row.id} (${row.branch}) isn't stacked on anything.`); return; }
  setParent(db, row, null);
  console.log(`#${row.id} (${row.branch}) is no longer stacked on #${parent.id} (${parent.branch})`);
}

// Push the chain's branches and create/update the stack of PRs on GitHub.
async function cmdStackLink(args) {
  const db = openDb();
  const row = await resolveTarget(db, positionals(args)[0] || flagValue(args, '--ws'), 'link the stack for');
  const chain = stackLine(db, row);
  const check = stackCheck(chain);
  if (!check.ok) die(check.reason);
  console.log(`Linking ${chain.length} branches into a GitHub stack on ${check.repo}:`);
  for (const [i, r] of chain.entries()) console.log(`  ${i + 1}. ${r.branch}`);
  const res = ghStackLink(chain, { open: args.includes('--open') });
  if (res.output) console.log(res.output);
  if (!res.ok) die(`${res.command} failed`);
}

// Cascading rebase down the chain, each branch in its own worktree.
async function cmdStackRebase(args) {
  const db = openDb();
  const row = await resolveTarget(db, positionals(args)[0] || flagValue(args, '--ws'), 'rebase the stack for');
  const chain = stackLine(db, row);
  if (chain.length < 2 && !args.includes('--trunk')) die('nothing to rebase: this chain has one workstream');
  const trunk = args.includes('--trunk');
  const res = rebaseStack(chain, { trunk });
  for (const s of res.steps) {
    console.log(s.ok ? `  ✓ ${s.branch} onto ${s.onto}` : `  ✗ ${s.branch} onto ${s.onto}`);
  }
  if (!res.ok) {
    const failed = res.steps[res.steps.length - 1];
    console.log(`\n${failed.error}`);
    console.log(`\nResolve in ${failed.path}, then: git rebase --continue`);
    console.log(`Re-run \`ws stack rebase --ws ${row.id}\` afterwards to finish the branches above it.`);
    process.exit(1);
  }
  console.log('\nStack rebased. Push the rewritten branches yourself (each needs --force-with-lease).');
}

// ws issue add|remove|list — manage issues linked to a workstream.
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
  const db = openDb();
  // Workstream comes from --ws or the current worktree; positionals are issue refs.
  const row = await resolveTarget(db, flagValue(args, '--ws'), 'add an issue to');
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
  printIssues(db, row.id);
}

async function cmdIssueRemove(args) {
  const positional = positionals(args);
  const db = openDb();
  const row = await resolveTarget(db, flagValue(args, '--ws'), 'remove an issue from');
  let target = positional[0];
  if (!target) {
    printIssues(db, row.id);
    target = await prompt('\nIssue to remove (id or exact link): ');
  }
  if (!target) die('no issue given');
  const { result } = await workstreamCommand(row.id, 'issue-remove', { ref: target });
  const { removed } = result.result;
  console.log(removed ? `Removed issue "${target}" from #${row.id}` : `No matching issue "${target}" on #${row.id}`);
}

async function cmdIssueList(args) {
  const db = openDb();
  const row = await resolveTarget(db, flagValue(args, '--ws'), 'list issues for');
  console.log(`#${row.id} ${row.org}/${row.repo} @ ${row.branch}`);
  printIssues(db, row.id);
}

// ws log [msg...] [--done] — jot a one-line work note against a workstream.
// The workstream comes from --ws or the current worktree; positionals are the note.
async function cmdLog(args) {
  const db = openDb();
  const done = args.includes('--done');
  const row = await resolveTarget(db, flagValue(args, '--ws'), 'log work against');
  let body = positionals(args).join(' ').trim();
  if (!body) body = (await prompt('What did you do? ')).trim();
  if (!body) die('nothing to log');
  const { result } = await workstreamCommand(row.id, 'log', { body, done });
  const entry = result.result;
  console.log(`  logged${entry.done ? ' [done]' : ''}: ${entry.body}`);
  console.log(`  on #${row.id} (${row.org}/${row.repo} @ ${row.branch})`);
}

// ws digest [YYYY-MM-DD] [--write] — assemble a day's activity (commits + work
// logs, with linked issues) into notes-format bullets. Prints them; --write also
// appends them under the day's heading in this week's configured work-notes file.
async function cmdDigest(args) {
  const db = openDb();
  const write = args.includes('--write');
  const date = positionals(args)[0]; // optional YYYY-MM-DD; defaults to today
  const activity = collectDayActivity(db, { date });
  const md = renderDigest(activity);
  if (!md) {
    console.log(`No workstream activity on ${activity.dateIso}.`);
    return;
  }
  console.log(md);
  if (write) {
    const { file, heading } = appendDayEntry(md, activity.date, NOTES_ROOT);
    console.log(`\nAppended under "${heading}" in ${file}`);
  }
}

// ws note list|show — read longer-form notes under the configured notes root.
// They are written by the MCP server's ws_note tool; this is the human read side.
async function cmdNote(args) {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'list': case 'ls': case undefined: return cmdNoteList(rest);
    case 'show': case 'cat': return cmdNoteShow(rest);
    default: die(`unknown 'note' subcommand "${sub}" (try: list | show)`);
  }
}

async function cmdNoteList(args) {
  const db = openDb();
  const row = await resolveTarget(db, flagValue(args, '--ws'), 'list notes for');
  const notes = listNotes(row);
  console.log(`Notes on #${row.id} (${row.org}/${row.repo} @ ${row.branch}):`);
  if (notes.length === 0) { console.log('  (none)'); return; }
  for (const n of notes) console.log(`  ${n.year}/${n.file}`);
}

async function cmdNoteShow(args) {
  const positional = positionals(args);
  const db = openDb();
  const row = await resolveTarget(db, flagValue(args, '--ws'), 'show a note for');
  const file = positional[0] || await prompt('Note filename (see: ws note list): ');
  if (!file) die('no note filename given');
  console.log(readNote(row, file));
}

export function usageText() {
  return `ws — FritzWorks CLI (git worktrees + browser terminals + Claude Code or Codex)

Usage:
  ws list [--all]                  List active workstreams (--all includes archived)
  ws new <org/repo> <ref>          Create and open a FritzWorks workspace (alias: create)
                                   (--parent <id|branch>: branch off that workstream and stack on it)
  ws scratch [name]                Create a scratchpad under the configured root (alias: sp)
                                   (both take repeatable --link <ref> and --seed <file>)
  ws location <name> [--close]     Open any configured location in FritzWorks; --close pauses it
  ws <location-name> [--close]     Shorthand when the name is not another ws command
  ws join [id|branch]              Open in FritzWorks, reconstituting if needed (alias: rejoin)
  ws pause [id|branch]             Close browser terminals but keep the worktree
  ws resume [id|branch]            Open a paused workstream in FritzWorks
  ws archive [id|branch] [--keep]  Archive the session; remove worktree unless --keep
                                   (scratchpads keep their dir by default; --delete removes it)
                                   (aliases: close, rm)
  ws rename [id|branch] <name>     Rename the FritzWorks display name
  ws issue add <link...> [--ws X]       Link Linear/GitHub issues to a workstream
  ws issue remove <link> [--ws X]       Unlink an issue (by link or issue id)
  ws issue list [--ws X]                Show issues linked to a workstream
  ws stack [--ws X]                     Show the parent/child chain this workstream is in
  ws stack on <id|branch> [--ws X]      Record that it's stacked on another workstream
  ws stack off [--ws X]                 Detach it from its parent
  ws stack link [--open] [--ws X]       Push the chain and stack its PRs on GitHub (gh stack link)
  ws stack rebase [--trunk] [--ws X]    Cascade-rebase the chain, each branch in its own worktree
  ws log <msg...> [--done] [--ws X]     Jot a work note (--done marks it completed)
  ws note list [--ws X]                 List longer-form notes (written via the MCP ws_note tool)
  ws note show <file> [--ws X]          Print a note's contents
  ws digest [YYYY-MM-DD] [--write]      Draft a day's notes from commits + work logs
                                        (--write appends to the configured weekly notes file)
  ws config                        Print the resolved configuration and config file path
  ws refresh                       Reconcile status with live browser terminal sessions
  ws hooks [install|status]         Install or inspect Claude/Codex agent-status hooks
  ws daemon [start|stop|restart|status|foreground|log] [--host H] [--port P]
                                   Manage the local REST/WebSocket service (default: start)
  ws web start [--host H] [--port P]
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
selector (id, branch, or org/repo:branch) or --ws; else the worktree you're in;
else an interactive pick. Lifecycle commands start the local service if needed
and update the shared FritzWorks workspace inventory; they never manage terminal tabs.

Configuration: ${CONFIG.configPath}
An MCP server is available as ws-mcp.`;
}

function usage() {
  console.log(usageText());
}

// ---------------------------------------------------------------- entry

export const run = async (argv = process.argv.slice(2)) => {
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
    case 'archive': case 'close': case 'rm': return cmdArchive(rest);
    case 'issue': case 'issues': return cmdIssue(rest);
    case 'stack': return cmdStack(rest);
    case 'log': return cmdLog(rest);
    case 'note': return cmdNote(rest);
    case 'digest': return cmdDigest(rest);
    case 'config': return cmdConfig();
    case 'refresh': return cmdRefresh();
    case 'hooks': return cmdHooks(rest);
    case 'hook': return cmdAgentHook(rest);
    case 'daemon': case 'server': return cmdDaemon(rest);
    case 'web': return cmdWeb(rest);
    case 'version': case '-V': case '--version': return console.log(VERSION);
    case undefined: case 'help': case '-h': case '--help': return usage();
    default:
      if (CONFIG.locations[cmd]) return cmdConfiguredLocation(cmd, rest);
      die(`unknown command "${cmd}" (try: ws help)`);
  }
};

const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) run().catch((e) => die(e.message || String(e)));
