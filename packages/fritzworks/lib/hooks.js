import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { randomUUID } from 'node:crypto';
const shellQuote = (value) => `'${value.replaceAll("'", "'\"'\"'")}'`;
const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const HOOK_COMMAND = `${shellQuote(process.execPath)} --no-warnings ${shellQuote(CLI)} hook`;
export const AGENT_HOOK_COMMAND = `${HOOK_COMMAND} agent-status`;
export const SHELL_HOOK_COMMAND = `${HOOK_COMMAND} shell-status`;
const SHELL_HOOK_SOURCE = fileURLToPath(new URL('../shell/fritzworks.zsh', import.meta.url));
const SHELL_HOOK_MARKER = '# fritzworks shell status hook';

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
  if (existsSync(path)) {
    path = realpathSync(path);
    if (!existsSync(`${path}.fritzworks-backup`)) writeFileSync(`${path}.fritzworks-backup`, readFileSync(path), { mode: 0o600 });
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function writeTextAtomic(path, value, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, value, { mode });
  renameSync(temporary, path);
}


function shellHookScript(source = SHELL_HOOK_SOURCE) {
  return readFileSync(source, 'utf8')
    .replace(' && (( $+commands[fw] ))', '')
    .replace('command fw hook shell-status', `command ${SHELL_HOOK_COMMAND}`);
}

function shellHookSourced(rc, path, home) {
  const lines = rc.split(/\r?\n/);
  return lines.includes(`source ${shellQuote(path)}`)
    || (path === join(home, '.config', 'fritzworks', 'shell.zsh')
      && lines.includes('[ -f "$HOME/.config/fritzworks/shell.zsh" ] && source "$HOME/.config/fritzworks/shell.zsh"'));
}

function installFile(path, provider, command) {
  const settings = readJson(path);
  const marker = `${path}.fritzworks-command`;
  const previous = existsSync(marker) ? readFileSync(marker, 'utf8') : null;
  let migrated = false;
  if (command === AGENT_HOOK_COMMAND) {
    for (const groups of Object.values(settings.hooks || {})) {
      if (!Array.isArray(groups)) continue;
      for (const group of groups) {
        if (!Array.isArray(group?.hooks)) continue;
        for (const hook of group.hooks) {
          if (hook?.type === 'command' && hook.command !== command
              && ['fw hook agent-status', 'ws hook agent-status', previous].includes(hook.command)) {
            hook.command = command;
            migrated = true;
          }
        }
      }
    }
  }
  let added = 0;
  for (const event of COMMON_EVENTS) added += Number(addHandler(settings, event, { command }));
  if (provider === 'claude') {
    added += Number(addHandler(settings, 'Notification', {
      matcher: 'idle_prompt|permission_prompt',
      command,
    }));
  }
  if (added || migrated) writeJsonAtomic(path, settings);
  writeFileSync(marker, command, { mode: 0o600 });
  return { provider, path, added, installed: true };
}

export function clientHomes({ home = homedir(), env = process.env } = {}) {
  return {
    claude: env.CLAUDE_CONFIG_DIR || join(home, '.claude'),
    codex: env.CODEX_HOME || join(home, '.codex'),
  };
}

function agentFiles(options) {
  const homes = clientHomes(options);
  const providers = options.providers || ['claude', 'codex'];
  for (const provider of providers) {
    if (!homes[provider]) throw new Error(`unknown hook provider: ${provider}`);
  }
  return providers.map((provider) => [provider,
    options[`${provider}Path`] || join(homes[provider], provider === 'claude' ? 'settings.json' : 'hooks.json'),
    provider === 'claude' ? [...COMMON_EVENTS, 'Notification'] : COMMON_EVENTS,
  ]);
}

export function installAgentHooks(options = {}) {
  const command = options.command || AGENT_HOOK_COMMAND;
  return agentFiles(options).map(([provider, path]) => installFile(path, provider, command));
}

export function agentHookStatus(options = {}) {
  const command = options.command || AGENT_HOOK_COMMAND;
  return agentFiles(options).map(([provider, path, events]) => {
    const settings = readJson(path);
    const installedEvents = events.filter((event) => hasHandler(settings.hooks?.[event], command));
    return { provider, path, installed: installedEvents.length === events.length, events: installedEvents };
  });
}

export function uninstallAgentHooks(options = {}) {
  const command = options.command || AGENT_HOOK_COMMAND;
  return agentFiles(options).map(([provider, path]) => {
    const settings = readJson(path);
    const marker = `${path}.fritzworks-command`;
    const previous = existsSync(marker) ? readFileSync(marker, 'utf8') : null;
    const ownedCommands = command === AGENT_HOOK_COMMAND ? [command, previous] : [command];
    let removed = 0;
    for (const [event, groups] of Object.entries(settings.hooks || {})) {
      if (!Array.isArray(groups)) continue;
      settings.hooks[event] = groups.flatMap((group) => {
        if (!Array.isArray(group?.hooks)) return [group];
        const hooks = group.hooks.filter((hook) => {
          const owned = hook?.type === 'command' && ownedCommands.includes(hook.command);
          removed += Number(owned);
          return !owned;
        });
        if (hooks.length === group.hooks.length) return [group];
        return hooks.length ? [{ ...group, hooks }] : [];
      });
      if (groups.length && !settings.hooks[event].length) delete settings.hooks[event];
    }
    if (removed) {
      writeJsonAtomic(path, settings);
      if (ownedCommands.includes(previous)) rmSync(marker, { force: true });
    }
    return { provider, path, removed };
  });
}

