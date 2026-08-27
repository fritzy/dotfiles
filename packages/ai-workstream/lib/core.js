// ai-workstream core — shared logic for the CLI and the MCP server.
//
// A "workstream" is a branch checked out under the configured repository root
// recorded in a SQLite db so it can be listed, rejoined (reconstituted if the
// worktree was removed), paused/resumed, closed, and annotated with issues.
//
// Everything here is side-effect-light: data functions touch only the db and
// return values; functions throw Error on failure rather than calling exit, and
// progress/diagnostics go to stderr (never stdout) so this is safe to use from
// an stdio MCP server whose stdout carries the JSON-RPC stream.

import { DatabaseSync } from 'node:sqlite';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, renameSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { CONFIG } from './config.js';

export const HOME = CONFIG.home;
export const GITHUB_ROOT = CONFIG.paths.repositories;
// Scratchpads are throwaway worktree-shaped workstreams that live in a plain
// directory instead of a git worktree. They're recorded with org=repo=SCRATCH_ORG
// and source='scratch', so the same list/join/pause/close machinery applies. They
// live under the configured scratchpad root so they survive reboots.
export const SCRATCH_ORG = 'scratch';
export const SCRATCH_ROOT = CONFIG.paths.scratchpads;
export const DATA_DIR = CONFIG.paths.data;
export const DB_PATH = join(DATA_DIR, 'workstreams.db');
// Seed documents handed to a workstream's agent panel on open (see writeSeed).
export const SEEDS_DIR = join(DATA_DIR, 'seeds');
// Zellij session used when ws is run from outside any session.
export const WS_SESSION = CONFIG.zellijSession;

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

