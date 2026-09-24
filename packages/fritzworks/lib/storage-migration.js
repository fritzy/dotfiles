import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseIni, resolveConfig } from './config.js';
import { canonicalDestination, storageAnchor, verifyStorageAnchor } from './session-notes.js';
import { ApiError } from './operation-error.js';

import { fileText, replaceFile } from './storage-files.js';

const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const slug = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const conflict = (message) => { throw new ApiError(409, message, { code: 'storage_migration_conflict' }); };

export function storageBackup(db, config, id) {
  const directory = join(config.paths.data, 'backups', id);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const database = join(directory, 'workstreams.db');
  if (!existsSync(database)) db.prepare('VACUUM INTO ?').run(database);
  if (config.configPath && existsSync(config.configPath)) copyFileSync(config.configPath, join(directory, 'config.original'));
  if (config.configPath && existsSync(`${config.configPath}.instance.json`)) copyFileSync(`${config.configPath}.instance.json`, join(directory, 'config.instance.json'));
  const tabs = join(config.paths.data, 'editor-tabs.json');
  if (existsSync(tabs)) copyFileSync(tabs, join(directory, 'editor-tabs.json'));
  writeFileSync(join(directory, 'effective-config.json'), JSON.stringify(config, null, 2));
  return directory;
}

export function initializeStorageOwners(context) {
  const { db, config } = context;
  const binding = db.prepare("SELECT value FROM application_metadata WHERE key='storageDataPath'").get()?.value;
  if (binding && binding !== realpathSync(config.paths.data)) conflict('data directory identity changed; explicit offline rebind is required before this database can own resources');
  if (db.prepare("SELECT 1 FROM application_metadata WHERE key='storageVersion'").get()) return;
  const rows = db.prepare('SELECT * FROM workstreams').all();
  const groups = db.prepare("SELECT * FROM panel_groups WHERE type='configured'").all();
  for (const { state_json } of db.prepare("SELECT state_json FROM browser_ui_state WHERE scope='workspaces'").all()) {
    try {
      for (const item of JSON.parse(state_json).workspaces || []) {
        if (config.locations[item.id] && !groups.some((group) => group.owner_id === String(item.id))) groups.push({ owner_id: String(item.id) });
      }
    } catch { conflict('legacy workspace state cannot be inventoried'); }
  }
  if (rows.length || groups.length) storageBackup(db, config, `before-storage-v3-${randomUUID()}`);
  const insert = db.prepare("INSERT OR IGNORE INTO storage_owners (owner_key,uuid,status) VALUES (?,?,'migration_required')");
  for (const row of rows) insert.run(`session:${row.uuid}`, row.uuid);
  for (const group of groups) insert.run(`location:${group.owner_id}`, randomUUID());
  db.prepare("INSERT INTO application_metadata (key,value) VALUES ('storageVersion','3')").run();
  db.prepare("INSERT OR IGNORE INTO application_metadata (key,value) VALUES ('storageDataPath',?)").run(realpathSync(config.paths.data));
}

