import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';
import { verifySpreadsheet } from '../login.js';

function adapter(reply) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  child.requests = [];
  child.stdin = new Writable({ write(chunk, encoding, done) {
    const request = JSON.parse(chunk.toString());
    child.requests.push(request);
    if (request.id) {
      setImmediate(() => child.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0', id: request.id,
        result: request.id === 1 ? { capabilities: {} } : reply,
      })}\n`));
    }
    done();
  } });
  return child;
}

test('login verifies an actual read, including text-encoded metadata', async () => {
  const child = adapter({ content: [{ type: 'text', text: JSON.stringify({
    spreadsheetId: 'sheet-123', properties: { title: 'Example' },
  }) }] });
  const result = await verifySpreadsheet(child, 'sheet-123');
  assert.equal(result.properties.title, 'Example');
  assert.equal(child.requests.at(-1).method, 'tools/call');
  assert.equal(child.requests.at(-1).params.name, 'get_spreadsheet');
  assert.equal(child.requests.some(request => request.method === 'resources/list'), false);
  assert.equal(child.killed, true);
});

test('login rejects tool errors without printing returned HTML', async () => {
  const child = adapter({ isError: true, content: [{ type: 'text', text: '<html>private diagnostic</html>' }] });
  await assert.rejects(verifySpreadsheet(child, 'sheet-123'), /Google rejected the spreadsheet read/);
  assert.equal(child.killed, true);
});

test('successful initialization without spreadsheet metadata is not login success', async () => {
  const child = adapter({ tools: [] });
  await assert.rejects(verifySpreadsheet(child, 'sheet-123'), /no matching spreadsheet metadata/);
  assert.equal(child.killed, true);
});
