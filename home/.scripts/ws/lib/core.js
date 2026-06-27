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
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOME = homedir();
export const GITHUB_ROOT = join(HOME, 'github');
// Scratchpads are throwaway worktree-shaped workstreams that live in a plain
// directory instead of a git worktree. They're recorded with org=repo=SCRATCH_ORG
// and source='scratch', so the same list/join/pause/close machinery applies. They
// live under ~/scratchpad (not a temp dir) so they survive reboots.
export const SCRATCH_ORG = 'scratch';
export const SCRATCH_ROOT = join(HOME, 'scratchpad');
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

// Update a workstream's recorded directory. Used when the canonical path moves
// (e.g. scratchpads migrating from $TMPDIR to ~/scratchpad).
export function setPath(db, id, path) {
  db.prepare('UPDATE workstreams SET path=? WHERE id=?').run(path, id);
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

// Create (and register) a scratchpad: a plain directory under ~/scratchpad opened
// with the same three-pane tab as a workstream. An unnamed scratchpad gets a random
// name.
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
  // In fork-routed clones the canonical repo is `upstream`; its default branch is
  // the one to base new work on (the fork's HEAD can lag). Fall back to origin.
  const remote = gitTry(['--git-dir', bare, 'remote', 'get-url', 'upstream']) !== null ? 'upstream' : 'origin';
  const ref = gitTry(['--git-dir', bare, 'symbolic-ref', `refs/remotes/${remote}/HEAD`]);
  if (ref) return ref.replace(`refs/remotes/${remote}/`, '');
  const head = gitTry(['--git-dir', bare, 'ls-remote', '--symref', remote, 'HEAD']);
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

// The PR (if any) whose head branch is `branch` on <org>/<repo> — matches PRs from
// the repo itself and from forks (gh's --head filters by head ref name). Prefers an
// open PR, else the most recently created. Returns {number, url, state} or null
// (no gh / no match). Best-effort: callers treat null as "no PR".
export function prForBranch(org, repo, branch) {
  const r = spawnSync('gh', ['pr', 'list', '--repo', `${org}/${repo}`, '--head', branch,
    '--state', 'all', '--limit', '20', '--json', 'number,url,state,createdAt'],
    { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return null;
  try {
    const prs = JSON.parse(r.stdout);
    if (!Array.isArray(prs) || prs.length === 0) return null;
    prs.sort((a, b) => {
      const rank = (p) => (p.state === 'OPEN' ? 0 : 1);
      return rank(a) - rank(b) || String(b.createdAt).localeCompare(String(a.createdAt));
    });
    const pr = prs[0];
    return { number: pr.number, url: pr.url, state: pr.state };
  } catch { return null; }
}

// Link the workstream's branch PR (if any) as an issue. Best-effort and
// idempotent (duplicates are ignored, so resuming won't re-add). Returns
// { pr, added } when a PR was found, else null (no PR / scratchpad / no gh).
export function linkPr(db, row) {
  if (isScratch(row)) return null;
  const pr = prForBranch(row.org, row.repo, row.branch);
  if (!pr) return null;
  const { added } = addIssue(db, row.id, pr.url);
  return { pr, added };
}

// The authenticated GitHub login (from gh), cached. null if gh is missing/unauth'd.
let _login;
function ghLogin() {
  if (_login !== undefined) return _login;
  const r = spawnSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8' });
  _login = r.status === 0 && r.stdout ? r.stdout.trim() : null;
  return _login;
}

// Does a ruleset forbid us from *creating* `branch` on <org>/<repo>? We use the
// rulesets API (`/rules/branches/<ref>`), which any read access can query and
// which reflects the rules effective for a ref — unlike the classic
// branch-protection API, which requires admin. A `creation` rule means new refs
// matching the pattern can't be pushed, so the branch must go through a fork.
// Branch names may contain slashes; the API takes them as path segments.
function branchCreationBlocked(org, repo, branch) {
  const r = spawnSync('gh', ['api', `repos/${org}/${repo}/rules/branches/${branch}`], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return false; // no gh / can't tell -> assume allowed
  try {
    const rules = JSON.parse(r.stdout);
    return Array.isArray(rules) && rules.some((x) => x && x.type === 'creation');
  } catch { return false; }
}

// The user's fork of <org>/<repo>, creating it if needed. Returns {owner, repo}
// or null when gh is unavailable or forking fails.
function ensureFork(org, repo) {
  const login = ghLogin();
  if (!login) return null;
  const view = spawnSync('gh', ['repo', 'view', `${login}/${repo}`, '--json', 'isFork,parent'], { encoding: 'utf8' });
  if (view.status === 0 && view.stdout) {
    try {
      const j = JSON.parse(view.stdout);
      const parent = j.parent && j.parent.nameWithOwner;
      if (j.isFork && (!parent || parent.toLowerCase() === `${org}/${repo}`.toLowerCase())) {
        return { owner: login, repo };
      }
    } catch { /* fall through to fork */ }
  }
  progress(`Creating fork ${login}/${repo} from ${org}/${repo}…`);
  const f = spawnSync('gh', ['repo', 'fork', `${org}/${repo}`, '--clone=false', '--remote=false'],
    { encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'] });
  return f.status === 0 ? { owner: login, repo } : null;
}

// Sleep synchronously — everything in this module drives git via execFileSync.
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Fetch a remote, retrying with backoff: a just-created fork can lag GitHub's
// replication for a second or two before it's fetchable. Normal (already-present)
// remotes succeed on the first try and never sleep.
function fetchWithRetry(bare, remote, tries = 5) {
  for (let i = 0; i < tries - 1; i++) {
    if (gitTry(['--git-dir', bare, 'fetch', remote], { stdio: ['inherit', 'ignore', 'inherit'] }) !== null) return;
    progress(`Fetch of ${remote} failed (fork may still be replicating); retrying in ${i + 1}s…`);
    sleepSync(1000 * (i + 1));
  }
  // Final attempt: let a genuine failure surface to the caller.
  git(['--git-dir', bare, 'fetch', remote], { stdio: ['inherit', 'ignore', 'inherit'] });
}

// Reshape a bare clone for the fork workflow, mirroring a hand-set-up checkout:
//   origin   -> the fork (push target, branches you create live here)
//   upstream -> the canonical repo (fetch only; pushurl disabled)
// Idempotent.
function setupForkTopology(bare, org, repo, fork) {
  const canonicalUrl = `git@github.com:${org}/${repo}.git`;
  const forkUrl = `git@github.com:${fork.owner}/${fork.repo}.git`;
  progress(`Routing ${org}/${repo} through your fork ${fork.owner}/${fork.repo} (origin=fork, upstream=canonical)`);
  ensureRemote(bare, 'upstream', canonicalUrl);
  git(['--git-dir', bare, 'config', 'remote.upstream.fetch', '+refs/heads/*:refs/remotes/upstream/*']);
  git(['--git-dir', bare, 'config', 'remote.upstream.pushurl', 'no_push']);
  git(['--git-dir', bare, 'remote', 'set-url', 'origin', forkUrl]);
  git(['--git-dir', bare, 'fetch', 'upstream'], { stdio: ['inherit', 'ignore', 'inherit'] });
  fetchWithRetry(bare, 'origin'); // origin is the fork — may be freshly created
  gitTry(['--git-dir', bare, 'remote', 'set-head', 'upstream', '--auto']);
}

// True if this clone routes new branches through a fork (origin=fork/upstream=canonical).
const isForkRouted = (bare) => gitTry(['--git-dir', bare, 'config', '--get', 'ws.useFork']) === '1';

// Decide whether `branch` must be created on a fork because a ruleset blocks
// creating it on the canonical repo, and if so switch the clone to fork routing.
// The positive decision is sticky (recorded as ws.useFork): once a repo is
// fork-routed it stays that way; unprotected repos are simply left on origin and
// re-checked on the next new branch (cheap, and avoids caching a wrong "no").
function ensureForkRouting(bare, org, repo, branch) {
  if (isForkRouted(bare)) return;
  if (!branchCreationBlocked(org, repo, branch)) return;
  const fork = ensureFork(org, repo);
  if (!fork) {
    progress(`Creating branches on ${org}/${repo} is restricted but no fork is available; pushes may be rejected.`);
    return;
  }
  setupForkTopology(bare, org, repo, fork);
  git(['--git-dir', bare, 'config', 'ws.useFork', '1']);
}

// Point a freshly created branch at the fork (origin) for push/pull, matching a
// hand-set-up fork checkout. Safe to call when the worktree-add already set this.
function wireForkTracking(bare, branch) {
  git(['--git-dir', bare, 'config', `branch.${branch}.remote`, 'origin']);
  git(['--git-dir', bare, 'config', `branch.${branch}.merge`, `refs/heads/${branch}`]);
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

  // Fork-routed clone: origin is the fork, upstream the canonical repo. Prefer a
  // branch already on the fork (your existing work), then one on the canonical
  // repo, else start a new branch off the canonical default branch.
  if (isForkRouted(bare)) {
    git(['--git-dir', bare, 'fetch', 'upstream'], { stdio: ['inherit', 'ignore', 'inherit'] });
    if (gitTry(['--git-dir', bare, 'rev-parse', '--verify', '--quiet', `origin/${branch}`]) !== null) {
      return `origin/${branch}`;
    }
    if (gitTry(['--git-dir', bare, 'rev-parse', '--verify', '--quiet', `upstream/${branch}`]) !== null) {
      return `upstream/${branch}`;
    }
    const base = `upstream/${defaultBranch(bare)}`;
    progress(`Branch "${branch}" not found; creating it from ${base} (will push to your fork)`);
    return base;
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
  // its directory under ~/scratchpad.
  if (source === 'scratch') {
    const path = scratchPath(branch);
    mkdirSync(path, { recursive: true });
    return path;
  }
  const { container, bare } = repoPaths(org, repo);
  ensureBareClone(org, repo);
  // For plain branches, route the repo through a fork if a ruleset blocks creating
  // refs on the canonical repo. PR/explicit-fork sources manage their own remotes.
  if (!source || source === 'origin') ensureForkRouting(bare, org, repo, branch);
  const path = join(container, sanitize(branch));
  if (existsSync(path)) return path;

  if (localBranchExists(bare, branch)) {
    git(['--git-dir', bare, 'worktree', 'add', path, branch], { stdio: ['inherit', 'ignore', 'inherit'] });
  } else {
    const base = fetchBaseRef(bare, org, repo, branch, source);
    git(['--git-dir', bare, 'worktree', 'add', '-b', branch, path, base], { stdio: ['inherit', 'ignore', 'inherit'] });
    // In a fork-routed clone, push/pull go to the fork even when based on upstream.
    if ((!source || source === 'origin') && isForkRouted(bare)) wireForkTracking(bare, branch);
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
