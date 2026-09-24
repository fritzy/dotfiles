export function initializeStorageSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS storage_owners (
      owner_key TEXT PRIMARY KEY, uuid TEXT NOT NULL UNIQUE,
      notes_path TEXT, notes_reads TEXT NOT NULL DEFAULT '[]',
      notes_created INTEGER NOT NULL DEFAULT 0, notes_canonical TEXT, notes_anchor TEXT,
      status TEXT NOT NULL DEFAULT 'ready'
    );
    CREATE TABLE IF NOT EXISTS repository_storage (
      id TEXT PRIMARY KEY, source TEXT NOT NULL UNIQUE,
      common_dir TEXT NOT NULL, kind TEXT NOT NULL, layout_version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS worktree_storage (
      session_uuid TEXT PRIMARY KEY, repository_id TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE, branch TEXT NOT NULL, source TEXT NOT NULL,
      layout_version INTEGER NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS storage_migrations (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
      plan_json TEXT NOT NULL, backup_path TEXT, error TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS terminal_adoptions (
      identity_key TEXT PRIMARY KEY, session_name TEXT NOT NULL UNIQUE,
      evidence_json TEXT NOT NULL, claim_path TEXT NOT NULL,
      status TEXT NOT NULL
    );
  `);
  if (!db.prepare('PRAGMA table_info(storage_owners)').all().some(({ name }) => name === 'notes_canonical')) {
    db.exec('ALTER TABLE storage_owners ADD COLUMN notes_canonical TEXT');
  }
  if (!db.prepare('PRAGMA table_info(storage_owners)').all().some(({ name }) => name === 'notes_anchor')) {
    db.exec('ALTER TABLE storage_owners ADD COLUMN notes_anchor TEXT');
  }
}
