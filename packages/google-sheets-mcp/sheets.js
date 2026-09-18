import { chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { adapterArgs, authDir, credentialsPath, normalizeCredentials } from './config.js';
import { logAuthProgress, verifySpreadsheet } from './login.js';

try {
  const args = process.argv.slice(2);
  const login = args[0] === '--login';
  if (args.length && (!login || args.length !== 2)) {
    throw new Error('Usage: node sheets.js --login <spreadsheet ID or URL>');
  }
  const spreadsheetId = login ? (args[1].match(/\/spreadsheets\/d\/([\w-]+)/)?.[1] || args[1]) : null;
  if (login && !/^[\w-]+$/.test(spreadsheetId)) throw new Error('Invalid spreadsheet ID or URL.');
  process.umask(0o077);
  normalizeCredentials(JSON.parse(readFileSync(credentialsPath, 'utf8')));
  chmodSync(credentialsPath, 0o600);
  mkdirSync(authDir, { recursive: true, mode: 0o700 });
  chmodSync(authDir, 0o700);
  const adapter = fileURLToPath(new URL('node_modules/mcp-remote/dist/proxy.js', import.meta.url));
  const child = spawn(process.execPath, [adapter, ...adapterArgs()], {
    stdio: login ? 'pipe' : 'inherit',
    env: { ...process.env, MCP_REMOTE_CONFIG_DIR: authDir },
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
  if (login) {
    console.error('Checking spreadsheet access. Complete Google sign-in if prompted.');
    logAuthProgress(child.stderr);
    const metadata = await verifySpreadsheet(child, spreadsheetId);
    console.log(`Verified Google Sheets MCP access: ${metadata.properties?.title || spreadsheetId}`);
    for (const sheet of metadata.sheets || []) {
      console.log(`  ${sheet.properties.title} (gid=${sheet.properties.sheetId})`);
    }
  } else {
    child.on('error', error => {
      console.error(`Sheets MCP: ${error.message}`);
      process.exitCode = 1;
    });
    child.on('exit', code => { process.exitCode = code ?? 1; });
  }
} catch (error) {
  console.error(`Sheets MCP: ${error.code === 'ENOENT' ? `missing ${credentialsPath}; run setup.sh --credentials /path/to/google-oauth-client.json` : error.message}`);
  process.exitCode = 1;
}
