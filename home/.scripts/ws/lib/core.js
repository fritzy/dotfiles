// ws core — shared logic for the CLI and the MCP server.
//
// A "workstream" is a branch checked out as a git worktree under
//   ~/github/<org>/<repo>/<branch>/   (bare clone at ~/github/<org>/<repo>/.bare)
// recorded in a SQLite db so it can be listed, rejoined (reconstituted if the
// worktree was removed), paused/resumed, closed, and annotated with issues.
//
// Everything here is side-effect-light: data functions touch only the db and
// return values; functions throw Error on failure rather than calling exit, and
// progress/diagnostics go to stderr (never stdout) so this is safe to use from
// an stdio MCP server whose stdout carries the JSON-RPC stream.

import { DatabaseSync } from 'node:sqlite';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const HOME = homedir();
export const GITHUB_ROOT = join(HOME, 'github');
// Scratchpads are throwaway worktree-shaped workstreams that live in a temp dir
// instead of a git worktree. They're recorded with org=repo=SCRATCH_ORG and
// source='scratch', so the same list/join/pause/close machinery applies to them.
export const SCRATCH_ORG = 'scratch';
export const SCRATCH_ROOT = join(tmpdir(), 'ws-scratch');
export const DATA_DIR = join(process.env.XDG_DATA_HOME || join(HOME, '.local', 'share'), 'ws');
export const DB_PATH = join(DATA_DIR, 'workstreams.db');
// Zellij session used when ws is run from outside any session (override with $WS_SESSION).
export const WS_SESSION = process.env.WS_SESSION || 'ws';