export function openDb(path = DB_PATH) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE IF NOT EXISTS workstreams (
      id INTEGER PRIMARY KEY,
      org TEXT NOT NULL,
      repo TEXT NOT NULL,
      branch TEXT NOT NULL,
      path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'origin',  -- origin | pr:<N> | fork:<owner>
      status TEXT NOT NULL DEFAULT 'active',
      agent_status TEXT CHECK(agent_status IN ('working', 'ready')),
      shell_status TEXT CHECK(shell_status IN ('working', 'ready')),
      agent TEXT CHECK(agent IN ('claude', 'codex')),
      git_clean INTEGER CHECK(git_clean IN (0, 1)),
      label TEXT,               -- optional display name override (set via ws rename)
      parent_id INTEGER,        -- the workstream this one is stacked on (see stacks below)
      created_at TEXT NOT NULL,
      last_joined_at TEXT,
      UNIQUE(org, repo, branch)
    );
  `);
  // Migrate older databases that predate the `source`/`label` columns, and drop
  // the old `tab_name` column now that it's computed on demand (see computeTabName)
  // instead of stored — storing it let stale rows keep a pre-id-prefix name forever.
  try { db.exec("ALTER TABLE workstreams ADD COLUMN source TEXT NOT NULL DEFAULT 'origin'"); } catch { /* exists */ }
  try { db.exec("ALTER TABLE workstreams ADD COLUMN agent_status TEXT CHECK(agent_status IN ('working', 'ready'))"); } catch { /* exists */ }
  try { db.exec("ALTER TABLE workstreams ADD COLUMN shell_status TEXT CHECK(shell_status IN ('working', 'ready'))"); } catch { /* exists */ }
  try { db.exec("ALTER TABLE workstreams ADD COLUMN agent TEXT CHECK(agent IN ('claude', 'codex'))"); } catch { /* exists */ }
  try { db.exec('ALTER TABLE workstreams ADD COLUMN git_clean INTEGER CHECK(git_clean IN (0, 1))'); } catch { /* exists */ }
  try { db.exec('ALTER TABLE workstreams ADD COLUMN label TEXT'); } catch { /* exists */ }
  // parent_id carries no REFERENCES clause: rows are only ever status='closed',
  // never deleted, so there's nothing for a cascade to do — and a plain column
  // keeps this migration byte-identical to the CREATE above. Readers tolerate a
  // dangling id (parentOf returns null) rather than trusting referential integrity.
  try { db.exec('ALTER TABLE workstreams ADD COLUMN parent_id INTEGER'); } catch { /* exists */ }
  try { db.exec('ALTER TABLE workstreams DROP COLUMN tab_name'); } catch { /* already dropped */ }
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY,
      workstream_id INTEGER NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,
      body TEXT NOT NULL,       -- a one-line note of what was done / figured out
      done INTEGER NOT NULL DEFAULT 0,  -- 1 = a completed item (vs. progress note)
      created_at TEXT NOT NULL
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS workstream_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      workstream_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('new_session', 'update_session', 'agent_status', 'shell_status')),
      agent_status TEXT CHECK(agent_status IN ('working', 'ready')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK(type IN ('agent_status', 'shell_status') OR agent_status IS NULL),
      CHECK(type NOT IN ('agent_status', 'shell_status') OR agent_status IS NOT NULL)
    );
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS configured_location_state (
      id TEXT PRIMARY KEY,
      agent_status TEXT CHECK(agent_status IN ('working', 'ready')),
      shell_status TEXT CHECK(shell_status IN ('working', 'ready')),
      agent TEXT CHECK(agent IN ('claude', 'codex')),
      git_clean INTEGER CHECK(git_clean IN (0, 1))
    );
  `);
  try { db.exec("ALTER TABLE configured_location_state ADD COLUMN shell_status TEXT CHECK(shell_status IN ('working', 'ready'))"); } catch { /* exists */ }
  try { db.exec("ALTER TABLE configured_location_state ADD COLUMN agent TEXT CHECK(agent IN ('claude', 'codex'))"); } catch { /* exists */ }
  try { db.exec('ALTER TABLE configured_location_state ADD COLUMN git_clean INTEGER CHECK(git_clean IN (0, 1))'); } catch { /* exists */ }
  const configuredLocationSchema = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type='table' AND name='configured_location_state'
  `).get()?.sql || '';
  if (/CHECK\s*\(\s*id\s+IN\s*\(/i.test(configuredLocationSchema)) {
    db.exec(`
      DROP TRIGGER IF EXISTS configured_location_event_agent_status_changed;
      DROP TRIGGER IF EXISTS configured_location_event_agent_changed;
      DROP TRIGGER IF EXISTS configured_location_event_git_clean_changed;
      ALTER TABLE configured_location_state RENAME TO configured_location_state_legacy;
      CREATE TABLE configured_location_state (
        id TEXT PRIMARY KEY,
        agent_status TEXT CHECK(agent_status IN ('working', 'ready')),
        shell_status TEXT CHECK(shell_status IN ('working', 'ready')),
        agent TEXT CHECK(agent IN ('claude', 'codex')),
        git_clean INTEGER CHECK(git_clean IN (0, 1))
      );
      INSERT INTO configured_location_state (id, agent_status, shell_status, agent, git_clean)
      SELECT id, agent_status, shell_status, agent, git_clean FROM configured_location_state_legacy;
      DROP TABLE configured_location_state_legacy;
    `);
  }
  // Migrate the original invalidation journal without discarding pending events.
  // Trigger names are dropped first because SQLite rewrites their target table
  // when a table is renamed, which would otherwise leave them writing to the
  // temporary legacy table.
  const eventColumns = db.prepare('PRAGMA table_info(workstream_events)').all();
  if (eventColumns.some(({ name }) => name === 'change')) {
    db.exec(`
      DROP TRIGGER IF EXISTS workstream_event_created;
      DROP TRIGGER IF EXISTS workstream_event_status_changed;
      DROP TRIGGER IF EXISTS workstream_event_issue_added;
      DROP TRIGGER IF EXISTS workstream_event_issue_removed;
      ALTER TABLE workstream_events RENAME TO workstream_events_legacy;
      CREATE TABLE workstream_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        workstream_id INTEGER NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('new_session', 'update_session', 'agent_status', 'shell_status')),
        agent_status TEXT CHECK(agent_status IN ('working', 'ready')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(type IN ('agent_status', 'shell_status') OR agent_status IS NULL),
        CHECK(type NOT IN ('agent_status', 'shell_status') OR agent_status IS NOT NULL)
      );
      INSERT INTO workstream_events (sequence, workstream_id, type, created_at)
      SELECT sequence, workstream_id,
        CASE change WHEN 'new' THEN 'new_session' ELSE 'update_session' END,
        created_at
      FROM workstream_events_legacy;
      DROP TABLE workstream_events_legacy;
    `);
  }
  const eventSchema = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type='table' AND name='workstream_events'
  `).get()?.sql || '';
  if (!eventSchema.includes("'shell_status'")) {
    db.exec(`
      DROP TRIGGER IF EXISTS workstream_event_created;
      DROP TRIGGER IF EXISTS workstream_event_status_changed;
      DROP TRIGGER IF EXISTS workstream_event_agent_status_changed;
      DROP TRIGGER IF EXISTS workstream_event_shell_status_changed;
      DROP TRIGGER IF EXISTS workstream_event_agent_changed;
      DROP TRIGGER IF EXISTS workstream_event_git_clean_changed;
      DROP TRIGGER IF EXISTS workstream_event_label_changed;
      DROP TRIGGER IF EXISTS configured_location_event_agent_status_changed;
      DROP TRIGGER IF EXISTS configured_location_event_shell_status_changed;
      DROP TRIGGER IF EXISTS configured_location_event_agent_changed;
      DROP TRIGGER IF EXISTS configured_location_event_git_clean_changed;
      DROP TRIGGER IF EXISTS workstream_event_issue_added;
      DROP TRIGGER IF EXISTS workstream_event_issue_removed;
      ALTER TABLE workstream_events RENAME TO workstream_events_before_shell_status;
      CREATE TABLE workstream_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        workstream_id INTEGER NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('new_session', 'update_session', 'agent_status', 'shell_status')),
        agent_status TEXT CHECK(agent_status IN ('working', 'ready')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(type IN ('agent_status', 'shell_status') OR agent_status IS NULL),
        CHECK(type NOT IN ('agent_status', 'shell_status') OR agent_status IS NOT NULL)
      );
      INSERT INTO workstream_events (sequence, workstream_id, type, agent_status, created_at)
      SELECT sequence, workstream_id, type, agent_status, created_at
      FROM workstream_events_before_shell_status;
      DROP TABLE workstream_events_before_shell_status;
    `);
  }
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS workstream_event_created
    AFTER INSERT ON workstreams
    BEGIN
      INSERT INTO workstream_events (workstream_id, type) VALUES (NEW.id, 'new_session');
    END;

    CREATE TRIGGER IF NOT EXISTS workstream_event_status_changed
    AFTER UPDATE OF status ON workstreams
    WHEN OLD.status IS NOT NEW.status
    BEGIN
      INSERT INTO workstream_events (workstream_id, type) VALUES (NEW.id, 'update_session');
    END;

    CREATE TRIGGER IF NOT EXISTS workstream_event_agent_status_changed
    AFTER UPDATE OF agent_status ON workstreams
    WHEN OLD.agent_status IS NOT NEW.agent_status AND NEW.agent_status IS NOT NULL
    BEGIN
      INSERT INTO workstream_events (workstream_id, type, agent_status)
      VALUES (NEW.id, 'agent_status', NEW.agent_status);
    END;

    CREATE TRIGGER IF NOT EXISTS workstream_event_shell_status_changed
    AFTER UPDATE OF shell_status ON workstreams
    WHEN OLD.shell_status IS NOT NEW.shell_status
    BEGIN
      INSERT INTO workstream_events (workstream_id, type, agent_status)
      VALUES (
        NEW.id,
        CASE WHEN NEW.shell_status IS NULL THEN 'update_session' ELSE 'shell_status' END,
        NEW.shell_status
      );
    END;

    CREATE TRIGGER IF NOT EXISTS workstream_event_agent_changed
    AFTER UPDATE OF agent ON workstreams
    WHEN OLD.agent IS NOT NEW.agent
    BEGIN
      INSERT INTO workstream_events (workstream_id, type) VALUES (NEW.id, 'update_session');
    END;

    CREATE TRIGGER IF NOT EXISTS workstream_event_git_clean_changed
    AFTER UPDATE OF git_clean ON workstreams
    WHEN OLD.git_clean IS NOT NEW.git_clean
    BEGIN
      INSERT INTO workstream_events (workstream_id, type) VALUES (NEW.id, 'update_session');
    END;

    CREATE TRIGGER IF NOT EXISTS workstream_event_label_changed
    AFTER UPDATE OF label ON workstreams
    WHEN OLD.label IS NOT NEW.label
    BEGIN
      INSERT INTO workstream_events (workstream_id, type) VALUES (NEW.id, 'update_session');
    END;

    CREATE TRIGGER IF NOT EXISTS configured_location_event_agent_status_changed
    AFTER UPDATE OF agent_status ON configured_location_state
    WHEN OLD.agent_status IS NOT NEW.agent_status AND NEW.agent_status IS NOT NULL
    BEGIN
      INSERT INTO workstream_events (workstream_id, type, agent_status)
      VALUES (NEW.id, 'agent_status', NEW.agent_status);
    END;

    CREATE TRIGGER IF NOT EXISTS configured_location_event_shell_status_changed
    AFTER UPDATE OF shell_status ON configured_location_state
    WHEN OLD.shell_status IS NOT NEW.shell_status
    BEGIN
      INSERT INTO workstream_events (workstream_id, type, agent_status)
      VALUES (
        NEW.id,
        CASE WHEN NEW.shell_status IS NULL THEN 'update_session' ELSE 'shell_status' END,
        NEW.shell_status
      );
    END;

    CREATE TRIGGER IF NOT EXISTS configured_location_event_agent_changed
    AFTER UPDATE OF agent ON configured_location_state
    WHEN OLD.agent IS NOT NEW.agent
    BEGIN
      INSERT INTO workstream_events (workstream_id, type) VALUES (NEW.id, 'update_session');
    END;

    CREATE TRIGGER IF NOT EXISTS configured_location_event_git_clean_changed
    AFTER UPDATE OF git_clean ON configured_location_state
    WHEN OLD.git_clean IS NOT NEW.git_clean
    BEGIN
      INSERT INTO workstream_events (workstream_id, type) VALUES (NEW.id, 'update_session');
    END;

    CREATE TRIGGER IF NOT EXISTS workstream_event_issue_added
    AFTER INSERT ON issues
    BEGIN
      INSERT INTO workstream_events (workstream_id, type) VALUES (NEW.workstream_id, 'update_session');
    END;

    CREATE TRIGGER IF NOT EXISTS workstream_event_issue_removed
    AFTER DELETE ON issues
    BEGIN
      INSERT INTO workstream_events (workstream_id, type) VALUES (OLD.workstream_id, 'update_session');
    END;
  `);
  return db;
}

export const latestWorkstreamEventSequence = (db) =>
  Number(db.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM workstream_events').get().sequence);

export const workstreamEventsAfter = (db, sequence) =>
  db.prepare(`
    SELECT sequence, workstream_id AS id, type, agent_status AS status
    FROM workstream_events
    WHERE sequence > ?
    ORDER BY sequence
  `).all(sequence).map((event) => {
    const stringId = String(event.id);
    return {
      id: /^\d+$/.test(stringId) ? Number(stringId) : stringId,
      type: event.type,
      ...(['agent_status', 'shell_status'].includes(event.type) ? { status: event.status } : {}),
      sequence: Number(event.sequence),
    };
  });

// The tab name for a workstream: derived on demand from its id, org/repo/branch
// (or label override), never stored — so it can't go stale relative to those
// fields. `row.tab_name` lets synthetic configured-location tabs pass a
// literal name straight through instead of being computed.
export function computeTabName(row) {
  if (row.tab_name) return row.tab_name;
  const base = row.label || (isScratch(row) ? `scratchpad:${row.branch}` : `${row.repo}:${sanitize(row.branch)}`);
  return `${row.id}:${base}`;
}

export function upsertWorkstream(db, ws) {
  db.prepare(`
    INSERT INTO workstreams (org, repo, branch, path, source, status, created_at, last_joined_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT(org, repo, branch) DO UPDATE SET
      path = excluded.path,
      source = excluded.source,
      status = 'active',
      last_joined_at = excluded.last_joined_at
  `).run(ws.org, ws.repo, ws.branch, ws.path, ws.source, ws.created_at, ws.last_joined_at);
  return db.prepare('SELECT * FROM workstreams WHERE org=? AND repo=? AND branch=?')
    .get(ws.org, ws.repo, ws.branch);
}

// Rename a workstream's display name. For a scratchpad (a made-up name with no
// git identity) this renames the branch field itself and moves its directory.
// For a git-backed workstream, renaming only sets a `label` override — the
// underlying branch is untouched, since renaming a real git branch is a much
// bigger operation.
export function renameWorkstream(db, row, newName) {
  if (isScratch(row)) {
    const slug = scratchSlug(newName);
    if (!slug) throw new Error('empty name');
    let n = slug, i = 2;
    while (n !== row.branch && db.prepare(
      'SELECT 1 FROM workstreams WHERE org=? AND repo=? AND branch=? AND id!=?'
    ).get(SCRATCH_ORG, SCRATCH_ORG, n, row.id)) { n = `${slug}-${i++}`; }
    const newPath = scratchPath(n);
    if (n !== row.branch) {
      if (existsSync(row.path)) renameSync(row.path, newPath);
      else mkdirSync(newPath, { recursive: true });
    }
    db.prepare('UPDATE workstreams SET branch=?, path=? WHERE id=?').run(n, newPath, row.id);
  } else {
    const label = newName.trim();
    if (!label) throw new Error('empty name');
    db.prepare('UPDATE workstreams SET label=? WHERE id=?').run(label, row.id);
  }
  return db.prepare('SELECT * FROM workstreams WHERE id=?').get(row.id);
}

// Change only the user-facing name. Unlike renameWorkstream's scratchpad path,
// this deliberately leaves the branch and directory untouched.
export function setWorkstreamLabel(db, row, newName) {
  const label = newName.trim();
  if (!label) throw new Error('empty name');
  db.prepare('UPDATE workstreams SET label=? WHERE id=?').run(label, row.id);
  return db.prepare('SELECT * FROM workstreams WHERE id=?').get(row.id);
}

export const listWorkstreams = (db, { all = false } = {}) =>
  db.prepare(
    `SELECT * FROM workstreams ${all ? '' : "WHERE status!='closed'"} ORDER BY last_joined_at DESC, id DESC`
  ).all();

export function recentRepositories(db, { months = 3, reference = new Date() } = {}) {
  const cutoff = new Date(reference);
  if (Number.isNaN(cutoff.valueOf())) throw new Error('invalid recent repository reference date');
  const originalDay = cutoff.getUTCDate();
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate();
  cutoff.setUTCDate(Math.min(originalDay, lastDay));
  return db.prepare(`
    SELECT org, repo, MAX(COALESCE(last_joined_at, created_at)) AS last_used
    FROM workstreams
    WHERE org != ? AND COALESCE(last_joined_at, created_at) >= ?
    GROUP BY org, repo
    ORDER BY last_used DESC, org COLLATE NOCASE, repo COLLATE NOCASE
  `).all(SCRATCH_ORG, cutoff.toISOString()).map(({ org, repo }) => `${org}/${repo}`);
}

export function setStatus(db, id, status, touchJoined = false) {
  if (touchJoined) {
    db.prepare('UPDATE workstreams SET status=?, last_joined_at=? WHERE id=?').run(status, now(), id);
  } else {
    db.prepare('UPDATE workstreams SET status=? WHERE id=?').run(status, id);
  }
}

export function setAgentStatus(db, id, status) {
  if (status !== 'working' && status !== 'ready') {
    throw new Error(`unknown agent status "${status}" (expected working or ready)`);
  }
  db.prepare('UPDATE workstreams SET agent_status=? WHERE id=?').run(status, id);
}

export function setShellStatus(db, id, status) {
  if (status !== null && status !== 'working' && status !== 'ready') {
    throw new Error(`unknown shell status "${status}" (expected working, ready, or null)`);
  }
  db.prepare('UPDATE workstreams SET shell_status=? WHERE id=?').run(status, id);
}

export function configuredLocationAgentStatus(db, id) {
  return db.prepare('SELECT agent_status FROM configured_location_state WHERE id=?')
    .get(id)?.agent_status || null;
}

export function configuredLocationShellStatus(db, id) {
  return db.prepare('SELECT shell_status FROM configured_location_state WHERE id=?')
    .get(id)?.shell_status || null;
}

const cachedBoolean = (value) => value === null || value === undefined ? null : Boolean(value);

export function configuredLocationGitClean(db, id) {
  return cachedBoolean(db.prepare('SELECT git_clean FROM configured_location_state WHERE id=?')
    .get(id)?.git_clean);
}

const configuredLocationId = (id) => typeof id === 'string' && !/^\d+$/.test(id);

function ensureConfiguredLocationState(db, id) {
  db.prepare('INSERT OR IGNORE INTO configured_location_state (id) VALUES (?)').run(id);
}

export function setCachedGitClean(db, id, clean) {
  if (clean !== null && typeof clean !== 'boolean') {
    throw new Error('Git cleanliness must be true, false, or null');
  }
  const value = clean === null ? null : Number(clean);
  const configured = configuredLocationId(id);
  if (configured) ensureConfiguredLocationState(db, id);
  const table = configured ? 'configured_location_state' : 'workstreams';
  const result = db.prepare(`UPDATE ${table} SET git_clean=? WHERE id=? AND git_clean IS NOT ?`)
    .run(value, id, value);
  return result.changes > 0;
}

export function setConfiguredLocationAgentStatus(db, id, status) {
  if (status !== 'working' && status !== 'ready') {
    throw new Error(`unknown agent status "${status}" (expected working or ready)`);
  }
  ensureConfiguredLocationState(db, id);
  db.prepare('UPDATE configured_location_state SET agent_status=? WHERE id=?').run(status, id);
}

export function setConfiguredLocationShellStatus(db, id, status) {
  if (status !== null && status !== 'working' && status !== 'ready') {
    throw new Error(`unknown shell status "${status}" (expected working, ready, or null)`);
  }
  ensureConfiguredLocationState(db, id);
  db.prepare('UPDATE configured_location_state SET shell_status=? WHERE id=?').run(status, id);
}

export function selectedAgent(db, id, fallback = CONFIG.agent) {
  const stored = configuredLocationId(id)
    ? db.prepare('SELECT agent FROM configured_location_state WHERE id=?').get(id)?.agent
    : db.prepare('SELECT agent FROM workstreams WHERE id=?').get(id)?.agent;
  return stored || fallback;
}

export function setSelectedAgent(db, id, agent) {
  if (agent !== 'claude' && agent !== 'codex') {
    throw new Error(`unknown agent "${agent}" (expected claude or codex)`);
  }
  const configured = configuredLocationId(id);
  if (configured) ensureConfiguredLocationState(db, id);
  const result = configured
    ? db.prepare('UPDATE configured_location_state SET agent=?, agent_status=NULL WHERE id=?').run(agent, id)
    : db.prepare('UPDATE workstreams SET agent=?, agent_status=NULL WHERE id=?').run(agent, id);
  if (result.changes === 0) throw new Error(`no workstream matching "${id}"`);
  return agent;
}

// Reconcile workstream status against a complete snapshot of open Zellij tab
// names. An open tab is authoritative and makes its row active. A missing tab
// pauses an active row, while an already closed row remains closed when absent.
export function refreshWorkstreamStatuses(db, tabNames) {
  const open = new Set(tabNames);
  const rows = db.prepare('SELECT * FROM workstreams ORDER BY id').all();
  const activated = rows.filter((row) => row.status !== 'active' && open.has(computeTabName(row)));
  const paused = rows.filter((row) => row.status === 'active' && !open.has(computeTabName(row)));
  if (activated.length || paused.length) {
    const activate = db.prepare("UPDATE workstreams SET status='active' WHERE id=? AND status!='active'");
    const pause = db.prepare("UPDATE workstreams SET status='paused' WHERE id=? AND status='active'");
    db.exec('BEGIN');
    try {
      for (const row of activated) activate.run(row.id);
      for (const row of paused) pause.run(row.id);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return {
    checked: rows.length,
    unchanged: rows.length - activated.length - paused.length,
    activated: activated.map((row) => ({ ...row, status: 'active', tabName: computeTabName(row) })),
    paused: paused.map((row) => ({ ...row, status: 'paused', tabName: computeTabName(row) })),
    tabCount: open.size,
  };
}

// Update a workstream's recorded directory. Used when the canonical path moves
  // (e.g. scratchpads migrating to a newly configured root).
export function setPath(db, id, path) {
  db.prepare('UPDATE workstreams SET path=?, git_clean=NULL WHERE id=?').run(path, id);
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

// ---------------------------------------------------------------- stacks
//
// A workstream can be *stacked on* another (parent_id): "this branch builds on
// that one." The relationship is deliberately loose — any workstream may parent
// any other, including across repos and scratchpads, so it can also just record
// "this work follows from that work."
//
// Turning a chain into GitHub *stacked PRs* is narrower: see stackCheck. Note
// that ws owns the local side of a stack (this column + `ws join` to move
// between branches) and delegates only the GitHub side to `gh stack link`.
// gh-stack's own local tracking is unusable here: init/checkout/up/down/rebase/sync
// all `git checkout` each branch in one working tree, which can't work when every
// branch is its own worktree. `link` is the one command built for external branch
// managers, and it never checks anything out.

export const parentOf = (db, row) =>
  (row.parent_id ? db.prepare('SELECT * FROM workstreams WHERE id=?').get(row.parent_id) : null) || null;

export const childrenOf = (db, row) =>
  db.prepare('SELECT * FROM workstreams WHERE parent_id=? ORDER BY id').all(row.id);

// Record that `row` is stacked on `parent` (or nothing when parent is null).
// Rejects self-parenting and cycles — the chain walkers below assume acyclicity.
export function setParent(db, row, parent) {
  if (!parent) {
    db.prepare('UPDATE workstreams SET parent_id=NULL WHERE id=?').run(row.id);
    return db.prepare('SELECT * FROM workstreams WHERE id=?').get(row.id);
  }
  if (parent.id === row.id) throw new Error('a workstream cannot be stacked on itself');
  for (let p = parent, guard = 0; p && guard < 100; p = parentOf(db, p), guard++) {
    if (p.id === row.id) {
      throw new Error(`#${parent.id} is already downstack of #${row.id}; that would make a cycle`);
    }
  }
  db.prepare('UPDATE workstreams SET parent_id=? WHERE id=?').run(parent.id, row.id);
  return db.prepare('SELECT * FROM workstreams WHERE id=?').get(row.id);
}

