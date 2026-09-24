import { createHash, randomUUID } from 'node:crypto';
import { parseIni } from './config.js';
import { fileText, replaceFile } from './storage-files.js';
import { storageBackup } from './storage-migration.js';
import { ApiError } from './operation-error.js';

const conflict = (message) => { throw new ApiError(409, message, { code: 'location_migration_conflict' }); };
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const serialize = (object, section = '') => {
  const leaf = Object.entries(object).filter(([, value]) => !value || typeof value !== 'object' || Array.isArray(value));
  const nested = Object.entries(object).filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value));
  return `${section ? `[${section}]\n` : ''}${leaf.map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n')}\n`
    + nested.map(([key, value]) => serialize(value, section ? `${section}.${key}` : key)).join('\n');
};

export function createLocationMigration(context) {
  const { db, config } = context;
  const preview = ({ from, to }) => {
    if (config.configVersion !== 2) conflict('migrate configuration to version 2 first');
    if (!config.locations[from]) conflict('source location is not enabled');
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(to || '') || ['__proto__', 'prototype', 'constructor', 'all', 'new', 'events', 'repositories', 'scratchpads', 'data'].includes(to)) conflict('invalid destination location ID');
    if (config.locations[to] || db.prepare('SELECT 1 FROM storage_owners WHERE owner_key=?').get(`location:${to}`)
      || db.prepare("SELECT 1 FROM panel_groups WHERE type='configured' AND owner_id=?").get(to)) conflict('destination identity already exists');
    const before = fileText(config.configPath);
    if (!before) conflict('location migration requires a config file');
    const raw = config.configPath.endsWith('.json') ? JSON.parse(before) : parseIni(before);
    if (!raw.locations?.[from] || raw.locations[to]) conflict('location must have an unambiguous file definition');
    raw.locations[to] = { ...raw.locations[from], name: config.locations[from].name }; delete raw.locations[from];
    const after = config.configPath.endsWith('.json') ? JSON.stringify(raw, null, 2) + '\n' : serialize(raw);
    const terminals = context.storageRelocation.affectedTerminals(from);
    const plan = { from, to, before, after, instanceId: context.instanceId, terminals,
      owner: db.prepare('SELECT * FROM storage_owners WHERE owner_key=?').get(`location:${from}`) || null };
    return { ...plan, revision: digest(plan), blocked: terminals.some((item) => item.live.length) };
  };
  const recover = ({ migrationId }) => {
    const entry = db.prepare("SELECT * FROM storage_migrations WHERE id=? AND kind='location'").get(migrationId);
    if (!entry) throw new ApiError(404, 'no such location migration');
    if (entry.status === 'complete') return { migrationId, status: 'complete', restartRequired: true };
    const plan = JSON.parse(entry.plan_json);
    if (plan.instanceId !== context.instanceId || context.storageRelocation.affectedTerminals(plan.from).some((item) => item.live.length)) conflict('instance changed or terminals are active');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE storage_owners SET owner_key=? WHERE owner_key=?').run(`location:${plan.to}`, `location:${plan.from}`);
      db.prepare('UPDATE configured_location_state SET id=? WHERE id=?').run(plan.to, plan.from);
      db.prepare("UPDATE panel_groups SET owner_id=? WHERE type='configured' AND owner_id=?").run(plan.to, plan.from);
      for (const row of db.prepare("SELECT scope,state_json FROM browser_ui_state WHERE scope='workspaces'").all()) {
        const state = JSON.parse(row.state_json);
        for (const item of state.workspaces || []) if (String(item.id) === plan.from) item.id = plan.to;
        if (String(state.activeWorkspaceId) === plan.from) state.activeWorkspaceId = plan.to;
        db.prepare('UPDATE browser_ui_state SET state_json=? WHERE scope=?').run(JSON.stringify(state), row.scope);
      }
      db.prepare("INSERT OR REPLACE INTO application_metadata VALUES ('locationConfigPending',?)").run(JSON.stringify({ from: plan.from, to: plan.to }));
      replaceFile(config.configPath, plan.before, plan.after);
      db.prepare("UPDATE storage_migrations SET status='complete',error=NULL WHERE id=?").run(migrationId);
      db.prepare('UPDATE panel_layout_state SET revision=revision+1 WHERE singleton=1').run();
      db.exec('COMMIT');
      return { migrationId, status: 'complete', restartRequired: true, from: plan.from, to: plan.to };
    } catch (error) {
      db.exec('ROLLBACK');
      db.prepare("UPDATE storage_migrations SET status='interrupted',error=? WHERE id=?").run(error.message, migrationId);
      throw error;
    }
  };
  const apply = (body) => {
    const plan = preview(body);
    if (body.revision !== plan.revision || plan.blocked) conflict('preview changed or location terminals are active');
    const id = `location-${randomUUID()}`;
    const backup = storageBackup(db, config, id);
    db.prepare(`INSERT INTO storage_migrations (id,kind,status,plan_json,backup_path,updated_at)
      VALUES (?,'location','applying',?,?,?)`).run(id, JSON.stringify(plan), backup, context.clock());
    return recover({ migrationId: id });
  };
  return { preview, apply, recover };
}
