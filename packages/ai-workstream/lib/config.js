import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
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

const validIniName = (value) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(value);

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
  if (typeof value !== 'string' || value.trim() === '') {
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
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
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

function panelValue(value) {
  const panels = typeof value === 'string' ? value.split(',').map((part) => part.trim()).filter(Boolean) : value;
  if (!Array.isArray(panels) || panels.length === 0) {
    throw new Error('panels must contain at least one of: shell, editor, agent');
  }
  const unique = [...new Set(panels)];
  const invalid = unique.find((panel) => !PANEL_ROLES.includes(panel));
  if (invalid) throw new Error(`unknown panel "${invalid}" (expected shell, editor, or agent)`);
  return unique;
}

function modelValue(value, fallback) {
  const selected = value === undefined ? fallback : value;
  if (selected === null || selected === '') return null;
  if (typeof selected !== 'string') throw new Error('agent models must be strings or null');
  return selected;
}

function integerValue(value, name, { min, max }) {
  const number = Number(value);
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

function booleanValue(value, fallback, name) {
  const selected = value ?? fallback;
  if (typeof selected !== 'boolean') throw new Error(`${name} must be true or false`);
  return selected;
}

export function resolveConfig({
  env = process.env,
  home = homedir(),
  configPath,
  defaultConfigPath = DEFAULT_CONFIG_PATH,
} = {}) {
  const xdgConfig = env.XDG_CONFIG_HOME || join(home, '.config');
  const requestedConfigPath = configPath
    || env.AI_WORKSTREAM_CONFIG
    || env.WS_CONFIG
    || join(xdgConfig, 'ai-workstream', 'config.ini');
  const selectedConfigPath = expandPath(requestedConfigPath, {
    home,
    dataHome: env.XDG_DATA_HOME || join(home, '.local', 'share'),
    base: process.cwd(),
  });
  const file = mergeConfig(
    readConfigFile(defaultConfigPath, { required: true }),
    readConfigFile(selectedConfigPath),
  );

  const base = dirname(selectedConfigPath);
  const dataHome = env.XDG_DATA_HOME || join(home, '.local', 'share');
  const pathEnv = {
    repositories: firstDefined(env.AI_WORKSTREAM_REPOSITORIES, env.WS_REPOSITORIES),
    scratchpads: firstDefined(env.AI_WORKSTREAM_SCRATCHPADS, env.WS_SCRATCHPADS),
    notes: firstDefined(env.AI_WORKSTREAM_NOTES, env.WS_NOTES),
    dotfiles: firstDefined(env.AI_WORKSTREAM_DOTFILES, env.WS_DOTFILES),
    data: firstDefined(env.AI_WORKSTREAM_DATA, env.WS_DATA_DIR),
  };
  const pathNames = ['repositories', 'scratchpads', 'data'];
  const paths = Object.fromEntries(pathNames.map((name) => [
    name,
    expandPath(firstDefined(pathEnv[name], file.paths?.[name]), { home, dataHome, base }),
  ]));
  const locations = Object.fromEntries(Object.entries(file.locations || {}).map(([id, location]) => {
    if (RESERVED_LOCATION_IDS.has(id)) {
      throw new Error(`locations.${id} uses a reserved location name`);
    }
    if (!location || typeof location !== 'object' || Array.isArray(location)) {
      throw new Error(`locations.${id} must be a section with repo and path settings`);
    }
    const path = expandPath(firstDefined(pathEnv[id], file.paths?.[id], location.path), {
      home, dataHome, base,
    });
    paths[id] = path;
    return [id, {
      id,
      name: id,
      repo: repositoryValue(location.repo, id),
      path,
      branch: branchValue(location.branch, id),
      closeable: false,
      weeklyNotes: booleanValue(location.weeklyNotes, false, `locations.${id}.weeklyNotes`),
    }];
  }));

  const agent = firstDefined(env.AI_WORKSTREAM_AGENT, env.WS_AGENT, file.agent);
  if (!AGENT_PROVIDERS.includes(agent)) {
    throw new Error(`unknown agent "${agent}" (expected claude or codex)`);
  }

  const panels = panelValue(firstDefined(
    env.AI_WORKSTREAM_PANELS,
    env.WS_PANELS,
    file.panels,
  ));
  const commands = {
    shell: commandValue(firstDefined(envCommand(env.AI_WORKSTREAM_SHELL), envCommand(env.WS_SHELL), file.commands?.shell), undefined, 'shell'),
    editor: commandValue(firstDefined(envCommand(env.AI_WORKSTREAM_EDITOR), envCommand(env.WS_EDITOR), file.commands?.editor), undefined, 'editor'),
    claude: commandValue(firstDefined(envCommand(env.AI_WORKSTREAM_CLAUDE), envCommand(env.WS_CLAUDE), file.commands?.claude), undefined, 'claude'),
    codex: commandValue(firstDefined(envCommand(env.AI_WORKSTREAM_CODEX), envCommand(env.WS_CODEX), file.commands?.codex), undefined, 'codex'),
  };
  const models = {
    claude: {
      default: modelValue(firstDefined(env.AI_WORKSTREAM_CLAUDE_MODEL, env.WS_CLAUDE_MODEL), file.models?.claude?.default),
      scratch: modelValue(firstDefined(env.AI_WORKSTREAM_CLAUDE_SCRATCH_MODEL, env.WS_CLAUDE_SCRATCH_MODEL), file.models?.claude?.scratch),
    },
    codex: {
      default: modelValue(firstDefined(env.AI_WORKSTREAM_CODEX_MODEL, env.WS_CODEX_MODEL), file.models?.codex?.default),
      scratch: modelValue(firstDefined(env.AI_WORKSTREAM_CODEX_SCRATCH_MODEL, env.WS_CODEX_SCRATCH_MODEL), file.models?.codex?.scratch),
    },
  };
  const zellijSession = firstDefined(env.AI_WORKSTREAM_ZELLIJ_SESSION, env.WS_SESSION, file.zellijSession);
  if (typeof zellijSession !== 'string' || zellijSession === '') {
    throw new Error('zellijSession must be a non-empty string');
  }
  const gitProtocol = firstDefined(env.AI_WORKSTREAM_GIT_PROTOCOL, env.WS_GIT_PROTOCOL, file.gitProtocol);
  if (!['ssh', 'https'].includes(gitProtocol)) {
    throw new Error('gitProtocol must be "ssh" or "https"');
  }
  const serverHost = firstDefined(env.AI_WORKSTREAM_HOST, env.WS_HOST, file.server?.host);
  if (typeof serverHost !== 'string' || serverHost.trim() === '') {
    throw new Error('server.host must be a non-empty string');
  }
  const server = {
    host: serverHost,
    port: integerValue(
      firstDefined(env.AI_WORKSTREAM_PORT, env.WS_PORT, file.server?.port),
      'server.port',
      { min: 1, max: 65535 },
    ),
    pollInterval: integerValue(
      firstDefined(env.AI_WORKSTREAM_POLL_INTERVAL, env.WS_POLL_INTERVAL, file.server?.pollInterval),
      'server.pollInterval',
      { min: 100, max: 60000 },
    ),
  };

  return {
    defaultConfigPath,
    configPath: selectedConfigPath,
    home,
    paths,
    locations,
    panels,
    commands,
    agent,
    models,
    zellijSession,
    gitProtocol,
    server,
  };
}

export const CONFIG = resolveConfig();