// The bottom of `row`'s chain: walk parent_id until it runs out.
export function stackRoot(db, row) {
  let r = row;
  for (let guard = 0; guard < 100; guard++) {
    const p = parentOf(db, r);
    if (!p) return r;
    r = p;
  }
  return r;
}

// The whole chain containing `row` as a nested tree from its root:
// { row, children: [{ row, children: [...] }, ...] }. Used for display, which
// (unlike the gh-stack path) can represent a branch point just fine.
export function stackTree(db, row) {
  const build = (r) => ({ row: r, children: childrenOf(db, r).map(build) });
  return build(stackRoot(db, row));
}

// `row`'s chain flattened bottom-to-top, for handing to `gh stack link` (which
// takes a strictly linear stack). Throws at a branch point, since two children
// of one branch are two different stacks and only the user can say which is meant.
export function stackLine(db, row) {
  const down = [];
  for (let r = row; r; r = parentOf(db, r)) down.unshift(r);
  let r = row;
  for (let guard = 0; guard < 100; guard++) {
    const kids = childrenOf(db, r);
    if (kids.length === 0) break;
    if (kids.length > 1) {
      const ids = kids.map((k) => `#${k.id} (${k.branch})`).join(', ');
      throw new Error(`#${r.id} (${r.branch}) has multiple workstreams stacked on it — ${ids}. `
        + 'A GitHub stack must be linear; target one of them explicitly.');
    }
    down.push(kids[0]);
    r = kids[0];
  }
  return down;
}

