#!/usr/bin/env -S node --no-warnings
// ws CLI — workstream manager (git worktrees + Zellij tabs + Claude Code).
// Shared data/git logic lives in ./lib/core.js (also used by the MCP server).

import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import {
  WS_SESSION, now, sanitize,
  openDb, upsertWorkstream, resolveRow, currentWorkstream, setStatus,
  listWorkstreams, issuesByWorkstream, listIssues, addIssue, removeIssue,
  hasClone, parseSelector, materializeWorktree, removeWorktree,
} from './lib/core.js';

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
function positionals(args, valueFlags = ['--ws']) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (valueFlags.includes(args[i])) { i++; continue; }
    if (args[i].startsWith('--')) continue;
    out.push(args[i]);
  }
  return out;
}

function printIssues(db, workstreamId) {
  const issues = listIssues(db, workstreamId);
  if (issues.length === 0) { console.log('  (no issues linked)'); return; }
  for (const it of issues) console.log(`  ${String(it.id).padStart(3)}  [${it.kind}] ${it.ref}`);
}

// ---------------------------------------------------------------- zellij

const inZellij = () => Boolean(process.env.ZELLIJ);

function zellij(args, opts = {}) {
  return spawnSync('zellij', args, { encoding: 'utf8', ...opts });
}

function tabNames() {
  const r = zellij(['action', 'query-tab-names']);
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

// Names of sessions that are currently running (excludes EXITED/resurrectable ones).
function runningSessions() {
  const r = zellij(['list-sessions', '--no-formatting']);
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout.split('\n')
    .filter((l) => l.trim() && !l.includes('EXITED'))
    .map((l) => l.trim().split(/\s+/)[0]);
}

function writeLayout(row) {
  const file = join(tmpdir(), `ws-layout-${process.pid}-${row.id}.kdl`);
  // Include the tab-bar plugin pane explicitly: a layout passed to `new-tab`
  // replaces that tab's whole template, so without it this tab would lose the
  // top tab row that default tabs show. We deliberately omit the bottom
  // status-bar (shortcut) pane to keep the tab clean.
  const kdl = `layout {
    tab name="${row.tab_name}" cwd="${row.path}" {
        pane size=1 borderless=true {
            plugin location="zellij:tab-bar"
        }
        pane split_direction="vertical" {
            pane name="zsh"
            pane name="nvim"   command="nvim"
            // Resume this worktree's most recent Claude session; if there is
            // none (a brand-new worktree), --continue exits non-zero and we
            // fall back to a fresh session. --continue is scoped to cwd, so it
            // picks up exactly this workstream's prior conversation.
            pane name="claude" command="zsh" {
                args "-c" "claude --continue || claude"
            }
        }
    }
}
`;
  writeFileSync(file, kdl);
  return file;
}

function openTab(row) {
  const file = writeLayout(row);

  // Inside a session already: add (or focus) the tab in that session.
  if (inZellij()) {
    if (tabNames().includes(row.tab_name)) {
      zellij(['action', 'go-to-tab-name', row.tab_name], { stdio: 'inherit' });
      return;
    }
    const r = zellij(['action', 'new-tab', '--layout', file], { stdio: 'inherit' });
    if (r.status !== 0) die('failed to create Zellij tab');
    zellij(['action', 'go-to-tab-name', row.tab_name], { stdio: 'inherit' });
    return;
  }

  // Outside any session: attach to (or create) the ws session. With --session,
  // `--layout` adds the tab to an existing session or starts a new one named WS_SESSION.
  const verb = runningSessions().includes(WS_SESSION) ? 'Attaching to' : 'Starting';
  console.log(`${verb} Zellij session "${WS_SESSION}" for "${row.tab_name}"...`);
  spawnSync('zellij', ['--session', WS_SESSION, '--layout', file], { stdio: 'inherit' });
}

function closeTab(row) {
  if (inZellij() && tabNames().includes(row.tab_name)) {
    zellij(['action', 'go-to-tab-name', row.tab_name]);
    zellij(['action', 'close-tab']);
  }
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
  cmdList([]);
  const picked = await prompt(`\nWorkstream to ${verb} (id or branch): `);
  const row = resolveRow(db, picked);
  if (!row) die(`no workstream matching "${picked}"`);
  return row;
}

// ---------------------------------------------------------------- commands

function cmdList(args) {
  const db = openDb();
  const rows = listWorkstreams(db, { all: args.includes('--all') });
  if (rows.length === 0) {
    console.log('No workstreams yet. Create one with: ws new <org/repo> <branch>');
    return;
  }
  const issues = issuesByWorkstream(db);
  const current = currentWorkstream(db);
  const fmt = (s, w) => String(s ?? '').padEnd(w);
  console.log([fmt('ID', 4), fmt('', 3), fmt('REPO', 28), fmt('BRANCH', 24), fmt('STATUS', 8), 'LAST JOINED'].join(' '));
  for (const r of rows) {
    // "▸" marks the workstream containing the current directory; ●/○ = worktree present.
    const mark = (current && current.id === r.id ? '▸' : ' ') + (existsSync(r.path) ? '●' : '○');
    const last = r.last_joined_at ? r.last_joined_at.replace('T', ' ').slice(0, 16) : '—';
    console.log([
      fmt(r.id, 4), fmt(mark, 3), fmt(`${r.org}/${r.repo}`, 28),
      fmt(r.branch, 24), fmt(r.status, 8), last,
    ].join(' '));
    for (const it of issues[r.id] || []) {
      console.log(`         ↳ [${it.kind}] ${it.ref}`);
    }
  }
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

  const { branch, source } = parseSelector(org, repo, selector);
  const path = materializeWorktree(org, repo, branch, source);
  const db = openDb();
  const row = upsertWorkstream(db, {
    org, repo, branch, source, path,
    tab_name: `${repo}:${sanitize(branch)}`,
    created_at: now(),
    last_joined_at: now(),
  });
  console.log(`Workstream #${row.id}: ${org}/${repo} @ ${branch}`);
  console.log(`  worktree: ${path}`);
  openTab(row);
}

// Open (or focus) a workstream's tab, reconstituting the worktree if it's gone.
// Backs both `join`/`rejoin` and `resume`.
async function cmdJoin(args, verb = 'join') {
  const positional = positionals(args);
  const db = openDb();
  const row = await resolveTarget(db, positional[0] || flagValue(args, '--ws'), verb);

  if (!existsSync(row.path)) {
    console.log(`Worktree missing; reconstituting at ${row.path}`);
    materializeWorktree(row.org, row.repo, row.branch, row.source);
  }
  setStatus(db, row.id, 'active', true);
  openTab(row); // focuses the tab if it already exists, else creates it
}

// Stop working on a workstream for now: close its tab, keep the worktree.
async function cmdPause(args) {
  const positional = positionals(args);
  const db = openDb();
  const row = await resolveTarget(db, positional[0] || flagValue(args, '--ws'), 'pause');
  closeTab(row);
  setStatus(db, row.id, 'paused');
  console.log(`Paused workstream #${row.id} (${row.org}/${row.repo} @ ${row.branch}); worktree kept at ${row.path}`);
}

async function cmdClose(args) {
  const keep = args.includes('--keep');
  const positional = positionals(args);
  const db = openDb();
  const row = await resolveTarget(db, positional[0] || flagValue(args, '--ws'), 'close');

  closeTab(row);
  if (!keep && existsSync(row.path)) {
    if (await confirm(`Remove the worktree at ${row.path}?`)) {
      removeWorktree(row.org, row.repo, row.path);
    }
  }
  setStatus(db, row.id, 'closed');
  console.log(`Closed workstream #${row.id} (${row.org}/${row.repo} @ ${row.branch})`);
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
  for (const ref of refs) {
    const { added, kind } = addIssue(db, row.id, ref);
    console.log(added ? `  + [${kind}] ${ref}` : `  (already linked) ${ref}`);
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
  const { removed } = removeIssue(db, row.id, target);
  console.log(removed ? `Removed issue "${target}" from #${row.id}` : `No matching issue "${target}" on #${row.id}`);
}

async function cmdIssueList(args) {
  const db = openDb();
  const row = await resolveTarget(db, flagValue(args, '--ws'), 'list issues for');
  console.log(`#${row.id} ${row.org}/${row.repo} @ ${row.branch}`);
  printIssues(db, row.id);
}

function usage() {
  console.log(`ws — workstream manager (git worktrees + Zellij + Claude Code)

Usage:
  ws list [--all]                  List active workstreams (--all includes closed)
  ws new <org/repo> <ref>          Create/open a workstream (alias: create)
  ws join [id|branch]              Rejoin a workstream, reconstituting it if needed (alias: rejoin)
  ws pause [id|branch]             Close the tab but keep the worktree (status: paused)
  ws resume [id|branch]            Reopen a paused workstream's tab (reconstitutes if needed)
  ws close [id|branch] [--keep]    Close the tab; remove worktree unless --keep
  ws issue add <link...> [--ws X]       Link Linear/GitHub issues to a workstream
  ws issue remove <link> [--ws X]       Unlink an issue (by link or issue id)
  ws issue list [--ws X]                Show issues linked to a workstream

<ref> for "new" is one of:
  feature-x        a branch on origin (created off the default branch if new)
  123  or  #123    a pull request by number — works for fork PRs too
  owner:feature-x  a branch on someone's fork of this repo

Context: commands that act on a workstream take it from, in order: the given
selector (id, branch, or org/repo:branch) or --ws; else the worktree you're in;
else an interactive pick. Run from outside Zellij, join/resume/new attach to (or
create) the "${WS_SESSION}" session ($WS_SESSION to change); from inside, they use the
current session.

An MCP server (mcp.js) exposes the read/issue operations to Claude sessions.`);
}

// ---------------------------------------------------------------- entry

const [cmd, ...rest] = process.argv.slice(2);
const run = async () => {
  switch (cmd) {
    case 'list': case 'ls': return cmdList(rest);
    case 'new': case 'create': return cmdNew(rest);
    case 'join': case 'rejoin': return cmdJoin(rest);
    case 'resume': return cmdJoin(rest, 'resume');
    case 'pause': return cmdPause(rest);
    case 'close': case 'rm': return cmdClose(rest);
    case 'issue': case 'issues': return cmdIssue(rest);
    case undefined: case 'help': case '-h': case '--help': return usage();
    default: die(`unknown command "${cmd}" (try: ws help)`);
  }
};
run().catch((e) => die(e.message || String(e)));
