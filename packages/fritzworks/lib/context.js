import { createJobs } from './jobs.js';
import { previewStack } from './stack-operations.js';
import { createOperationPolicy } from './operation-policy.js';
import { createHookEvents } from './hook-events.js';
import { createLocationMigration } from './location-migration.js';
import { checkInstanceBinding, persistInstanceBinding } from './instance-binding.js';
import { initializeStorageOwners, createStorageMigration } from './storage-migration.js';
import { createStorageRelocation } from './storage-relocation.js';
import { createTerminalMigration } from './terminal-migration.js';
import { createSessionNotes } from './session-notes.js';
import { createGitStorage } from './git-storage.js';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { CONFIG, persistConfigVersion } from './config.js';
import {
  openDb, createScratchpad, materializeWorktree, removeWorktree, writeSeed, now,
  parseSelector, expandIssueReference, stackLine, stackTree, parentOf, briefStackRow,
} from './core.js';
import * as operations from './operations.js';
import { resolveTarget } from './targets.js';
import { ApiError } from './operation-error.js';
import { configReloader, configurationStatus, daemonEnvironment, configRevision } from './runtime-config.js';

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export function createApplicationContext({
  config = CONFIG, db: suppliedDb, clock = now, publish = () => {}, adapters = {},
  runProcess = spawnSync, jobWorker = false,
  reloadConfig = configReloader(config),
} = {}) {
  const environment = daemonEnvironment(config);
  config = freeze(structuredClone(config));
  const databasePath = join(config.paths.data, 'workstreams.db');
  checkInstanceBinding(config);
  persistConfigVersion(config);
  const db = suppliedDb || openDb(databasePath, { config });
  db.exec('CREATE TABLE IF NOT EXISTS application_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const put = db.prepare('INSERT OR IGNORE INTO application_metadata (key, value) VALUES (?, ?)');
  put.run('instanceId', randomUUID());
  const instanceId = db.prepare("SELECT value FROM application_metadata WHERE key = 'instanceId'").get().value;
  const metadata = (key) => db.prepare('SELECT value FROM application_metadata WHERE key = ?').get(key)?.value;
  const previousNamespace = metadata('terminalNamespace');
  if (!previousNamespace || ['fw', 'ws'].includes(previousNamespace)) {
    // Old terminal records cannot prove ownership of a live global session.
    const panels = db.prepare("SELECT id FROM panels WHERE kind IN ('terminal', 'ai') ORDER BY id").all();
    const scopes = db.prepare("SELECT scope, state_json FROM browser_ui_state WHERE scope IN ('workspaces', 'bottom-terminals')").all()
      .filter(({ state_json }) => {
        try {
          const state = JSON.parse(state_json);
          return (state.workspaces?.length || state.terminals?.length || state.groups?.length) > 0;
        } catch { return true; }
      }).map(({ scope }) => scope);
    if (panels.length || scopes.length) {
      put.run('terminalOwnership', JSON.stringify({
        status: 'migration_required', legacyNamespace: previousNamespace || 'fw',
        panelIds: panels.map(({ id }) => id), browserScopes: scopes,
      }));
    }
    db.prepare('INSERT OR REPLACE INTO application_metadata (key, value) VALUES (?, ?)')
      .run('terminalNamespace', `fw-${instanceId.slice(0, 8)}`);
  }
  const pendingLocation = JSON.parse(metadata('locationConfigPending') || 'null');
  if (pendingLocation && !config.locations[pendingLocation.from] && config.locations[pendingLocation.to]) {
    db.prepare("DELETE FROM application_metadata WHERE key='locationConfigPending'").run();
  }
  const terminalNamespace = metadata('terminalNamespace');
  let closed = false;
  let lastOwnership = metadata('terminalOwnership') ? JSON.parse(metadata('terminalOwnership')) : { status: 'owned' };
  const ownership = () => {
    try {
      if (!closed) lastOwnership = metadata('terminalOwnership') ? JSON.parse(metadata('terminalOwnership')) : { status: 'owned' };
    } catch (error) { if (error.code !== 'ERR_INVALID_STATE') throw error; }
    return lastOwnership;
  };
  const assertTerminalOwnership = () => {
    if (!closed && metadata('locationConfigPending')) throw new ApiError(409, 'location identity migrated; restart the daemon to load its configuration');
    const terminalOwnership = ownership();
    if (terminalOwnership.status !== 'owned') {
      throw new ApiError(409, 'legacy terminal ownership requires migration; existing terminal processes are preserved', {
        code: 'terminal_ownership_migration_required', ...terminalOwnership,
      });
    }
  };
  const context = {
    config, db, instanceId, terminalNamespace, get terminalOwnership() { return ownership(); }, assertTerminalOwnership, clock, publish, runProcess,
    configRevision: configRevision(config),
    environment: { ...environment, FRITZWORKS_INSTANCE_ID: instanceId },
    configurationStatus: () => configurationStatus(config, reloadConfig),
    storage: { ...config.storage, roots: config.paths, notesRoot: config.paths.notes ?? null, dataDir: config.paths.data },
    adapters: {
      parseSelector,
      nativeOpenAvailable: adapters.openPath ? () => true : undefined,
      expandIssue: (row, value) => expandIssueReference(row, value, { run: runProcess }),
      openPath: (path) => operations.openPathWithXdg(path, { run: runProcess }),
      materialize: (org, repo, branch, source, options = {}) => materializeWorktree(org, repo, branch, source, { ...options, config }),
      removeWorktree: (org, repo, path) => removeWorktree(org, repo, path, config),
      createScratchpad: (db, name) => createScratchpad(db, name, config),
      writeSeed: (row, content) => writeSeed(row, content, config),
      ...adapters,
    },
    sessionNotes: createSessionNotes(db, config, { clock }),
    gitStorage: createGitStorage(db, config, { run: runProcess, instanceId }),
    resolveTarget: (value) => resolveTarget(db, config, value),
    close: () => {
      if (closed) return;
      const finish = () => { lastOwnership = ownership(); closed = true; if (!suppliedDb) db.close(); };
      const draining = context.jobs?.close();
      if (draining) return draining.then(finish);
      finish();
    },
  };
  try { initializeStorageOwners(context); persistInstanceBinding(config, instanceId); }
  catch (error) { if (!suppliedDb) db.close(); throw error; }
  context.storageMigration = createStorageMigration(context);
  context.storageRelocation = createStorageRelocation(context, adapters.storageRelocation);
  context.locationMigration = createLocationMigration(context);
  context.terminalMigration = createTerminalMigration(context, adapters.terminalMigration);
  const options = (extra = {}) => ({ ...context.adapters, defaultPanels: context.policy?.defaultPanels(), legacyGitAdapter: Boolean(adapters.materialize), sessionNotes: context.sessionNotes, gitStorage: context.gitStorage, notesRoot: config.paths.notes ?? null, ...extra, config, now: clock });
  context.ownerId = (target) => {
    const resolved = context.resolveTarget(target);
    return resolved.kind === 'session'
      ? String(db.prepare('SELECT id FROM workstreams WHERE uuid = ?').get(resolved.id).id)
      : resolved.id;
  };
  context.previewStack = (target, kind, body) => previewStack(context, target, kind, body);
  context.assertMutationAvailable = () => { if (!jobWorker && context.jobs?.list().some((job) => ['running', 'cancel_requested'].includes(job.status))) throw new ApiError(409, 'a daemon job is using managed state; retry after it settles', { code: 'job_in_progress' }); };
  context.policy = createOperationPolicy(context);
  context.hooks = createHookEvents(context, { resetStatus: !jobWorker });
  const validated = (intent) => { context.assertMutationAvailable(); return context.policy.validate(intent, intent.body?.previewRevision, { confirm: intent.body?.confirm }).intent.body; };
  const decorate = (item) => ({ ...item, availableActions: context.policy.actions(context.resolveTarget(String(item.id))) });
  context.operations = {
    list: (query, extra) => {
      const result = operations.queryWorkstreams(db, query, options(extra));
      return { ...result, items: result.items.map(decorate) };
    },
    createRepo: (body, extra) => operations.createRepoWorkstream(db, validated({ kind: 'create-repo', body }), options(extra)),
    createScratchpad: (body, extra) => operations.createScratchpadWorkstream(db, validated({ kind: 'create-scratchpad', body }), options(extra)),
    execute: (target, command, body, extra) => {
      if (['pause', 'resume', 'archive', 'close', 'agent-set', 'terminal-reset'].includes(command)) assertTerminalOwnership();
      const normalized = validated({ kind: 'action', target, command, body });
      const result = operations.executeWorkstreamCommand(db, context.ownerId(target), command, normalized, options(extra));
      if (['pause', 'archive', 'close', 'terminal-reset'].includes(command)) context.hooks.revoke(target);
      else if ((command === 'agent-set' && result.result.changed) || (command === 'resume' && (result.result.agentChanged || result.result.seeded))) {
        context.hooks.revoke(target, 'claude'); context.hooks.revoke(target, 'codex');
      }
      result.workstream = decorate(result.workstream);
      return result;
    },
    stack: (target) => {
      const row = db.prepare('SELECT * FROM workstreams WHERE id=?').get(context.ownerId(target));
      if (!row) throw new ApiError(400, 'stacks require a session');
      const brief = (item) => ({ ...briefStackRow(item), repo: `${item.org}/${item.repo}` });
      const tree = (item) => ({ ...brief(item.row), stackedBy: item.children.map(tree) });
      let chain = null; let reason;
      try { chain = stackLine(db, row); } catch (error) { reason = error.message; }
      const capability = chain ? context.previewStack(target, 'stack-link', {}) : null;
      return { workstream: brief(row), stackedOn: parentOf(db, row) ? brief(parentOf(db, row)) : null,
        stack: tree(stackTree(db, row)), linear: Boolean(chain), bottomToTop: chain?.map((item) => ({ ...brief(item), path: item.path })),
        canLinkOnGitHub: capability?.available || false, reason: reason || capability?.blocked.join('; '), githubRepo: capability?.remote?.repository };
    },
    setStack: (target, body) => operations.setWorkstreamStack(db, context.ownerId(target), body),
    linkStack: (target, body) => ({ job: context.jobs.submit({ kind: 'stack-link', target, body }, { idempotencyKey: body?.idempotencyKey }) }),
    notes: (target, extra) => operations.workstreamNotes(db, context.ownerId(target), options(extra)),
    createNote: (target, body, extra) => operations.createWorkstreamNote(db, context.ownerId(target), body, options(extra)),
    sync: (target, extra) => operations.syncWorkstreamSession(db, context.ownerId(target), options(extra)),
    digest: (body, extra) => operations.workstreamDigest(db, body, options(extra)),
  };
  if (!jobWorker) context.jobs = createJobs(context);
  return context;
}