// Whether a chain can become a stack of GitHub PRs, and why not if it can't.
// Requires ≥2 same-repo branches that live on the canonical repo: a scratchpad has
// no branch, a `fork:` branch belongs to someone else, and in a fork-routed clone
// our branches aren't on the repo the PRs target — `gh stack link` chains PR bases
// within one repo, so none of those can participate.
export function stackCheck(chain) {
  if (chain.length < 2) return { ok: false, reason: 'a stack needs at least two workstreams' };
  const scratch = chain.find(isScratch);
  if (scratch) return { ok: false, reason: `#${scratch.id} is a scratchpad — it has no branch to open a PR from` };
  const fork = chain.find((r) => String(r.source).startsWith('fork:'));
  if (fork) return { ok: false, reason: `#${fork.id} (${fork.branch}) is a branch on someone else's fork` };
  const { org, repo } = chain[0];
  const other = chain.find((r) => r.org !== org || r.repo !== repo);
  if (other) {
    return { ok: false, reason: `mixes repos (${org}/${repo} and ${other.org}/${other.repo}); `
      + 'a GitHub stack is one repo' };
  }
  if (isForkRouted(repoPaths(org, repo).bare)) {
    return { ok: false, reason: `${org}/${repo} is routed through your fork, so these branches aren't on `
      + 'the repo the PRs target; stack them by hand in the PR descriptions' };
  }
  return { ok: true, repo: `${org}/${repo}` };
}

