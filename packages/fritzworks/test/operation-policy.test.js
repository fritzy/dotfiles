import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApplicationContext } from '../lib/context.js';
import { resolveConfig } from '../lib/config.js';
import { assertRemovableNotes } from '../lib/removal-policy.js';

function fixture(t, { adapters = {}, extra = '', runProcess = () => { throw new Error('unexpected process'); } } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'fw-operation-policy-'));
  const configPath = join(home, 'config.ini');
  writeFileSync(configPath, `configVersion=2\n[paths]\ndata=./data\n${extra}`);
  const config = resolveConfig({ configPath, home, env: {} });
  const context = createApplicationContext({ config, runProcess, adapters: { providerAvailable: () => false, commandAvailable: () => true, ...adapters } });
  t.after(async () => { await context.close(); rmSync(home, { recursive: true, force: true }); });
  return { home, config, context };
}
const rejectCode = (code) => (error) => error.status === 409 && error.details?.code === code;

test('creation and context previews never allocate notes, files, records or provider lookups', (t) => {
  const { context, config } = fixture(t);
  const before = context.db.prepare('SELECT total_changes() AS count').get().count;
  const preview = context.policy.preview({ kind: 'create-repo', body: { repository: 'owner/repo', selector: '#123' } });
  assert.equal(preview.resolved.providerLookup, true);
  assert.equal(preview.resolved.path, null);
  assert.deepEqual(preview.intent.body.panels, ['shell']);
  context.policy.preview({ kind: 'create-scratchpad', body: { name: 'hello' } });
  assert.deepEqual(context.policy.resolveContext({}).candidates, []);
  assert.equal(context.db.prepare('SELECT total_changes() AS count').get().count, before);
  for (const name of ['scratchpads', 'sessionNotes', 'worktrees', 'repositories']) assert.equal(existsSync(config.paths[name]), false);
  assert.throws(() => context.policy.preview({ kind: 'create-repo', body: { repository: 'bad', selector: 'branch' } }), /repository/);
});

test('shell-only defaults and configured executable availability agree with execution', (t) => {
  const { context } = fixture(t);
  const capabilities = context.policy.capabilities();
  assert.deepEqual(capabilities.defaults.panels, ['shell']);
  assert.equal(capabilities.features.agent.available, false);
  assert.throws(() => context.operations.createScratchpad({ panels: ['shell', 'agent'] }), /unavailable/);
  const row = context.operations.createScratchpad({ name: 'shell-only' }).workstream;
  assert.deepEqual(context.operations.execute(row.uuid, 'resume', {}).result.panels, ['shell']);
  assert.equal(context.operations.list({ status: 'all' }).items[0].availableActions.archive.available, true);
});

test('provider overrides use absolute configured executable, not conventional command name', (t) => {
  const { home, context } = fixture(t);
  const executable = join(home, 'custom-agent');
  writeFileSync(executable, '#!/bin/sh\n'); chmodSync(executable, 0o700);
  const config = structuredClone(context.config); config.paths.data = join(home, 'other-data'); config.configPath = join(home, 'other.ini'); writeFileSync(config.configPath, 'configVersion=2'); config.commands.codex = [executable]; config.agent = 'codex';
  const other = createApplicationContext({ config, runProcess: () => { throw new Error('no process'); } });
  t.after(() => other.close());
  assert.equal(other.policy.capabilities().providers.find(({ id }) => id === 'codex').available, true);
  assert.deepEqual(other.policy.defaultPanels(), ['shell', 'agent']);
});

test('destructive revisions reject changed file contents, new files and changed terminal generations', (t) => {
  const calls = [];
  const { context } = fixture(t, { adapters: { removeWorktree: (...args) => calls.push(args) } });
  const row = context.operations.createScratchpad({ name: 'keep-content' }).workstream;
  const file = join(row.path, 'file'); writeFileSync(file, 'first');
  const intent = { kind: 'action', target: row.uuid, command: 'archive', body: { remove: true } };
  const preview = context.policy.preview(intent);
  assert.throws(() => context.operations.execute(row.uuid, 'archive', { remove: true }), rejectCode('confirmation_required'));
  writeFileSync(file, 'other');
  assert.throws(() => context.operations.execute(row.uuid, 'archive', { ...preview.intent.body, previewRevision: preview.revision, confirm: true }), rejectCode('stale_preview'));
  assert.deepEqual(calls, []); assert.equal(readFileSync(file, 'utf8'), 'other');
  const refreshed = context.policy.preview(intent);
  writeFileSync(join(row.path, 'new'), 'new');
  assert.throws(() => context.policy.validate(intent, refreshed.revision, { confirm: true }), rejectCode('stale_preview'));
  const beforeGitData = context.policy.preview(intent);
  mkdirSync(join(row.path, '.git')); writeFileSync(join(row.path, '.git', 'HEAD'), 'new repository metadata');
  assert.throws(() => context.policy.validate(intent, beforeGitData.revision, { confirm: true }), rejectCode('stale_preview'));
  const reset = context.policy.preview({ kind: 'terminal-reset-all', body: {} });
  context.hooks.environment(row.uuid, 'shell');
  assert.throws(() => context.policy.validate({ kind: 'terminal-reset-all', body: {} }, reset.revision, { confirm: true }), rejectCode('stale_preview'));
});

