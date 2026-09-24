import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { sep } from 'node:path';
import { ApiError } from './operation-error.js';

export const fileText = (path) => existsSync(path) ? readFileSync(path, 'utf8') : null;

export function replaceFile(path, before, after) {
  const current = fileText(path);
  if (current === after) return;
  if (current !== before) throw new ApiError(409, `file changed during migration: ${path}`);
  const temporary = `${path}.${randomUUID()}.pending`;
  writeFileSync(temporary, after, { flag: 'wx', mode: 0o600 });
  renameSync(temporary, path);
}

export function rewritePaths(value, source, destination) {
  if (typeof value === 'string') return value === source || value.startsWith(source + sep)
    ? destination + value.slice(source.length) : value;
  if (Array.isArray(value)) return value.map((item) => rewritePaths(item, source, destination));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [rewritePaths(key, source, destination), rewritePaths(item, source, destination)]));
  return value;
}