export function uninstallShellHooks({
  home = homedir(), configHome = process.env.XDG_CONFIG_HOME || join(home, '.config'),
} = {}) {
  const path = join(configHome, 'fritzworks', 'shell.zsh');
  const rcPath = join(home, '.zshrc');
  let removed = false;
  if (existsSync(rcPath)) {
    const original = readFileSync(rcPath, 'utf8');
    const lines = original.split('\n');
    const source = `source ${shellQuote(path)}`;
    const kept = lines.filter((line, index) => {
      if (line === SHELL_HOOK_MARKER && lines[index + 1] === source) return false;
      if (line === source && lines[index - 1] === SHELL_HOOK_MARKER) { removed = true; return false; }
      return true;
    });
    if (removed) {
      const target = realpathSync(rcPath);
      writeTextAtomic(target, kept.join('\n'), statSync(target).mode & 0o777);
    }
  }
  if (removed && existsSync(path) && readFileSync(path, 'utf8') === shellHookScript()) {
    rmSync(path);
  }
  return { provider: 'zsh', path, removed };
}

export function installShellHooks({
  home = homedir(),
  configHome = process.env.XDG_CONFIG_HOME || join(home, '.config'),
  source = SHELL_HOOK_SOURCE,
} = {}) {
  const path = join(configHome, 'fritzworks', 'shell.zsh');
  const rcPath = join(home, '.zshrc');
  const script = shellHookScript(source);
  const installedScript = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const scriptUpdated = installedScript !== script;
  if (scriptUpdated) writeTextAtomic(path, script, 0o644);

  const sourceLine = `source ${shellQuote(path)}`;
  const originalRc = existsSync(rcPath) ? readFileSync(rcPath, 'utf8') : '';
  const legacyPath = join(configHome, 'ai-workstream', 'shell.zsh');
  const rc = originalRc.split(/\r?\n/).filter((line) =>
    !line.startsWith('# ai-workstream shell status hook')
    && line !== `source ${shellQuote(legacyPath)}`
    && line !== '[ -f "$HOME/.config/ai-workstream/shell.zsh" ] && source "$HOME/.config/ai-workstream/shell.zsh"'
  ).join('\n');
  const added = !shellHookSourced(rc, path, home);
  if (added || rc !== originalRc) {
    const separator = rc && !rc.endsWith('\n') ? '\n' : '';
    const writableRcPath = existsSync(rcPath) ? realpathSync(rcPath) : rcPath;
    const mode = existsSync(writableRcPath) ? statSync(writableRcPath).mode & 0o777 : 0o644;
    writeTextAtomic(writableRcPath, added ? `${rc}${separator}\n${SHELL_HOOK_MARKER}\n${sourceLine}\n` : rc, mode);
  }
  return { provider: 'zsh', path, rcPath, added: Number(added), updated: scriptUpdated, installed: true };
}

export function shellHookStatus({
  home = homedir(), configHome = process.env.XDG_CONFIG_HOME || join(home, '.config'),
} = {}) {
  const path = join(configHome, 'fritzworks', 'shell.zsh');
  const rcPath = join(home, '.zshrc');
  const sourced = existsSync(rcPath) && shellHookSourced(readFileSync(rcPath, 'utf8'), path, home);
  return { provider: 'zsh', path, rcPath, installed: existsSync(path) && sourced };
}

async function sendHook(provider, status, payload, {
  env = process.env, cwd = env.PWD || process.cwd(), fetchImpl = fetch, timeoutMs = 500,
} = {}) {
  const instanceId = env.FRITZWORKS_INSTANCE_ID;
  const generation = env.FRITZWORKS_GENERATION;
  const url = env.FRITZWORKS_DAEMON_URL;
  const sessionId = env.FRITZWORKS_ID || env.AI_WORKSTREAM_ID;
  const terminalId = env.FRITZWORKS_TERMINAL_ID;
  if (!instanceId || !generation || !url || !sessionId || !terminalId) return { updated: false, reason: 'missing daemon identity' };
  const occurredAt = Date.now();
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('hook deadline exceeded')); }, Math.min(1000, Math.max(1, timeoutMs)));
  });
  try {
    return await Promise.race([deadline, (async () => {
      const response = await fetchImpl(new URL('/hooks/events', url), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ instanceId, sessionId, terminalId, generation, provider, status,
          cwd: payload.cwd || cwd, eventId: payload.eventId || randomUUID(),
          emitterId: provider === 'shell' ? env.FRITZWORKS_HOOK_EMITTER || `shell:${process.ppid}` : `${provider}:${terminalId}`,
          sequence: Number((provider === 'shell' ? env.FRITZWORKS_HOOK_SEQUENCE : payload.sequence) || occurredAt), occurredAt }),
      });
      if (!response.ok) return { updated: false, reason: `daemon rejected hook (${response.status})` };
      return await response.json();
    })()]);
  } catch {
    return { updated: false, reason: 'daemon unavailable' };
  } finally { clearTimeout(timer); }
}

export async function recordAgentHook(payload, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { updated: false, reason: 'invalid payload' };
  const event = payload.hook_event_name;
  const status = WORKING_EVENTS.has(event) ? 'working' : READY_EVENTS.has(event) ? 'ready' : null;
  if (!status) return { updated: false, reason: 'unsupported event' };
  const env = options.env || process.env;
  return sendHook(env.FRITZWORKS_PROVIDER || payload.provider || 'claude', status, payload, options);
}

export async function recordShellHook(status, options = {}) {
  if (!['ready', 'working'].includes(status)) return { updated: false, reason: 'unsupported status' };
  return sendHook('shell', status, {}, options);
}
