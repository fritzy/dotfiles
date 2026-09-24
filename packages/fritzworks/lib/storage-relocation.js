import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { ApiError } from './operation-error.js';
import { storageBackup } from './storage-migration.js';
import { canonicalDestination, confinedPath, storageAnchor } from './session-notes.js';
import { terminalPanelDescriptor } from './panels.js';
import { browserTerminalSessionName } from './zellij.js';

import { fileText, replaceFile, rewritePaths } from './storage-files.js';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const conflict = (message) => { throw new ApiError(409, message, { code: 'storage_relocation_conflict' }); };

function entries(root) {
  const result = [];
  const walk = (path, relative = '') => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = join(relative, entry.name);
      const full = join(path, entry.name);
      if (entry.isDirectory()) { result.push([name, 'directory']); walk(full, name); }
      else if (entry.isFile()) result.push([name, createHash('sha256').update(readFileSync(full)).digest('hex')]);
      else if (entry.isSymbolicLink()) result.push([name, `symlink:${readlinkSync(full)}`]);
      else conflict(`relocation requires manual handling of non-regular entry: ${full}`);
    }
  };
  walk(root);
  return result;
}
const manifest = (root) => hash(entries(root));

export function createStorageRelocation(context, adapters = {}) {
  const { db, config, gitStorage, sessionNotes } = context;
  const liveNames = adapters.liveNames || (() => {
    const result = context.runProcess('zellij', ['list-sessions', '--short', '--no-formatting'], { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      if (/no active .*sessions?/i.test(`${result.stdout}\n${result.stderr}`)) return [];
      conflict('cannot verify that affected terminal processes are stopped');
    }
    return String(result.stdout).trim().split('\n').filter(Boolean);
  });
  const affectedTerminals = (owner) => {
    const panels = db.prepare("SELECT p.id FROM panels p JOIN panel_groups g ON g.id=p.group_id WHERE g.owner_id=? AND p.kind IN ('terminal','ai')").all(String(owner));
    if (!panels.length) return [];
    const live = new Set(liveNames());
    return panels.map(({ id }) => {
      const { identity } = terminalPanelDescriptor(db, id);
      const names = [context.terminalNamespace, 'fw', 'ws'].map((namespace) => browserTerminalSessionName({ ...identity, namespace }));
      return { panelId: id, names, live: names.filter((name) => live.has(name)) };
    });
  };
  const assertUnreserved = (destination, migrationId) => {
    const overlaps = (path) => {
      if (!path) return;
      const canonical = canonicalDestination(path);
      if (canonical === destination || canonical.startsWith(destination + sep) || destination.startsWith(canonical + sep)) {
        conflict(`destination overlaps reserved storage: ${path}`);
      }
    };
    for (const owner of db.prepare('SELECT notes_path,notes_reads,notes_canonical FROM storage_owners').all()) {
      for (const path of [owner.notes_path, owner.notes_canonical, ...JSON.parse(owner.notes_reads)]) overlaps(path);
    }
    for (const { path } of db.prepare('SELECT path FROM worktree_storage').all()) overlaps(path);
    for (const { common_dir } of db.prepare('SELECT common_dir FROM repository_storage').all()) overlaps(common_dir);
    for (const entry of db.prepare("SELECT id,plan_json FROM storage_migrations WHERE kind='relocation' AND status!='complete'").all()) {
      if (entry.id === migrationId) continue;
      const plan = JSON.parse(entry.plan_json);
      overlaps(plan.source); overlaps(plan.destination);
    }
  };
  const preview = (body) => {
    if (!['notes', 'worktree'].includes(body.kind)) throw new ApiError(400, 'relocation kind must be notes or worktree');
    if (typeof body.destination !== 'string' || !body.destination.startsWith('/')) throw new ApiError(400, 'destination must be an absolute path');
    const owner = context.ownerId(body.target);
    const row = db.prepare('SELECT * FROM workstreams WHERE id=?').get(owner);
    const allocation = body.kind === 'notes' ? sessionNotes.allocation(owner) : row && gitStorage.record(row.uuid);
    if (!allocation) conflict('storage has no verified allocation');
    const source = body.kind === 'notes' ? allocation.notes_path : allocation.path;
    const destination = canonicalDestination(resolve(body.destination));
    if (!existsSync(source)) conflict('source storage is unavailable');
    const sourceCanonical = canonicalDestination(source);
    if (sourceCanonical === destination || destination.startsWith(sourceCanonical + sep) || sourceCanonical.startsWith(destination + sep)) conflict('source and destination overlap');
    assertUnreserved(destination);
    if (existsSync(destination)) conflict('destination already exists');
    confinedPath(dirname(destination), destination);
    if (body.kind === 'worktree') gitStorage.verify(allocation);
    const terminals = affectedTerminals(owner);
    const plan = { kind: body.kind, owner, uuid: row?.uuid, ownerKey: allocation.owner_key,
      source, sourceCanonical, destination, commonDir: allocation.common_dir, branch: allocation.branch,
      tabsOriginal: fileText(join(config.paths.data, 'editor-tabs.json')),
      copy: body.copy === true, terminals, manifest: manifest(source), instanceId: context.instanceId };
    return { ...plan, revision: hash(plan), blocked: terminals.some((item) => item.live.length > 0) };
  };
  const finish = (id, plan) => {
    if (affectedTerminals(plan.owner).some((item) => item.live.length)) conflict('affected terminals must be stopped before relocation');
    const stage = db.prepare('SELECT status FROM storage_migrations WHERE id=?').get(id).status;
    if (stage === 'complete') return { migrationId: id, status: stage };
    if (plan.instanceId !== context.instanceId) conflict('relocation belongs to another instance');
    assertUnreserved(plan.destination, id);
    const claimPath = `${plan.destination}.fritzworks-relocation`;
    const claim = JSON.stringify({ id, instanceId: context.instanceId, source: plan.source, destination: plan.destination });
    mkdirSync(dirname(plan.destination), { recursive: true });
    if (!existsSync(claimPath)) {
      if (existsSync(plan.destination)) conflict('destination appeared without a relocation claim');
      writeFileSync(claimPath, claim, { flag: 'wx', mode: 0o600 });
    }
    if (lstatSync(claimPath).isSymbolicLink() || fileText(claimPath) !== claim) conflict('destination claimed by another relocation');
    if (canonicalDestination(plan.destination) !== plan.destination) conflict('destination binding changed');
    if (existsSync(plan.source) && canonicalDestination(plan.source) !== plan.sourceCanonical) conflict('source storage binding changed');
    const destinationExists = existsSync(plan.destination);
    if (!destinationExists) {
      if (manifest(plan.source) !== plan.manifest) conflict('source changed since relocation preview');
      mkdirSync(dirname(plan.destination), { recursive: true });
      if (plan.copy) {
        (adapters.copy || cpSync)(plan.source, plan.destination, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
      } else if (plan.kind === 'worktree') {
        gitStorage.git(['--git-dir', plan.commonDir, 'worktree', 'move', plan.source, plan.destination]);
      } else (adapters.rename || renameSync)(plan.source, plan.destination);
    }
    if (plan.copy && destinationExists && manifest(plan.destination) !== plan.manifest) {
      if (manifest(plan.source) !== plan.manifest) conflict('source changed during interrupted copy');
      const expected = new Map(entries(plan.source));
      for (const [name, kind] of entries(plan.destination)) {
        if (name.endsWith(`.${id}.pending`) && expected.has(name.slice(0, -`.${id}.pending`.length)) && kind !== 'directory' && !kind.startsWith('symlink:')) continue;
        if (!expected.has(name) || (kind === 'directory') !== (expected.get(name) === 'directory')) conflict('destination has unexpected entries');
      }
      for (const [name, kind] of expected) {
        const target = join(plan.destination, name);
        let current = null;
        try { current = lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (kind === 'directory') {
          if (current && !current.isDirectory()) conflict('partial copy directory type changed');
          mkdirSync(target, { recursive: true });
        } else if (kind.startsWith('symlink:')) {
          if (!current) symlinkSync(kind.slice(8), target);
          else if (!current.isSymbolicLink() || readlinkSync(target) !== kind.slice(8)) conflict('partial copy symlink changed');
        } else {
          if (current && !current.isFile()) conflict('partial copy file type changed');
          const temporary = `${target}.${id}.pending`;
          if (existsSync(temporary) && !lstatSync(temporary).isFile()) conflict('copy temporary path changed type');
          copyFileSync(join(plan.source, name), temporary);
          renameSync(temporary, target);
        }
      }
    }
    // A retained source is deliberate: cross-volume recovery never deletes it.
    if (manifest(plan.destination) !== plan.manifest) conflict('destination content differs; preserve both paths and inspect recovery');
    if (plan.copy && existsSync(plan.source) && manifest(plan.source) !== plan.manifest) conflict('source changed while copying; preserve both paths');
    if (plan.kind === 'worktree') {
      if (plan.copy) gitStorage.git(['--git-dir', plan.commonDir, 'worktree', 'repair', plan.destination]);
      gitStorage.verify({ path: plan.destination, common_dir: plan.commonDir, branch: plan.branch });
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      const rewrite = (path) => path === plan.source || path.startsWith(plan.source + sep)
        ? plan.destination + path.slice(plan.source.length) : path;
      for (const resource of db.prepare("SELECT id,value FROM resource_associations WHERE kind IN ('markdown','html')").all()) {
        const path = rewrite(resource.value);
        if (path !== resource.value) db.prepare('UPDATE resource_associations SET value=? WHERE id=?').run(path, resource.id);
      }
      for (const state of db.prepare('SELECT scope,state_json FROM browser_ui_state').all()) {
        db.prepare('UPDATE browser_ui_state SET state_json=? WHERE scope=?')
          .run(JSON.stringify(rewritePaths(JSON.parse(state.state_json), plan.source, plan.destination)), state.scope);
      }
      if (plan.tabsOriginal !== null) replaceFile(join(config.paths.data, 'editor-tabs.json'), plan.tabsOriginal,
        JSON.stringify(rewritePaths(JSON.parse(plan.tabsOriginal), plan.source, plan.destination), null, 2));
      if (plan.kind === 'notes') {
        const owner = db.prepare('SELECT * FROM storage_owners WHERE owner_key=?').get(plan.ownerKey);
        db.prepare('UPDATE storage_owners SET notes_path=?,notes_reads=?,notes_canonical=?,notes_anchor=? WHERE owner_key=?')
          .run(plan.destination, JSON.stringify(JSON.parse(owner.notes_reads).map(rewrite)), canonicalDestination(plan.destination), storageAnchor(plan.destination), plan.ownerKey);
      } else {
        db.prepare('UPDATE worktree_storage SET path=? WHERE session_uuid=?').run(plan.destination, plan.uuid);
        db.prepare('UPDATE workstreams SET path=? WHERE uuid=?').run(plan.destination, plan.uuid);
        db.prepare('UPDATE panel_groups SET path=? WHERE owner_id=?').run(plan.destination, String(plan.owner));
      }
      db.prepare('UPDATE panel_layout_state SET revision=revision+1,updated_at=? WHERE singleton=1').run(context.clock());
      db.prepare("UPDATE storage_migrations SET status='complete',error=NULL,updated_at=? WHERE id=?").run(context.clock(), id);
      db.exec('COMMIT');
      return { migrationId: id, status: 'complete', path: plan.destination, source: plan.source, retainedSource: plan.copy ? plan.source : null };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const recover = ({ migrationId }) => {
    const entry = db.prepare("SELECT * FROM storage_migrations WHERE id=? AND kind='relocation'").get(migrationId);
    if (!entry) throw new ApiError(404, 'no such relocation');
    try { return finish(entry.id, JSON.parse(entry.plan_json)); }
    catch (error) {
      db.prepare("UPDATE storage_migrations SET status='interrupted',error=?,updated_at=? WHERE id=?").run(error.message, context.clock(), entry.id);
      throw error;
    }
  };
  const apply = (body) => {
    const plan = preview(body);
    if (plan.revision !== body.revision || plan.blocked) conflict('relocation preview is stale or terminals are still active');
    const id = `relocation-${randomUUID()}`;
    const backup = storageBackup(db, config, id);
    db.prepare(`INSERT INTO storage_migrations (id,kind,status,plan_json,backup_path,updated_at)
      VALUES (?,'relocation','applying',?,?,?)`).run(id, JSON.stringify(plan), backup, context.clock());
    return recover({ migrationId: id });
  };
  return { preview, apply, recover, affectedTerminals };
}
