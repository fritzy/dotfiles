import assert from 'node:assert/strict';
import test from 'node:test';

import { DAEMON_REVISION, daemonHealth, daemonRevision, openWebPage } from '../lib/daemon.js';

test('daemon revision fingerprints server-side package sources', () => {
  assert.match(DAEMON_REVISION, /^[a-f0-9]{16}$/);
  assert.equal(daemonRevision(), DAEMON_REVISION);
});

test('web opener uses the platform command with the daemon URL', () => {
  const calls = [];
  const run = (...args) => { calls.push(args); return { status: 0 }; };
  assert.deepEqual(openWebPage('http://127.0.0.1:7337', { platform: 'linux', run }), {
    opener: 'xdg-open', url: 'http://127.0.0.1:7337',
  });
  assert.deepEqual(openWebPage('http://127.0.0.1:7337', { platform: 'darwin', run }), {
    opener: 'open', url: 'http://127.0.0.1:7337',
  });
  assert.equal(calls[0][0], 'xdg-open');
  assert.deepEqual(calls[0][1], ['http://127.0.0.1:7337']);
  assert.deepEqual(calls[0][2], { stdio: 'ignore' });
  assert.equal(calls[1][0], 'open');
});

test('web opener reports launch failures', () => {
  assert.throws(
    () => openWebPage('http://127.0.0.1:7337', { run: () => ({ status: 1 }) }),
    /could not open/,
  );
});

test('daemon health recognizes the legacy service for upgrades but still verifies identity', async (t) => {
  const info = { pid: 123, host: '127.0.0.1', port: 7337 };
  let health = { service: 'ai-workstream', pid: info.pid };
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => health }));
  assert.deepEqual(await daemonHealth(info), health);
  health = { service: 'fritzworks', pid: info.pid };
  assert.deepEqual(await daemonHealth(info), health);
  health = { service: 'unrelated', pid: info.pid };
  assert.equal(await daemonHealth(info), null);
  health = { service: 'ai-workstream', pid: 456 };
  assert.equal(await daemonHealth(info), null);
});

test('foreground and detached daemon startup share config, instance metadata, and ownership', async (t) => {
  const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createServer } = await import('node:net');
  const { resolveConfig } = await import('../lib/config.js');
  const { configRevision } = await import('../lib/runtime-config.js');
  const { daemonFiles, daemonStatus, startDaemon, stopDaemon, runForeground } = await import('../lib/daemon.js');
  const root = mkdtempSync(join(tmpdir(), 'fw-daemon-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const configPath = join(root, 'selected.ini');
  writeFileSync(configPath, `[paths]\ndata = ./data\nnotes = ./notes\n[server]\nport = ${port}\n`);
  const config = resolveConfig({ env: {}, home: root, configPath });
  t.after(() => stopDaemon(config));
  const detached = await startDaemon({ config });
  assert.equal(detached.health.configRevision, configRevision(config));
  const instanceId = detached.health.instanceId;
  assert.equal(JSON.parse(readFileSync(daemonFiles(config).pid, 'utf8')).configPath, configPath);
  writeFileSync(configPath, `[paths]\ndata = ./data\nnotes = ./changed\n[server]\nport = ${port}\n`);
  assert.equal((await daemonStatus(config)).restartRequired, true);
  await assert.rejects(startDaemon({ config }), /configuration changed/);
  await stopDaemon(config);
  const updated = resolveConfig({ env: {}, home: root, configPath });
  const foreground = runForeground({ config: updated });
  let status;
  for (let i = 0; i < 100; i++) {
    status = await daemonStatus(updated);
    if (status.running) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(status.running, true);
  assert.equal(status.health.instanceId, instanceId);
  assert.equal(status.health.configRevision, configRevision(updated));
  assert.equal(status.restartRequired, false);
  await stopDaemon(updated);
  await foreground;
});