test('all owners retained notes block directory removal through preview and execution policy', (t) => {
  const { context, home } = fixture(t);
  const victim = context.operations.createScratchpad({ name: 'victim' }).workstream;
  const owner = context.operations.createScratchpad({ name: 'owner' }).workstream;
  context.sessionNotes.allocation(owner.id);
  const retained = join(victim.path, 'retained'); mkdirSync(retained);
  const alias = join(home, 'notes-alias'); symlinkSync(retained, alias);
  context.db.prepare('UPDATE storage_owners SET notes_path=?,notes_reads=? WHERE owner_key=?').run(alias, JSON.stringify([alias]), `session:${owner.uuid}`);
  assert.throws(() => context.policy.preview({ kind: 'action', target: victim.uuid, command: 'archive', body: { remove: true } }), rejectCode('retained_notes'));
  assert.throws(() => assertRemovableNotes(context.db, victim), rejectCode('retained_notes'));
});

test('context resolution is daemon-owned, typed, side-effect free and remote-explicit', (t) => {
  const { context } = fixture(t);
  const row = context.operations.createScratchpad({ name: 'context' }).workstream;
  const before = context.db.prepare('SELECT total_changes() AS count').get().count;
  const result = context.policy.resolveContext({ cwd: join(row.path, 'child') });
  assert.deepEqual(result.target, { kind: 'session', id: row.uuid });
  assert.equal(result.workstream.id, row.id);
  assert.equal(context.db.prepare('SELECT total_changes() AS count').get().count, before);
  assert.throws(() => context.policy.resolveContext({ cwd: row.path, remote: true }), /explicit selector/);
  assert.throws(() => context.policy.resolveContext({ sessionId: 'unknown', cwd: row.path }), /no workstream/);
  assert.equal(context.policy.resolveContext({ remote: true, selector: row.uuid }).workstream.id, row.id);
});

test('hooks isolate terminal generations, ordering, instance identity and use runtime endpoint', (t) => {
  const { context } = fixture(t);
  const row = context.operations.createScratchpad({ name: 'hooks' }).workstream;
  context.runtimeEndpoint = 'http://127.0.0.1:12345';
  const firstIdentity = { sessionId: String(row.id), role: 'shell', panelId: 'first' };
  const secondIdentity = { sessionId: String(row.id), role: 'shell', panelId: 'second' };
  const first = context.hooks.environment(row.uuid, 'shell', firstIdentity);
  const second = context.hooks.environment(row.uuid, 'shell', secondIdentity);
  assert.equal(first.FRITZWORKS_DAEMON_URL, context.runtimeEndpoint);
  const event = (env, sequence = 1) => ({ instanceId: context.instanceId, sessionId: row.id, provider: 'shell', status: 'working', generation: env.FRITZWORKS_GENERATION,
    terminalId: env.FRITZWORKS_TERMINAL_ID, emitterId: 'shell-process', eventId: `event-${sequence}`, sequence, occurredAt: Date.now() });
  assert.equal(context.hooks.ingest(event(first)).updated, true);
  assert.equal(context.hooks.ingest(event(first)).updated, false);
  context.hooks.revokeIdentity(firstIdentity);
  assert.equal(context.hooks.ingest(event(first, 2)).reason, 'stale terminal generation');
  assert.equal(context.hooks.ingest(event(second)).updated, true);
  assert.equal(context.hooks.ingest({ ...event(second, 2), instanceId: 'other' }).reason, 'wrong instance');
  assert.equal(context.hooks.ingest({ ...event(second, 2), occurredAt: Date.now() - 300000 }).reason, 'stale event time');
});

test('restart preserves generation identity but clears stale confident statuses', (t) => {
  const { context, config } = fixture(t);
  const row = context.operations.createScratchpad({ name: 'restart' }).workstream;
  const identity = { sessionId: String(row.id), role: 'shell' };
  const env = context.hooks.environment(row.uuid, 'shell', identity);
  context.db.prepare("UPDATE workstreams SET agent_status='ready', shell_status='working' WHERE id=?").run(row.id);
  context.close();
  const reopened = createApplicationContext({ config }); t.after(() => reopened.close());
  assert.equal(reopened.db.prepare('SELECT shell_status FROM workstreams WHERE id=?').get(row.id).shell_status, null);
  assert.equal(reopened.db.prepare('SELECT agent_status FROM workstreams WHERE id=?').get(row.id).agent_status, null);
  assert.equal(reopened.hooks.environment(row.uuid, 'shell', identity).FRITZWORKS_GENERATION, env.FRITZWORKS_GENERATION);
});


test('preview revisions survive canonical job serialization and retain explicit confirmation', (t) => {
  const { context } = fixture(t);
  const row = context.operations.createScratchpad({ name: 'serialize' }).workstream;
  const preview = context.policy.preview({ kind: 'action', target: row.uuid, command: 'archive', body: { force: true, remove: true } });
  const reordered = { ...preview.intent, body: Object.fromEntries(Object.entries(preview.intent.body).sort(([a], [b]) => a.localeCompare(b))) };
  assert.equal(context.policy.validate(reordered, preview.revision, { confirm: true }).revision, preview.revision);
  assert.throws(() => context.policy.validate(reordered, preview.revision), rejectCode('confirmation_required'));
});
