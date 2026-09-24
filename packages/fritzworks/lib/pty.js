import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let native;
function nodePty() {
  try { return native ||= require('node-pty'); }
  catch { throw new Error('Native terminal support is unavailable. Run fw doctor for installation instructions.'); }
}

export function spawnZshTerminal({
  command = 'zsh',
  args = command === 'zsh' ? ['-l'] : [],
  cwd = process.cwd(),
  env = process.env,
  cols = 80,
  rows = 24,
} = {}) {
  const shellEnv = { ...env };
  delete shellEnv.NO_COLOR;
  delete shellEnv.FORCE_COLOR;
  return nodePty().spawn(command, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...shellEnv,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
  });
}

// Attach to a (possibly pre-existing) Zellij session as the pty behind a
// websocket-connected browser terminal. Killing the returned pty only kills
// this attach client, detaching from the session rather than the process
// running inside it — see ensureBrowserTerminalSession in zellij.js.
export function spawnZellijAttachTerminal({
  session,
  configFile,
  cwd = process.cwd(),
  env = process.env,
  cols = 80,
  rows = 24,
} = {}) {
  const attachEnv = { ...env };
  delete attachEnv.ZELLIJ;
  delete attachEnv.ZELLIJ_PANE_ID;
  delete attachEnv.ZELLIJ_SESSION_NAME;
  delete attachEnv.NO_COLOR;
  delete attachEnv.FORCE_COLOR;
  return nodePty().spawn('zellij', ['--config', configFile, 'attach', session], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...attachEnv,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
  });
}
