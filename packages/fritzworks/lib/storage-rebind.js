import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { acquireDaemonLock } from './daemon.js';
import { parseIni } from './config.js';
import { bindingPath } from './instance-binding.js';
import { canonicalDestination } from './session-notes.js';
import { fileText, replaceFile } from './storage-files.js';
import { storageBackup } from './storage-migration.js';
import { ApiError } from './operation-error.js';

const conflict = (message) => { throw new ApiError(409, message, { code: 'storage_rebind_conflict' }); };
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const serialize = (object, section = '') => {
  const lines = Object.entries(object).filter(([, value]) => !value || typeof value !== 'object' || Array.isArray(value));
  const nested = Object.entries(object).filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value));
  return `${section ? `[${section}]\n` : ''}${lines.map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n')}\n`
    + nested.map(([key, value]) => serialize(value, section ? `${section}.${key}` : key)).join('\n');
};

// Offline state transfer retains existing storage paths and terminal identities.
export function rebindStorage({ config, source = config.paths.data, destination, action = 'preview', revision, migrationId }, adapters = {}) {
  source = canonicalDestination(resolve(source));
  if (!existsSync(join(source, 'workstreams.db'))) conflict('source database does not exist');
  const db = new DatabaseSync(join(source, 'workstreams.db'), { readOnly: action === 'preview' });
  const releases = [];
  let activeId;
  try {
    const metadata = (key) => db.prepare('SELECT value FROM application_metadata WHERE key=?').get(key)?.value;
    let plan;
    let id = migrationId;
    let backup;
    if (action === 'recover') {
      const entry = db.prepare("SELECT * FROM storage_migrations WHERE id=? AND kind='rebind'").get(id);
      if (!entry) conflict('no such data rebind');
      plan = JSON.parse(entry.plan_json);
      backup = entry.backup_path;
      if (entry.status === 'complete') return { status: 'complete', migrationId: id, destination: plan.destination, backup };
    } else {
      if (config.configVersion !== 2 || metadata('storageVersion') !== '3') conflict('complete storage/config migration before rebinding data');
      if (metadata('storageRetiredTo')) conflict('source is already retired');
      if (db.prepare("SELECT 1 FROM storage_migrations WHERE status!='complete'").get()) conflict('recover pending migrations before rebinding data');
      if (!destination || !destination.startsWith('/')) conflict('destination must be an absolute path');
      destination = canonicalDestination(destination);
      if (source === destination || destination.startsWith(source + sep) || source.startsWith(destination + sep)) conflict('source and destination overlap');
      if (existsSync(destination)) conflict('destination already exists');
      const before = fileText(config.configPath);
      const raw = before ? (config.configPath.endsWith('.json') ? JSON.parse(before) : parseIni(before)) : {};
      raw.configVersion = 2;
      raw.paths = { ...config.paths, data: destination };
      const after = config.configPath.endsWith('.json') ? JSON.stringify(raw, null, 2) + '\n' : serialize(raw);
      plan = { source, destination, instanceId: metadata('instanceId'), configPath: config.configPath,
        configBefore: before, configAfter: after, bindingBefore: fileText(bindingPath(config)),
        retainedPaths: config.paths,
        allocations: { sessions: db.prepare('SELECT uuid,path FROM workstreams ORDER BY uuid').all(),
          notes: db.prepare('SELECT owner_key,notes_path,notes_reads FROM storage_owners ORDER BY owner_key').all(),
          repositories: db.prepare('SELECT id,common_dir FROM repository_storage ORDER BY id').all() },
        terminalNamespace: metadata('terminalNamespace') };
      plan.revision = hash(plan);
      if (action === 'preview') return plan;
      if (action !== 'apply' || revision !== plan.revision) conflict('data rebind preview is stale');
      id = `rebind-${randomUUID()}`;
    }
    activeId = id;
    const lock = adapters.lock || acquireDaemonLock;
    releases.push(lock({ ...config, paths: { ...config.paths, data: source } }));
    backup ||= storageBackup(db, { ...config, paths: { ...config.paths, data: source } }, id);
    db.prepare(`INSERT OR IGNORE INTO storage_migrations (id,kind,status,plan_json,backup_path,updated_at)
      VALUES (?,'rebind','applying',?,?,?)`).run(id, JSON.stringify(plan), backup, new Date().toISOString());
    mkdirSync(plan.destination, { recursive: true, mode: 0o700 });
    releases.push(lock({ ...config, paths: { ...config.paths, data: plan.destination } }));
    const pending = join(plan.destination, 'rebind-pending.json');
    const claim = JSON.stringify({ migrationId: id, source, instanceId: plan.instanceId });
    if (!existsSync(pending)) writeFileSync(pending, claim, { flag: 'wx', mode: 0o600 });
    if (fileText(pending) !== claim) conflict('destination belongs to another rebind');
    // Retirement precedes the snapshot; either side stays blocked on interruption.
    db.prepare("INSERT OR REPLACE INTO application_metadata VALUES ('storageRetiredTo',?)").run(plan.destination);
    const target = join(plan.destination, 'workstreams.db');
    if (existsSync(target)) {
      let probe;
      let damaged = false;
      try {
        probe = new DatabaseSync(target, { readOnly: true });
        damaged = probe.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok'
          || !probe.prepare("SELECT 1 FROM sqlite_master WHERE type='table'").get();
      } catch (error) {
        if (!/malformed|not a database|database disk image/i.test(error.message)) throw error;
        damaged = true;
      } finally { probe?.close(); }
      if (damaged) renameSync(target, `${target}.interrupted-${randomUUID()}`);
    }
    if (!existsSync(target)) db.prepare('VACUUM INTO ?').run(target);
    const destinationDb = new DatabaseSync(target);
    try {
      const saved = destinationDb.prepare("SELECT value FROM application_metadata WHERE key='instanceId'").get()?.value;
      if (saved !== plan.instanceId || !destinationDb.prepare('SELECT 1 FROM storage_migrations WHERE id=?').get(id)) conflict('destination database belongs to another transfer');
      destinationDb.exec('BEGIN IMMEDIATE');
      destinationDb.prepare("UPDATE application_metadata SET value=? WHERE key='storageDataPath'").run(plan.destination);
      const previous = JSON.parse(metadata('previousDataPaths') || '[]');
      destinationDb.prepare("INSERT OR REPLACE INTO application_metadata VALUES ('previousDataPaths',?)").run(JSON.stringify([...new Set([...previous, source])]));
      destinationDb.prepare("DELETE FROM application_metadata WHERE key='storageRetiredTo'").run();
      destinationDb.prepare("UPDATE storage_migrations SET status='complete',error=NULL WHERE id=?").run(id);
      destinationDb.exec('COMMIT');
    } finally { destinationDb.close(); }
    for (const file of ['editor-tabs.json', 'config-format.json']) {
      if (existsSync(join(source, file)) && !existsSync(join(plan.destination, file))) copyFileSync(join(source, file), join(plan.destination, file));
    }
    const seeds = join(source, 'seeds');
    if (existsSync(seeds)) {
      mkdirSync(join(plan.destination, 'seeds'), { recursive: true });
      for (const entry of readdirSync(seeds, { withFileTypes: true })) {
        if (!entry.isFile()) conflict('seed storage contains a non-regular file');
        const target = join(plan.destination, 'seeds', entry.name);
        replaceFile(target, fileText(target), readFileSync(join(seeds, entry.name), 'utf8'));
      }
    }
    (adapters.checkpoint || (() => {}))('before-config');
    replaceFile(plan.configPath, plan.configBefore, plan.configAfter);
    replaceFile(`${plan.configPath}.instance.json`, plan.bindingBefore, JSON.stringify({ data: plan.destination, instanceId: plan.instanceId }));
    unlinkSync(pending);
    db.prepare("UPDATE storage_migrations SET status='complete',error=NULL WHERE id=?").run(id);
    return { status: 'complete', migrationId: id, destination: plan.destination, retainedSource: source, backup };
  } catch (error) {
    if (activeId) db.prepare("UPDATE storage_migrations SET status='interrupted',error=? WHERE id=? AND status!='complete'").run(error.message, activeId);
    throw error;
  } finally {
    db.close();
    for (const release of releases.reverse()) release();
  }
}
