#!/usr/bin/env -S node --no-warnings

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CONFIG } from './lib/config.js';
import { startDaemon } from './lib/daemon.js';
import { configureFirefoxProfile } from './desktop/configure-firefox.js';

export async function launchApp({
  config = CONFIG,
  profileName = process.env.AI_WORKSTREAM_FIREFOX_PROFILE || 'appmode',
  firefox = process.env.FIREFOX || 'firefox',
  env = process.env,
  run = spawn,
  start = startDaemon,
  configure = configureFirefoxProfile,
} = {}) {
  configure({ profileName, env, home: env.HOME });
  const status = await start({ config });
  const url = `${status.url}/v2/`;
  const child = run(firefox, ['-P', profileName, '--new-window', url], {
    env: { ...env, MOZ_APP_REMOTINGNAME: 'fritzworks' },
    stdio: 'ignore',
  });
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  return { child, profileName, url };
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) launchApp().catch((error) => {
  console.error(`FritzWorks: ${error.message || error}`);
  process.exit(1);
});
