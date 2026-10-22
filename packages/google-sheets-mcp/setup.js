import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callbackPort, credentialsPath, normalizeCredentials } from './config.js';

function run(command, args, allowMissing = false) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30000 });
  if (allowMissing && result.error?.code === 'ENOENT') return null;
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.slice(0, 2).join(' ')} failed: ${result.error?.message || result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function ensureAdapter() {
  const packageDir = fileURLToPath(new URL('.', import.meta.url));
  const lockText = readFileSync(join(packageDir, 'package-lock.json'), 'utf8');
  const revision = createHash('sha256')
    .update(readFileSync(join(packageDir, 'package.json'))).update(lockText).digest('hex');
  const stamp = join(packageDir, 'node_modules/.dotfiles-dependencies');
  const packages = Object.entries(JSON.parse(lockText).packages).filter(([path]) => path);
  const complete = () => {
    try {
      return existsSync(join(packageDir, 'node_modules/mcp-remote/dist/proxy.js'))
        && packages.every(([path, expected]) =>
          JSON.parse(readFileSync(join(packageDir, path, 'package.json'), 'utf8')).version === expected.version);
    } catch { return false; }
  };
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === revision && complete()) return;
  const result = spawnSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: packageDir, stdio: 'inherit', timeout: 300000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Installing the Sheets adapter failed: ${result.error?.message || result.status}`);
  }
  if (!complete()) throw new Error('Sheets adapter installation does not match package-lock.json.');
  writeFileSync(stamp, revision);
}

try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--credentials')) {
    throw new Error('Usage: node setup.js [--credentials /path/to/google-oauth-client.json]');
  }
  process.umask(0o077);
  if (args.length) {
    const credentials = normalizeCredentials(JSON.parse(readFileSync(args[1], 'utf8')));
    const repoRoot = realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
    mkdirSync(dirname(credentialsPath), { recursive: true, mode: 0o700 });
    const target = existsSync(credentialsPath)
      ? realpathSync(credentialsPath)
      : join(realpathSync(dirname(credentialsPath)), 'oauth-client.json');
    if (target === repoRoot || target.startsWith(`${repoRoot}/`)) {
      throw new Error('OAuth credentials must be stored outside the dotfiles repository.');
    }
    const temporary = `${credentialsPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, credentialsPath);
  }
  const ready = existsSync(credentialsPath);
  const launcher = fileURLToPath(new URL('sheets.js', import.meta.url));
  const server = { type: 'stdio', command: 'node', args: [launcher], env: {} };
  const prepareRegistration = () => {
    normalizeCredentials(JSON.parse(readFileSync(credentialsPath, 'utf8')));
    ensureAdapter();
  };
  if (run('claude', ['--version'], true) !== null) {
    const claudeDir = process.env.CLAUDE_CONFIG_DIR;
    const configPath = claudeDir ? join(claudeDir, 'claude.json') : join(homedir(), '.claude.json');
    const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
    const current = config.mcpServers?.sheets;
    if (current) {
      if (current.args?.includes(launcher)) ensureAdapter();
      console.log('Preserving existing Sheets MCP registration for Claude Code.');
    } else if (!ready) {
      console.log('Sheets MCP setup deferred for Claude Code: OAuth client credentials missing.');
    } else {
      prepareRegistration();
      run('claude', ['mcp', 'add-json', '--scope', 'user', 'sheets', JSON.stringify(server)]);
      console.log('Sheets MCP registered with Claude Code (user scope).');
    }
  } else {
    console.log('Claude Code is not installed; rerun setup.sh after installing it.');
  }
  if (run('codex', ['--version'], true) !== null) {
    const servers = JSON.parse(run('codex', ['mcp', 'list', '--json']));
    const current = servers.find(server => server.name === 'sheets');
    if (current) {
      if (current.transport?.args?.includes(launcher)) ensureAdapter();
      console.log('Preserving existing Sheets MCP registration for Codex.');
    } else if (ready) {
      prepareRegistration();
      // Stdio registration never starts an OAuth login during bootstrap.
      run('codex', ['mcp', 'add', 'sheets', '--', 'node', launcher]);
      console.log('Sheets MCP registered with Codex.');
    } else {
      console.log('Sheets MCP setup deferred for Codex: OAuth client credentials missing.');
    }
  } else {
    console.log('Codex is not installed; rerun setup.sh after installing it.');
  }
  if (!ready) {
    console.log(`Credentials missing: run setup.sh --credentials /path/to/google-oauth-client.json to create ${credentialsPath}.`);
  }
  console.log(`Google OAuth redirect URI: http://localhost:${callbackPort}/callback`);
  console.log(`Sign in and verify access: node ${JSON.stringify(resolve(launcher))} --login <spreadsheet-ID-or-URL>`);
} catch (error) {
  console.error(`Sheets MCP setup: ${error.message}`);
  process.exitCode = 1;
}
