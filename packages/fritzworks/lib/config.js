import { endpoint } from '../shared/transport.js';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PANEL_ROLES = ['shell', 'editor', 'agent'];
export const AGENT_PROVIDERS = ['claude', 'codex'];
export const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../config.ini', import.meta.url));

const RESERVED_LOCATION_IDS = new Set(['all', 'new', 'events', 'repositories', 'scratchpads', 'data']);

const firstDefined = (...values) => values.find((value) => value !== undefined);

function iniValue(raw, source, lineNumber) {
  const value = raw.trim();
  if (value === '' || value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value.startsWith('[') || value.startsWith('"')) {
    try { return JSON.parse(value); }
    catch (error) { throw new Error(`${source}:${lineNumber}: invalid value: ${error.message}`); }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

const validIniName = (value) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(value)
  && !['__proto__', 'prototype', 'constructor'].includes(value);

export function parseIni(text, source = '<config>') {
  const config = {};
  let section = config;
  for (const [index, rawLine] of text.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    if (line.startsWith('[')) {
      const match = line.match(/^\[([^\]]+)]$/);
      if (!match) throw new Error(`${source}:${lineNumber}: invalid section header`);
      const parts = match[1].split('.').map((part) => part.trim());
      if (parts.some((part) => !validIniName(part))) {
        throw new Error(`${source}:${lineNumber}: invalid section name`);
      }
      section = config;
      for (const part of parts) {
        if (section[part] !== undefined && (typeof section[part] !== 'object' || Array.isArray(section[part]))) {
          throw new Error(`${source}:${lineNumber}: section conflicts with "${part}"`);
        }
        section[part] ||= {};
        section = section[part];
      }
      continue;
    }

    const equals = rawLine.indexOf('=');
    if (equals === -1) throw new Error(`${source}:${lineNumber}: expected key = value`);
    const key = rawLine.slice(0, equals).trim();
    if (!validIniName(key)) throw new Error(`${source}:${lineNumber}: invalid key "${key}"`);
    if (Object.hasOwn(section, key)) throw new Error(`${source}:${lineNumber}: duplicate key "${key}"`);
    section[key] = iniValue(rawLine.slice(equals + 1), source, lineNumber);
  }
  return config;
}

function readConfigFile(path, { required = false } = {}) {
  if (!existsSync(path)) {
    if (required) throw new Error(`default config not found: ${path}`);
    return {};
  }
  try {
    const text = readFileSync(path, 'utf8');
    return extname(path).toLowerCase() === '.json' ? JSON.parse(text) : parseIni(text, path);
  } catch (error) {
    if (error.message.startsWith(`${path}:`)) throw error;
    throw new Error(`cannot read config ${path}: ${error.message}`);
  }
}

function mergeConfig(base, override) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value)
        && merged[key] && typeof merged[key] === 'object' && !Array.isArray(merged[key])) {
      merged[key] = mergeConfig(merged[key], value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function expandPath(value, { home, dataHome, base }) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new Error('configured paths must be non-empty strings');
  }
  let expanded = value;
  const variables = [
    ['${HOME}', home], ['$HOME', home],
    ['${XDG_DATA_HOME}', dataHome], ['$XDG_DATA_HOME', dataHome],
  ];
  for (const [prefix, replacement] of variables) {
    if (expanded === prefix) expanded = replacement;
    else if (expanded.startsWith(`${prefix}/`)) expanded = join(replacement, expanded.slice(prefix.length + 1));
  }
  expanded = expanded === '~'
    ? home
    : expanded.startsWith('~/')
      ? join(home, expanded.slice(2))
      : expanded;
  if (expanded.startsWith('$') || (expanded.startsWith('~') && !expanded.startsWith('~/'))) throw new Error(`unsupported path expansion: ${value}`);
  return resolve(base, expanded);
}

