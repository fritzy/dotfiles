import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  addIssue,
  addLog,
  computeTabName,
  configuredLocationAgentStatus,
  configuredLocationGitClean,
  expandIssueReference,
  issueKind,
  listIssues,
  listLogs,
  latestWorkstreamEventSequence,
  openDb,
  parentOf,
  refreshWorkstreamStatuses,
  removeIssue,
  resolveRow,
  setParent,
  setAgentStatus,
  setConfiguredLocationAgentStatus,
  setCachedGitClean,
  setSelectedAgent,
  setStatus,
  stackLine,
  selectedAgent,
  upsertWorkstream,
  workstreamEventsAfter,
  worktreeClean,
  worktreeCleanAsync,
} from '../lib/core.js';

test('worktree cleanliness distinguishes clean, dirty, and unavailable paths', async () => {
  const present = { exists: () => true };
  assert.equal(worktreeClean('/repo', { ...present, run: () => '' }), true);
  assert.equal(worktreeClean('/repo', { ...present, run: () => ' M file.js' }), false);
  assert.equal(worktreeClean('/repo', { ...present, run: () => null }), null);
  assert.equal(worktreeClean('/missing', { exists: () => false, run: () => '' }), null);
  const asyncRun = (stdout) => (_command, _args, _options, callback) => callback(null, stdout);
  assert.equal(await worktreeCleanAsync('/repo', { ...present, run: asyncRun('') }), true);
  assert.equal(await worktreeCleanAsync('/repo', { ...present, run: asyncRun(' M file.js') }), false);
  assert.equal(await worktreeCleanAsync('/repo', {
    ...present,
    run: (_command, _args, _options, callback) => callback(new Error('not Git')),
  }), null);
});

test('cached Git cleanliness emits update-session events only when it changes', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-workstream-git-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(join(dir, 'workstreams.db'));
  t.after(() => db.close());
  const row = upsertWorkstream(db, {
    org: 'example', repo: 'project', branch: 'cache', source: 'origin',
    path: join(dir, 'cache'), created_at: '2026-08-26T12:00:00.000Z',
    last_joined_at: '2026-08-26T12:00:00.000Z',
  });
  const cursor = latestWorkstreamEventSequence(db);
  assert.equal(setCachedGitClean(db, row.id, true), true);
  assert.equal(setCachedGitClean(db, row.id, true), false);
  assert.equal(setCachedGitClean(db, 'savefiles', false), true);
  assert.equal(resolveRow(db, String(row.id)).git_clean, 1);
  assert.equal(configuredLocationGitClean(db, 'savefiles'), false);
  assert.deepEqual(
    workstreamEventsAfter(db, cursor).map(({ sequence, ...event }) => event),
    [
      { id: row.id, type: 'update_session' },
      { id: 'savefiles', type: 'update_session' },
    ],
  );
});

test('configured-location state removes the legacy fixed-id constraint without losing data', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-workstream-location-migration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'workstreams.db');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE configured_location_state (
      id TEXT PRIMARY KEY CHECK(id IN ('dotfiles', 'notes')),
      agent_status TEXT CHECK(agent_status IN ('working', 'ready')),
      agent TEXT CHECK(agent IN ('claude', 'codex')),
      git_clean INTEGER CHECK(git_clean IN (0, 1))
    );
    INSERT INTO configured_location_state (id, agent_status, agent, git_clean)
    VALUES ('dotfiles', 'ready', 'codex', 0);
  `);
  legacy.close();

  const db = openDb(path);
  t.after(() => db.close());
  assert.equal(configuredLocationAgentStatus(db, 'dotfiles'), 'ready');
  assert.equal(selectedAgent(db, 'dotfiles', 'claude'), 'codex');
  setConfiguredLocationAgentStatus(db, 'savefiles', 'working');
  setSelectedAgent(db, 'savefiles', 'claude');
  assert.equal(configuredLocationAgentStatus(db, 'savefiles'), null);
  assert.equal(selectedAgent(db, 'savefiles', 'codex'), 'claude');
  const schema = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type='table' AND name='configured_location_state'
  `).get().sql;
  assert.doesNotMatch(schema, /id\s+IN/i);
});

