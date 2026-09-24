import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createJobs } from '../lib/jobs.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t, runJob, jobCompleted) {
  const db = new DatabaseSync(':memory:');
  const context = { db, adapters: { runJob }, jobCompleted };
  const jobs = createJobs(context);
  t.after(() => { jobs.close(); db.close(); });
  return { jobs, db, context };
}

test('jobs yield immediately, journal progress, serialize work and finish daemon side effects', async (t) => {
  let finish;
  const completions = [];
  const { jobs } = fixture(t, async (intent, { progress }) => {
    progress({ stage: 'external-effect-started' });
    if (intent.body.name === 'first') await new Promise((resolve) => { finish = resolve; });
    return { name: intent.body.name };
  }, (result) => completions.push(result));
  const first = jobs.submit({ kind: 'create-scratchpad', body: { name: 'first' } });
  const second = jobs.submit({ kind: 'create-scratchpad', body: { name: 'second' } });
  assert.equal(first.status, 'queued');
  await tick();
  assert.equal(jobs.get(first.id).status, 'running');
  assert.equal(jobs.get(second.id).status, 'queued');
  assert.equal(jobs.get(first.id).progress.some((entry) => entry.stage === 'external-effect-started'), true);
  let responsive = false;
  await new Promise((resolve) => setImmediate(() => { responsive = true; resolve(); }));
  assert.equal(responsive, true);
  finish();
  await tick(); await tick();
  assert.equal(jobs.get(first.id).status, 'succeeded');
  assert.equal(jobs.get(second.id).status, 'succeeded');
  assert.deepEqual(completions, [{ name: 'first' }, { name: 'second' }]);
});

test('idempotent retry returns the original job and rejects changed intent', async (t) => {
  let runs = 0;
  const { jobs } = fixture(t, async () => { runs++; return { ok: true }; });
  const first = jobs.submit({ kind: 'create-scratchpad', body: { name: 'same', seed: 'a' } }, { idempotencyKey: 'key' });
  const retried = jobs.submit({ body: { seed: 'a', name: 'same' }, kind: 'create-scratchpad' }, { idempotencyKey: 'key' });
  assert.equal(first.id, retried.id);
  assert.throws(() => jobs.submit({ kind: 'create-scratchpad', body: { name: 'different' } }, { idempotencyKey: 'key' }), /different intent/);
  await tick();
  assert.equal(runs, 1);
  assert.equal(jobs.submit(first.intent, { idempotencyKey: 'key' }).status, 'succeeded');
});

test('queued cancellation executes no effects and running cancellation retains partial progress', async (t) => {
  let proceed;
  let runs = 0;
  const { jobs } = fixture(t, async (_intent, { signal, progress }) => {
    runs++;
    progress({ stage: 'completed-first-effect' });
    await new Promise((resolve) => { proceed = resolve; });
    if (signal.aborted) throw Object.assign(new Error('stopped between effects'), { name: 'AbortError', partialResult: { steps: ['first'] } });
  });
  const first = jobs.submit({ kind: 'action', command: 'resume' });
  const second = jobs.submit({ kind: 'action', command: 'resume' });
  assert.equal(jobs.cancel(second.id).status, 'cancelled');
  await tick();
  assert.equal(jobs.cancel(first.id).status, 'cancel_requested');
  proceed();
  await tick();
  assert.equal(jobs.get(first.id).status, 'cancelled');
  assert.deepEqual(jobs.get(first.id).result, { steps: ['first'] });
  assert.equal(runs, 1);
});

test('an in-flight operation that completes after cancellation remains successful', async (t) => {
  let finish;
  const { jobs } = fixture(t, async () => new Promise((resolve) => { finish = resolve; }));
  const job = jobs.submit({ kind: 'create-repo', body: { repository: 'example/project' } });
  await tick();
  jobs.cancel(job.id);
  finish({ ok: true });
  await tick();
  assert.equal(jobs.get(job.id).status, 'succeeded');
});

test('restart preserves the interrupted journal and never replays external effects', (t) => {
  let executions = 0;
  const { jobs, db, context } = fixture(t, async () => { executions++; });
  const job = jobs.submit({ kind: 'stack-link', target: 'session' }, { idempotencyKey: 'once' });
  db.prepare("UPDATE operation_jobs SET status='running' WHERE id=?").run(job.id);
  const recovered = createJobs(context);
  assert.equal(recovered.get(job.id).status, 'interrupted');
  assert.match(recovered.get(job.id).error.message, /not rolled back/);
  assert.equal(recovered.submit(job.intent, { idempotencyKey: 'once' }).id, job.id);
  assert.equal(executions, 0);
  recovered.close();
});

test('partial stack failure and completion callback failure preserve inspectable results', async (t) => {
  const { jobs } = fixture(t, async () => ({ ok: false, steps: [{ branch: 'a', ok: true }, { branch: 'b', ok: false }] }));
  const job = jobs.submit({ kind: 'stack-rebase', target: 'session' });
  await tick();
  assert.equal(jobs.get(job.id).status, 'failed');
  assert.equal(jobs.get(job.id).result.steps.length, 2);
  const other = fixture(t, async () => ({ workstream: { id: 42 } }), () => { throw new Error('terminal failed'); });
  const created = other.jobs.submit({ kind: 'create-scratchpad', body: { name: 'x' } });
  await tick();
  assert.equal(other.jobs.get(created.id).status, 'failed');
  assert.equal(other.jobs.get(created.id).result.workstream.id, 42);
});

test('shutdown drains an in-flight effect and completion callback before releasing resources', async (t) => {
  let settleEffect;
  let settleCompletion;
  const { jobs } = fixture(t, async (_intent, { signal }) => {
    await new Promise((resolve) => { settleEffect = resolve; });
    assert.equal(signal.aborted, true);
    return { ok: true };
  }, async () => { await new Promise((resolve) => { settleCompletion = resolve; }); });
  const running = jobs.submit({ kind: 'create-repo', body: { repository: 'example/project' } });
  const queued = jobs.submit({ kind: 'create-scratchpad', body: { name: 'queued' } });
  await tick();
  let drained = false;
  const drain = jobs.close().then(() => { drained = true; });
  assert.equal(jobs.get(queued.id).status, 'cancelled');
  assert.equal(jobs.get(running.id).status, 'cancel_requested');
  assert.throws(() => jobs.submit({ kind: 'create-scratchpad', body: { name: 'late' } }), /closed/);
  await tick();
  assert.equal(drained, false);
  settleEffect();
  await tick();
  assert.equal(drained, false);
  settleCompletion();
  await drain;
  assert.equal(drained, true);
  assert.equal(jobs.get(running.id).status, 'succeeded');
});

test('idempotent replay precedes fresh-state validation and queued work is validated again', async (t) => {
  let valid = true;
  let executions = 0;
  const { jobs, context } = fixture(t, async () => { executions++; return { ok: true }; });
  context.policy = { validate: () => { if (!valid) throw new Error('stale preview'); } };
  const intent = { kind: 'stack-rebase', target: 'session', body: { previewRevision: 'revision', confirm: true } };
  const job = jobs.submit(intent, { idempotencyKey: 'stable' });
  valid = false;
  assert.equal(jobs.submit(intent, { idempotencyKey: 'stable' }).id, job.id);
  assert.throws(() => jobs.submit(intent, { idempotencyKey: 'new-key' }), /stale preview/);
  await tick();
  assert.equal(executions, 0);
  assert.equal(jobs.get(job.id).status, 'failed');
  assert.match(jobs.get(job.id).error.message, /stale preview/);
});
