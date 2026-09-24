import { canonicalDestination } from './session-notes.js';
import { ApiError } from './operation-error.js';

export function retainedNotes(db, directory) {
  const root = canonicalDestination(directory);
  return db.prepare('SELECT * FROM storage_owners').all().filter((owner) => {
    const paths = [...new Set([owner.notes_path, ...JSON.parse(owner.notes_reads)].filter(Boolean))];
    return paths.some((path) => {
      const canonical = canonicalDestination(path);
      return canonical === root || canonical.startsWith(root + '/');
    });
  });
}

export function assertRemovableNotes(db, row) {
  const owner = db.prepare('SELECT * FROM storage_owners WHERE owner_key=?').get(`session:${row.uuid}`);
  if (owner?.status === 'migration_required') throw new ApiError(409, 'migrate session storage before removing its directory');
  const retained = retainedNotes(db, row.path);
  if (retained.length) throw new ApiError(409, 'relocate retained session notes before removing this directory', {
    code: 'retained_notes', owners: retained.map((item) => item.owner_key),
  });
  return retained;
}