export function createStorageMigration(context) {
  const { db, config, gitStorage, sessionNotes } = context;
  const inventory = ({ legacyConfigPath } = {}) => {
    const legacy = legacyConfigPath ? resolveConfig({ configPath: resolve(legacyConfigPath), home: config.home, env: {} }) : config;
    const root = legacy.paths.notes;
    const owners = [];
    const errors = [];
    const rows = db.prepare('SELECT * FROM workstreams ORDER BY id').all();
    const identities = rows.map((row) => ({ id: String(row.id), key: `session:${row.uuid}`, uuid: row.uuid, row }));
    const locationIds = new Set([...Object.keys(config.locations), ...db.prepare("SELECT owner_key FROM storage_owners WHERE owner_key LIKE 'location:%'").all().map(({ owner_key }) => owner_key.slice(9))]);
    for (const id of locationIds) {
      const saved = db.prepare('SELECT * FROM storage_owners WHERE owner_key=?').get(`location:${id}`);
      identities.push({ id, key: `location:${id}`, uuid: saved?.uuid || null });
    }
    const directories = [];
    if (root) {
      try {
        const work = join(root, 'work');
        // Missing legacy storage is not proof that its notes were deleted.
        if (!existsSync(root)) conflict(`legacy notes root unavailable: ${root}`);
        if (existsSync(work)) for (const year of readdirSync(work).filter((name) => /^\d{4}$/.test(name)).sort().reverse()) {
          const parent = join(work, year, 'workstream');
          if (!existsSync(parent)) continue;
          for (const entry of readdirSync(parent, { withFileTypes: true })) {
            if (entry.isDirectory()) directories.push({ name: entry.name, path: join(parent, entry.name) });
          }
        }
      } catch (error) { errors.push(error.message); }
    } else if (db.prepare("SELECT 1 FROM storage_owners WHERE status!='ready'").get()) {
      errors.push('legacyConfigPath is required to resolve the previous effective note root');
    }
    for (const identity of identities) {
      const saved = db.prepare('SELECT * FROM storage_owners WHERE owner_key=?').get(identity.key);
      const prefix = identity.row ? (identity.row.source === 'scratch' ? `${identity.id}-` : `${identity.id}-${identity.row.repo}-`) : `${slug(identity.id)}-`;
      const found = directories.filter((entry) => entry.name === identity.uuid || entry.name.startsWith(prefix)
        || (!identity.row && entry.name === slug(identity.id))).map(({ path }) => path);
      const primary = saved?.notes_path || found.find((path) => path.endsWith(`/${identity.uuid}`)) || found[0] || null;
      let uncreatedPrimary = null;
      if (saved?.notes_path && !saved.notes_created && !existsSync(saved.notes_path)) {
        try {
          verifyStorageAnchor(saved.notes_anchor, primary);
          const canonical = canonicalDestination(primary);
          if (saved.notes_canonical && canonical !== saved.notes_canonical) conflict(`note storage binding changed: ${primary}`);
          uncreatedPrimary = { path: primary, canonical, anchor: saved.notes_anchor || storageAnchor(primary) };
        } catch (error) { errors.push(error.message); }
      }
      owners.push({ key: identity.key, uuid: saved?.uuid || identity.uuid,
        primary, uncreatedPrimary,
        directories: [...new Set([...(saved ? JSON.parse(saved.notes_reads) : []), ...found])].filter((path) => path !== uncreatedPrimary?.path), id: identity.id });
    }
    const paths = new Map();
    for (const owner of owners) for (const path of [...owner.directories, ...(owner.uncreatedPrimary ? [owner.uncreatedPrimary.path] : [])]) {
      let canonical;
      try { canonical = path === owner.uncreatedPrimary?.path ? owner.uncreatedPrimary.canonical : realpathSync(path); }
      catch (error) { errors.push(`note storage unavailable: ${path}`); continue; }
      if (paths.has(canonical) && paths.get(canonical) !== owner.key) errors.push(`ambiguous notes directory: ${path}`);
      paths.set(canonical, owner.key);
    }
    const worktrees = [];
    for (const row of rows.filter((row) => row.source !== 'scratch')) {
      if (gitStorage.record(row.uuid)) continue;
      try {
        let allocation;
        if (!existsSync(row.path) && row.status === 'closed' && legacy.configVersion === 1) {
          if (![row.org, row.repo].every((part) => /^[A-Za-z0-9_.-]+$/.test(part) && !['.', '..'].includes(part))) conflict('legacy repository identity is ambiguous');
          const container = join(legacy.paths.repositories, row.org, row.repo);
          if (resolve(row.path) !== join(container, row.branch.replace(/\//g, '-'))) conflict('missing worktree does not match the legacy layout');
          allocation = { session_uuid: row.uuid, path: row.path, branch: row.branch, source: row.source,
            common_dir: realpathSync(join(container, '.bare')), removed_parent: realpathSync(container), status: 'removed' };
          gitStorage.verifyRemoved(allocation);
        } else {
          const common = gitStorage.commonDirectory(row.path);
          allocation = { session_uuid: row.uuid, path: row.path, branch: row.branch, source: row.source, common_dir: common, status: 'ready' };
          gitStorage.verify(allocation);
        }
        worktrees.push(allocation);
      } catch (error) { errors.push(`session ${row.id}: ${error.message}`); }
    }
    const caches = new Set(worktrees.map((tree) => tree.common_dir));
    if (legacy.configVersion === 1 && existsSync(legacy.paths.repositories)) {
      try {
        for (const org of readdirSync(legacy.paths.repositories, { withFileTypes: true }).filter((item) => item.isDirectory())) {
          const parent = join(legacy.paths.repositories, org.name);
          for (const repo of readdirSync(parent, { withFileTypes: true }).filter((item) => item.isDirectory())) {
            const cache = join(parent, repo.name, '.bare');
            if (existsSync(cache)) caches.add(cache);
          }
        }
      } catch (error) { errors.push(`repository cache inventory: ${error.message}`); }
    }
    const tabsPath = join(config.paths.data, 'editor-tabs.json');
    let tabs = null;
    try { tabs = existsSync(tabsPath) ? JSON.parse(readFileSync(tabsPath, 'utf8')) : null; }
    catch (error) { errors.push(`editor tabs: ${error.message}`); }
    const resources = db.prepare('SELECT * FROM resource_associations ORDER BY id').all();
    const proposedConfiguration = { ...Object.fromEntries(['agent', 'gitProtocol', 'server', 'commands', 'models', 'suggestions'].map((key) => [key, config[key]])), configVersion: 2, paths: { data: config.paths.data, repositories: config.paths.repositories,
      worktrees: config.paths.worktrees || join(config.paths.data, 'worktrees'), scratchpads: config.paths.scratchpads,
      sessionNotes: config.paths.sessionNotes || join(config.paths.data, 'session-notes') }, locations: Object.fromEntries(Object.entries(config.locations).map(([id, item]) => [id,
        { name: item.name, path: item.path, ...(item.repo ? { repo: item.repo, branch: item.branch } : {}) }])),
      daemons: Object.fromEntries(Object.entries(config.daemons).map(([id, item]) => [id, { name: item.name, url: item.url }])), notes: config.notes };
    const originalConfig = fileText(config.configPath);
    if (originalConfig) {
      const original = config.configPath.endsWith('.json') ? JSON.parse(originalConfig) : parseIni(originalConfig);
      for (const section of ['locations', 'daemons']) for (const [id, item] of Object.entries(original[section] || {})) {
        if (item.enabled === false) proposedConfiguration[section][id] = item;
      }
    }
    const serialize = (object, section = '') => {
      const scalars = Object.entries(object).filter(([, value]) => !value || typeof value !== 'object' || Array.isArray(value));
      const nested = Object.entries(object).filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value));
      return `${section ? `[${section}]\n` : ''}${scalars.map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n')}\n`
        + nested.map(([key, value]) => serialize(value, section ? `${section}.${key}` : key)).join('\n');
    };
    const translatedConfig = config.configPath.endsWith('.json') ? JSON.stringify(proposedConfiguration, null, 2) + '\n' : serialize(proposedConfiguration);
    const configuration = { path: config.configPath, before: originalConfig, after: translatedConfig,
      changes: ['Set configVersion to 2', 'Pin effective roots and settings', 'Separate ordinary locations from session-note storage'],
      environmentOverrides: Object.entries(config.sources).filter(([, source]) => source.kind === 'environment').map(([key, source]) => ({ key, variable: source.key })) };
    const plan = { proposedConfiguration, configuration, owners, worktrees, caches: [...caches].sort(), resources, tabs, legacyRoot: root || null, legacyConfigPath: legacyConfigPath || null,
      configRevision: context.configRevision, instanceId: context.instanceId, errors };
    return { ...plan, revision: digest(plan), moves: [] };
  };
  const finish = (id, plan, backup) => {
    const previous = db.prepare('SELECT status FROM storage_migrations WHERE id=?').get(id);
    if (previous.status === 'complete') return { migrationId: id, status: 'complete', backup };
    if (plan.instanceId !== context.instanceId) conflict('migration belongs to a different instance');
    for (const { uncreatedPrimary } of plan.owners) if (uncreatedPrimary) {
      verifyStorageAnchor(uncreatedPrimary.anchor, uncreatedPrimary.path);
      if (canonicalDestination(uncreatedPrimary.path) !== uncreatedPrimary.canonical) conflict('uncreated note storage binding changed');
    }
    for (const owner of plan.owners) for (const path of owner.directories) {
      if (!existsSync(path)) conflict(`note storage unavailable: ${path}`);
    }
    for (const tree of plan.worktrees) {
      if (tree.status === 'removed') {
        const row = db.prepare('SELECT status,path,branch FROM workstreams WHERE uuid=?').get(tree.session_uuid);
        if (row?.status !== 'closed' || row.path !== tree.path || row.branch !== tree.branch) conflict('removed legacy session changed since inventory');
        gitStorage.verifyRemoved(tree);
      } else gitStorage.verify(tree);
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const owner of plan.owners) {
        const uuid = owner.uuid;
        const primary = owner.primary || (config.configVersion === 2 ? join(config.paths.sessionNotes, uuid)
          : join(plan.legacyRoot, 'work', String(new Date(context.clock()).getFullYear()), 'workstream', uuid));
        const reads = [...new Set([primary, ...owner.directories])];
        db.prepare(`INSERT INTO storage_owners (owner_key,uuid,notes_path,notes_reads,notes_created,notes_canonical,notes_anchor,status)
          VALUES (?,?,?,?,?,?,?,'ready') ON CONFLICT(owner_key) DO UPDATE SET
          notes_path=excluded.notes_path, notes_reads=excluded.notes_reads, notes_created=excluded.notes_created,
          notes_canonical=excluded.notes_canonical, notes_anchor=excluded.notes_anchor, status='ready'`)
          .run(owner.key, uuid, primary, JSON.stringify(reads), existsSync(primary) ? 1 : 0,
            owner.uncreatedPrimary?.canonical || canonicalDestination(primary), owner.uncreatedPrimary?.anchor || storageAnchor(primary));
      }
      for (const tree of plan.worktrees) {
        const source = `legacy:${tree.common_dir}`;
        const repositoryId = digest(source);
        db.prepare('INSERT OR IGNORE INTO repository_storage (id,source,common_dir,kind,layout_version) VALUES (?,?,?,?,1)')
          .run(repositoryId, source, tree.common_dir, 'legacy');
        db.prepare(`INSERT OR IGNORE INTO worktree_storage (session_uuid,repository_id,path,branch,source,layout_version,status)
          VALUES (?,?,?,?,?,1,?)`).run(tree.session_uuid, repositoryId, tree.path, tree.branch, tree.source, tree.status || 'ready');
      }
      if (plan.tabs) {
        // Pin relative legacy tabs before a config switch removes their old root.
        const converted = structuredClone(plan.tabs);
        for (const state of Object.values(converted)) {
          for (const tab of state.tabs || []) {
            if ((tab.source || 'notes') === 'notes') {
              if (!plan.legacyRoot) conflict('legacy tabs have no resolved notes root');
              const oldPath = tab.path;
              tab.path = resolve(plan.legacyRoot, oldPath); tab.source = 'file';
              if (state.activePath === oldPath) state.activePath = tab.path;
            }
          }
        }
        replaceFile(join(config.paths.data, 'editor-tabs.json'), plan.tabsOriginal, JSON.stringify(converted, null, 2));
      }
      if (plan.applyConfiguration) replaceFile(plan.configuration.path, plan.configuration.before, plan.configuration.after);
      db.prepare("UPDATE storage_migrations SET status='complete', error=NULL, updated_at=? WHERE id=?").run(context.clock(), id);
      db.exec('COMMIT');
      return { status: 'complete', migrationId: id, backup, moved: [] };
    } catch (error) {
      db.exec('ROLLBACK');
      db.prepare("UPDATE storage_migrations SET status='interrupted',error=?,updated_at=? WHERE id=?").run(error.message, context.clock(), id);
      throw error;
    }
  };
  const recover = ({ migrationId } = {}) => {
    const entry = db.prepare("SELECT * FROM storage_migrations WHERE id=? AND kind='storage'").get(migrationId);
    if (!entry) throw new ApiError(404, 'no such storage migration');
    return finish(entry.id, JSON.parse(entry.plan_json), entry.backup_path);
  };
  const apply = (body = {}) => {
    const id = `storage-${body.revision}${body.applyConfiguration === true ? '-config' : ''}`;
    const previous = db.prepare('SELECT * FROM storage_migrations WHERE id=?').get(id);
    if (previous) return recover({ migrationId: id });
    const plan = inventory(body);
    if (body.revision !== plan.revision) conflict('storage inventory changed; preview again');
    if (plan.errors.length) conflict(plan.errors.join('; '));
    plan.owners = plan.owners.map((owner) => ({ ...owner, uuid: owner.uuid || randomUUID() }));
    plan.tabsOriginal = fileText(join(config.paths.data, 'editor-tabs.json'));
    plan.applyConfiguration = body.applyConfiguration === true;
    const backup = storageBackup(db, config, id);
    if (plan.legacyConfigPath) copyFileSync(plan.legacyConfigPath, join(backup, 'legacy-config.original'));
    db.prepare(`INSERT INTO storage_migrations (id,kind,status,plan_json,backup_path,updated_at)
      VALUES (?,'storage','applying',?,?,?)`).run(id, JSON.stringify(plan), backup, context.clock());
    return recover({ migrationId: id });
  };
  return { inventory, apply, recover,
    ledger: () => db.prepare('SELECT * FROM storage_migrations ORDER BY updated_at DESC').all(),
  };
}
