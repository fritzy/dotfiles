import { createHash } from 'node:crypto';
import { configResolution, resolveConfig } from './config.js';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

export function configRevision(config) {
  return createHash('sha256').update(JSON.stringify(canonical(config))).digest('hex').slice(0, 16);
}

export function configurationStatus(config, reload) {
  const activeRevision = configRevision(config);
  try {
    const diskRevision = reload ? configRevision(reload()) : activeRevision;
    return { activeRevision, diskRevision, restartRequired: activeRevision !== diskRevision, reload: 'restart' };
  } catch (error) {
    return { activeRevision, diskRevision: null, restartRequired: true, reload: 'restart', error: error.message };
  }
}

export function configReloader(config) {
  const resolution = configResolution(config);
  return resolution ? () => resolveConfig(resolution) : null;
}

export function daemonEnvironment(config, env = process.env) {
  const source = configResolution(config);
  const selected = source?.env || env;
  const result = Object.fromEntries(Object.entries(env).filter(([key]) => !/^(FRITZWORKS_|FW_|XDG_)/.test(key)));
  for (const [key, value] of Object.entries(selected)) {
    if (/^(FRITZWORKS_|FW_|XDG_)/.test(key)) result[key] = value;
  }
  if (config.configPath) result.FRITZWORKS_CONFIG = config.configPath;
  if (config.defaultConfigPath) result.FRITZWORKS_DEFAULT_CONFIG = config.defaultConfigPath;
  if (config.home) result.FRITZWORKS_HOME = config.home;
  for (const name of source ? [] : ['data', 'repositories', 'worktrees', 'scratchpads', 'sessionNotes', 'notes']) {
    if (config.paths[name]) result[`FRITZWORKS_${name.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`] = config.paths[name];
  }
  return result;
}
