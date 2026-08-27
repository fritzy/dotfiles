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
