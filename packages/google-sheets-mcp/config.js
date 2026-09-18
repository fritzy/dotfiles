import { homedir } from 'node:os';
import { join } from 'node:path';

export const serverUrl = 'https://sheetsmcp.googleapis.com/mcp/v1';
export const callbackPort = 8765;
export const configDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'google-sheets-mcp');
export const credentialsPath = join(configDir, 'oauth-client.json');
export const authDir = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'google-sheets-mcp');

export function normalizeCredentials(input) {
  const client = input.web || input.installed || input.mcpServers?.sheets?.oauth || input;
  const client_id = client.client_id || client.clientId;
  const client_secret = client.client_secret || client.clientSecret;
  if (typeof client_id !== 'string' || !client_id.trim() ||
      typeof client_secret !== 'string' || !client_secret.trim()) {
    throw new Error('OAuth JSON must contain a client ID and client secret.');
  }
  return { client_id, client_secret };
}

export function adapterArgs(clientFile = credentialsPath) {
  return [
    serverUrl, String(callbackPort),
    '--host', 'localhost',
    '--callback-path', '/callback',
    '--transport', 'http-only',
    '--auth-timeout', '300',
    '--static-oauth-client-info', `@${clientFile}`,
    '--static-oauth-client-metadata', JSON.stringify({
      token_endpoint_auth_method: 'client_secret_post',
      scope: [
        'https://www.googleapis.com/auth/drive.readonly',
        'https://www.googleapis.com/auth/drive.file',
        'https://www.googleapis.com/auth/spreadsheets.readonly',
        'https://www.googleapis.com/auth/spreadsheets',
      ].join(' '),
    }),
    '--authorize-param', 'access_type=offline',
    '--authorize-param', 'prompt=consent',
  ];
}
