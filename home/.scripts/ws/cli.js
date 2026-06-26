#!/usr/bin/env -S node --no-warnings
// ws CLI — workstream manager (git worktrees + Zellij tabs + Claude Code).
// Shared data/git logic lives in ./lib/core.js (also used by the MCP server).

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import {
  WS_SESSION, now, sanitize, isScratch,
  openDb, upsertWorkstream, resolveRow, currentWorkstream, setStatus,
  listWorkstreams, issuesByWorkstream, listIssues, addIssue, removeIssue,
  hasClone, parseSelector, materializeWorktree, removeWorktree, worktreeDirty,
  createScratchpad,
} from './lib/core.js';
import { openTab, closeTab } from './lib/zellij.js';

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
    const repoLabel = isScratch(r) ? 'scratch' : `${r.org}/${r.repo}`;
    console.log([
      fmt(r.id, 4), fmt(mark, 3), fmt(repoLabel, 28),
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

// Create a scratchpad: a throwaway temp-dir workstream with the same three-pane
// tab. With no name, a random one is generated.
async function cmdScratch(args) {
  const name = positionals(args)[0];
  const db = openDb();
  const row = createScratchpad(db, name);
  console.log(`Scratchpad #${row.id}: ${row.branch}`);
  console.log(`  dir: ${row.path}`);
  openTab(row);
}

// Open (or focus) the three-pane tab for ~/dotfiles. Not a workstream: no
// worktree, no db row — just the same tab layout pointed at the dotfiles repo.
function cmdDotfiles() {
  openTab({ id: 'dotfiles', tab_name: 'dotfiles', path: join(homedir(), 'dotfiles') });
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad2 = (n) => String(n).padStart(2, '0');
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

// The Monday that starts the week containing `d` (notes use Monday-based weeks).
function weekMonday(d = new Date()) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + (date.getDay() === 0 ? -6 : 1 - date.getDay()));
  return date;
}

// Ensure the current week's work-notes file exists under <root>/work/<YYYY>/ and
// return its path. Matches the notes skill's layout: <YYYY-MM-DD>-week.md keyed to
// the week's Monday, scaffolded with a heading per weekday. Honors an existing file
// (dashed or older compact name) rather than creating a duplicate.
function ensureWeeklyNote(root) {
  const monday = weekMonday();
  const iso = `${monday.getFullYear()}-${pad2(monday.getMonth() + 1)}-${pad2(monday.getDate())}`;
  const dir = join(root, 'work', String(monday.getFullYear()));
  const file = join(dir, `${iso}-week.md`);
  const compact = join(dir, `${monday.getFullYear()}${pad2(monday.getMonth() + 1)}${pad2(monday.getDate())}-week.md`);
  if (existsSync(file)) return file;
  if (existsSync(compact)) return compact;

  const headings = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    headings.push(`## ${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${ordinal(d.getDate())}, ${d.getFullYear()}`);
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, headings.join('\n\n') + '\n');
  console.log(`Created weekly note ${file}`);
  return file;
}

// Open (or focus) the three-pane tab for ~/notes, ensuring the current weekly
// work-notes file exists and loading it in nvim. Not a workstream: no worktree, no db.
function cmdNotes() {
  const root = join(homedir(), 'notes');
  const file = ensureWeeklyNote(root);
  openTab({ id: 'notes', tab_name: 'notes', path: root }, { nvimFile: file });
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
    const noun = isScratch(row) ? 'directory' : 'worktree';
    const dirty = worktreeDirty(row.path);
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
      removeWorktree(row.org, row.repo, row.path);
    } else {
      console.log(`Kept ${noun} at ${row.path}.`);
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
  ws scratch [name]                Create a throwaway scratchpad in a temp dir (alias: sp)
  ws dotfiles                      Open the three-pane tab for ~/dotfiles (no worktree, no db)
  ws notes                         Open the three-pane tab for ~/notes; nvim loads this week's note
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
    case 'scratch': case 'scratchpad': case 'sp': return cmdScratch(rest);
    case 'dotfiles': return cmdDotfiles();
    case 'notes': return cmdNotes();
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
