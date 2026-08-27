import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { CONFIG } from './config.js';
import {
  currentWorkstream,
  openDb,
  resolveRow,
  setAgentStatus,
  setConfiguredLocationAgentStatus,
} from './core.js';

export const AGENT_HOOK_COMMAND = 'ws hook agent-status';

const COMMON_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'Stop'];
const READY_EVENTS = new Set(['SessionStart', 'PermissionRequest', 'Notification', 'Stop']);
const WORKING_EVENTS = new Set(['UserPromptSubmit', 'PostToolUse']);

function readJson(path) {
  if (!existsSync(path)) return {};
  const source = readFileSync(path, 'utf8');
  try {
    const value = JSON.parse(source);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('expected a JSON object');
    return value;
  } catch (error) {
    throw new Error(`cannot parse ${path}: ${error.message}`);
  }
}

function hasHandler(groups, command = AGENT_HOOK_COMMAND) {
  return Array.isArray(groups) && groups.some((group) =>
    Array.isArray(group?.hooks) && group.hooks.some((hook) =>
      hook?.type === 'command' && hook.command === command));
}

function addHandler(settings, event, { matcher, command = AGENT_HOOK_COMMAND } = {}) {
  settings.hooks ??= {};
  const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  settings.hooks[event] = groups;
  if (hasHandler(groups, command)) return false;
  groups.push({
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: 'command', command, timeout: 5 }],
  });
  return true;
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function installFile(path, provider, command) {
  const settings = readJson(path);
  let added = 0;
  for (const event of COMMON_EVENTS) added += Number(addHandler(settings, event, { command }));
  if (provider === 'claude') {
    added += Number(addHandler(settings, 'Notification', {
      matcher: 'idle_prompt|permission_prompt',
      command,
    }));
  }
  if (added) writeJsonAtomic(path, settings);
  return { provider, path, added, installed: true };
}

export function installAgentHooks({ home = homedir(), command = AGENT_HOOK_COMMAND } = {}) {
  return [
    installFile(join(home, '.claude', 'settings.json'), 'claude', command),
    installFile(join(home, '.codex', 'hooks.json'), 'codex', command),
  ];
}

export function agentHookStatus({ home = homedir(), command = AGENT_HOOK_COMMAND } = {}) {
  return [
    ['claude', join(home, '.claude', 'settings.json'), [...COMMON_EVENTS, 'Notification']],
    ['codex', join(home, '.codex', 'hooks.json'), COMMON_EVENTS],
  ].map(([provider, path, events]) => {
    const settings = readJson(path);
    const installedEvents = events.filter((event) => hasHandler(settings.hooks?.[event], command));
    return { provider, path, installed: installedEvents.length === events.length, events: installedEvents };
  });
}

export function recordAgentHook(payload, {
  db: suppliedDb,
  env = process.env,
  config = CONFIG,
} = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { updated: false, reason: 'invalid payload' };
  }
  const event = payload.hook_event_name;
  const status = WORKING_EVENTS.has(event) ? 'working' : READY_EVENTS.has(event) ? 'ready' : null;
  if (!status) return { updated: false, reason: 'unsupported event' };

  const db = suppliedDb || openDb();
  try {
    const explicitId = env.AI_WORKSTREAM_ID;
    if (explicitId && config.locations?.[explicitId]) {
      setConfiguredLocationAgentStatus(db, explicitId, status);
      return { updated: true, id: explicitId, status };
    }
    const row = explicitId ? resolveRow(db, String(explicitId)) : null;
    const selected = row || (typeof payload.cwd === 'string' ? currentWorkstream(db, payload.cwd) : null);
    if (selected) {
      setAgentStatus(db, selected.id, status);
      return { updated: true, id: selected.id, status };
    }
    if (typeof payload.cwd === 'string') {
      const cwd = resolve(payload.cwd);
      const configured = Object.values(config.locations || {}).find((location) => {
        const path = resolve(location.path);
        return cwd === path || cwd.startsWith(`${path}/`);
      });
      if (configured) {
        setConfiguredLocationAgentStatus(db, configured.id, status);
        return { updated: true, id: configured.id, status };
      }
    }
    return { updated: false, reason: 'workstream not found' };
  } finally {
    if (!suppliedDb) db.close();
  }
}