// Is the `gh stack` extension installed? Its absence is the common failure here,
// and worth naming precisely rather than surfacing a raw gh error.
export function hasGhStack() {
  const r = spawnSync('gh', ['stack', '--version'], { encoding: 'utf8' });
  return r.status === 0;
}

// Push the chain's branches and create/update the GitHub stack, bottom to top.
// Runs from the bottom branch's worktree — any worktree of the clone would do
// (link addresses branches by name), but a stable choice keeps gh's own bookkeeping
// in one place. Returns { ok, output }.
export function ghStackLink(chain, { open = false } = {}) {
  const check = stackCheck(chain);
  if (!check.ok) throw new Error(check.reason);
  if (!hasGhStack()) {
    throw new Error('the `gh stack` extension is not installed (gh extension install github/gh-stack)');
  }
  const bottom = chain[0];
  const cwd = existsSync(bottom.path)
    ? bottom.path
    : materializeWorktree(bottom.org, bottom.repo, bottom.branch, bottom.source);
  const args = ['stack', 'link'];
  if (open) args.push('--open');
  args.push(...chain.map((r) => r.branch));
  const r = spawnSync('gh', args, { cwd, encoding: 'utf8' });
  const output = [r.stdout, r.stderr].filter(Boolean).join('').trim();
  return { ok: r.status === 0, output, command: `gh stack ${args.slice(1).join(' ')}` };
}

// Cascading rebase across the chain's worktrees, bottom to top: each branch is
// rebased onto its parent in its *own* worktree, which is why this doesn't just
// call `gh stack rebase` (that checks each branch out in one tree). With
// `trunk: true` the bottom branch is first rebased onto the fetched default branch.
// Stops at the first conflict and reports where, leaving the rebase in progress
// for the user to resolve — the branches below it are already rebased.
export function rebaseStack(chain, { trunk = false } = {}) {
  const steps = [];
  const pathFor = (r) => (existsSync(r.path) ? r.path : materializeWorktree(r.org, r.repo, r.branch, r.source));
  const run = (r, onto) => {
    const path = pathFor(r);
    const dirty = worktreeDirty(path);
    if (dirty) {
      return { branch: r.branch, onto, ok: false, path,
        error: 'worktree has uncommitted changes; commit or stash them first' };
    }
    const res = spawnSync('git', ['-C', path, 'rebase', onto], { encoding: 'utf8' });
    return { branch: r.branch, onto, ok: res.status === 0, path,
      error: res.status === 0 ? null : [res.stdout, res.stderr].filter(Boolean).join('').trim() };
  };

  if (trunk) {
    const { bare } = repoPaths(chain[0].org, chain[0].repo);
    gitTry(['--git-dir', bare, 'fetch', 'origin'], { stdio: ['ignore', 'ignore', 'ignore'] });
    const step = run(chain[0], `origin/${defaultBranch(bare)}`);
    steps.push(step);
    if (!step.ok) return { ok: false, steps };
  }
  for (let i = 1; i < chain.length; i++) {
    const step = run(chain[i], chain[i - 1].branch);
    steps.push(step);
    if (!step.ok) return { ok: false, steps };
  }
  return { ok: true, steps };
}

