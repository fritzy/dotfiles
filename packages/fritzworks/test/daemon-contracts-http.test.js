import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createApplicationContext } from '../lib/context.js';
import { resolveConfig } from '../lib/config.js';
import { createApiService } from '../lib/api.js';
import { readPanelLayout, terminalPanelsForOwner } from '../lib/panels.js';

function request(service, path, body = {}, method = 'POST') {
  return new Promise((resolve) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method, url: path, headers: { host: 'localhost' } });
    let status;
    service.server.emit('request', req, {
      writeHead(value) { status = value; },
      end(value) { resolve({ status, body: JSON.parse(value) }); },
    });
  });
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function settled(context, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const job = context.jobs.get(id);
    if (!['queued', 'running', 'cancel_requested'].includes(job.status)) return job;
    await tick();
  }
  assert.fail('injected job did not settle');
}
function fixture(t, execute) {
  const home = mkdtempSync(join(tmpdir(), 'fw-contract-http-'));
  const configPath = join(home, 'config.ini');
  writeFileSync(configPath, 'configVersion=2\n[paths]\ndata=./data\n');
  const config = resolveConfig({ configPath, home, env: {} });
  const forbidden = () => { throw new Error('unexpected external process'); };
  const calls = [];
  let worker;
  const adapters = { providerAvailable: () => true, commandAvailable: () => true, expandIssue: (_row, ref) => ref,
    runJob: async (intent, options) => {
      calls.push(intent);
      if (execute) return execute(intent, worker, options);
      if (intent.kind === 'create-scratchpad') return worker.operations.createScratchpad(intent.body);
      if (intent.kind === 'action') return worker.operations.execute(intent.target, intent.command, intent.body);
      throw new Error('fixture must explicitly mock repository work');
    },
  };
  const context = createApplicationContext({ config, runProcess: forbidden, adapters });
  worker = createApplicationContext({ config, db: context.db, jobWorker: true, runProcess: forbidden, adapters });
  const resets = [], kills = [], releases = [];
  const service = createApiService({ context, pollInterval: 0,
    checkGit: async () => null, checkPr: async () => ({ added: false }),
    ensureTerminalSession: forbidden, spawnTerminalAttach: forbidden,
    resetTerminalSession: (identity) => { resets.push(identity); return { reset: true, session: identity.panelId }; },
    killTerminalSession: (identity) => { kills.push(identity); return true; },
    resetAllTerminalSessions: forbidden,
  });
  t.after(async () => { releases.forEach((release) => release()); await service.close(); await worker.close(); await context.close(); rmSync(home, { recursive: true, force: true }); });
  return { context, worker, config, service, calls, resets, kills, releases };
}

test('HTTP repository creation is always a job and identical retries reuse running and completed work', async (t) => {
  let release;
  const deferred = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, async () => { await deferred; return { mockedRepository: true }; });
  f.releases.push(release);
  const body = { repository: 'team/project', selector: 'feature', idempotencyKey: 'repository-1' };
  const first = await request(f.service, '/fw', body);
  assert.equal(first.status, 202);
  await tick();
  assert.equal(f.context.jobs.get(first.body.job.id).status, 'running');
  const retry = await request(f.service, '/fw', body);
  assert.equal(retry.status, 202);
  assert.equal(retry.body.job.id, first.body.job.id);
  assert.equal(f.calls.length, 1);
  release();
  assert.equal((await settled(f.context, first.body.job.id)).status, 'succeeded');
  const completedRetry = await request(f.service, '/fw', body);
  assert.equal(completedRetry.body.job.id, first.body.job.id);
  assert.equal(completedRetry.body.job.status, 'succeeded');
  assert.equal((await request(f.service, '/fw', { ...body, selector: 'different' })).status, 409);
  assert.equal(f.calls.length, 1);
});

test('HTTP scratch idempotency creates one directory and one shared workspace', async (t) => {
  const f = fixture(t);
  const body = { name: 'scratch-job', idempotencyKey: 'scratch-1' };
  const first = await request(f.service, '/fw/scratchpad', body);
  assert.equal(first.status, 202);
  const job = await settled(f.context, first.body.job.id);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  const retry = await request(f.service, '/fw/scratchpad', body);
  assert.equal(retry.body.job.id, job.id);
  assert.equal(f.context.db.prepare('SELECT COUNT(*) AS count FROM workstreams').get().count, 1);
  assert.equal(existsSync(job.result.workstream.path), true);
  assert.equal(readPanelLayout(f.context.db).groups.some((group) => group.ownerId === String(job.result.workstream.id)), true);
});

