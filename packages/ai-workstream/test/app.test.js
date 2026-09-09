import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { launchApp } from '../app.js';
import { configureFirefoxProfile } from '../desktop/configure-firefox.js';

test('Firefox app profile keeps native decorations while hiding browser chrome', () => {
  const home = mkdtempSync(join(tmpdir(), 'ai-workstream-firefox-'));
  const registryDirectory = join(home, '.config', 'mozilla', 'firefox');
  const profileDirectory = join(registryDirectory, 'example.appmode');
  mkdirSync(profileDirectory, { recursive: true });
  writeFileSync(join(registryDirectory, 'profiles.ini'), [
    '[General]',
    'Version=2',
    '',
    '[Profile0]',
    'Name=appmode',
    'IsRelative=1',
    'Path=example.appmode',
    '',
  ].join('\n'));

  const first = configureFirefoxProfile({ profileName: 'appmode', env: {}, home });
  const second = configureFirefoxProfile({ profileName: 'appmode', env: {}, home });
  const userJs = readFileSync(join(profileDirectory, 'user.js'), 'utf8');
  const userChrome = readFileSync(join(profileDirectory, 'chrome', 'userChrome.css'), 'utf8');

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.match(userJs, /user_pref\("browser\.tabs\.inTitlebar", 0\);/);
  assert.match(userJs, /toolkit\.legacyUserProfileCustomizations\.stylesheets", true/);
  assert.match(userChrome, /#TabsToolbar,[\s\S]*#nav-bar[\s\S]*visibility: collapse !important/);
});

test('FritzWorks launcher configures appmode, starts the daemon, and launches Firefox', async () => {
  const calls = [];
  const child = new EventEmitter();
  const resultPromise = launchApp({
    config: { sample: true },
    profileName: 'appmode',
    firefox: '/usr/bin/firefox',
    env: { HOME: '/users/example', DISPLAY: ':1' },
    configure(options) { calls.push(['configure', options]); },
    async start(options) {
      calls.push(['start', options]);
      return { url: 'http://127.0.0.1:7337' };
    },
    run(command, args, options) {
      calls.push(['run', command, args, options]);
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  const result = await resultPromise;

  assert.equal(result.url, 'http://127.0.0.1:7337/v2/');
  assert.deepEqual(calls[0][1], {
    profileName: 'appmode',
    env: { HOME: '/users/example', DISPLAY: ':1' },
    home: '/users/example',
  });
  assert.deepEqual(calls[1], ['start', { config: { sample: true } }]);
  assert.equal(calls[2][1], '/usr/bin/firefox');
  assert.deepEqual(calls[2][2], ['-P', 'appmode', '--new-window', 'http://127.0.0.1:7337/v2/']);
  assert.equal(calls[2][3].env.MOZ_APP_REMOTINGNAME, 'fritzworks');
});
