import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const setup = fileURLToPath(new URL('../setup.js', import.meta.url));
const launcher = fileURLToPath(new URL('../sheets.js', import.meta.url));

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sheets-mcp-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const claudeDir = join(root, 'claude');
  mkdirSync(claudeDir);
  const claudeConfig = join(claudeDir, 'claude.json');
  writeFileSync(claudeConfig, JSON.stringify({
    theme: 'dark', mcpServers: { fw: { command: 'keep-me' }, sheets: { type: 'http', url: 'old' } },
  }));
  const fake = `#!${process.execPath}
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { basename, join } from 'node:path';
const name = basename(process.argv[1]);
const args = process.argv.slice(2);
if (args[0] === '--version') process.exit(0);
appendFileSync(process.env.TEST_CALLS, JSON.stringify({name, args}) + '\\n');
if (name === 'codex') process.exit(0);
const path = join(process.env.CLAUDE_CONFIG_DIR, 'claude.json');
const config = JSON.parse(readFileSync(path, 'utf8'));
if (args[1] === 'remove') delete config.mcpServers.sheets;
else if (args[1] === 'add-json') config.mcpServers.sheets = JSON.parse(args.at(-1));
else process.exit(1);
writeFileSync(path, JSON.stringify(config));
`;
  for (const cli of ['claude', 'codex']) {
    writeFileSync(join(bin, cli), fake);
    chmodSync(join(bin, cli), 0o700);
  }
  writeFileSync(join(bin, 'package.json'), '{"type":"module"}');
  const env = {
    ...process.env, PATH: bin, CLAUDE_CONFIG_DIR: claudeDir,
    XDG_CONFIG_HOME: join(root, 'config'), XDG_STATE_HOME: join(root, 'state'),
    TEST_CALLS: join(root, 'calls.jsonl'),
  };
  return { root, bin, env, claudeConfig, credentials: join(env.XDG_CONFIG_HOME, 'google-sheets-mcp', 'oauth-client.json') };
}

test('bootstrap imports credentials privately, preserves other settings, and can run twice', t => {
  const f = fixture(t);
  const source = join(f.root, 'google.json');
  writeFileSync(source, JSON.stringify({ web: { client_id: 'test-client', client_secret: 'test-secret' } }));
  const first = execFileSync(process.execPath, [setup, '--credentials', source], { env: f.env, encoding: 'utf8' });
  const second = execFileSync(process.execPath, [setup], { env: f.env, encoding: 'utf8' });
  assert.ok(!first.includes('test-secret') && !second.includes('test-secret'));
  assert.equal(statSync(f.credentials).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(f.credentials)), { client_id: 'test-client', client_secret: 'test-secret' });
  const config = JSON.parse(readFileSync(f.claudeConfig));
  assert.equal(config.theme, 'dark');
  assert.deepEqual(config.mcpServers.fw, { command: 'keep-me' });
  assert.deepEqual(config.mcpServers.sheets.args, [launcher]);
  const calls = readFileSync(f.env.TEST_CALLS, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(calls.filter(call => call.name === 'claude' && call.args[1] === 'remove').length, 1);
  assert.equal(calls.filter(call => call.name === 'claude' && call.args[1] === 'add-json').length, 1);
  assert.equal(calls.filter(call => call.name === 'codex' && call.args.includes(launcher)).length, 2);
  assert.ok(!readFileSync(f.env.TEST_CALLS, 'utf8').includes('test-secret'));
});

test('missing clients and credentials do not start login or break bootstrap', t => {
  const f = fixture(t);
  rmSync(join(f.bin, 'claude'));
  rmSync(join(f.bin, 'codex'));
  const output = execFileSync(process.execPath, [setup], { env: f.env, encoding: 'utf8' });
  assert.match(output, /Claude Code is not installed/);
  assert.match(output, /Codex is not installed/);
  assert.match(output, /Credentials missing/);
  assert.equal(existsSync(f.env.TEST_CALLS), false);
  const launch = spawnSync(process.execPath, [launcher], { env: f.env, encoding: 'utf8' });
  assert.equal(launch.status, 1);
  assert.equal(launch.stdout, '');
  assert.match(launch.stderr, /setup.sh --credentials/);
});

test('invalid credentials fail before changing either client', t => {
  const f = fixture(t);
  const original = readFileSync(f.claudeConfig, 'utf8');
  const source = join(f.root, 'bad.json');
  writeFileSync(source, '{"web":{"client_id":"test-client"}}');
  const result = spawnSync(process.execPath, [setup, '--credentials', source], { env: f.env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(readFileSync(f.claudeConfig, 'utf8'), original);
  assert.equal(existsSync(f.credentials), false);
  assert.equal(existsSync(f.env.TEST_CALLS), false);
});
