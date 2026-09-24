import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'fw-checkout-'));
const home = join(directory, 'home');
const checkout = join(directory, "fresh checkout's source");
mkdirSync(home);
const env = {
  PATH: `${join(home, '.local', 'bin')}:${process.env.PATH}`,
  HOME: home,
  XDG_CONFIG_HOME: join(home, '.config'),
  XDG_DATA_HOME: join(home, '.local', 'share'),
  XDG_CACHE_HOME: join(home, '.cache'),
  CODEX_HOME: join(home, '.codex'),
  CLAUDE_CONFIG_DIR: join(home, '.claude'),
  FRITZWORKS_CONFIG: join(home, '.config', 'fritzworks', 'config.ini'),
};
const run = (command, args, options = {}) => execFileSync(command, args, {
  cwd: home, env, encoding: 'utf8', timeout: 120_000, ...options,
});
let daemon;
let transport;
let daemonOutput = '';
let terminalSocket;
const terminalId = `smoke-${directory.split('-').at(-1)}`;
const terminalSession = `fw-browser-terminal-${terminalId}`;
const testTerminal = process.env.FW_SMOKE_TERMINAL === '1';
let base;
async function start() {
  daemonOutput = '';
  daemon = spawn(process.execPath, [join(installed, 'server.js'), '--port', '0'], {
    cwd: home, env: { ...env, FRITZWORKS_DAEMON: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemon.stdout.on('data', (data) => { daemonOutput += data; });
  daemon.stderr.on('data', (data) => { daemonOutput += data; });
  daemon.on('error', (error) => { daemonOutput += error.message; });
  const metadata = join(env.XDG_DATA_HOME, 'fritzworks', 'api-server.json');
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null) throw new Error(`daemon exited: ${daemonOutput}`);
    if (existsSync(metadata)) {
      const info = JSON.parse(readFileSync(metadata, 'utf8'));
      base = `http://127.0.0.1:${info.port}`;
      try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* startup */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`daemon startup timed out: ${daemonOutput}`);
}
async function stop() {
  if (!daemon || daemon.exitCode !== null) return;
  const exited = once(daemon, 'exit');
  daemon.kill('SIGTERM');
  const timer = setTimeout(() => daemon.kill('SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(timer); daemon = null; }
}
async function request(path, body) {
  const response = await fetch(`${base}${path}`, body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.ok, true, JSON.stringify(result));
  return result;
}
async function waitForFile(path) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, 'utf8')) return readFileSync(path, 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`terminal did not write ${path}`);
}
async function terminalCommand(command) {
  terminalSocket = new WebSocket(`${base.replace('http:', 'ws:')}/fw/terminal?terminal=${terminalId}&client=smoke&owner=1`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('terminal attach timed out')), 20_000);
    terminalSocket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('terminal connection failed')); });
    terminalSocket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.type === 'error') { clearTimeout(timer); reject(new Error(message.message)); }
      if (message.type === 'claimed') { clearTimeout(timer); resolve(); }
    });
  });
  terminalSocket.send(JSON.stringify({ type: 'input', data: `${command}\r` }));
}
const installed = checkout;
try {
  cpSync(root, checkout, { recursive: true, filter: (path) =>
    !['node_modules', 'coverage', '.git', 'web/v2'].some((excluded) =>
      path === join(root, excluded) || path.startsWith(`${join(root, excluded)}/`)) });
  const install = () => run('npm', ['i', '--cache', join(directory, 'npm-cache'),
    '--userconfig', '/dev/null', '--no-audit', '--no-fund'], { cwd: checkout, timeout: 300_000 });
  install();
  const setup = () => run('npm', ['run', 'setup', '--', '--provider', 'codex', '--no-mcp', '--shell'], { cwd: checkout });
  setup();
  setup();
  const fw = (...args) => run(join(home, '.local', 'bin', 'fw'), args);
  assert.equal(fw('--version').trim(), JSON.parse(readFileSync(join(root, 'package.json'))).version);
  assert.ok(existsSync(join(checkout, 'web', 'v2', 'index.html')));
  const config = JSON.parse(fw('config'));
  assert.deepEqual(config.locations, {});
  assert.deepEqual(config.daemons, {});
  assert.equal(config.paths.notes, join(home, 'notes'));
  let doctor;
  try { doctor = JSON.parse(fw('doctor', '--json')); }
  catch (error) { doctor = JSON.parse(error.stdout); }
  assert.equal(doctor.checks.find(({ name }) => name === 'node-pty').level, 'ok');
  assert.ok(existsSync(join(env.CODEX_HOME, 'skills', 'fw', 'SKILL.md')));

  const requireInstalled = createRequire(join(installed, 'package.json'));
  const pty = requireInstalled('node-pty').spawn('/bin/sh', ['-c', 'printf fw-native-ok'], { cwd: home, env });
  let ptyOutput = '';
  pty.onData((data) => { ptyOutput += data; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pty.kill(); reject(new Error('native PTY timed out')); }, 5000);
    pty.onExit(() => { clearTimeout(timer); resolve(); });
  });
  assert.match(ptyOutput, /fw-native-ok/);

  await start();
  for (const path of ['/v2/', '/v2/fonts/jetbrains-mono-latin.woff2', '/panel-layout', '/daemons']) {
    assert.equal((await fetch(`${base}${path}`)).status, 200, path);
  }
  assert.deepEqual((await request('/fw/link-suggestions/linear')).items, []);
  const scratch = (await request('/fw/scratchpad', { name: 'install-smoke' })).workstream;
  assert.ok(existsSync(scratch.path));
  assert.match(fw('list'), /install-smoke/);
  const hooks = JSON.parse(readFileSync(join(env.CODEX_HOME, 'hooks.json'), 'utf8'));
  assert.equal(hooks.hooks.UserPromptSubmit.length, 1);
  run('/bin/sh', ['-c', hooks.hooks.UserPromptSubmit[0].hooks[0].command], {
    env: { ...env, PATH: '' }, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: scratch.path }),
  });
  assert.equal((await request(`/fw/${scratch.id}?status=all`)).items[0].agentStatus, 'working');

  const source = join(directory, 'source');
  run('git', ['init', '-b', 'main', source]);
  run('git', ['-C', source, '-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '--allow-empty', '-m', 'fixture']);
  const bare = join(config.paths.repositories, 'example', 'fixture', '.bare');
  mkdirSync(dirname(bare), { recursive: true });
  run('git', ['clone', '--bare', source, bare]);
  const repo = (await request('/fw', { repository: 'example/fixture', selector: 'main' })).workstream;
  assert.ok(existsSync(join(repo.path, '.git')));

  const sdk = join(installed, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client');
  const { Client } = await import(pathToFileURL(join(sdk, 'index.js')));
  const { StdioClientTransport } = await import(pathToFileURL(join(sdk, 'stdio.js')));
  transport = new StdioClientTransport({ command: process.execPath, args: [join(installed, 'mcp.js')], env, cwd: home, stderr: 'pipe' });
  const client = new Client({ name: 'checkout-smoke', version: '1.0.0' });
  await client.connect(transport);
  assert.ok((await client.listTools()).tools.some(({ name }) => name === 'fw_scratch'));
  const result = await client.callTool({ name: 'fw_list', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.match(JSON.stringify(result), /install-smoke/);
  await transport.close(); transport = null;
  let originalShell;
  if (testTerminal) {
    await terminalCommand(`FW_SMOKE_TOKEN=retained; printf '%s:%s' "$FW_SMOKE_TOKEN" "$$" > '${join(home, 'before')}'`);
    originalShell = await waitForFile(join(home, 'before'));
    terminalSocket.close();
  }
  await stop();
  install();
  setup();
  await start();
  if (testTerminal) {
    await terminalCommand(`printf '%s:%s' "$FW_SMOKE_TOKEN" "$$" > '${join(home, 'after')}'`);
    assert.equal(await waitForFile(join(home, 'after')), originalShell, 'shell state and PID must survive setup/restart');
    terminalSocket.close();
    console.log('Persistent Zellij shell survived setup and daemon restart with its PID and environment intact.');
  }
  assert.ok((await request('/fw/all?status=all')).items.some(({ id }) => id === scratch.id));
  assert.ok(existsSync(repo.path));
  fw('hooks', 'uninstall', '--provider', 'codex');
  fw('skills', 'uninstall', '--provider', 'codex');
  assert.equal(existsSync(join(env.CODEX_HOME, 'skills', 'fw', 'SKILL.md')), false);
  console.log('Checkout smoke passed: npm i/setup, native PTY, UI, CLI, MCP, scratchpad, Git worktree, setup/restart, integrations.');
} catch (error) {
  console.error(daemonOutput);
  throw error;
} finally {
  terminalSocket?.close();
  if (testTerminal) {
    spawnSync('zellij', ['kill-session', terminalSession], { env, stdio: 'ignore', timeout: 5000 });
    spawnSync('zellij', ['delete-session', '--force', terminalSession], { env, stdio: 'ignore', timeout: 5000 });
  }
  await transport?.close();
  await stop();
  rmSync(directory, { recursive: true, force: true });
}