function commandValue(value, fallback, name) {
  const selected = value ?? fallback;
  const command = typeof selected === 'string' ? [selected] : selected;
  if (!Array.isArray(command) || command.length === 0
      || command.some((part) => typeof part !== 'string' || part === '')) {
    throw new Error(`commands.${name} must be a command string or a non-empty array of strings`);
  }
  return [...command];
}

function envCommand(value) {
  if (!value) return undefined;
  if (value.trim().startsWith('[')) {
    try { return JSON.parse(value); }
    catch (error) { throw new Error(`invalid command array in environment: ${error.message}`); }
  }
  return value;
}

function modelValue(value, fallback) {
  const selected = value === undefined ? fallback : value;
  if (selected === null || selected === '') return null;
  if (typeof selected !== 'string') throw new Error('agent models must be strings or null');
  return selected;
}

function integerValue(value, name, { min, max }) {
  const number = typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)) ? Number(value) : NaN;
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}`);
  }
  return number;
}

function repositoryValue(value, name) {
  const repository = typeof value === 'string' ? value.trim() : '';
  const parts = repository.split('/');
  if (parts.length !== 2
      || parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..')) {
    throw new Error(`locations.${name}.repo must be in owner/repository form`);
  }
  return repository;
}

function branchValue(value, name) {
  const branch = value ?? 'main';
  if (typeof branch !== 'string' || branch.trim() === '') {
    throw new Error(`locations.${name}.branch must be a non-empty string`);
  }
  return branch.trim();
}

function daemonUrlValue(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`daemons.${name}.url must be a non-empty string`);
  }
  try { return endpoint(value.trim()); }
  catch { throw new Error(`daemons.${name}.url must be a valid absolute URL with a loopback host and no credentials, path prefix, query, or fragment`); }
}

function displayName(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function daemonNameValue(value, id) {
  if (value === undefined) return id.charAt(0).toUpperCase() + id.slice(1);
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`daemons.${id}.name must be a non-empty string`);
  }
  return value.trim();
}

function enabledValue(value, name, fallback = true) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${name} must be true or false`);
  return value;
}

function stringList(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${name} must be an array of non-empty strings`);
  }
  return value;
}

function resolveSuggestions(value = {}) {
  const linear = value.linear || {};
  const github = value.github || {};
  const linearEnabled = enabledValue(linear.enabled, 'suggestions.linear.enabled', false);
  if (linearEnabled && (typeof linear.team !== 'string' || !/^[A-Za-z0-9_-]+$/.test(linear.team))) {
    throw new Error('suggestions.linear.team is required when enabled');
  }
  const reviewRepositories = stringList(github.reviewRepositories, 'suggestions.github.reviewRepositories');
  for (const repo of [...reviewRepositories, ...(github.issueRepository ? [github.issueRepository] : [])]) {
    repositoryValue(repo, 'suggestions.github');
  }
  if (github.issueLabel != null && typeof github.issueLabel !== 'string') {
    throw new Error('suggestions.github.issueLabel must be a string');
  }
  return {
    linear: { enabled: linearEnabled, team: linear.team || null },
    github: {
      enabled: enabledValue(github.enabled, 'suggestions.github.enabled', false),
      issueRepository: github.issueRepository || null,
      issueLabel: github.issueLabel || null,
      reviewRepositories,
      teammates: stringList(github.teammates, 'suggestions.github.teammates'),
    },
  };
}

function section(value, name, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be a section`);
  }
  for (const key of Object.keys(value)) {
    if (!validIniName(key) || (keys && !keys.includes(key))) throw new Error(`unknown configuration key ${name}.${key}`);
  }
}

