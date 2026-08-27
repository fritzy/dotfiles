#!/usr/bin/env -S node --no-warnings

import { existsSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createApiService } from './lib/api.js';
import { CONFIG } from './lib/config.js';
import { daemonFiles } from './lib/daemon.js';

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
  host = CONFIG.server.host,
  port = CONFIG.server.port,
  config = CONFIG,
} = {}) {
  const service = createApiService({ config });
  const address = await listen(service.server, host, port);
  const actualHost = typeof address === 'object' && address ? address.address : host;
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const files = daemonFiles(config);
  const daemonized = process.env.AI_WORKSTREAM_DAEMON === '1';
  const info = {
    pid: process.pid,
    host: actualHost,
    port: actualPort,
    startedAt: new Date().toISOString(),
  };
  if (daemonized) writeFileSync(files.pid, `${JSON.stringify(info, null, 2)}\n`);
  process.stdout.write(`ai-workstream API listening on http://${actualHost}:${actualPort}\n`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await service.close();
    if (daemonized && existsSync(files.pid)) {
      try {
        const current = JSON.parse(readFileSync(files.pid, 'utf8'));
        if (current.pid === process.pid) unlinkSync(files.pid);
      } catch { /* leave an unfamiliar pid file alone */ }
    }
  };
  process.once('SIGINT', () => stop().then(() => process.exit(0)));
  process.once('SIGTERM', () => stop().then(() => process.exit(0)));
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
  console.error(`ai-workstream API: ${error.message || error}`);
  process.exit(1);
});