// ---------------------------------------------------------------- issues

// Best-effort classification of an issue reference, for display only.
export function issueKind(ref) {
  if (/linear\.app/i.test(ref) || /^[A-Z]{2,}-\d+$/.test(ref)) return 'linear';
  if (/github\.com/i.test(ref)) return 'github';
  return 'link';
}

export function expandIssueReference(row, value, { run = spawnSync } = {}) {
  const ref = String(value).trim();
  const localGitHub = ref.match(/^#(\d+)$/);
  if (localGitHub) {
    if (isScratch(row)) {
      throw new Error(`"${ref}" needs an owner/repository in a scratchpad (for example owner/repo${ref})`);
    }
    return `https://github.com/${row.org}/${row.repo}/issues/${localGitHub[1]}`;
  }

  const explicitGitHub = ref.match(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/);
  if (explicitGitHub) {
    return `https://github.com/${explicitGitHub[1]}/issues/${explicitGitHub[2]}`;
  }

  if (/^[A-Z]{2,}-\d+$/.test(ref)) {
    const result = run('linear', ['issue', 'url', ref], { encoding: 'utf8' });
    if (result.error) throw new Error(`could not run Linear CLI: ${result.error.message}`);
    const output = stripVTControlCharacters(`${result.stdout || ''}\n${result.stderr || ''}`).trim();
    if (result.status !== 0) {
      throw new Error(`could not resolve Linear issue ${ref}${output ? `: ${output}` : ''}`);
    }
    const url = output.match(/https:\/\/linear\.app\/\S+/i)?.[0];
    if (!url) throw new Error(`Linear CLI returned no URL for ${ref}`);
    return url;
  }

  return ref;
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

// ---------------------------------------------------------------- work logs

// Record a one-line work note against a workstream. `done` marks it a completed
// item (vs. an in-progress note). These feed the daily notes digest.
export function addLog(db, workstreamId, body, done = false) {
  const info = db.prepare(
    'INSERT INTO logs (workstream_id, body, done, created_at) VALUES (?, ?, ?, ?)'
  ).run(workstreamId, body, done ? 1 : 0, now());
  return { id: Number(info.lastInsertRowid), body, done: !!done };
}

// Work-log entries for a workstream, oldest first. Optional half-open time window
// [since, until) filters on created_at (ISO strings compare lexically).
export function listLogs(db, workstreamId, { since, until } = {}) {
  let sql = 'SELECT * FROM logs WHERE workstream_id=?';
  const params = [workstreamId];
  if (since) { sql += ' AND created_at>=?'; params.push(since); }
  if (until) { sql += ' AND created_at<?'; params.push(until); }
  sql += ' ORDER BY id';
  return db.prepare(sql).all(...params).map((r) => ({ ...r, done: !!r.done }));
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

// Create (and register) a scratchpad under the configured scratchpad root, opened
// with the same configured tab as a workstream. An unnamed scratchpad gets a random
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
    path, created_at: now(), last_joined_at: now(),
  });
}

// ---------------------------------------------------------------- git / worktrees

export function repoPaths(org, repo) {
  const container = join(GITHUB_ROOT, org, repo);
  return { container, bare: join(container, '.bare') };
}

export const githubUrl = (org, repo) => CONFIG.gitProtocol === 'https'
  ? `https://github.com/${org}/${repo}.git`
  : `git@github.com:${org}/${repo}.git`;

export const hasClone = (org, repo) => existsSync(repoPaths(org, repo).bare);