export const now = () => new Date().toISOString();
export const sanitize = (branch) => branch.replace(/\//g, '-');
const progress = (msg) => process.stderr.write(`${msg}\n`);

export function git(args, opts = {}) {
  // execFileSync throws on non-zero exit; callers use gitTry when failure is expected.
  // It returns null (not a string) when stdout isn't piped (e.g. stdio inherit/ignore),
  // so guard before trimming.
  const out = execFileSync('git', args, { encoding: 'utf8', ...opts });
  return out == null ? '' : out.trim();
}

export function gitTry(args, opts = {}) {
  try { return git(args, opts); } catch { return null; }
}

// ---------------------------------------------------------------- database

export function openDb() {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS workstreams (
      id INTEGER PRIMARY KEY,
      org TEXT NOT NULL,
      repo TEXT NOT NULL,
      branch TEXT NOT NULL,
      path TEXT NOT NULL,
      tab_name TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'origin',  -- origin | pr:<N> | fork:<owner>
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      last_joined_at TEXT,
      UNIQUE(org, repo, branch)
    );
  `);
  // Migrate older databases that predate the `source` column.
  try { db.exec("ALTER TABLE workstreams ADD COLUMN source TEXT NOT NULL DEFAULT 'origin'"); } catch { /* exists */ }
  db.exec(`
    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY,
      workstream_id INTEGER NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
      ref TEXT NOT NULL,        -- a Linear/GitHub link or identifier
      kind TEXT,                -- linear | github | link
      created_at TEXT NOT NULL,
      UNIQUE(workstream_id, ref)
    );
  `);
  return db;
}

export function upsertWorkstream(db, ws) {
  db.prepare(`
    INSERT INTO workstreams (org, repo, branch, path, tab_name, source, status, created_at, last_joined_at)
    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT(org, repo, branch) DO UPDATE SET
      path = excluded.path,
      tab_name = excluded.tab_name,
      source = excluded.source,
      status = 'active',
      last_joined_at = excluded.last_joined_at
  `).run(ws.org, ws.repo, ws.branch, ws.path, ws.tab_name, ws.source, ws.created_at, ws.last_joined_at);
  return db.prepare('SELECT * FROM workstreams WHERE org=? AND repo=? AND branch=?')
    .get(ws.org, ws.repo, ws.branch);
}

export const listWorkstreams = (db, { all = false } = {}) =>
  db.prepare(
    `SELECT * FROM workstreams ${all ? '' : "WHERE status!='closed'"} ORDER BY last_joined_at DESC, id DESC`
  ).all();

export function setStatus(db, id, status, touchJoined = false) {
  if (touchJoined) {
    db.prepare('UPDATE workstreams SET status=?, last_joined_at=? WHERE id=?').run(status, now(), id);
  } else {
    db.prepare('UPDATE workstreams SET status=? WHERE id=?').run(status, id);
  }
}

// Resolve a selector to a row: numeric id, exact branch, or org/repo:branch.
// Returns null when nothing matches; throws when a branch is ambiguous.
export function resolveRow(db, selector) {
  if (!selector) return null;
  if (/^\d+$/.test(selector)) {
    return db.prepare('SELECT * FROM workstreams WHERE id=?').get(Number(selector));
  }
  if (selector.includes(':')) {
    const [orgRepo, branch] = selector.split(':');
    const [org, repo] = orgRepo.split('/');
    return db.prepare('SELECT * FROM workstreams WHERE org=? AND repo=? AND branch=?')
      .get(org, repo, branch);
  }
  const rows = db.prepare('SELECT * FROM workstreams WHERE branch=?').all(selector);
  if (rows.length > 1) {
    throw new Error(`branch "${selector}" matches multiple workstreams; use id or org/repo:branch`);
  }
  return rows[0] || null;
}

// The workstream whose worktree contains `cwd`, if any. Lets commands default
// to "the workstream I'm standing in" without an explicit selector.
export function currentWorkstream(db, cwd = process.cwd()) {
  let best = null;
  for (const r of db.prepare('SELECT * FROM workstreams').all()) {
    if ((cwd === r.path || cwd.startsWith(r.path + '/')) &&
        (!best || r.path.length > best.path.length)) {
      best = r;
    }
  }
  return best;
}

// ---------------------------------------------------------------- issues

// Best-effort classification of an issue reference, for display only.
export function issueKind(ref) {
  if (/linear\.app/i.test(ref) || /^[A-Z]{2,}-\d+$/.test(ref)) return 'linear';
  if (/github\.com/i.test(ref)) return 'github';
  return 'link';
}

export const listIssues = (db, workstreamId) =>
  db.prepare('SELECT * FROM issues WHERE workstream_id=? ORDER BY id').all(workstreamId);

// All issues grouped by workstream id — for rendering a full list without N+1.
export function issuesByWorkstream(db) {
  const map = {};
  for (const it of db.prepare('SELECT * FROM issues ORDER BY id').all()) {
    (map[it.workstream_id] ||= []).push(it);
  }
  return map;
}

export function addIssue(db, workstreamId, ref) {
  const kind = issueKind(ref);
  const info = db.prepare(
    'INSERT OR IGNORE INTO issues (workstream_id, ref, kind, created_at) VALUES (?, ?, ?, ?)'
  ).run(workstreamId, ref, kind, now());
  return { ref, kind, added: info.changes > 0 };
}

// Remove by the issue's own id (bare number) or by exact link match.
export function removeIssue(db, workstreamId, target) {
  let info;
  if (/^\d+$/.test(target)) {
    info = db.prepare('DELETE FROM issues WHERE workstream_id=? AND id=?').run(workstreamId, Number(target));
  }
  if (!info || info.changes === 0) {
    info = db.prepare('DELETE FROM issues WHERE workstream_id=? AND ref=?').run(workstreamId, target);
  }
  return { removed: info.changes > 0 };
}

// ---------------------------------------------------------------- scratchpads

export const isScratch = (row) => row.source === 'scratch' || row.org === SCRATCH_ORG;

export const scratchPath = (name) => join(SCRATCH_ROOT, name);

// Slug a user-supplied scratchpad name into something safe for a dir/tab name:
// whitespace and other odd characters collapse to single hyphens.
const scratchSlug = (name) =>
  name.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

// A short, readable random name like "calm-otter" for unnamed scratchpads.
const ADJECTIVES = ['calm', 'brisk', 'lucky', 'amber', 'quiet', 'bold', 'spry', 'misty', 'keen', 'tidy'];
const NOUNS = ['otter', 'finch', 'cedar', 'comet', 'maple', 'heron', 'pebble', 'willow', 'lynx', 'reef'];
export function randomScratchName() {
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
}

// Create (and register) a scratchpad: a temp directory opened with the same
// three-pane tab as a workstream. An unnamed scratchpad gets a random name.
// Names collide-avoid by appending a numeric suffix.
export function createScratchpad(db, rawName) {
  let name = (rawName ? scratchSlug(rawName) : '') || randomScratchName();
  // Don't clobber an existing scratchpad of the same name: suffix until unique.
  if (rawName) {
    let n = name, i = 2;
    while (db.prepare('SELECT 1 FROM workstreams WHERE org=? AND repo=? AND branch=?')
      .get(SCRATCH_ORG, SCRATCH_ORG, n)) { n = `${name}-${i++}`; }
    name = n;
  }
  const path = scratchPath(name);
  mkdirSync(path, { recursive: true });
  return upsertWorkstream(db, {
    org: SCRATCH_ORG, repo: SCRATCH_ORG, branch: name, source: 'scratch',
    path, tab_name: `scratchpad:${name}`, created_at: now(), last_joined_at: now(),
  });
}

// ---------------------------------------------------------------- git / worktrees

export function repoPaths(org, repo) {
  const container = join(GITHUB_ROOT, org, repo);
  return { container, bare: join(container, '.bare') };
}

export const hasClone = (org, repo) => existsSync(repoPaths(org, repo).bare);

export function ensureBareClone(org, repo) {
  const { container, bare } = repoPaths(org, repo);
  if (!existsSync(bare)) {
    mkdirSync(container, { recursive: true });
    const url = `git@github.com:${org}/${repo}.git`;
    progress(`Cloning ${url} -> ${bare}`);
    // Use init + fetch rather than `git clone --bare`: clone --bare copies every
    // remote branch into refs/heads/*, which would make worktrees base on frozen,
    // upstream-less local heads. With an empty refs/heads, every branch stays a
    // remote-tracking ref, so `worktree add` bases on a fresh origin/<branch> and
    // sets up tracking. Branches ws itself creates become the only local heads.
    git(['init', '--bare', '-q', bare]);
    git(['--git-dir', bare, 'remote', 'add', 'origin', url]);
    git(['--git-dir', bare, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
    git(['--git-dir', bare, 'fetch', 'origin'], { stdio: ['inherit', 'ignore', 'inherit'] });
    gitTry(['--git-dir', bare, 'remote', 'set-head', 'origin', '--auto']);
  }
  return bare;
}

export function defaultBranch(bare) {
  const ref = gitTry(['--git-dir', bare, 'symbolic-ref', 'refs/remotes/origin/HEAD']);
  if (ref) return ref.replace('refs/remotes/origin/', '');
  const head = gitTry(['--git-dir', bare, 'ls-remote', '--symref', 'origin', 'HEAD']);
  const m = head && head.match(/ref:\s+refs\/heads\/(\S+)\s+HEAD/);
  return m ? m[1] : 'main';
}

const localBranchExists = (bare, branch) =>
  gitTry(['--git-dir', bare, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]) !== null;

function ensureRemote(bare, name, url) {
  if (gitTry(['--git-dir', bare, 'remote', 'get-url', name]) === null) {
    git(['--git-dir', bare, 'remote', 'add', name, url]);
  }
}

// Fetch PR metadata via gh. Returns parsed JSON, or null if gh is missing/fails.
function ghPr(org, repo, number) {
  const r = spawnSync('gh', ['pr', 'view', String(number), '--repo', `${org}/${repo}`,
    '--json', 'number,headRefName,isCrossRepository,headRepositoryOwner,headRepository'],
    { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

// Turn a user selector into the local branch name + how it's sourced.
//   "feature-x"      -> origin branch (origin/local/new)
//   "123" / "#123"   -> PR by number (works for fork PRs via gh / pull refs)
//   "owner:branch"   -> a branch on a fork (owner's clone of this repo)
export function parseSelector(org, repo, selector) {
  const prMatch = selector.match(/^#?(\d+)$/);
  if (prMatch) {
    const n = prMatch[1];
    const pr = ghPr(org, repo, n);
    const branch = pr && pr.headRefName ? pr.headRefName : `pr-${n}`;
    return { branch, source: `pr:${n}` };
  }
  if (selector.includes(':')) {
    const [owner, branch] = selector.split(':');
    if (owner && branch) return { branch, source: `fork:${owner}` };
  }
  return { branch: selector, source: 'origin' };
}

// Fetch whatever ref the worktree should be based on (per `source`) and return it.
// Only called when the local branch doesn't already exist.
function fetchBaseRef(bare, org, repo, branch, source) {
  git(['--git-dir', bare, 'fetch', 'origin'], { stdio: ['inherit', 'ignore', 'inherit'] });

  if (source && source.startsWith('pr:')) {
    const n = source.slice(3);
    const pr = ghPr(org, repo, n);
    if (pr && pr.isCrossRepository) {
      const owner = pr.headRepositoryOwner.login;
      const forkRepo = (pr.headRepository && pr.headRepository.name) || repo;
      ensureRemote(bare, owner, `https://github.com/${owner}/${forkRepo}.git`);
      git(['--git-dir', bare, 'fetch', owner, pr.headRefName], { stdio: ['inherit', 'ignore', 'inherit'] });
      return `${owner}/${pr.headRefName}`; // remote-tracking ref -> sets upstream, push works
    }
    if (pr) return `origin/${pr.headRefName}`; // same-repo PR
    git(['--git-dir', bare, 'fetch', 'origin', `pull/${n}/head`], { stdio: ['inherit', 'ignore', 'inherit'] });
    return 'FETCH_HEAD';
  }

  if (source && source.startsWith('fork:')) {
    const owner = source.slice(5);
    ensureRemote(bare, owner, `https://github.com/${owner}/${repo}.git`);
    git(['--git-dir', bare, 'fetch', owner, branch], { stdio: ['inherit', 'ignore', 'inherit'] });
    return `${owner}/${branch}`;
  }

  if (gitTry(['--git-dir', bare, 'rev-parse', '--verify', '--quiet', `origin/${branch}`]) !== null) {
    return `origin/${branch}`;
  }
  const base = `origin/${defaultBranch(bare)}`;
  progress(`Branch "${branch}" not found on origin; creating it from ${base}`);
  return base;
}