test('HTTP generic jobs deduplicate queued and running work and block conflicting sync or storage mutations', async (t) => {
  let release;
  const deferred = new Promise((resolve) => { release = resolve; });
  const f = fixture(t, async (intent, worker) => { await deferred; return worker.operations.execute(intent.target, intent.command, intent.body); });
  f.releases.push(release);
  const row = f.context.operations.createScratchpad({ name: 'job-owner' }).workstream;
  const submission = { intent: { kind: 'action', target: row.uuid, command: 'rename', body: { name: 'renamed' } }, idempotencyKey: 'rename-1' };
  const first = await request(f.service, '/jobs', submission);
  const queuedRetry = await request(f.service, '/jobs', submission);
  assert.equal(queuedRetry.body.job.id, first.body.job.id);
  await tick();
  const runningRetry = await request(f.service, '/jobs', submission);
  assert.equal(runningRetry.body.job.id, first.body.job.id);
  for (const path of ['/migrations/storage/apply', '/storage/relocate/apply', `/fw/${row.id}/sync`, `/fw/${row.id}/pause`]) {
    const blocked = await request(f.service, path);
    assert.equal(blocked.status, 409, path);
    assert.equal(blocked.body.details.code, 'job_in_progress', path);
  }
  release();
  const job = await settled(f.context, first.body.job.id);
  assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
  assert.equal(readPanelLayout(f.context.db).groups.find((group) => group.ownerId === String(row.id)).label, 'renamed');
  const retry = await request(f.service, '/jobs', submission);
  assert.equal(retry.body.job.id, first.body.job.id);
  assert.equal(f.calls.length, 1);
});

test('HTTP synchronous and job lifecycle completion update terminal reset results, labels and issue resources', async (t) => {
  const f = fixture(t);
  const row = f.context.operations.createScratchpad({ name: 'parity' }).workstream;
  await request(f.service, `/fw/${row.id}/resume`);
  for (const async of [false, true]) {
    const call = async (command, body) => {
      const response = await request(f.service, `/fw/${row.id}/${command}`, { ...body, async });
      assert.equal(response.status, async ? 202 : 200, JSON.stringify(response.body));
      if (!async) return response.body;
      const job = await settled(f.context, response.body.job.id);
      assert.equal(job.status, 'succeeded', JSON.stringify(job.error));
      return job.result;
    };
    const preview = await request(f.service, '/intents/preview', { kind: 'action', target: row.uuid, command: 'terminal-reset', body: {} });
    const before = f.resets.length;
    const reset = await call('terminal-reset', { previewRevision: preview.body.revision, confirm: true });
    assert.ok(reset.result.terminals);
    assert.equal(f.resets.length - before, terminalPanelsForOwner(f.context.db, row.id).length);
    await call('rename', { name: `parity-${async}` });
    assert.equal(readPanelLayout(f.context.db).groups.find((group) => group.ownerId === String(row.id)).label, `parity-${async}`);
    const ref = `https://example.com/issues/${async}`;
    await call('issue-add', { refs: [ref] });
    const group = readPanelLayout(f.context.db).groups.find((item) => item.ownerId === String(row.id));
    assert.ok(group.resources.some((resource) => resource.value === ref));
  }
});

test('HTTP invalid and stale previews make no domain mutations or job submissions', async (t) => {
  const f = fixture(t);
  const row = f.context.operations.createScratchpad({ name: 'preserved' }).workstream;
  const before = f.context.db.prepare('SELECT total_changes() AS count').get().count;
  const invalid = await request(f.service, '/intents/preview', { kind: 'create-repo', body: { repository: 'invalid', selector: 'feature' } });
  assert.equal(invalid.status, 400);
  assert.equal(f.context.db.prepare('SELECT total_changes() AS count').get().count, before);
  const preview = await request(f.service, '/intents/preview', { kind: 'action', target: row.uuid, command: 'terminal-reset', body: {} });
  f.context.hooks.environment(row.uuid, 'shell');
  const stale = await request(f.service, `/fw/${row.id}/terminal-reset`, { async: true, previewRevision: preview.body.revision, confirm: true });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.details.code, 'stale_preview');
  assert.equal(f.context.jobs.list().length, 0);
  assert.equal(f.resets.length, 0);
  assert.equal(f.calls.length, 0);
});
