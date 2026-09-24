import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalDestination } from './session-notes.js';
import { ApiError } from './operation-error.js';

export const bindingPath = (config) => `${config.configPath}.instance.json`;
export function checkInstanceBinding(config) {
  if (existsSync(join(config.paths.data, 'rebind-pending.json'))) throw new ApiError(409, 'data rebind is incomplete; use offline recovery');
  const path = bindingPath(config);
  if (!existsSync(path)) return;
  const binding = JSON.parse(readFileSync(path, 'utf8'));
  if (binding.data !== canonicalDestination(config.paths.data)) throw new ApiError(409, 'config data directory changed; explicit offline rebind is required');
  return binding;
}

export function persistInstanceBinding(config, instanceId) {
  const previous = checkInstanceBinding(config);
  if (previous) {
    if (previous.instanceId !== instanceId) throw new ApiError(409, 'config belongs to a different daemon instance');
    return;
  }
  mkdirSync(dirname(bindingPath(config)), { recursive: true });
  writeFileSync(bindingPath(config), JSON.stringify({ data: canonicalDestination(config.paths.data), instanceId }), { flag: 'wx', mode: 0o600 });
}
