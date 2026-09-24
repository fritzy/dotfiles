import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { ApiError } from './operation-error.js';
import { readMarkdownFile, writeMarkdownFile } from './notes-files.js';

const slug = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const unavailable = (path, error) => new ApiError(409, `session-note storage unavailable: ${path}`, {
  code: 'storage_unavailable', path, reason: error?.code || error?.message,
});

export function confinedPath(root, path) {
  const base = resolve(root);
  const target = resolve(path);
  if (target !== base && !target.startsWith(base + sep)) throw new ApiError(400, 'path escapes session-note directory');
  let ancestor = base;
  while (!existsSync(ancestor)) {
    try { lstatSync(ancestor); throw new ApiError(409, `dangling storage symlink: ${ancestor}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    ancestor = dirname(ancestor);
  }
  const realBase = resolve(realpathSync(ancestor), base.slice(ancestor.length).replace(/^[/\\]+/, ''));
  let current = target;
  while (!existsSync(current)) {
    try { lstatSync(current); throw new ApiError(409, `dangling storage symlink: ${current}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    current = dirname(current);
  }
  const actual = resolve(realpathSync(current), target.slice(current.length).replace(/^[/\\]+/, ''));
  if (actual !== realBase && !actual.startsWith(realBase + sep)) throw new ApiError(400, 'symlink escapes session-note directory');
  return target;
}

export function canonicalDestination(path) {
  let parent = path;
  while (!existsSync(parent)) parent = dirname(parent);
  if (!statSync(parent).isDirectory()) throw unavailable(path);
  return resolve(realpathSync(parent), path.slice(parent.length).replace(/^[/\\]+/, ''));
}

export function storageAnchor(path) {
  let parent = path;
  while (!existsSync(parent)) parent = dirname(parent);
  const info = statSync(parent);
  return JSON.stringify({ path: parent, real: realpathSync(parent), device: info.dev, inode: info.ino });
}

export function verifyStorageAnchor(anchor, path) {
  if (!anchor) return;
  const saved = JSON.parse(anchor);
  try {
    const current = statSync(saved.path);
    if (current.dev !== saved.device || current.ino !== saved.inode || realpathSync(saved.path) !== saved.real) throw unavailable(path);
  } catch (error) { throw unavailable(path, error); }
}

export function createSessionNotes(db, config, { clock = () => new Date().toISOString() } = {}) {
  const owner = (id) => {
    if (db.prepare("SELECT 1 FROM application_metadata WHERE key='locationConfigPending'").get()) throw new ApiError(409, 'location identity migrated; restart the daemon before note operations');
    const row = db.prepare('SELECT * FROM workstreams WHERE id=? OR uuid=?').get(String(id), String(id));
    if (row) return { key: `session:${row.uuid}`, uuid: row.uuid, row };
    if (config.locations?.[id]) return { key: `location:${id}`, uuid: null, row: null };
    throw new ApiError(404, `no note owner "${id}"`);
  };
  const allocation = (id) => {
    const identity = owner(id);
    if (db.prepare("SELECT 1 FROM storage_migrations WHERE kind='relocation' AND status!='complete' AND (json_extract(plan_json,'$.owner')=? OR json_extract(plan_json,'$.ownerKey')=?)").get(String(identity.row?.id ?? id), identity.key)) {
      throw new ApiError(409, 'note owner has an interrupted relocation; recover it before writing or scanning');
    }
    let saved = db.prepare('SELECT * FROM storage_owners WHERE owner_key=?').get(identity.key);
    if (!saved) {
      db.prepare('INSERT INTO storage_owners (owner_key, uuid) VALUES (?, ?)').run(identity.key, identity.uuid || randomUUID());
      saved = db.prepare('SELECT * FROM storage_owners WHERE owner_key=?').get(identity.key);
    }
    if (saved.status !== 'ready') throw new ApiError(409, 'session-note storage requires explicit migration', {
      code: 'storage_migration_required', owner: identity.key,
    });
    if (!saved.notes_path) {
      const root = config.configVersion === 2 ? config.paths.sessionNotes
        : join(config.paths.notes, 'work', String(new Date(clock()).getFullYear()), 'workstream');
      const path = join(root, saved.uuid);
      db.prepare('UPDATE storage_owners SET notes_path=?, notes_reads=? WHERE owner_key=?')
        .run(path, JSON.stringify([path]), identity.key);
      saved = db.prepare('SELECT * FROM storage_owners WHERE owner_key=?').get(identity.key);
    }
    verifyStorageAnchor(saved.notes_anchor, saved.notes_path);
    const canonical = canonicalDestination(saved.notes_path);
    if (saved.notes_canonical && saved.notes_canonical !== canonical) throw unavailable(saved.notes_path);
    if (!saved.notes_canonical) db.prepare('UPDATE storage_owners SET notes_canonical=? WHERE owner_key=?').run(canonical, saved.owner_key);
    if (!saved.notes_anchor) db.prepare('UPDATE storage_owners SET notes_anchor=? WHERE owner_key=?').run(storageAnchor(saved.notes_path), saved.owner_key);
    return { ...saved, notes_canonical: canonical, directories: JSON.parse(saved.notes_reads) };
  };
  const describe = (id) => {
    try {
      const saved = allocation(id);
      return { path: saved.notes_path, directories: saved.directories, available: existsSync(saved.notes_path),
        status: existsSync(saved.notes_path) ? 'available' : saved.notes_created ? 'unavailable' : 'uncreated', uuid: saved.uuid };
    } catch (error) {
      if (error instanceof ApiError) return { path: error.details?.path || null, available: false, status: 'unavailable', code: error.details?.code || 'storage_migration_required' };
      throw error;
    }
  };
  const scan = (id) => {
    const saved = allocation(id);
    const notes = [];
    for (const directory of saved.directories) {
      try {
        // Once used or adopted, disappearance may mean an unmounted volume.
        if (!existsSync(directory) && !saved.notes_created && directory === saved.notes_path) continue;
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          if (!entry.name.toLowerCase().endsWith('.md')) continue;
          const path = confinedPath(directory, join(directory, entry.name));
          if (!statSync(path).isFile()) continue;
          notes.push({ file: entry.name, path, year: basename(dirname(dirname(directory))) });
        }
      } catch (error) { throw unavailable(directory, error); }
    }
    return notes.sort((a, b) => a.path.localeCompare(b.path));
  };
  const create = (id, body, { title } = {}) => {
    const saved = allocation(id);
    if (typeof body !== 'string' || Buffer.byteLength(body) > 1024 * 1024) throw new ApiError(400, 'note content must be text of at most 1 MiB');
    if (saved.notes_created && !existsSync(saved.notes_path)) throw unavailable(saved.notes_path);
    confinedPath(saved.notes_path, saved.notes_path);
    mkdirSync(saved.notes_path, { recursive: true });
    const file = `${clock().replace(/[:.]/g, '-')}${title ? `-${slug(title)}` : ''}-${randomUUID()}.md`;
    const path = confinedPath(saved.notes_path, join(saved.notes_path, file));
    const content = title ? `# ${title}\n\n${body}` : body;
    writeFileSync(path, content.endsWith('\n') ? content : `${content}\n`, { flag: 'wx' });
    db.prepare('UPDATE storage_owners SET notes_created=1 WHERE owner_key=?').run(saved.owner_key);
    return { ...readMarkdownFile(path), file };
  };
  const resolveFile = (id, requested) => {
    const match = scan(id).find((note) => note.path === requested || note.file === requested);
    if (!match) throw new ApiError(404, 'no such session note');
    if (scan(id).filter((note) => note.file === requested).length > 1) throw new ApiError(409, 'ambiguous note name; use its absolute path');
    return match.path;
  };
  const ownerForPath = (path) => {
    const target = resolve(path);
    const owners = db.prepare('SELECT * FROM storage_owners WHERE notes_path IS NOT NULL').all();
    const currentPaths = [...owners.flatMap((saved) => JSON.parse(saved.notes_reads)), ...db.prepare('SELECT path FROM worktree_storage').all().map(({ path }) => path)];
    for (const { plan_json, status } of db.prepare("SELECT plan_json,status FROM storage_migrations WHERE kind='relocation'").all()) {
      const plan = JSON.parse(plan_json);
      if (status === 'complete' && currentPaths.some((path) => target === path || target.startsWith(path + sep))) continue;
      if (target === plan.source || target.startsWith(plan.source + sep)) throw new ApiError(409,
        status === 'complete' ? 'resource storage relocated; reopen its updated path' : 'resource storage has an interrupted relocation',
        { code: 'storage_relocated', path: plan.destination + target.slice(plan.source.length) });
    }
    for (const saved of owners) {
      if (!JSON.parse(saved.notes_reads).some((directory) => target.startsWith(directory + sep))) continue;
      if (saved.owner_key.startsWith('location:')) return saved.owner_key.slice(9);
      return db.prepare('SELECT id FROM workstreams WHERE uuid=?').get(saved.uuid)?.id ?? null;
    }
    return null;
  };
  return { ownerForPath, owner, allocation, describe, scan, create,
    read: (id, file) => readMarkdownFile(resolveFile(id, file)),
    write: (id, file, content, options) => writeMarkdownFile(resolveFile(id, file), content, options),
  };
}
