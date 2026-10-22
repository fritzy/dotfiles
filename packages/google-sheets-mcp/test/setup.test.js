import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packageSource = fileURLToPath(new URL('..', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sheets-mcp-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageDir = join(root, 'checkout/packages/google-sheets-mcp');
  mkdirSync(packageDir, { recursive: true });
  for (const name of ['setup.js', 'setup.sh', 'sheets.js', 'config.js', 'login.js', 'package.json', 'package-lock.json']) {
    copyFileSync(join(packageSource, name), join(packageDir, name));
  }
  const setup = join(packageDir, 'setup.js');
  const launcher = join(packageDir, 'sheets.js');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const claudeDir = join(root, 'claude');
  mkdirSync(claudeDir);
  const claudeConfig = join(claudeDir, 'claude.json');
  writeFileSync(claudeConfig, JSON.stringify({
    theme: 'dark', mcpServers: { fw: { command: 'keep-me' } },
  }));
  const fake = `#!${process.execPath}
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
const name = basename(process.argv[1]);
const args = process.argv.slice(2);
if (args[0] === '--version') process.exit(0);
appendFileSync(process.env.TEST_CALLS, JSON.stringify({name, args}) + '\\n');
if (name === 'npm') {
  if (process.env.TEST_NPM_FAIL) process.exit(9);
  const lock = JSON.parse(readFileSync(join(process.cwd(), 'package-lock.json')));
  for (const [path, metadata] of Object.entries(lock.packages)) {
    if (!path) continue;
    mkdirSync(join(process.cwd(), path), { recursive: true });
    writeFileSync(join(process.cwd(), path, 'package.json'), JSON.stringify({ version: metadata.version }));
  }
  const directory = join(process.cwd(), 'node_modules/mcp-remote/dist');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'proxy.js'), '');
  process.exit(0);
}
if (name === 'codex') {
  const path = process.env.TEST_CODEX_CONFIG;
  const servers = JSON.parse(readFileSync(path, 'utf8'));
  if (args[1] === 'list') {
    if (process.env.TEST_CODEX_LIST_FAIL) process.exit(1);
    console.log(JSON.stringify(servers));
  }
  else if (args[1] === 'remove') writeFileSync(path, JSON.stringify(servers.filter(s => s.name !== args[2])));
  else if (args[1] === 'add') {
    servers.push({ name: args[2], transport: { type: 'stdio', command: args[4], args: args.slice(5), env: {} } });
    writeFileSync(path, JSON.stringify(servers));
  } else process.exit(1);
  process.exit(0);
}
const path = join(process.env.CLAUDE_CONFIG_DIR, 'claude.json');
const config = JSON.parse(readFileSync(path, 'utf8'));
if (args[1] === 'remove') delete config.mcpServers.sheets;
else if (args[1] === 'add-json') config.mcpServers.sheets = JSON.parse(args.at(-1));
else process.exit(1);
writeFileSync(path, JSON.stringify(config));
`;
  for (const cli of ['claude', 'codex', 'npm']) {
    writeFileSync(join(bin, cli), fake);
    chmodSync(join(bin, cli), 0o700);
  }
  writeFileSync(join(bin, 'package.json'), '{"type":"module"}');
  const codexConfig = join(root, 'codex.json');
  writeFileSync(codexConfig, '[]');
  const env = {
    ...process.env, PATH: bin, CLAUDE_CONFIG_DIR: claudeDir,
    XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state'),
    TEST_CALLS: join(root, 'calls.jsonl'),
    TEST_CODEX_CONFIG: codexConfig,
  };
  return { root, bin, env, setup, launcher, packageDir, claudeConfig, codexConfig, credentials: join(env.XDG_CONFIG_HOME, 'google-sheets-mcp', 'oauth-client.json') };
}

test('bootstrap imports credentials privately, preserves other settings, and can run twice', t => {
  const f = fixture(t);
  const source = join(f.root, 'google.json');
  writeFileSync(source, JSON.stringify({ web: { client_id: 'test-client', client_secret: 'test-secret' } }));
  const first = execFileSync(process.execPath, [f.setup, '--credentials', source], { env: f.env, encoding: 'utf8' });
  const second = execFileSync(process.execPath, [f.setup], { env: f.env, encoding: 'utf8' });
  assert.ok(!first.includes('test-secret') && !second.includes('test-secret'));
  assert.equal(statSync(f.credentials).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(f.credentials)), { client_id: 'test-client', client_secret: 'test-secret' });
  const config = JSON.parse(readFileSync(f.claudeConfig));
  assert.equal(config.theme, 'dark');
  assert.deepEqual(config.mcpServers.fw, { command: 'keep-me' });
  assert.deepEqual(config.mcpServers.sheets.args, [f.launcher]);
  const calls = readFileSync(f.env.TEST_CALLS, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(call => call.name === 'claude' && call.args[1] === 'remove').length, 0);
  assert.equal(calls.filter(call => call.name === 'claude' && call.args[1] === 'add-json').length, 1);
  assert.equal(calls.filter(call => call.name === 'codex' && call.args.includes(f.launcher)).length, 1);
  assert.equal(calls.filter(call => call.name === 'npm').length, 1);
  assert.ok(!readFileSync(f.env.TEST_CALLS, 'utf8').includes('test-secret'));
});

