import * as nodePty from 'node-pty';

export function spawnZshTerminal({
  command = 'zsh',
  args = command === 'zsh' ? ['-l'] : [],
  cwd = process.cwd(),
  env = process.env,
  cols = 80,
  rows = 24,
} = {}) {
  return nodePty.spawn(command, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...env,
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
  return nodePty.spawn('zellij', ['--config', configFile, 'attach', session], {
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
