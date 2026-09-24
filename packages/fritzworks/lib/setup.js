import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readlinkSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { fileURLToPath } from 'node:url';

import { CONFIG } from './config.js';
import { clientHomes, installAgentHooks, installShellHooks } from './hooks.js';
import { executableExists } from './doctor.js';

const digest = (text) => createHash('sha256').update(text).digest('hex');
const SKILLS = ['fw', 'fritzworks'];

export function setupConfig({ config = CONFIG } = {}) {
  const path = config.configPath;
  if (existsSync(path)) return { path, created: false };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '# FritzWorks user overrides. Run fw config to see effective settings.\n', { flag: 'wx', mode: 0o600 });
  return { path, created: true };
}

export function manageSkills(action, options = {}) {
  if (!['install', 'uninstall', 'status'].includes(action)) throw new Error('skills action must be install, uninstall, or status');
  const homes = clientHomes(options);
  const providers = options.providers || ['claude', 'codex'];
  const results = [];
  for (const provider of providers) {
    if (!homes[provider]) throw new Error(`unknown skill provider: ${provider}`);
    for (const name of SKILLS) {
      const directory = join(homes[provider], 'skills', name);
      const path = join(directory, 'SKILL.md');
      const marker = join(directory, '.fritzworks-owned');
      const source = readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url), 'utf8');
      const existing = existsSync(path) ? readFileSync(path, 'utf8') : null;
      const owned = existsSync(marker) && existing !== null && readFileSync(marker, 'utf8') === digest(existing);
      if (action === 'status') {
        results.push({ provider, path, installed: existing === source, owned });
        continue;
      }
      if (action === 'install') {
        if (existing !== null && !owned) {
          results.push({ provider, path, status: existing === source ? 'already present (unmanaged)' : 'preserved existing skill' });
          continue;
        }
        mkdirSync(directory, { recursive: true });
        writeFileSync(path, source);
        writeFileSync(marker, digest(source));
        results.push({ provider, path, status: 'installed' });
      } else {
        if (owned) { rmSync(path); rmSync(marker); }
        results.push({ provider, path, status: owned ? 'removed' : 'preserved or absent' });
      }
    }
  }
  return results;
}


export function installCommandLinks({ home = CONFIG.home,
  root = fileURLToPath(new URL('../', import.meta.url)),
} = {}) {
  const entries = Object.entries({ fw: 'cli.js', 'fw-mcp': 'mcp.js', fritzworks: 'app.js' })
    .map(([name, file]) => ({ name, path: join(home, '.local', 'bin', name), target: join(root, file) }));
  for (const { path, target } of entries) {
    try {
      const stat = lstatSync(path);
      if (!stat.isSymbolicLink() || resolve(dirname(path), readlinkSync(path)) !== resolve(target)) {
        throw new Error(`preserving existing command ${path}; move it before rerunning setup`);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  return entries.map((entry) => {
    try { symlinkSync(entry.target, entry.path); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    return entry;
  });
}

export function setupCheckout({ config = CONFIG, env = process.env, providers,
  shell = [env.SHELL, config.commands.shell[0]].some((command) => basename(command || '') === 'zsh'),
  mcp = true, run = spawnSync,
} = {}) {
  const homes = clientHomes({ home: config.home, env });
  const selected = providers || ['claude', 'codex'].filter((provider) =>
    existsSync(homes[provider]) || executableExists(config.commands[provider][0], env));
  for (const provider of selected) {
    if (!['claude', 'codex'].includes(provider)) throw new Error(`unknown provider: ${provider}`);
  }
  const commands = installCommandLinks({ home: config.home });
  const userConfig = setupConfig({ config });
  const options = { home: config.home, env, providers: selected };
  const hooks = installAgentHooks(options);
  const skills = manageSkills('install', options);
  const shellHooks = shell ? installShellHooks({ home: config.home,
    configHome: env.XDG_CONFIG_HOME || join(config.home, '.config') }) : null;
  const registrations = [];
  if (mcp) {
    for (const provider of selected) {
      const [program, ...args] = config.commands[provider];
      if (!executableExists(program, env)) {
        registrations.push({ provider, status: 'CLI unavailable; MCP registration skipped' });
        continue;
      }
      const options = { env, encoding: 'utf8', timeout: 15_000 };
      const existing = run(program, [...args, 'mcp', 'get', 'fw'], options);
      if (existing.status === 0) {
        registrations.push({ provider, status: 'existing MCP registration preserved' });
        continue;
      }
      const added = run(program, [...args, 'mcp', 'add',
        ...(provider === 'claude' ? ['--scope', 'user'] : []), 'fw', '--',
        process.execPath, '--no-warnings', fileURLToPath(new URL('../mcp.js', import.meta.url)),
      ], options);
      if (added.status !== 0) {
        throw new Error(`${provider} MCP registration failed: ${added.error?.message || added.stderr || added.stdout || added.status}`);
      }
      registrations.push({ provider, status: 'MCP registered' });
    }
  }
  return { config: userConfig, commands, hooks, skills, shellHooks, registrations, providers: selected };
}
