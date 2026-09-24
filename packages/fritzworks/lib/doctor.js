import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { dirname, delimiter, isAbsolute, join } from 'node:path';
import { createRequire } from 'node:module';

import { CONFIG } from './config.js';
import { daemonStatus } from './daemon.js';
import { agentHookStatus, shellHookStatus } from './hooks.js';

const require = createRequire(import.meta.url);

export function executableExists(command, env = process.env) {
  const paths = isAbsolute(command) || command.includes('/')
    ? [command] : (env.PATH || '').split(delimiter).map((path) => join(path, command));
  return paths.some((path) => {
    try { accessSync(path, constants.X_OK); return statSync(path).isFile(); }
    catch { return false; }
  });
}

export async function diagnose({ config = CONFIG, env = process.env, run = spawnSync,
  loadPty = () => require('node-pty'), status = daemonStatus,
} = {}) {
  const checks = [];
  const add = (name, level, detail) => checks.push({ name, level, detail });
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  const supported = major >= 26 || major === 24 && minor >= 15
    || major === 22 && (minor > 22 || minor === 22 && patch >= 2);
  add('Node.js', supported ? 'ok' : 'error', `${process.version}; requires Node 22.22.2+, 24.15+, or 26+`);
  add('platform', ['linux', 'darwin'].includes(process.platform) ? 'ok' : 'error', process.platform);
  try {
    const pty = loadPty();
    if (typeof pty.spawn !== 'function') throw new Error('native module has no spawn function');
    add('node-pty', 'ok', 'native module loaded');
  } catch {
    add('node-pty', 'error', 'Native module unavailable. Run npm rebuild node-pty in the checkout. With npm 12+, approve it first using npm install-scripts approve node-pty. A source build needs Python and C/C++ build tools.');
  }
  for (const [name, command, required] of [
    ['Git', ['git'], true], ['Zellij', ['zellij'], true],
    ['shell', config.commands.shell, true], ['editor', config.commands.editor, false],
    ['agent', config.commands[config.agent], false],
    ['GitHub CLI', ['gh'], false], ['Linear CLI', ['linear'], false],
    ['browser opener', [process.platform === 'darwin' ? 'open' : 'xdg-open'], false],
  ]) {
    const present = executableExists(command[0], env);
    add(name, present ? 'ok' : required ? 'error' : 'warning', `${command[0]}${present ? '' : ' is not on PATH'}`);
  }
  if (executableExists('zellij', env)) {
    const result = run('zellij', ['--version'], { env, encoding: 'utf8', timeout: 5000 });
    add('Zellij version', result.status === 0 ? 'ok' : 'error', String(result.stdout || result.error?.message || result.stderr).trim());
  }
  for (const [name, path] of Object.entries(config.paths)) {
    try {
      let ancestor = path;
      while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
      if (!statSync(ancestor).isDirectory()) throw new Error(`${ancestor} is not a directory`);
      accessSync(ancestor, constants.W_OK | constants.X_OK);
      add(`${name} path`, 'ok', path);
    } catch (error) { add(`${name} path`, 'error', `${path}: ${error.message}`); }
  }
  const daemon = await status(config);
  add('daemon', daemon.running ? 'ok' : 'warning', daemon.running ? daemon.url : 'not running; fw web start launches it');
  try {
    for (const hook of [...agentHookStatus({ home: config.home, env }), shellHookStatus({ home: config.home, configHome: env.XDG_CONFIG_HOME || join(config.home, '.config') })]) {
      add(`${hook.provider} hooks`, hook.installed ? 'ok' : 'warning', `${hook.path}: ${hook.installed ? 'configured; client execution is not verified' : 'not installed (optional)'}`);
    }
  } catch (error) { add('hooks', 'warning', error.message); }
  return { ok: !checks.some((check) => check.level === 'error'), checks };
}
