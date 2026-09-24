import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createApplicationContext } from '../lib/context.js';
import { resolveConfig } from '../lib/config.js';

async function settled(jobs, id) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const job = jobs.get(id);
    if (!['queued', 'running', 'cancel_requested'].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('worker did not settle');
}

test('worker threads preserve instance, reviewed intent and persistence for non-Git scratch actions', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'fw-worker-review-'));
  const configPath = join(home, 'config.ini');
  writeFileSync(configPath, 'configVersion=2\n[paths]\ndata=./data\n[commands]\nshell=/bin/sh\ncodex=/missing-worker-test-agent\nclaude=/missing-worker-test-agent\n');
  const config = resolveConfig({ home, env: {}, configPath });
  const context = createApplicationContext({ config, runProcess: () => assert.fail('no subprocess is permitted') });
  t.after(async () => { await context.close(); rmSync(home, { recursive: true, force: true }); });
  const instance = context.instanceId;
  const intent = { kind: 'create-scratchpad', body: { name: 'worker fixture', panels: ['shell'] } };
  const preview = context.policy.preview(intent);
  const submitted = context.jobs.submit({ ...intent, body: { ...preview.intent.body, previewRevision: preview.revision } }, { idempotencyKey: 'worker-scratch' });
  const created = await settled(context.jobs, submitted.id);
  assert.equal(created.status, 'succeeded', JSON.stringify(created.error));
  const row = created.result.workstream;
  assert.ok(row.path.startsWith(config.paths.scratchpads + '/'));
  assert.equal(existsSync(row.path), true);
  assert.equal(context.db.prepare("SELECT value FROM application_metadata WHERE key='instanceId'").get().value, instance);
  const rename = { kind: 'action', target: row.uuid, command: 'rename', body: { name: 'worker renamed' } };
  const renamed = await settled(context.jobs, context.jobs.submit(rename).id);
  assert.equal(renamed.status, 'succeeded', JSON.stringify(renamed.error));
  assert.equal(context.db.prepare('SELECT label FROM workstreams WHERE uuid=?').get(row.uuid).label, 'worker renamed');
  assert.equal(context.jobs.get(submitted.id).status, 'succeeded');
  assert.equal(context.jobs.get(renamed.id).status, 'succeeded');
});