test('missing clients and credentials do not start login or break bootstrap', t => {
  const f = fixture(t);
  rmSync(join(f.bin, 'claude'));
  rmSync(join(f.bin, 'codex'));
  const output = execFileSync(process.execPath, [f.setup], { env: f.env, encoding: 'utf8' });
  assert.match(output, /Claude Code is not installed/);
  assert.match(output, /Codex is not installed/);
  assert.match(output, /Credentials missing/);
  assert.equal(existsSync(f.env.TEST_CALLS), false);
  const launch = spawnSync(process.execPath, [f.launcher], { env: f.env, encoding: 'utf8' });
  assert.equal(launch.status, 1);
  assert.equal(launch.stdout, '');
  assert.match(launch.stderr, /setup.sh --credentials/);
});

test('invalid credentials fail before changing either client', t => {
  const f = fixture(t);
  const original = readFileSync(f.claudeConfig, 'utf8');
  const source = join(f.root, 'bad.json');
  writeFileSync(source, '{"web":{"client_id":"test-client"}}');
  const result = spawnSync(process.execPath, [f.setup, '--credentials', source], { env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(readFileSync(f.claudeConfig, 'utf8'), original);
  assert.equal(existsSync(f.credentials), false);
  assert.equal(existsSync(f.env.TEST_CALLS), false);
});

test('missing credentials preserve even stale registrations without removing or reinstalling them', t => {
  const f = fixture(t);
  const stale = { command: 'node', args: ['/home/other/dotfiles/packages/google-sheets-mcp/sheets.js'] };
  const claude = JSON.parse(readFileSync(f.claudeConfig));
  claude.mcpServers.sheets = stale;
  writeFileSync(f.claudeConfig, JSON.stringify(claude));
  const fw = { name: 'fw', transport: { command: 'keep-me' } };
  writeFileSync(f.codexConfig, JSON.stringify([fw, { name: 'sheets', transport: stale }]));
  for (let i = 0; i < 2; i++) {
    const output = execFileSync(process.execPath, [f.setup], { env: f.env, encoding: 'utf8' });
    assert.match(output, /Preserving existing/);
    assert.match(output, /Credentials missing/);
  }
  assert.deepEqual(JSON.parse(readFileSync(f.codexConfig)), [fw, { name: 'sheets', transport: stale }]);
  assert.deepEqual(JSON.parse(readFileSync(f.claudeConfig)), claude);
  const calls = readFileSync(f.env.TEST_CALLS, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(call => call.args[1] === 'remove').length, 0);
  assert.ok(calls.every(call => call.name !== 'npm' && !['add', 'add-json', 'login'].includes(call.args[1])));
  assert.equal(existsSync(f.credentials), false);
});

test('missing credentials preserve independently configured Sheets servers', t => {
  const f = fixture(t);
  const initial = JSON.parse(readFileSync(f.claudeConfig));
  initial.mcpServers.sheets = { type: 'http', url: 'https://example.test/mcp' };
  writeFileSync(f.claudeConfig, JSON.stringify(initial));
  const claude = readFileSync(f.claudeConfig, 'utf8');
  const codex = JSON.stringify([{ name: 'sheets', transport: { type: 'http', url: 'https://example.test/mcp' } }]);
  writeFileSync(f.codexConfig, codex);
  execFileSync(process.execPath, [f.setup], { env: f.env });
  assert.equal(readFileSync(f.claudeConfig, 'utf8'), claude);
  assert.equal(readFileSync(f.codexConfig, 'utf8'), codex);
});

test('existing local registrations retain custom options and tokens across wrapper reruns', t => {
  const f = fixture(t);
  const server = { type: 'stdio', command: '/custom/node', args: [f.launcher], env: { CUSTOM: 'keep' } };
  writeFileSync(f.claudeConfig, JSON.stringify({ mcpServers: { sheets: server }, theme: 'custom' }));
  writeFileSync(f.codexConfig, JSON.stringify([{ name: 'sheets', enabled: false, transport: server, tool_timeout_sec: 99 }]));
  mkdirSync(join(f.env.XDG_CONFIG_HOME, 'google-sheets-mcp'), { recursive: true });
  writeFileSync(f.credentials, JSON.stringify({ client_id: 'existing', client_secret: 'existing-secret' }), { mode: 0o600 });
  const tokens = join(f.env.XDG_STATE_HOME, 'google-sheets-mcp/tokens.json');
  mkdirSync(join(f.env.XDG_STATE_HOME, 'google-sheets-mcp'), { recursive: true });
  writeFileSync(tokens, 'existing-token');
  const adapter = join(f.packageDir, 'node_modules/mcp-remote/dist/proxy.js');
  mkdirSync(join(f.packageDir, 'node_modules/mcp-remote/dist'), { recursive: true });
  writeFileSync(adapter, 'existing-adapter');
  const lock = readFileSync(join(f.packageDir, 'package-lock.json'), 'utf8');
  for (const [path, metadata] of Object.entries(JSON.parse(lock).packages)) {
    if (!path) continue;
    mkdirSync(join(f.packageDir, path), { recursive: true });
    writeFileSync(join(f.packageDir, path, 'package.json'), JSON.stringify({ version: metadata.version }));
  }
  writeFileSync(join(f.packageDir, 'node_modules/.dotfiles-dependencies'),
    createHash('sha256').update(readFileSync(join(f.packageDir, 'package.json'))).update(lock).digest('hex'));
  const paths = [f.claudeConfig, f.codexConfig, f.credentials, tokens, adapter];
  const before = paths.map(path => [readFileSync(path, 'utf8'), statSync(path).mtimeMs]);
  // Exercise setup.sh too: it must not unconditionally reinstall dependencies.
  const env = { ...f.env, PATH: `${f.bin}:/usr/bin:/bin` };
  for (let i = 0; i < 2; i++) execFileSync('/bin/bash', [join(f.packageDir, 'setup.sh')], { env });
  assert.deepEqual(paths.map(path => [readFileSync(path, 'utf8'), statSync(path).mtimeMs]), before);
  const calls = readFileSync(f.env.TEST_CALLS, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.every(call => call.name === 'codex' && call.args[1] === 'list'));
});

test('existing remote servers are preserved even when local OAuth credentials are present', t => {
  const f = fixture(t);
  writeFileSync(f.claudeConfig, JSON.stringify({ mcpServers: { sheets: { type: 'http', url: 'https://example.test' } } }));
  writeFileSync(f.codexConfig, JSON.stringify([{ name: 'sheets', transport: { type: 'http', url: 'https://example.test' } }]));
  mkdirSync(join(f.env.XDG_CONFIG_HOME, 'google-sheets-mcp'), { recursive: true });
  writeFileSync(f.credentials, 'credentials used by another setup');
  const before = [readFileSync(f.claudeConfig, 'utf8'), readFileSync(f.codexConfig, 'utf8')];
  execFileSync(process.execPath, [f.setup], { env: f.env });
  assert.deepEqual([readFileSync(f.claudeConfig, 'utf8'), readFileSync(f.codexConfig, 'utf8')], before);
  const calls = readFileSync(f.env.TEST_CALLS, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.every(call => call.name === 'codex' && call.args[1] === 'list'));
});

test('failed registration lookup never removes or adds a Codex server', t => {
  const f = fixture(t);
  const before = readFileSync(f.codexConfig, 'utf8');
  const result = spawnSync(process.execPath, [f.setup], { env: { ...f.env, TEST_CODEX_LIST_FAIL: '1' }, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(readFileSync(f.codexConfig, 'utf8'), before);
  const calls = readFileSync(f.env.TEST_CALLS, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(calls.every(call => call.args[1] === 'list'));
});

test('changed lockfiles and missing transitive packages trigger dependency repair', t => {
  const f = fixture(t);
  writeFileSync(f.claudeConfig, JSON.stringify({ mcpServers: { sheets: { args: [f.launcher] } } }));
  execFileSync(process.execPath, [f.setup], { env: f.env });
  const installs = () => readFileSync(f.env.TEST_CALLS, 'utf8').trim().split('\n')
    .map(JSON.parse).filter(call => call.name === 'npm').length;
  assert.equal(installs(), 1);
  execFileSync(process.execPath, [f.setup], { env: f.env });
  assert.equal(installs(), 1);
  const path = join(f.packageDir, 'package-lock.json');
  const lock = JSON.parse(readFileSync(path));
  lock.packages['node_modules/mcp-remote'].version = '0.14.3';
  writeFileSync(path, JSON.stringify(lock));
  execFileSync(process.execPath, [f.setup], { env: f.env });
  assert.equal(installs(), 2);
  rmSync(join(f.packageDir, 'node_modules/accepts/package.json'));
  execFileSync(process.execPath, [f.setup], { env: f.env });
  assert.equal(installs(), 3);
});

test('failed dependency repair does not replace registrations or mark dependencies current', t => {
  const f = fixture(t);
  const registration = JSON.stringify({ mcpServers: { sheets: { args: [f.launcher], env: { CUSTOM: 'keep' } } } });
  writeFileSync(f.claudeConfig, registration);
  const result = spawnSync(process.execPath, [f.setup], { env: { ...f.env, TEST_NPM_FAIL: '1' } });
  assert.equal(result.status, 1);
  assert.equal(readFileSync(f.claudeConfig, 'utf8'), registration);
  assert.equal(existsSync(join(f.packageDir, 'node_modules/.dotfiles-dependencies')), false);
});
