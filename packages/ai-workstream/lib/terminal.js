import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

function procTokens(procRoot, pid) {
  try {
    return readFileSync(join(procRoot, String(pid), 'cmdline'))
      .toString('utf8').split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

function procParent(procRoot, pid) {
  try {
    const match = readFileSync(join(procRoot, String(pid), 'status'), 'utf8').match(/^PPid:\s+(\d+)/m);
    return match ? Number(match[1]) : 0;
  } catch {
    return 0;
  }
}

function procEnvironment(procRoot, pid) {
  try {
    return Object.fromEntries(readFileSync(join(procRoot, String(pid), 'environ'))
      .toString('utf8').split('\0').filter(Boolean).map((entry) => {
        const separator = entry.indexOf('=');
        return separator === -1 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)];
      }));
  } catch {
    return {};
  }
}

function attachedClients(session, procRoot) {
  let entries;
  try { entries = readdirSync(procRoot, { withFileTypes: true }); }
  catch { return []; }
  const processes = entries
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => ({ pid: Number(entry.name), tokens: procTokens(procRoot, entry.name) }));
  const explicit = processes.filter(({ tokens }) => {
      const attach = tokens.indexOf('attach');
      return tokens.length > 0 && basename(tokens[0]) === 'zellij'
        && attach !== -1 && tokens[attach + 1] === session;
    });
  if (explicit.length) return explicit;

  // A client that created its session is commonly just `zellij`, with no
  // session name in argv. Associate it when exactly one Zellij server exists;
  // otherwise declining to guess is safer than raising the wrong terminal.
  const serverSessions = new Set(processes.flatMap(({ tokens }) => {
    const server = tokens.indexOf('--server');
    return basename(tokens[0] || '') === 'zellij' && server !== -1 && tokens[server + 1]
      ? [basename(tokens[server + 1])]
      : [];
  }));
  if (serverSessions.size !== 1 || !serverSessions.has(session)) return [];
  return processes.filter(({ tokens }) => basename(tokens[0] || '') === 'zellij' && tokens.length === 1);
}

function terminalEnvironment(procRoot, pid) {
  let current = pid;
  for (let depth = 0; current > 1 && depth < 32; depth++) {
    const environment = procEnvironment(procRoot, current);
    if (environment.KITTY_WINDOW_ID || environment.KONSOLE_DBUS_WINDOW) return environment;
    current = procParent(procRoot, current);
  }
  return {};
}

export function focusTerminalForZellij(session, {
  procRoot = '/proc',
  run = spawnSync,
} = {}) {
  const clients = attachedClients(session, procRoot);
  if (clients.length === 0) {
    return { focused: false, terminal: null, reason: `Zellij session "${session}" has no attached terminal client` };
  }
  if (clients.length > 1) {
    return { focused: false, terminal: null, reason: `Zellij session "${session}" has multiple attached terminal clients` };
  }

  const client = clients[0];
  const environment = terminalEnvironment(procRoot, client.pid);
  if (environment.KITTY_WINDOW_ID) {
    if (!environment.KITTY_LISTEN_ON) {
      return {
        focused: false,
        terminal: 'kitty',
        reason: 'Kitty remote control has no listen socket',
      };
    }
    const result = run('kitty', [
      '@', '--to', environment.KITTY_LISTEN_ON,
      'focus-window', '--match', `id:${environment.KITTY_WINDOW_ID}`,
    ], { encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      const detail = result.error?.message || String(result.stderr || result.stdout || '').trim();
      return {
        focused: false,
        terminal: 'kitty',
        reason: `Kitty could not focus its window${detail ? `: ${detail}` : ''}`,
      };
    }
    return { focused: true, terminal: 'kitty' };
  }

  if (environment.KONSOLE_DBUS_WINDOW) {
    return {
      focused: false,
      terminal: 'konsole',
      reason: 'Konsole window activation is not configured',
    };
  }
  return { focused: false, terminal: null, reason: 'Attached terminal does not expose a focus interface' };
}
