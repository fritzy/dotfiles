// Zellij is an implementation detail of browser-terminal persistence. Each
// shell/editor/agent gets a private headless session so disconnecting xterm.js
// does not stop the process. This module deliberately has no managed-tab API.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { AGENT_PROVIDERS, CONFIG } from './config.js';
import { isScratch } from './core.js';

const ZELLIJ_COMMAND_TIMEOUT_MS = 15_000;

function zellij(args, opts = {}) {
  return spawnSync('zellij', args, {
    encoding: 'utf8', timeout: ZELLIJ_COMMAND_TIMEOUT_MS, killSignal: 'SIGKILL', ...opts,
  });
}

function detachedZellij(args, opts = {}) {
  const env = { ...process.env, ...opts.env };
  delete env.ZELLIJ;
  delete env.ZELLIJ_PANE_ID;
  delete env.ZELLIJ_SESSION_NAME;
  return zellij(args, { ...opts, env });
}

const lines = (value) => String(value || '').split('\n').map((line) => line.trim()).filter(Boolean);
const regexEscape = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const shellQuote = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`;
const shellCommand = (args) => args.map(shellQuote).join(' ');
const kdlString = (value) => JSON.stringify(String(value));

function zellijOutput(result) {
  return stripVTControlCharacters(`${result.stdout || ''}\n${result.stderr || ''}`).trim();
}

function requireZellij(result, message) {
  if (result.error) throw new Error(`${message}: ${result.error.message}`);
  if (result.status !== 0) {
    const output = zellijOutput(result);
    throw new Error(`${message}${output ? `: ${output}` : ''}`);
  }
  return result;
}

function sessionNotFound(output, session) {
  return new RegExp(`session ["']?${regexEscape(session)}["']? not found`, 'i')
    .test(stripVTControlCharacters(output));
}

