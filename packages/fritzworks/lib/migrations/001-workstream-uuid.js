import { randomUUID } from 'node:crypto';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const newWorkstreamUuid = () => randomUUID();
export const isWorkstreamUuid = (value) => UUID_PATTERN.test(String(value || '').toLowerCase());

// Idempotent schema/data migration. openDb runs this on every daemon and CLI
// startup, so a workstation is migrated as soon as it pulls and opens its DB.
export function migrateWorkstreamUuids(db, { generateUuid = newWorkstreamUuid } = {}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const columns = db.prepare('PRAGMA table_info(workstreams)').all();
    const addedColumn = !columns.some(({ name }) => name === 'uuid');
    if (addedColumn) db.exec('ALTER TABLE workstreams ADD COLUMN uuid TEXT');

    const seen = new Set();
    let backfilled = 0;
    const update = db.prepare('UPDATE workstreams SET uuid=? WHERE id=?');
    for (const row of db.prepare('SELECT id, uuid FROM workstreams ORDER BY id').all()) {
      const current = String(row.uuid || '').toLowerCase();
      if (isWorkstreamUuid(current) && !seen.has(current)) {
        seen.add(current);
        if (current !== row.uuid) update.run(current, row.id);
        continue;
      }
      let uuid;
      do { uuid = String(generateUuid()).toLowerCase(); }
      while (!isWorkstreamUuid(uuid) || seen.has(uuid));
      update.run(uuid, row.id);
      seen.add(uuid);
      backfilled += 1;
    }

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS workstreams_uuid_unique ON workstreams(uuid);

      CREATE TRIGGER IF NOT EXISTS workstreams_uuid_required_insert
      BEFORE INSERT ON workstreams
      WHEN NEW.uuid IS NULL OR length(trim(NEW.uuid)) = 0
      BEGIN
        SELECT RAISE(ABORT, 'workstream uuid is required');
      END;

      CREATE TRIGGER IF NOT EXISTS workstreams_uuid_required_update
      BEFORE UPDATE OF uuid ON workstreams
      WHEN NEW.uuid IS NULL OR length(trim(NEW.uuid)) = 0
      BEGIN
        SELECT RAISE(ABORT, 'workstream uuid is required');
      END;
    `);
    db.exec('COMMIT');
    return { addedColumn, backfilled };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already ended */ }
    throw error;
  }
}