export function ensureBareClone(org, repo) {
  const { container, bare } = repoPaths(org, repo);
  if (!existsSync(bare)) {
    mkdirSync(container, { recursive: true });
    const url = githubUrl(org, repo);
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

// An existing remote already pointing at owner/repo (ssh or https), if any.
// Saves adding a redundant remote when e.g. a fork-routed clone's origin is
// already the PR author's fork.
function remoteFor(bare, owner, repo) {
  const remotes = (gitTry(['--git-dir', bare, 'remote']) || '').split('\n').filter(Boolean);
  const want = `${owner}/${repo}`.toLowerCase();
  for (const name of remotes) {
    const url = gitTry(['--git-dir', bare, 'remote', 'get-url', name]) || '';
    const m = url.match(/github\.com[:/](.+?\/.+?)(?:\.git)?$/i);
    if (m && m[1].toLowerCase() === want) return name;
  }
  return null;
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
  const canonicalUrl = githubUrl(org, repo);
  const forkUrl = githubUrl(fork.owner, fork.repo);
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
      let remote = remoteFor(bare, owner, forkRepo);
      if (!remote) {
        ensureRemote(bare, owner, githubUrl(owner, forkRepo));
        remote = owner;
      }
      git(['--git-dir', bare, 'fetch', remote, pr.headRefName], { stdio: ['inherit', 'ignore', 'inherit'] });
      return `${remote}/${pr.headRefName}`; // remote-tracking ref -> sets upstream, push works
    }
    if (pr) return `origin/${pr.headRefName}`; // same-repo PR
    git(['--git-dir', bare, 'fetch', 'origin', `pull/${n}/head`], { stdio: ['inherit', 'ignore', 'inherit'] });
    return 'FETCH_HEAD';
  }

  if (source && source.startsWith('fork:')) {
    const owner = source.slice(5);
    let remote = remoteFor(bare, owner, repo);
    if (!remote) {
      ensureRemote(bare, owner, githubUrl(owner, repo));
      remote = owner;
    }
    git(['--git-dir', bare, 'fetch', remote, branch], { stdio: ['inherit', 'ignore', 'inherit'] });
    return `${remote}/${branch}`;
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
// `base` overrides what a *new* branch is created from (used when stacking a
// branch on its parent instead of the default branch); it's ignored once the
// branch exists, since then its history is already settled.
export function materializeWorktree(org, repo, branch, source, { base } = {}) {
  // Scratchpads aren't git worktrees — reconstituting one just means recreating
  // its directory under the configured scratchpad root.
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
    const from = base || fetchBaseRef(bare, org, repo, branch, source);
    if (base) progress(`Creating branch "${branch}" stacked on ${base}`);
    git(['--git-dir', bare, 'worktree', 'add', '-b', branch, path, from], { stdio: ['inherit', 'ignore', 'inherit'] });
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

// A tri-state cleanliness check for display/API consumers: true is a clean Git
// worktree, false is dirty, and null means the path is missing or is not Git.
export function worktreeClean(path, { exists = existsSync, run = gitTry } = {}) {
  if (!exists(path)) return null;
  const out = run(['-C', path, 'status', '--porcelain'], { stdio: ['ignore', 'pipe', 'ignore'] });
  return out === null ? null : out === '';
}

export function worktreeCleanAsync(path, { exists = existsSync, run = execFile } = {}) {
  if (!exists(path)) return Promise.resolve(null);
  return new Promise((resolve) => {
    run('git', ['-C', path, 'status', '--porcelain'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    }, (error, stdout) => {
      resolve(error ? null : String(stdout || '').trim() === '');
    });
  });
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

// ---------------------------------------------------------------- notes files

// Notes live under the configured notes root, split work/ and journal/, one file per
// Monday-based week: <root>/work/<YYYY>/<YYYY-MM-DD>-week.md. See the notes skill.
export const NOTES_ROOT = CONFIG.paths.notes;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad2 = (n) => String(n).padStart(2, '0');
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};

// The Monday that starts the week containing `d` (notes use Monday-based weeks).
export function weekMonday(d = new Date()) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + (date.getDay() === 0 ? -6 : 1 - date.getDay()));
  return date;
}

// The per-weekday heading a day's entries live under, e.g.
// "## Thursday, June 25th, 2026".
export const dayHeading = (d) =>
  `## ${WEEKDAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${ordinal(d.getDate())}, ${d.getFullYear()}`;

// Ensure the work-notes file for the week containing `d` exists under
// <root>/work/<YYYY>/ and return its path. Matches the notes skill's layout:
// <YYYY-MM-DD>-week.md keyed to the week's Monday, scaffolded with a heading per
// weekday. Honors an existing file (dashed or older compact name) rather than
// creating a duplicate.
export function ensureWeeklyNote(root = NOTES_ROOT, d = new Date()) {
  const monday = weekMonday(d);
  const iso = `${monday.getFullYear()}-${pad2(monday.getMonth() + 1)}-${pad2(monday.getDate())}`;
  const dir = join(root, 'work', String(monday.getFullYear()));
  const file = join(dir, `${iso}-week.md`);
  const compact = join(dir, `${monday.getFullYear()}${pad2(monday.getMonth() + 1)}${pad2(monday.getDate())}-week.md`);
  if (existsSync(file)) return file;
  if (existsSync(compact)) return compact;

  const headings = [];
  for (let i = 0; i < 7; i++) {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    headings.push(dayHeading(day));
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, headings.join('\n\n') + '\n');
  progress(`Created weekly note ${file}`);
  return file;
}

// Append a markdown block under `d`'s weekday heading in the correct weekly file,
// after any existing entries for that day (creating the heading if absent).
// Returns { file, heading }.
export function appendDayEntry(block, d = new Date(), root = NOTES_ROOT) {
  const file = ensureWeeklyNote(root, d);
  const heading = dayHeading(d);
  const lines = readFileSync(file, 'utf8').split('\n');

  let hIdx = lines.findIndex((l) => l.trim() === heading);
  if (hIdx === -1) {
    if (lines.length && lines[lines.length - 1].trim() !== '') lines.push('');
    lines.push(heading);
    hIdx = lines.length - 1;
  }
  // End of this day's section: the next "## " heading, or end of file.
  let end = hIdx + 1;
  while (end < lines.length && !lines[end].startsWith('## ')) end++;
  // Insert after the last non-blank line of the section (so entries accrete).
  let at = end;
  while (at - 1 > hIdx && lines[at - 1].trim() === '') at--;

  lines.splice(at, 0, '', ...block.split('\n'));
  writeFileSync(file, lines.join('\n'));
  return { file, heading };
}

// ---------------------------------------------------------------- per-workstream notes

// Longer-form notes (as opposed to `ws log`'s one-liners) live as their own
// files under <root>/work/<YYYY>/workstream/<slug>/, one per note, keyed to
// the workstream by an id+name slug so it stays readable and never collides.
const noteSlug = (s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export const workstreamSlug = (row) =>
  isScratch(row) ? `${row.id}-${row.branch}` : `${row.id}-${row.repo}-${sanitize(row.branch)}`;

export const noteDir = (row, d = new Date(), root = NOTES_ROOT) =>
  join(root, 'work', String(d.getFullYear()), 'workstream', workstreamSlug(row));

// Return the newest year-specific notes directory that already exists for a
// workstream. A workstream can span a year boundary, so callers should not
// assume its notes are under the current year.
export function existingNoteDir(row, root = NOTES_ROOT) {
  const workDir = join(root, 'work');
  if (!existsSync(workDir)) return null;
  const slug = workstreamSlug(row);
  for (const year of readdirSync(workDir).sort().reverse()) {
    const dir = join(workDir, year, 'workstream', slug);
    if (existsSync(dir)) return dir;
  }
  return null;
}

// Note filenames sort chronologically: <YYYY-MM-DD-HHMMSS>[-<title-slug>].md.
export function addNote(row, body, { title, root = NOTES_ROOT } = {}) {
  const d = new Date();
  const dir = noteDir(row, d, root);
  mkdirSync(dir, { recursive: true });
  const stamp = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}-`
    + `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  const slug = title ? noteSlug(title) : '';
  const file = slug ? `${stamp}-${slug}.md` : `${stamp}.md`;
  const content = title ? `# ${title}\n\n${body}\n` : `${body}\n`;
  writeFileSync(join(dir, file), content);
  return { file, path: join(dir, file) };
}

// Build the automatic briefing used when a newly created workstream already has
// associated links. Canonical URLs are passed in so the agent can fetch richer,
// authenticated context itself rather than relying on display labels.
export function linkedSessionSeed(kind, links) {
  const refs = [...new Set((links || []).map((link) => String(link).trim()).filter(Boolean))];
  if (refs.length === 0) return '';
  const target = kind === 'scratchpad' ? 'scratchpad' : 'repo';
  return [
    `This is a new ws session to work on a ${target}. The following links are associated with this session. Use the linear skill with the cli and/or the gh cli to retrieve authed information.`,
    ...refs.map((ref) => `* ${ref.replace(/\s*\r?\n\s*/g, ' ')}`),
    'These links are for context. No action is to be taken based on these links nor their contents alone.',
    '',
  ].join('\n');
}

// Persist a seed document for a workstream's agent panel. Seeds live under
// DATA_DIR (not the worktree — git status stays clean) keyed by workstream id,
// so re-seeding overwrites rather than accumulating. Returns the file path,
// which the Zellij layout hands to the selected agent as its opening prompt target.
export function writeSeed(row, content) {
  mkdirSync(SEEDS_DIR, { recursive: true });
  const file = join(SEEDS_DIR, `${row.id}.md`);
  writeFileSync(file, content.endsWith('\n') ? content : `${content}\n`);
  return file;
}

// Note filenames for a workstream, oldest first, across every year it has any.
export function listNotes(row, root = NOTES_ROOT) {
  const workDir = join(root, 'work');
  if (!existsSync(workDir)) return [];
  const slug = workstreamSlug(row);
  const out = [];
  for (const year of readdirSync(workDir).sort()) {
    const dir = join(workDir, year, 'workstream', slug);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
      out.push({ year, file: f, path: join(dir, f) });
    }
  }
  return out;
}

