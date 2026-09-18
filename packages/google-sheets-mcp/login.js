import { createInterface } from 'node:readline';

export function verifySpreadsheet(child, spreadsheetId, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      child.kill('SIGTERM');
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('Sign-in timed out. Check the browser and the registered OAuth redirect URI.')), timeoutMs);
    const send = message => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    child.on('error', error => finish(error));
    child.on('exit', code => finish(new Error(`Sheets adapter exited before access was verified (status ${code}).`)));
    child.stdin.on('error', error => finish(error));
    lines.on('line', line => {
      let response;
      try { response = JSON.parse(line); }
      catch { return finish(new Error('Sheets adapter returned invalid MCP JSON.')); }
      if (response.error) {
        return finish(new Error(`MCP request failed (code ${response.error.code}); access is not verified.`));
      }
      if (response.id === 1) {
        send({ method: 'notifications/initialized' });
        send({
          id: 2, method: 'tools/call', params: {
            name: 'get_spreadsheet', arguments: {
              spreadsheetId,
              fields: ['spreadsheetId', 'properties.title', 'sheets.properties(sheetId,title)'],
            },
          },
        });
      } else if (response.id === 2) {
        const result = response.result;
        if (!result || result.isError) {
          return finish(new Error('Google rejected the spreadsheet read. Check the signed-in account, API access, and sharing permissions.'));
        }
        let metadata = result.structuredContent;
        for (const content of result.content || []) {
          if (content.type !== 'text') continue;
          try { metadata ||= JSON.parse(content.text); } catch {}
        }
        metadata = metadata?.fields || metadata;
        if (metadata?.spreadsheetId !== spreadsheetId) {
          return finish(new Error('Google returned no matching spreadsheet metadata; access is not verified.'));
        }
        finish(null, metadata);
      }
    });
    send({
      id: 1, method: 'initialize', params: {
        protocolVersion: '2025-03-26', capabilities: {},
        clientInfo: { name: 'sheets-login-check', version: '1' },
      },
    });
  });
}

export function logAuthProgress(stream) {
  const lines = createInterface({ input: stream });
  lines.on('line', line => {
    // Upstream diagnostics can contain an entire HTML error document.
    if (/^https:\/\/accounts\.google\.com\//.test(line)) {
      console.error(`Open this URL to authorize Google Sheets:\n${line}`);
    } else if (!/[<>]/.test(line) && /sign-in|callback port|Browser opened|Waiting for authorization|Completing authorization|Authorization completed|EADDRINUSE|invalid_client|invalid_grant|redirect_uri_mismatch/.test(line)) {
      console.error(line.slice(0, 500));
    }
  });
}
