import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { run } from '../cli.js';
import { listWorkstreams, requestDaemonService } from '../lib/client.js';

const daemon = { id: 'local', name: 'Local', local: true, url: 'http://test' };
async function cli(args, handler, options = {}) {
  const requests = [];
  const output = [];
  const original = console.log;
  console.log = (...parts) => output.push(parts.join(' '));
  try {
    await run(args, { ...options, request: async (path, request = {}) => {
      requests.push({ path, ...request });
      return { daemon, result: await handler(path, request) };
    } });
  } finally { console.log = original; }
  return { requests, output };
}

const resolve = () => ({ target: { id: 7 }, workstream: { id: 7, type: 'repo', org: 'team', repo: 'project', branch: 'feature', path: '/daemon/only' } });

test('CLI and shared listing consume all pages, including exact full final pages', async () => {
  const pages = [];
  const result = await listWorkstreams('all', { request: async (path) => {
    pages.push(path);
    return { daemon, result: { total: 200, items: Array.from({ length: 100 }, (_, id) => ({ id })) } };
  } });
  assert.equal(result.result.items.length, 200);
  assert.equal(pages.length, 2);
  const listed = await cli(['list'], (path) => path === '/context/resolve' ? resolve() : { total: 1, items: [{ id: 7, issues: [] }] });
  assert.equal(listed.requests[1].path, '/context/resolve');
});

test('CLI digest delegates both assembly and weekly writes', async () => {
  const result = await cli(['digest', '2026-09-24', '--write'], () => ({ markdown: '- finished', written: { file: '/daemon/weekly.md' } }));
  assert.deepEqual(result.requests, [{ path: '/fw/digest', method: 'POST', body: { date: '2026-09-24', write: true } }]);
  assert.match(result.output.join('\n'), /finished/);
});

test('CLI stack writes, note reads and configured targets use daemon paths', async () => {
  const stacked = await cli(['stack', 'on', 'base', '--fw', 'feature'], (path) => path === '/context/resolve' ? resolve() : { stackedOn: { id: 8 } });
  assert.equal(stacked.requests.at(-1).path, '/fw/7/stack-set');
  assert.deepEqual(stacked.requests.at(-1).body, { parent: 'base' });
  const note = await cli(['note', 'show', 'one.md', '--fw', 'feature'], (path) => path === '/context/resolve' ? resolve() : { content: '# From daemon' });
  assert.equal(note.requests.at(-1).path, '/fw/7/note-file?path=one.md');
  const location = await cli(['new-location', '--close'], (path) => path === '/capabilities' ? { locations: [{ id: 'new-location' }] } : {});
  assert.equal(location.requests.at(-1).path, '/fw/new-location/pause');
});

test('CLI destructive preview is reviewable without mutation and exact revision is forwarded', async () => {
  const handler = (path) => path === '/context/resolve' ? resolve() : path === '/intents/preview'
    ? { revision: 'p1', confirmationRequired: true, intent: { body: { remove: true } }, consequences: { path: '/daemon/only' } }
    : { job: { id: 'j1', status: 'queued' } };
  const previewed = await cli(['archive', '7', '--delete', '--preview'], handler);
  assert.equal(previewed.requests.length, 2);
  assert.match(previewed.output.join('\n'), /"revision": "p1"/);
  const applied = await cli(['archive', '7', '--delete', '--preview-revision', 'p1', '--confirm'], handler);
  assert.equal(applied.requests.at(-1).body.previewRevision, 'p1');
  assert.equal(applied.requests.at(-1).body.confirm, true);
  assert.equal(applied.requests.at(-1).body.async, true);
});

test('CLI missing noninteractive choices produce actionable errors and never mutate', async () => {
  if (process.stdin.isTTY) return;
  await assert.rejects(cli(['archive', '7', '--delete'], (path) => path === '/context/resolve' ? resolve()
    : { revision: 'p1', confirmationRequired: true, intent: { body: { remove: true } } }), /interactive input required/);
});

test('client request forwards abort signals and preserves structured daemon errors', async () => {
  const controller = new AbortController();
  await assert.rejects(requestDaemonService('/test', {
    config: { daemons: {} }, start: async () => ({ url: 'http://127.0.0.1:7000' }), signal: controller.signal,
    fetchImpl: async (_url, options) => {
      assert.equal(options.signal.aborted, controller.signal.aborted);
      return { ok: false, status: 409, json: async () => ({ message: 'stale preview', details: { code: 'stale_preview' } }) };
    },
  }), (error) => error.status === 409 && error.details.code === 'stale_preview');
});

test('domain clients and hooks have no direct SQLite, Git or core persistence imports', () => {
  for (const path of ['../cli.js', '../mcp.js', '../lib/hooks.js', '../lib/client.js']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /(?:from\s+['"][^'"]*(?:core|operations|git-storage|session-notes)\.js|node:sqlite|\bopenDb\s*\(|\bspawnSync\s*\()/, path);
  }
});

test('declining a CLI destructive preview leaves the session and its terminals untouched', async () => {
  const result = await cli(['archive', '7', '--delete'], (path) => path === '/context/resolve' ? resolve()
    : { revision: 'p1', confirmationRequired: true, intent: { body: { remove: true } }, consequences: ['Remove files'] },
  { prompt: async () => 'no' });
  assert.deepEqual(result.requests.map((request) => request.path), ['/context/resolve', '/intents/preview']);
});

test('CLI creation and lifecycle retry keys are payload options rather than selectors', async () => {
  const handler = (path) => path === '/context/resolve' ? resolve() : { job: { id: 'same-job', status: 'queued' } };
  const created = await cli(['scratch', '--idempotency-key', 'scratch-key', 'named'], handler);
  assert.equal(created.requests[0].body.name, 'named');
  assert.equal(created.requests[0].body.idempotencyKey, 'scratch-key');
  const resumed = await cli(['resume', '--idempotency-key=resume-key', '7'], handler);
  assert.equal(resumed.requests.at(-1).body.idempotencyKey, 'resume-key');
  const archived = await cli(['archive', '7', '--delete', '--idempotency-key', 'archive-key', '--preview-revision', 'exact', '--confirm'], handler);
  assert.deepEqual(archived.requests.map((request) => request.path), ['/context/resolve', '/fw/7/archive']);
  assert.equal(archived.requests.at(-1).body.idempotencyKey, 'archive-key');
  assert.equal(archived.requests.at(-1).body.previewRevision, 'exact');
  const stack = await cli(['stack', 'rebase', '7', '--idempotency-key', 'stack-key', '--preview-revision', 'exact', '--confirm'], handler);
  assert.equal(stack.requests.at(-1).body.idempotencyKey, 'stack-key');
  assert.equal(stack.requests.at(-1).body.previewRevision, 'exact');
  assert.equal(stack.requests.length, 2);
});

test('CLI keeps idempotency keys when executing normalized interactive previews', async () => {
  const handler = (path, request) => path === '/context/resolve' ? resolve() : path === '/intents/preview'
    ? { revision: 'p2', confirmationRequired: true, intent: { body: { remove: true } }, consequences: ['Remove'] }
    : { job: { id: 'retained-key', status: 'queued' } };
  const archive = await cli(['archive', '7', '--delete', '--idempotency-key', 'interactive-key'], handler, { prompt: async () => 'yes' });
  assert.equal(archive.requests.at(-1).body.idempotencyKey, 'interactive-key');
  const stack = await cli(['stack', 'rebase', '7', '--idempotency-key', 'stack-key'], handler, { prompt: async () => 'yes' });
  assert.equal(stack.requests.at(-1).body.idempotencyKey, 'stack-key');
});