export function readNote(row, file, root = NOTES_ROOT) {
  const match = listNotes(row, root).find((n) => n.file === file);
  if (!match) throw new Error(`no note "${file}" for this workstream`);
  return readFileSync(match.path, 'utf8');
}

// ---------------------------------------------------------------- digest

// The half-open local-day window [start, end) containing `dateStr` (YYYY-MM-DD),
// or today when omitted. Returned as a Date and matching UTC ISO bounds — git
// (--since/--until) and the ISO-stringed logs table both compare correctly.
export function dayWindow(dateStr) {
  const start = dateStr ? new Date(`${dateStr}T00:00:00`) : new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 1);
  return { date: start, startIso: start.toISOString(), endIso: end.toISOString() };
}

// Commits authored by this repo's configured user within [startIso, endIso) on the
// worktree's current branch. Returns [{sha, subject}] (empty on any failure).
function commitsInWindow(path, startIso, endIso) {
  // Silence stderr: a worktree dir can outlive its git metadata, and gitTry already
  // treats the failure as "no commits" — we don't want the "fatal: …" noise.
  const quiet = { stdio: ['ignore', 'pipe', 'ignore'] };
  const email = gitTry(['-C', path, 'config', 'user.email'], quiet);
  const args = ['-C', path, 'log', '--no-merges', `--since=${startIso}`, `--until=${endIso}`,
    '--format=%h%x1f%s'];
  if (email) args.push(`--author=${email}`);
  const out = gitTry(args, quiet);
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((line) => {
    const [sha, subject] = line.split('\x1f');
    return { sha, subject };
  });
}

// Gather a day's activity across all workstreams: git commits you authored that day
// plus work-log notes, with each workstream's linked issues for reference. Only
// workstreams with commits or logs that day are returned. A commit is attributed to
// the first workstream it appears in (branches can share history), so it isn't listed
// under every worktree.
export function collectDayActivity(db, { date } = {}) {
  const { date: dateObj, startIso, endIso } = dayWindow(date);
  const seen = new Set();
  const out = [];
  for (const r of listWorkstreams(db, { all: true })) {
    const scratch = isScratch(r);
    const commits = (!scratch && existsSync(r.path))
      ? commitsInWindow(r.path, startIso, endIso).filter((c) => !seen.has(c.sha))
      : [];
    for (const c of commits) seen.add(c.sha);
    const logs = listLogs(db, r.id, { since: startIso, until: endIso });
    if (commits.length === 0 && logs.length === 0) continue;
    out.push({
      id: r.id,
      repo: scratch ? 'scratch' : `${r.org}/${r.repo}`,
      repoName: scratch ? 'scratch' : r.repo,
      branch: r.branch,
      scratch,
      commits,
      logs: logs.map((l) => ({ body: l.body, done: l.done })),
      issues: listIssues(db, r.id).map((i) => ({ kind: i.kind, ref: i.ref })),
    });
  }
  return { date: dateObj, dateIso: startIso.slice(0, 10), workstreams: out };
}

// Render a day's activity as notes-format markdown: one checked bullet per
// workstream, with commits, log notes, and issue links nested beneath. Returns ''
// when there was no activity.
export function renderDigest(activity) {
  const blocks = activity.workstreams.map((w) => {
    const done = w.logs.find((l) => l.done);
    const summary = done ? done.body : `${w.repoName}: ${w.branch}`;
    const lines = [`- [x] ${done ? `${w.repoName}: ${summary}` : summary}`];
    for (const c of w.commits) lines.push(`    - \`${c.sha}\` ${c.subject}`);
    for (const l of w.logs) {
      if (done && l === done) continue; // already the summary
      lines.push(`    - ${l.done ? 'done' : 'note'}: ${l.body}`);
    }
    for (const i of w.issues) lines.push(`    - ${i.ref}`);
    return lines.join('\n');
  });
  return blocks.join('\n');
}

// A plain serialisable view of a workstream row (+ derived fields), for MCP output.
export function workstreamView(db, r, cwd) {
  const cur = cwd !== undefined ? currentWorkstream(db, cwd) : null;
  const scratch = isScratch(r);
  const parent = parentOf(db, r);
  const children = childrenOf(db, r);
  return {
    id: r.id,
    repo: scratch ? 'scratch' : `${r.org}/${r.repo}`,
    repoUrl: scratch ? null : `https://github.com/${r.org}/${r.repo}`,
    branch: r.branch,
    name: r.label || r.branch,
    label: r.label || null,
    scratch,
    status: r.status,
    agentStatus: r.agent_status || null,
    shellStatus: r.shell_status || null,
    agent: r.agent || CONFIG.agent,
    gitClean: cachedBoolean(r.git_clean),
    source: r.source,
    path: r.path,
    worktreePresent: existsSync(r.path),
    current: cur ? cur.id === r.id : undefined,
    createdAt: r.created_at,
    lastJoined: r.last_joined_at,
    stackedOn: parent ? briefStackRow(parent) : null,
    stackedBy: children.map(briefStackRow),
    issues: listIssues(db, r.id).map((i) => ({
      id: i.id, kind: i.kind, ref: i.ref, createdAt: i.created_at,
    })),
  };
}

// The minimal identity of a workstream, for naming one from inside another's view.
export const briefStackRow = (r) => ({ id: r.id, branch: r.branch, status: r.status });
