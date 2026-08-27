import assert from 'node:assert/strict';
import test from 'node:test';

import { DAEMON_REVISION, daemonRevision, openWebPage } from '../lib/daemon.js';

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
