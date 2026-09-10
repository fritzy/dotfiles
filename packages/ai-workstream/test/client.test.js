import assert from 'node:assert/strict';
import test from 'node:test';

import {
  daemonTargets, requestDaemonService, requestLocalService, resolveDaemonTarget, workstreamCommand,
} from '../lib/client.js';

test('service client starts the daemon and sends JSON lifecycle requests', async () => {
  const calls = [];
  const start = async ({ config }) => {
    calls.push({ start: config });
    return { url: 'http://127.0.0.1:7444' };
  };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ ok: true, workstream: { id: 42 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const config = { service: 'test' };
  const response = await workstreamCommand('feature/name', 'resume', { panels: ['shell', 'agent'] }, {
    config, start, fetchImpl,
  });

  assert.equal(response.daemon.url, 'http://127.0.0.1:7444');
  assert.equal(response.result.workstream.id, 42);
  assert.deepEqual(calls[0], { start: config });
  assert.equal(calls[1].url, 'http://127.0.0.1:7444/ws/feature%2Fname/resume');
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[1].options.body), { panels: ['shell', 'agent'] });
});

test('service client exposes structured HTTP failures', async () => {
  await assert.rejects(
    requestLocalService('/ws/7/close', {
      start: async () => ({ url: 'http://localhost:7337' }),
      fetchImpl: async () => new Response(JSON.stringify({
        message: 'worktree is dirty', details: { dirty: ['M file.js'] },
      }), { status: 409 }),
    }),
    (error) => error.status === 409
      && error.message === 'worktree is dirty'
      && error.details.dirty[0] === 'M file.js',
  );
});

test('service client resolves and relays requests to configured remote daemons', async () => {
  const calls = [];
  const config = {
    daemons: {
      workstation: { id: 'workstation', name: 'Workstation', url: 'http://127.1.1.2:7337' },
    },
  };
  const response = await requestDaemonService('/ws/all?status=all', {
    daemon: 'workstation',
    config,
    start: async () => { throw new Error('remote requests must not start the local daemon'); },
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(JSON.stringify({ items: [{ id: 9 }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  assert.equal(response.daemon.id, 'workstation');
  assert.equal(response.daemon.local, false);
  assert.deepEqual(response.result.items, [{ id: 9 }]);
  assert.equal(calls[0].url, 'http://127.1.1.2:7337/ws/all?status=all');
  assert.deepEqual(daemonTargets(config).map((daemon) => daemon.id), ['local', 'workstation']);
  assert.equal(resolveDaemonTarget('workstation', config).name, 'Workstation');
  assert.throws(() => resolveDaemonTarget('missing', config), /expected one of: local, workstation/);
});