function validateSchema(file, version, source) {
  section(file, source, ['configVersion', 'agent', 'gitProtocol', 'paths', 'locations', 'daemons', 'commands', 'models', 'server', 'suggestions', 'notes']);
  const fixed = {
    paths: version === 2 ? ['data', 'repositories', 'worktrees', 'scratchpads', 'sessionNotes']
      : ['data', 'repositories', 'scratchpads', 'notes', 'dotfiles', ...Object.keys(file.locations || {})],
    commands: ['shell', 'editor', 'claude', 'codex'],
    server: ['host', 'port', 'pollInterval'],
    models: ['claude', 'codex'], suggestions: ['linear', 'github'], notes: ['weekly'],
  };
  for (const [name, keys] of Object.entries(fixed)) if (file[name] !== undefined) section(file[name], name, keys);
  for (const provider of AGENT_PROVIDERS) {
    if (file.models?.[provider] !== undefined) section(file.models[provider], `models.${provider}`, ['default', 'scratch']);
  }
  if (file.suggestions?.linear !== undefined) section(file.suggestions.linear, 'suggestions.linear', ['enabled', 'team']);
  if (file.suggestions?.github !== undefined) section(file.suggestions.github, 'suggestions.github', ['enabled', 'issueRepository', 'issueLabel', 'reviewRepositories', 'teammates']);
  if (file.notes?.weekly !== undefined) section(file.notes.weekly, 'notes.weekly', ['enabled', 'root']);
  for (const name of ['locations', 'daemons']) {
    if (file[name] === undefined) continue;
    section(file[name], name);
    for (const [id, item] of Object.entries(file[name])) {
      if (name === 'daemons' && id === 'local') throw new Error('daemons.local is reserved for the current daemon');
      section(item, `${name}.${id}`, name === 'locations' ? ['name', 'path', 'repo', 'branch', 'enabled'] : ['name', 'url', 'enabled']);
      enabledValue(item.enabled, `${name}.${id}.enabled`);
      if (item.name !== undefined) displayName(item.name, `${name}.${id}.name`);
      if (name === 'locations') {
        if (item.path !== undefined && (typeof item.path !== 'string' || !item.path.trim())) throw new Error(`locations.${id}.path must be a non-empty string`);
        if (item.repo != null) repositoryValue(item.repo, id);
        if (item.branch !== undefined) branchValue(item.branch, id);
      } else if (item.url !== undefined) daemonUrlValue(item.url, id);
      if (name === 'locations' && RESERVED_LOCATION_IDS.has(id)) throw new Error(`locations.${id} uses a reserved location name`);
    }
  }
}

function directoryDestination(path, setting) {
  let ancestor = path;
  while (true) {
    try { lstatSync(ancestor); break; }
    catch (error) {
      const parent = dirname(ancestor);
      if (!['ENOENT', 'ENOTDIR'].includes(error.code) || parent === ancestor) {
        throw new Error(`${setting}: cannot inspect ${ancestor}: ${error.message}`);
      }
      ancestor = parent;
    }
  }
  try {
    if (!statSync(ancestor).isDirectory()) throw new Error('not a directory');
    return resolve(realpathSync(ancestor), relative(ancestor, path));
  } catch (error) {
    throw new Error(`${setting} requires a directory; ${ancestor}: ${error.message}`);
  }
}

function pathConflicts(paths) {
  const names = Object.keys(paths).filter((name) => name !== 'data');
  paths = Object.fromEntries(Object.entries(paths).map(([key, value]) => [key, directoryDestination(value, `paths.${key}`)]));
  const contains = (parent, child) => {
    const suffix = relative(parent, child);
    return suffix === '' || (!suffix.startsWith('..' + '/') && suffix !== '..' && !isAbsolute(suffix));
  };
  for (const [index, name] of names.entries()) {
    if (contains(paths[name], paths.data)) throw new Error(`paths.${name} must not contain paths.data`);
    for (const other of names.slice(index + 1)) {
      if (contains(paths[name], paths[other]) || contains(paths[other], paths[name])) {
        throw new Error(`paths.${name} conflicts with paths.${other}; managed roots must not overlap`);
      }
    }
  }
}

const resolutions = new WeakMap();
export const configResolution = (config) => resolutions.get(config);