test('legacy event journals migrate to typed WebSocket events', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-workstream-event-migration-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'workstreams.db');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE workstream_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      workstream_id INTEGER NOT NULL,
      change TEXT NOT NULL CHECK(change IN ('new', 'changed')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO workstream_events (workstream_id, change) VALUES (7, 'new');
    INSERT INTO workstream_events (workstream_id, change) VALUES (7, 'changed');
  `);
  legacy.close();

  const db = openDb(path);
  t.after(() => db.close());
  assert.deepEqual(
    workstreamEventsAfter(db, 0).map(({ sequence, ...event }) => event),
    [
      { id: 7, type: 'new_session' },
      { id: 7, type: 'update_session' },
    ],
  );
});

test('event journal preserves each creation, status, and link mutation', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-workstream-events-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(join(dir, 'workstreams.db'));
  t.after(() => db.close());
  const cursor = latestWorkstreamEventSequence(db);
  const created = '2026-08-26T12:00:00.000Z';
  const row = upsertWorkstream(db, {
    org: 'example', repo: 'project', branch: 'events', source: 'origin',
    path: join(dir, 'events'), created_at: created, last_joined_at: created,
  });
  setStatus(db, row.id, 'paused');
  setStatus(db, row.id, 'active');
  setStatus(db, row.id, 'active');
  setAgentStatus(db, row.id, 'working');
  setAgentStatus(db, row.id, 'working');
  setAgentStatus(db, row.id, 'ready');
  setConfiguredLocationAgentStatus(db, 'dotfiles', 'working');
  setConfiguredLocationAgentStatus(db, 'dotfiles', 'working');
  setConfiguredLocationAgentStatus(db, 'dotfiles', 'ready');
  addIssue(db, row.id, 'ABC-123');
  addIssue(db, row.id, 'ABC-123');
  removeIssue(db, row.id, 'ABC-123');

  assert.deepEqual(
    workstreamEventsAfter(db, cursor).map(({ sequence, ...event }) => event),
    [
      { id: row.id, type: 'new_session' },
      { id: row.id, type: 'update_session' },
      { id: row.id, type: 'update_session' },
      { id: row.id, type: 'agent_status', status: 'working' },
      { id: row.id, type: 'agent_status', status: 'ready' },
      { id: 'dotfiles', type: 'agent_status', status: 'working' },
      { id: 'dotfiles', type: 'agent_status', status: 'ready' },
      { id: row.id, type: 'update_session' },
      { id: row.id, type: 'update_session' },
    ],
  );
  assert.equal(configuredLocationAgentStatus(db, 'dotfiles'), 'ready');
});

test('agent provider selection persists for workstreams and configured locations', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-workstream-agent-selection-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(join(dir, 'workstreams.db'));
  t.after(() => db.close());
  const row = upsertWorkstream(db, {
    org: 'example', repo: 'project', branch: 'agent-choice', source: 'origin',
    path: join(dir, 'project'), created_at: '2026-08-26T12:00:00.000Z',
    last_joined_at: '2026-08-26T12:00:00.000Z',
  });
  const cursor = latestWorkstreamEventSequence(db);

  assert.equal(selectedAgent(db, row.id, 'claude'), 'claude');
  assert.equal(selectedAgent(db, 'dotfiles', 'claude'), 'claude');
  setAgentStatus(db, row.id, 'working');
  setConfiguredLocationAgentStatus(db, 'dotfiles', 'ready');
  setSelectedAgent(db, row.id, 'codex');
  setSelectedAgent(db, 'dotfiles', 'codex');

  assert.equal(selectedAgent(db, row.id, 'claude'), 'codex');
  assert.equal(selectedAgent(db, 'dotfiles', 'claude'), 'codex');
  assert.equal(resolveRow(db, String(row.id)).agent_status, null);
  assert.equal(configuredLocationAgentStatus(db, 'dotfiles'), null);
  assert.deepEqual(
    workstreamEventsAfter(db, cursor)
      .filter((event) => event.type === 'update_session')
      .map(({ id }) => id),
    [row.id, 'dotfiles'],
  );
});

test('issue shorthands expand to canonical GitHub and Linear URLs', () => {
  const repo = { id: 7, org: 'chainguard-dev', repo: 'mono', source: 'origin' };
  const scratch = { id: 8, org: 'scratch', repo: 'scratch', source: 'scratch' };
  assert.equal(
    expandIssueReference(repo, '#2353'),
    'https://github.com/chainguard-dev/mono/issues/2353',
  );
  assert.equal(
    expandIssueReference(scratch, 'chainguard-dev/mono#23945'),
    'https://github.com/chainguard-dev/mono/issues/23945',
  );
  assert.throws(() => expandIssueReference(scratch, '#2353'), /needs an owner\/repository/);

  const calls = [];
  const run = (...args) => {
    calls.push(args);
    return {
      status: 0,
      stdout: 'https://linear.app/chainguard/issue/ECO-23550/example\n',
      stderr: '',
    };
  };
  assert.equal(
    expandIssueReference(repo, 'ECO-23550', { run }),
    'https://linear.app/chainguard/issue/ECO-23550/example',
  );
  assert.deepEqual(calls, [[
    'linear', ['issue', 'url', 'ECO-23550'], { encoding: 'utf8' },
  ]]);
  assert.throws(
    () => expandIssueReference(repo, 'ECO-99999', {
      run: () => ({ status: 1, stdout: '', stderr: 'Could not find referenced Issue.' }),
    }),
    /could not resolve Linear issue ECO-99999/,
  );
});

test('database operations preserve workstream, stack, issue, and log state', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-workstream-core-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(join(dir, 'workstreams.db'));
  t.after(() => db.close());
  const created = '2026-08-26T12:00:00.000Z';
  const parent = upsertWorkstream(db, {
    org: 'example', repo: 'project', branch: 'base', source: 'origin',
    path: join(dir, 'base'), created_at: created, last_joined_at: created,
  });
  let child = upsertWorkstream(db, {
    org: 'example', repo: 'project', branch: 'feature', source: 'origin',
    path: join(dir, 'feature'), created_at: created, last_joined_at: created,
  });
  child = setParent(db, child, parent);

  assert.equal(resolveRow(db, String(child.id)).branch, 'feature');
  assert.equal(resolveRow(db, 'example/project:base').id, parent.id);
  assert.equal(parentOf(db, child).id, parent.id);
  assert.deepEqual(stackLine(db, child).map((row) => row.branch), ['base', 'feature']);
  assert.equal(computeTabName(child), `${child.id}:project:feature`);

  const refreshed = refreshWorkstreamStatuses(db, [computeTabName(parent)]);
  assert.equal(refreshed.checked, 2);
  assert.deepEqual(refreshed.paused.map((row) => row.id), [child.id]);
  assert.equal(resolveRow(db, String(parent.id)).status, 'active');
  assert.equal(resolveRow(db, String(child.id)).status, 'paused');
  setStatus(db, child.id, 'closed');
  const secondRefresh = refreshWorkstreamStatuses(db, [computeTabName(parent), computeTabName(child)]);
  assert.equal(secondRefresh.paused.length, 0);
  assert.deepEqual(secondRefresh.activated.map((row) => row.id), [child.id]);
  assert.equal(resolveRow(db, String(child.id)).status, 'active');

  assert.deepEqual(addIssue(db, child.id, 'https://github.com/example/project/issues/1'), {
    ref: 'https://github.com/example/project/issues/1', kind: 'github', added: true,
  });
  assert.equal(addIssue(db, child.id, 'https://github.com/example/project/issues/1').added, false);
  assert.equal(listIssues(db, child.id).length, 1);
  assert.equal(issueKind('ABC-123'), 'linear');

  addLog(db, child.id, 'found the cause');
  addLog(db, child.id, 'fixed it', true);
  assert.deepEqual(listLogs(db, child.id).map(({ body, done }) => ({ body, done })), [
    { body: 'found the cause', done: false },
    { body: 'fixed it', done: true },
  ]);
});
