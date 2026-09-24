import { resolveRow as findRow } from './core.js';

function resolveRow(db, selector) {
  try { return findRow(db, selector); } catch (error) {
    throw new ApiError(409, error.message, { code: 'ambiguous_target', candidates: db.prepare('SELECT uuid AS id FROM workstreams WHERE branch=?').all(selector).map((row) => ({ kind: 'session', id: row.id })) });
  }
}
import { ApiError } from './operation-error.js';

export function resolveTarget(db, config, value) {
  if (value && typeof value === 'object') {
    if (value.kind === 'location' && typeof value.id === 'string') {
      if (!config.locations?.[value.id]) throw new ApiError(404, `unknown location "${value.id}"`);
      return Object.freeze({ kind: 'location', id: value.id });
    }
    if (value.kind !== 'session' || typeof value.id !== 'string') {
      throw new ApiError(400, 'target must be a session or location reference');
    }
    const row = resolveRow(db, value.id);
    if (!row) throw new ApiError(404, `unknown session "${value.id}"`);
    return Object.freeze({ kind: 'session', id: row.uuid });
  }
  const selector = String(value);
  if (config.locations?.[selector]) return Object.freeze({ kind: 'location', id: selector });
  const row = resolveRow(db, selector);
  if (!row) throw new ApiError(404, `no workstream matching "${selector}"`);
  return Object.freeze({ kind: 'session', id: row.uuid });
}