export function resolveConfig({
  env = process.env,
  home = env.FRITZWORKS_HOME || homedir(),
  configPath,
  defaultConfigPath = env.FRITZWORKS_DEFAULT_CONFIG || DEFAULT_CONFIG_PATH,
} = {}) {
  const xdgConfig = env.XDG_CONFIG_HOME || join(home, '.config');
  const defaultUserConfig = join(xdgConfig, 'fritzworks', 'config.ini');
  const legacyUserConfig = join(xdgConfig, 'ai-workstream', 'config.ini');
  const requestedConfigPath = configPath
    || env.FRITZWORKS_CONFIG
    || env.FW_CONFIG
    || (existsSync(defaultUserConfig) || !existsSync(legacyUserConfig)
      ? defaultUserConfig : legacyUserConfig);
  const selectedConfigPath = expandPath(requestedConfigPath, {
    home,
    dataHome: env.XDG_DATA_HOME || join(home, '.local', 'share'),
    base: process.cwd(),
  });
  if ((configPath || env.FRITZWORKS_CONFIG || env.FW_CONFIG) && selectedConfigPath !== resolve(defaultUserConfig) && !existsSync(selectedConfigPath)) {
    throw new Error(`selected config not found: ${selectedConfigPath}`);
  }
  const userFile = readConfigFile(selectedConfigPath);
  const bundled = readConfigFile(defaultConfigPath, { required: true });
  const legacyData = join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'ws');
  const legacyEnvironment = ['FRITZWORKS_NOTES', 'FW_NOTES', 'FRITZWORKS_DOTFILES', 'FW_DOTFILES'].some((key) => env[key] !== undefined);
  const candidateData = expandPath(firstDefined(env.FRITZWORKS_DATA, env.FW_DATA_DIR, userFile.paths?.data, bundled.paths?.data), {
    home, dataHome: env.XDG_DATA_HOME || join(home, '.local', 'share'), base: dirname(selectedConfigPath),
  });
  const formatMarker = join(candidateData, 'config-format.json');
  let persistedVersion;
  if (existsSync(formatMarker)) {
    try { persistedVersion = JSON.parse(readFileSync(formatMarker, 'utf8')).configVersion; }
    catch { throw new Error(`cannot read configuration format marker: ${formatMarker}`); }
    integerValue(persistedVersion, 'persisted configVersion', { min: 1, max: 2 });
  }
  const inferredLegacy = persistedVersion !== 2 && (existsSync(selectedConfigPath) || legacyEnvironment
    || existsSync(join(legacyData, 'workstreams.db')) || existsSync(join(candidateData, 'workstreams.db')));
  const configVersion = integerValue(Object.hasOwn(userFile, 'configVersion') ? userFile.configVersion : (inferredLegacy ? 1 : bundled.configVersion ?? 2), 'configVersion', { min: 1, max: 2 });
  validateSchema(userFile, configVersion, selectedConfigPath);
  validateSchema(bundled, Number(bundled.configVersion || 1), defaultConfigPath);
  const legacyDefaults = { paths: { data: '${XDG_DATA_HOME}/fritzworks', repositories: '~/github', scratchpads: '~/scratchpad', notes: '~/notes' } };
  const defaults = configVersion === 1 ? { ...bundled, paths: legacyDefaults.paths, notes: { weekly: { enabled: true } } } : bundled;
  const file = mergeConfig(defaults, userFile);
  if (configVersion === 1 && ['FRITZWORKS_WORKTREES', 'FW_WORKTREES', 'FRITZWORKS_SESSION_NOTES', 'FW_SESSION_NOTES'].some((key) => env[key] !== undefined)) {
    throw new Error('independent worktree/session-note overrides require configVersion = 2; explicitly migrate legacy storage before switching');
  }
  const diagnostics = configVersion === 1
    ? ['Legacy configuration compatibility is active; storage retains its old layout. Use the daemon storage migration preview before switching formats.'] : [];
  if (configVersion === 2 && legacyEnvironment) {
    throw new Error('legacy notes/dotfiles environment overrides are not supported by configVersion = 2; configure locations and paths.sessionNotes explicitly');
  }
  const sources = {};
  const recordSources = (value, prefix = '') => {
    for (const [key, item] of Object.entries(value)) {
      const name = prefix ? `${prefix}.${key}` : key;
      if (item && typeof item === 'object' && !Array.isArray(item)) recordSources(item, name);
      else sources[name] = { kind: 'default', file: defaultConfigPath, key: name };
    }
  };
  recordSources(defaults);
  const recordUser = (value, prefix = '') => {
    for (const [key, item] of Object.entries(value)) {
      const name = prefix ? `${prefix}.${key}` : key;
      if (item && typeof item === 'object' && !Array.isArray(item)) recordUser(item, name);
      else sources[name] = { kind: 'file', file: selectedConfigPath, key: name };
    }
  };
  recordUser(userFile);
  if (configVersion === 1) for (const key of Object.keys(legacyDefaults.paths)) {
    if (userFile.paths?.[key] === undefined) sources[`paths.${key}`] = { kind: 'legacy-default' };
  }
  sources.configVersion = userFile.configVersion === undefined
    ? { kind: configVersion === 1 ? 'legacy-detection' : 'default' } : sources.configVersion;
  const envValue = (name, keys, fallback) => {
    const key = keys.find((key) => env[key] !== undefined);
    if (!key) return fallback;
    sources[name] = { kind: 'environment', key };
    return env[key];
  };
  const base = dirname(selectedConfigPath);
  const dataHome = env.XDG_DATA_HOME || join(home, '.local', 'share');
  const pathValue = (name, fallback, aliases = []) => {
    const key = name.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase();
    return expandPath(envValue(`paths.${name}`, [`FRITZWORKS_${key}`, ...aliases], firstDefined(file.paths?.[name], fallback)), { home, dataHome, base });
  };
  const paths = { data: pathValue('data', '${XDG_DATA_HOME}/fritzworks', ['FW_DATA_DIR']) };
  if (configVersion === 1 && env.FRITZWORKS_DATA === undefined && env.FW_DATA_DIR === undefined
      && userFile.paths?.data === undefined && !existsSync(paths.data) && existsSync(join(legacyData, 'workstreams.db'))) {
    paths.data = legacyData;
    sources['paths.data'] = { kind: 'legacy-detection', path: legacyData };
  }
  const pathNames = configVersion === 1 ? ['repositories', 'scratchpads', 'notes'] : ['repositories', 'worktrees', 'scratchpads', 'sessionNotes'];
  for (const name of pathNames) {
    const fallback = join(paths.data, name === 'sessionNotes' ? 'session-notes' : name);
    paths[name] = pathValue(name, fallback, [`FW_${name.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`]);
    sources[`paths.${name}`] ||= { kind: 'derived', from: 'paths.data' };
  }
  if (configVersion === 2) pathConflicts(paths);
  const locations = Object.fromEntries(Object.entries(file.locations || {}).filter(([id, item]) => enabledValue(item.enabled, `locations.${id}.enabled`)).map(([id, location]) => {
    let configuredPath = location.path;
    if (configVersion === 1) {
      const aliases = {
        notes: ['FRITZWORKS_NOTES', 'FW_NOTES'],
        dotfiles: ['FRITZWORKS_DOTFILES', 'FW_DOTFILES'],
      };
      const source = `locations.${id}.path`;
      if (userFile.paths?.[id] !== undefined) sources[source] = { kind: 'legacy-alias', from: `paths.${id}` };
      else if (configuredPath === undefined && file.paths?.[id] !== undefined) sources[source] = { kind: 'legacy-alias', from: `paths.${id}` };
      configuredPath = envValue(source, Object.hasOwn(aliases, id) ? aliases[id] : [],
        firstDefined(userFile.paths?.[id], configuredPath, file.paths?.[id]));
    }
    if (typeof configuredPath !== 'string' || !configuredPath.trim()) throw new Error(`locations.${id}.path is required`);
    const path = expandPath(configuredPath, { home, dataHome, base });
    directoryDestination(path, `locations.${id}.path`);
    if (configVersion === 1 && id === 'notes') {
      paths.notes = path;
      sources['paths.notes'] = { kind: 'legacy-alias', from: 'locations.notes.path' };
      diagnostics.push('Legacy locations.notes determines the old session/weekly note root; version 2 removes this coupling after migration.');
    }
    if (location.branch !== undefined && location.repo == null) throw new Error(`locations.${id}.branch requires repo metadata`);
    return [id, {
      id,
      name: location.name === undefined ? id : displayName(location.name, `locations.${id}.name`),
      repo: location.repo == null ? null : repositoryValue(location.repo, id),
      path,
      branch: location.repo == null ? null : branchValue(location.branch, id),
      closeable: false,
    }];
  }));
  const daemons = Object.fromEntries(Object.entries(file.daemons || {}).filter(([id, item]) => enabledValue(item.enabled, `daemons.${id}.enabled`)).map(([id, daemon]) => [id, {
    id, name: daemonNameValue(daemon.name, id), url: daemonUrlValue(daemon.url, id),
  }]));
  const daemonDirectory = { ...daemons, ...Object.fromEntries(Object.entries(file.daemons || {}).filter(([, item]) => item.enabled === false).map(([id, item]) => [id, { id, name: daemonNameValue(item.name, id), enabled: false }])) };
  const weeklyEnabled = enabledValue(file.notes?.weekly?.enabled, 'notes.weekly.enabled', configVersion === 1);
  const weeklyRoot = file.notes?.weekly?.root;
  if (configVersion === 2 && weeklyEnabled && !weeklyRoot) throw new Error('notes.weekly.root is required when weekly notes are enabled');
  const notes = { weekly: {
    enabled: weeklyEnabled,
    root: weeklyRoot ? expandPath(weeklyRoot, { home, dataHome, base }) : configVersion === 1 ? paths.notes : null,
  } };
  if (configVersion === 1 && userFile.notes?.weekly?.enabled === undefined) sources['notes.weekly.enabled'] = { kind: 'legacy-default' };
  sources['notes.weekly.enabled'] ||= { kind: configVersion === 1 ? 'legacy-default' : 'default' };
  sources['notes.weekly.root'] ||= { kind: configVersion === 1 ? 'legacy-alias' : 'default', ...(configVersion === 1 ? { from: 'paths.notes' } : {}) };
  if (notes.weekly.root) directoryDestination(notes.weekly.root, 'notes.weekly.root');
  if (configVersion === 2 && weeklyEnabled) pathConflicts({ ...paths, weeklyNotes: notes.weekly.root });
  for (const [name, path] of Object.entries(paths)) {
    directoryDestination(path, `paths.${name}`);
  }
  const storage = configVersion === 1
    ? { layout: 'legacy', sessionNotes: 'legacy', worktrees: 'legacy' }
    : { layout: 'v2', sessionNotes: 'persistent', worktrees: 'persistent' };

  const agent = firstDefined(env.FRITZWORKS_AGENT, env.FW_AGENT, file.agent);
  if (!AGENT_PROVIDERS.includes(agent)) {
    throw new Error(`unknown agent "${agent}" (expected claude or codex)`);
  }

  const commands = {
    shell: commandValue(firstDefined(envCommand(env.FRITZWORKS_SHELL), envCommand(env.FW_SHELL), file.commands?.shell), undefined, 'shell'),
    editor: commandValue(firstDefined(envCommand(env.FRITZWORKS_EDITOR), envCommand(env.FW_EDITOR), file.commands?.editor), undefined, 'editor'),
    claude: commandValue(firstDefined(envCommand(env.FRITZWORKS_CLAUDE), envCommand(env.FW_CLAUDE), file.commands?.claude), undefined, 'claude'),
    codex: commandValue(firstDefined(envCommand(env.FRITZWORKS_CODEX), envCommand(env.FW_CODEX), file.commands?.codex), undefined, 'codex'),
  };
  const models = {
    claude: {
      default: modelValue(firstDefined(env.FRITZWORKS_CLAUDE_MODEL, env.FW_CLAUDE_MODEL), file.models?.claude?.default),
      scratch: modelValue(firstDefined(env.FRITZWORKS_CLAUDE_SCRATCH_MODEL, env.FW_CLAUDE_SCRATCH_MODEL), file.models?.claude?.scratch),
    },
    codex: {
      default: modelValue(firstDefined(env.FRITZWORKS_CODEX_MODEL, env.FW_CODEX_MODEL), file.models?.codex?.default),
      scratch: modelValue(firstDefined(env.FRITZWORKS_CODEX_SCRATCH_MODEL, env.FW_CODEX_SCRATCH_MODEL), file.models?.codex?.scratch),
    },
  };
  const gitProtocol = firstDefined(env.FRITZWORKS_GIT_PROTOCOL, env.FW_GIT_PROTOCOL, file.gitProtocol);
  if (!['ssh', 'https'].includes(gitProtocol)) {
    throw new Error('gitProtocol must be "ssh" or "https"');
  }
  const serverHost = firstDefined(env.FRITZWORKS_HOST, env.FW_HOST, file.server?.host);
  if (typeof serverHost !== 'string' || serverHost.trim() === '') {
    throw new Error('server.host must be a non-empty string');
  }
  const server = {
    host: serverHost,
    port: integerValue(
      firstDefined(env.FRITZWORKS_PORT, env.FW_PORT, file.server?.port),
      'server.port',
      { min: 1, max: 65535 },
    ),
    pollInterval: integerValue(
      firstDefined(env.FRITZWORKS_POLL_INTERVAL, env.FW_POLL_INTERVAL, file.server?.pollInterval),
      'server.pollInterval',
      { min: 100, max: 60000 },
    ),
  };

  const suggestions = resolveSuggestions(file.suggestions);

  for (const [key, source] of Object.entries(env)) {
    const mapped = {
      AGENT: 'agent', GIT_PROTOCOL: 'gitProtocol', HOST: 'server.host', PORT: 'server.port', POLL_INTERVAL: 'server.pollInterval',
      SHELL: 'commands.shell', EDITOR: 'commands.editor', CLAUDE: 'commands.claude', CODEX: 'commands.codex',
      CLAUDE_MODEL: 'models.claude.default', CLAUDE_SCRATCH_MODEL: 'models.claude.scratch',
      CODEX_MODEL: 'models.codex.default', CODEX_SCRATCH_MODEL: 'models.codex.scratch',
    };
    const suffix = key.replace(/^(FRITZWORKS_|FW_)/, '');
    if (source !== undefined && mapped[suffix] && (key.startsWith('FRITZWORKS_') || (key.startsWith('FW_') && env[`FRITZWORKS_${suffix}`] === undefined))) {
      sources[mapped[suffix]] = { kind: 'environment', key };
    }
  }
  for (const [id, item] of Object.entries(locations)) {
    for (const key of Object.keys(item)) sources[`locations.${id}.${key}`] ||= { kind: 'derived', from: `locations.${id}` };
  }
  for (const [id, item] of Object.entries(daemons)) {
    for (const key of Object.keys(item)) sources[`daemons.${id}.${key}`] ||= { kind: 'derived', from: `daemons.${id}` };
  }
  const config = {
    configVersion, sources, diagnostics, storage, notes,
    suggestions,
    defaultConfigPath,
    configPath: selectedConfigPath,
    home,
    paths,
    locations,
    daemons,
    daemonDirectory,
    commands,
    agent,
    models,
    gitProtocol,
    server,
  };
  resolutions.set(config, { env: { ...env }, home, configPath: selectedConfigPath, defaultConfigPath });
  return config;
}

export function persistConfigVersion(config) {
  if (config.configVersion !== 2) return;
  const path = join(config.paths.data, 'config-format.json');
  mkdirSync(config.paths.data, { recursive: true });
  try { writeFileSync(path, JSON.stringify({ configVersion: 2 }) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}

export const CONFIG = resolveConfig();
