#!/usr/bin/env -S node --no-warnings

import {
  existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_CHROME = `/* Hide Firefox chrome while retaining the native window title bar. */
#TabsToolbar,
#nav-bar {
  visibility: collapse !important;
}`;

function parseIni(source) {
  const sections = new Map();
  let current = null;
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    const heading = line.match(/^\[([^\]]+)]$/);
    if (heading) {
      current = {};
      sections.set(heading[1], current);
      continue;
    }
    const separator = line.indexOf('=');
    if (!current || separator === -1) continue;
    current[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return sections;
}

function profileRegistryCandidates({ env = process.env, home = env.HOME } = {}) {
  const candidates = [];
  if (env.XDG_CONFIG_HOME) candidates.push(join(env.XDG_CONFIG_HOME, 'mozilla', 'firefox', 'profiles.ini'));
  if (home) {
    candidates.push(join(home, '.config', 'mozilla', 'firefox', 'profiles.ini'));
    candidates.push(join(home, '.mozilla', 'firefox', 'profiles.ini'));
  }
  return [...new Set(candidates)];
}

export function findFirefoxProfile(profileName, options = {}) {
  for (const registry of profileRegistryCandidates(options)) {
    if (!existsSync(registry)) continue;
    const sections = parseIni(readFileSync(registry, 'utf8'));
    for (const section of sections.values()) {
      if (section.Name !== profileName || !section.Path) continue;
      const path = section.IsRelative === '0' || isAbsolute(section.Path)
        ? resolve(section.Path)
        : resolve(dirname(registry), section.Path);
      return { path, registry };
    }
  }
  return null;
}

export function setUserPref(source, name, value) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const line = `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`;
  const pattern = new RegExp(`^[ \\t]*user_pref\\("${escapedName}",.*\\);[ \\t]*$`, 'm');
  if (pattern.test(source)) return source.replace(pattern, line);
  return `${source.trimEnd()}${source.trim() ? '\n' : ''}${line}\n`;
}

export function configureFirefoxProfile({
  profileName = 'appmode',
  env = process.env,
  home = env.HOME,
} = {}) {
  const profile = findFirefoxProfile(profileName, { env, home });
  if (!profile) {
    throw new Error(`Firefox profile "${profileName}" was not found`);
  }
  if (!existsSync(profile.path)) {
    throw new Error(`Firefox profile directory does not exist: ${profile.path}`);
  }

  const userJsPath = join(profile.path, 'user.js');
  const previousUserJs = existsSync(userJsPath) ? readFileSync(userJsPath, 'utf8') : '';
  let userJs = setUserPref(
    previousUserJs,
    'toolkit.legacyUserProfileCustomizations.stylesheets',
    true,
  );
  // 0 means Firefox uses KDE/GTK's native title bar instead of putting the
  // window buttons inside #TabsToolbar, which this app profile hides.
  userJs = setUserPref(userJs, 'browser.tabs.inTitlebar', 0);
  if (userJs !== previousUserJs) writeFileSync(userJsPath, userJs);

  const chromeDirectory = join(profile.path, 'chrome');
  const userChromePath = join(chromeDirectory, 'userChrome.css');
  mkdirSync(chromeDirectory, { recursive: true });
  const previousChrome = existsSync(userChromePath) ? readFileSync(userChromePath, 'utf8') : '';
  const alreadyHidesChrome = /#TabsToolbar\s*,\s*#nav-bar\s*\{[^}]*visibility:\s*collapse\s*!important;?[^}]*}/s
    .test(previousChrome);
  const userChrome = alreadyHidesChrome
    ? previousChrome
    : `${previousChrome.trimEnd()}${previousChrome.trim() ? '\n\n' : ''}${APP_CHROME}\n`;
  if (userChrome !== previousChrome) writeFileSync(userChromePath, userChrome);

  return {
    profile: profile.path,
    registry: profile.registry,
    changed: userJs !== previousUserJs || userChrome !== previousChrome,
  };
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  const profileIndex = process.argv.indexOf('--profile');
  const profileName = profileIndex === -1 ? 'appmode' : process.argv[profileIndex + 1];
  if (!profileName) {
    console.error('Usage: configure-firefox.js [--profile <name>]');
    process.exit(2);
  }
  try {
    const result = configureFirefoxProfile({ profileName });
    console.log(`${result.changed ? 'Configured' : 'Checked'} Firefox profile ${profileName} at ${result.profile}`);
  } catch (error) {
    console.error(`Could not configure Firefox app profile: ${error.message}`);
    process.exit(1);
  }
}