function activeSessions(run = detachedZellij) {
  const result = run(['list-sessions', '--no-formatting']);
  if (result.error) throw new Error(`cannot query Zellij sessions: ${result.error.message}`);
  if (result.status !== 0) {
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (/no active .*sessions?/i.test(output)) return [];
    throw new Error(`cannot query Zellij sessions${output.trim() ? `: ${output.trim()}` : ''}`);
  }
  return lines(result.stdout)
    .filter((line) => !/\(EXITED\b/i.test(line))
    .map((line) => line.replace(/\s+\[Created\b.*$/, '').trim())
    .filter(Boolean);
}

function deleteSessionSnapshot(session, run) {
  const result = run(['delete-session', '--force', session]);
  if (result.error) throw new Error(`cannot reset Zellij session "${session}": ${result.error.message}`);
  const output = zellijOutput(result);
  if (result.status !== 0 && !/not found|no active .*sessions?/i.test(output)) {
    throw new Error(`cannot reset Zellij session "${session}"${output ? `: ${output}` : ''}`);
  }
  return result.status === 0;
}

function providerFor(opts, config = CONFIG) {
  const provider = opts.agent || config.agent;
  if (!AGENT_PROVIDERS.includes(provider)) {
    throw new Error(`unknown agent "${provider}" (expected claude or codex)`);
  }
  return provider;
}

function modelFor(row, provider, opts, config = CONFIG) {
  if (opts.model !== undefined) return opts.model || null;
  const lightweight = isScratch(row) || Boolean(config.locations?.[String(row.id)]);
  return config.models[provider][lightweight ? 'scratch' : 'default'];
}

export function agentInvocation(row, opts = {}, config = CONFIG) {
  const provider = providerFor(opts, config);
  const model = modelFor(row, provider, opts, config);
  const command = [...config.commands[provider], ...(model ? ['--model', model] : [])];
  return { provider, command: command[0], args: command.slice(1) };
}

// Produce the resume/fallback shell command for a browser-backed agent terminal.
// Seeded launches bypass the shell and use agentInvocation() directly.
export function agentCommand(row, opts = {}, config = CONFIG) {
  const { provider, command, args } = agentInvocation(row, opts, config);
  const base = [command, ...args];
  const trackedCommand = (args) => `FRITZWORKS_ID=${shellQuote(String(row.id))} ${shellCommand(args)}`;
  const resume = provider === 'claude'
    ? [...base, '--continue']
    : [...base, 'resume', '--last'];
  return `${trackedCommand(resume)} || ${trackedCommand(base)}`;
}

const BROWSER_TERMINAL_CONFIG_FILE = join(tmpdir(), 'fw-browser-terminal-config.kdl');
const BROWSER_TERMINAL_SESSION_MAX_BYTES = 48;

function compactBrowserTerminalSessionName(session, prefix) {
  if (Buffer.byteLength(session) <= BROWSER_TERMINAL_SESSION_MAX_BYTES) return session;
  const digest = createHash('sha256').update(session).digest('hex').slice(0, 24);
  return `${prefix}h-${digest.slice(0, BROWSER_TERMINAL_SESSION_MAX_BYTES - Buffer.byteLength(prefix) - 2)}`;
}

function terminalSessionName({
  sessionId = null, role = 'shell', terminalId = 'default', panelId = null,
} = {}, namespace = 'fw') {
  if (panelId) {
    const prefix = `${namespace}-browser-panel-`;
    const owner = sessionId !== null && sessionId !== undefined ? `${sessionId}-` : '';
    return compactBrowserTerminalSessionName(`${prefix}${owner}${panelId}`, prefix);
  }
  const prefix = sessionId !== null && sessionId !== undefined
    ? `${namespace}-browser-${role}-`
    : `${namespace}-browser-terminal-`;
  const session = `${prefix}${sessionId !== null && sessionId !== undefined ? sessionId : terminalId}`;
  return compactBrowserTerminalSessionName(session, prefix);
}

export function browserTerminalSessionName(identity) {
  return identity?.adoptedSession || terminalSessionName(identity, identity?.namespace || 'fw');
}

function terminalSessionNames(identity) {
  if (identity?.adoptedSession) return [identity.adoptedSession];
  // Hash the original name too: replacing the prefix cannot recover old panel hashes.
  if (identity?.namespace && identity.namespace !== 'fw') return [browserTerminalSessionName(identity)];
  return [terminalSessionName(identity), terminalSessionName(identity, 'ws')];
}

export function browserAgentSessionName(id) {
  return browserTerminalSessionName({ sessionId: id, role: 'agent' });
}

export function browserTerminalConfigFile({ runtimeDir } = {}) {
  if (runtimeDir) mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const file = runtimeDir ? join(runtimeDir, 'terminal-config.kdl') : BROWSER_TERMINAL_CONFIG_FILE;
  writeFileSync(file, 'pane_frames false\nshow_startup_tips false\nshow_release_notes false\n');
  return file;
}

export const browserAgentConfigFile = browserTerminalConfigFile;

function writeBrowserTerminalLayout(session, command, cwd, runtimeDir) {
  if (runtimeDir) mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const [program, ...args] = command;
  const argsBlock = args.length ? ` {\n            args ${args.map(kdlString).join(' ')}\n        }` : '';
  const file = join(runtimeDir || tmpdir(), `fw-browser-terminal-layout-${process.pid}-${session}.kdl`);
  writeFileSync(file, `layout {\n    tab cwd=${kdlString(cwd)} {\n        pane borderless=true command=${kdlString(program)}${argsBlock}\n    }\n}\n`);
  return file;
}

export function ensureBrowserTerminalSession(identity, { command, cwd, runtimeDir, env, prepareCommand, run = detachedZellij } = {}) {
  const session = browserTerminalSessionName(identity);
  const live = activeSessions(run);
  const existing = terminalSessionNames(identity).find((name) => live.includes(name));
  if (existing) return { session: existing, created: false };
  if (identity?.adoptedSession) throw new Error('adopted terminal is unavailable; explicit recovery is required');
  if (prepareCommand) command = prepareCommand(command);
  run(['delete-session', session]);
  const hookIdentityKeys = ['FRITZWORKS_ID', 'FRITZWORKS_DAEMON', 'AI_WORKSTREAM_ID', 'FRITZWORKS_GENERATION', 'FRITZWORKS_TERMINAL_ID', 'FRITZWORKS_PROVIDER', 'FRITZWORKS_DAEMON_URL'];
  const launch = env ? [
    'env', ...hookIdentityKeys.flatMap((key) => ['-u', key]),
    ...Object.entries(env).filter(([key]) => /^(FRITZWORKS_|FW_|XDG_)/.test(key)
      && !hookIdentityKeys.includes(key))
      .map(([key, value]) => `${key}=${value}`),
    ...command,
  ] : command;
  const layout = writeBrowserTerminalLayout(session, launch, cwd, runtimeDir);
  const configFile = browserTerminalConfigFile({ runtimeDir });
  requireZellij(
    run(['--config', configFile, 'attach', '--create-background', session], { cwd, ...(env ? { env } : {}) }),
    `failed to start browser terminal session "${session}"`,
  );
  try {
    requireZellij(
      run(['--session', session, 'action', 'override-layout', layout]),
      `failed to lay out browser terminal session "${session}"`,
    );
  } catch (error) {
    try { deleteSessionSnapshot(session, run); } catch { /* retain the original error */ }
    throw error;
  }
  return { session, created: true };
}

export function ensureBrowserAgentSession(id, options = {}) {
  return ensureBrowserTerminalSession({ sessionId: id, role: 'agent' }, options);
}

export function killBrowserTerminalSession(identity, { run = detachedZellij } = {}) {
  const live = activeSessions(run);
  const session = terminalSessionNames(identity).find((name) => live.includes(name));
  if (!session) return false;
  const result = run(['kill-session', session]);
  if (result.error) throw new Error(`cannot kill browser terminal session "${session}": ${result.error.message}`);
  const output = zellijOutput(result);
  if (result.status !== 0 && !sessionNotFound(output, session)) {
    throw new Error(`failed to kill browser terminal session "${session}"${output ? `: ${output}` : ''}`);
  }
  return true;
}

export function resetBrowserTerminalSession(identity, { run = detachedZellij } = {}) {
  const session = browserTerminalSessionName(identity);
  const reset = terminalSessionNames(identity).map((name) => deleteSessionSnapshot(name, run));
  return { session, reset: reset.some(Boolean) };
}

export function resetAllBrowserTerminalSessions({ run = detachedZellij, namespace = 'fw' } = {}) {
  const result = run(['list-sessions', '--no-formatting']);
  if (result.error) throw new Error(`cannot query Zellij sessions: ${result.error.message}`);
  if (result.status !== 0) {
    const output = `${result.stdout || ''}\n${result.stderr || ''}`;
    if (/no active .*sessions?/i.test(output)) return { count: 0, sessions: [] };
    throw new Error(`cannot query Zellij sessions${output.trim() ? `: ${output.trim()}` : ''}`);
  }
  const sessions = lines(result.stdout)
    .map((line) => line.replace(/\s+\[Created\b.*$/, '').trim())
    .filter((session) => namespace === 'fw'
      ? /^(fw|ws)-browser-/.test(session)
      : session.startsWith(`${namespace}-browser-`));
  const reset = sessions.filter((session) => deleteSessionSnapshot(session, run));
  return { count: reset.length, sessions: reset };
}

export function killBrowserAgentSession(id, options = {}) {
  return killBrowserTerminalSession({ sessionId: id, role: 'agent' }, options);
}
