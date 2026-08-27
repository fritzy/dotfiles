import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG } from './config.js';

export const SERVER_ENTRY = fileURLToPath(new URL('../server.js', import.meta.url));

export function daemonFiles(config = CONFIG) {
  return {
    pid: join(config.paths.data, 'api-server.json'),
    log: join(config.paths.data, 'api-server.log'),
  };
}

export function openWebPage(url, { platform = process.platform, run = spawnSync } = {}) {
  const opener = platform === 'darwin' ? 'open' : 'xdg-open';
  const result = run(opener, [url], { stdio: 'ignore' });
  if (result.error) throw new Error(`could not run ${opener} for ${url}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${opener} could not open ${url}`);
  return { opener, url };
}

function endpoint(host, port) {
  let connectHost = host;
  if (host === '0.0.0.0') connectHost = '127.0.0.1';
  if (host === '::') connectHost = '::1';
  if (connectHost.includes(':') && !connectHost.startsWith('[')) connectHost = `[${connectHost}]`;
  return `http://${connectHost}:${port}`;
}

export function readDaemonInfo(config = CONFIG) {
  const file = daemonFiles(config).pid;
  if (!existsSync(file)) return null;
  try {
    const info = JSON.parse(readFileSync(file, 'utf8'));
    if (!Number.isInteger(info.pid) || typeof info.host !== 'string' || !Number.isInteger(info.port)) return null;
    return info;
  } catch {
    return null;
  }
}

const processExists = (pid) => {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
};

export async function daemonHealth(info, timeout = 750) {
  if (!info) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(`${endpoint(info.host, info.port)}/health`, { signal: controller.signal });
    if (!response.ok) return null;
    const health = await response.json();
    return health.service === 'ai-workstream' && health.pid === info.pid ? health : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function daemonStatus(config = CONFIG) {
  const info = readDaemonInfo(config);
  if (!info) return { running: false, stale: false, info: null };
  const health = await daemonHealth(info);
  if (health) {
    return {
      running: true,
      stale: false,
      info,
      health,
      url: endpoint(info.host, info.port),
      log: daemonFiles(config).log,
    };
  }
  return { running: false, stale: true, processExists: processExists(info.pid), info };
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function startDaemon({ config = CONFIG, host = config.server.host, port = config.server.port } = {}) {
  const existing = await daemonStatus(config);
  if (existing.running) return { ...existing, alreadyRunning: true };
  if (existing.processExists) {
    throw new Error(`pid ${existing.info.pid} exists but does not answer as ai-workstream; refusing to replace it`);
  }

  const files = daemonFiles(config);
  mkdirSync(config.paths.data, { recursive: true });
  if (existsSync(files.pid)) unlinkSync(files.pid);
  const logFd = openSync(files.log, 'a');
  let child;
  try {
    child = spawn(process.execPath, ['--no-warnings', SERVER_ENTRY, '--host', host, '--port', String(port)], {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, AI_WORKSTREAM_DAEMON: '1' },
    });
  } finally {
    closeSync(logFd);
  }
  child.unref();

  const expected = { pid: child.pid, host, port };
  for (let attempt = 0; attempt < 50; attempt++) {
    const health = await daemonHealth(expected, 200);
    if (health) {
      return {
        running: true,
        alreadyRunning: false,
        info: readDaemonInfo(config) || expected,
        health,
        url: endpoint(host, port),
        log: files.log,
      };
    }
    if (!processExists(child.pid)) break;
    await delay(100);
  }
  throw new Error(`API daemon did not start; see ${files.log}`);
}

export async function stopDaemon(config = CONFIG) {
  const status = await daemonStatus(config);
  const files = daemonFiles(config);
  if (!status.info) return { stopped: false, reason: 'not running' };
  if (!status.running) {
    if (status.processExists) {
      throw new Error(`pid ${status.info.pid} exists but is not the ai-workstream API; refusing to signal it`);
    }
    if (existsSync(files.pid)) unlinkSync(files.pid);
    return { stopped: false, reason: 'removed stale pid file' };
  }

  process.kill(status.info.pid, 'SIGTERM');
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!processExists(status.info.pid)) {
      if (existsSync(files.pid)) unlinkSync(files.pid);
      return { stopped: true, pid: status.info.pid };
    }
    await delay(100);
  }
  throw new Error(`API daemon ${status.info.pid} did not stop after SIGTERM`);
}

export async function runForeground({ config = CONFIG, host = config.server.host, port = config.server.port } = {}) {
  const child = spawn(process.execPath, ['--no-warnings', SERVER_ENTRY, '--host', host, '--port', String(port)], {
    stdio: 'inherit',
    env: process.env,
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0 || signal === 'SIGINT' || signal === 'SIGTERM') resolve();
      else reject(new Error(`API server exited with ${signal || `code ${code}`}`));
    });
  });
}
