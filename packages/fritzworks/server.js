#!/usr/bin/env -S node --no-warnings

import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createApiService } from './lib/api.js';
import { CONFIG } from './lib/config.js';
import { acquireDaemonLock, daemonFiles } from './lib/daemon.js';

function flagValue(args, name) {
  const index = args.indexOf(name);
  if (index !== -1 && args[index + 1]) return args[index + 1];
  const equals = args.find((arg) => arg.startsWith(`${name}=`));
  return equals ? equals.slice(name.length + 1) : undefined;
}

function portValue(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('port must be an integer from 0 to 65535');
  }
  return port;
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(server.address()); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

export async function runServer({
  config = CONFIG,
  host = config.server.host,
  port = config.server.port,
} = {}) {
  const release = acquireDaemonLock(config);
  let service;
  let address;
  try {
    service = createApiService({ config });
    address = await listen(service.server, host, port);
  } catch (error) {
    try { await service?.close(); } finally { release(); }
    throw error;
  }
  const actualHost = typeof address === 'object' && address ? address.address : host;
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const connectHost = actualHost === '0.0.0.0' ? '127.0.0.1' : actualHost === '::' ? '::1' : actualHost;
  service.context.runtimeEndpoint = `http://${connectHost.includes(':') && !connectHost.startsWith('[') ? `[${connectHost}]` : connectHost}:${actualPort}`;
  const files = daemonFiles(config);
  const info = {
    pid: process.pid,
    instanceId: service.context.instanceId,
    configPath: config.configPath,
    configRevision: service.context.configRevision,
    host: actualHost,
    port: actualPort,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(files.pid, `${JSON.stringify(info, null, 2)}\n`);
  process.stdout.write(`fritzworks API listening on http://${actualHost}:${actualPort}\n`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await service.close(); } finally { release(); }
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    if (existsSync(files.pid)) {
      try {
        const current = JSON.parse(readFileSync(files.pid, 'utf8'));
        if (current.pid === process.pid) unlinkSync(files.pid);
      } catch { /* leave an unfamiliar pid file alone */ }
    }
  };
  const onSignal = () => stop().then(() => process.exit(0));
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return { service, address, info, stop };
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: node server.js [--host <address>] [--port <number>]');
    return;
  }
  const host = flagValue(argv, '--host') || CONFIG.server.host;
  const port = portValue(flagValue(argv, '--port') ?? CONFIG.server.port);
  await runServer({ host, port });
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) main().catch((error) => {
  console.error(`fritzworks API: ${error.message || error}`);
  process.exit(1);
});