// Create (or reconstitute) the worktree dir for a branch. Idempotent.
export function materializeWorktree(org, repo, branch, source) {
  // Scratchpads aren't git worktrees — reconstituting one just means recreating
  // its temp directory.
  if (source === 'scratch') {
    const path = scratchPath(branch);
    mkdirSync(path, { recursive: true });
    return path;
  }
  const { container, bare } = repoPaths(org, repo);
  ensureBareClone(org, repo);
  const path = join(container, sanitize(branch));
  if (existsSync(path)) return path;

  if (localBranchExists(bare, branch)) {
    git(['--git-dir', bare, 'worktree', 'add', path, branch], { stdio: ['inherit', 'ignore', 'inherit'] });
  } else {
    const base = fetchBaseRef(bare, org, repo, branch, source);
    git(['--git-dir', bare, 'worktree', 'add', '-b', branch, path, base], { stdio: ['inherit', 'ignore', 'inherit'] });
  }
  return path;
}

// Returns the porcelain status lines for a worktree (uncommitted changes,
// untracked files), or null if the path is gone / not a working tree.
export function worktreeDirty(path) {
  if (!existsSync(path)) return null;
  const out = gitTry(['-C', path, 'status', '--porcelain']);
  return out ? out : null;
}

export function removeWorktree(org, repo, path) {
  // Scratchpads are plain temp directories, not git worktrees.
  if (org === SCRATCH_ORG) {
    rmSync(path, { recursive: true, force: true });
    return;
  }
  const { bare } = repoPaths(org, repo);
  // Run from the bare repo, not the inherited cwd: if `ws close` is invoked from
  // inside the worktree being removed, git can't operate on its own cwd and the
  // remove fails (falling through to prune, which leaves the directory behind).
  try {
    git(['--git-dir', bare, 'worktree', 'remove', '--force', path], { cwd: bare, stdio: ['inherit', 'ignore', 'inherit'] });
  } catch {
    gitTry(['--git-dir', bare, 'worktree', 'prune'], { cwd: bare });
    rmSync(path, { recursive: true, force: true });
  }
}

// A plain serialisable view of a workstream row (+ derived fields), for MCP output.
export function workstreamView(db, r, cwd) {
  const cur = cwd !== undefined ? currentWorkstream(db, cwd) : null;
  const scratch = isScratch(r);
  return {
    id: r.id,
    repo: scratch ? 'scratch' : `${r.org}/${r.repo}`,
    branch: r.branch,
    scratch,
    status: r.status,
    source: r.source,
    path: r.path,
    worktreePresent: existsSync(r.path),
    current: cur ? cur.id === r.id : undefined,
    lastJoined: r.last_joined_at,
    issues: listIssues(db, r.id).map((i) => ({ id: i.id, kind: i.kind, ref: i.ref })),
  };
}
