import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { ApiError } from './operation-error.js';

const kinds = new Set(['create-repo', 'create-scratchpad', 'action', 'stack-rebase', 'stack-link']);
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const stamp = () => new Date().toISOString();
const errorInfo = (error) => ({ message: error.message, status: error.status, details: error.details });

function runWorker(context, intent, { signal, progress }) {
  return new Promise((resolve, reject) => {
    const cancellation = new SharedArrayBuffer(4);
    const flag = new Int32Array(cancellation);
    const abort = () => Atomics.store(flag, 0, 1);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const worker = new Worker(new URL('./job-worker.js', import.meta.url), {
      workerData: { config: context.config, intent, cancellation },
    });
    let settled = false;
    let response;
    let workerError;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(result);
    };
    worker.on('message', (message) => {
      if (message.type === 'progress') progress(message.value);
      if (message.type === 'result') response = message.value;
      if (message.type === 'error') workerError = Object.assign(new Error(message.value.message), message.value);
    });
    worker.on('error', (error) => finish(error));
    worker.on('exit', (code) => finish(workerError || (code !== 0 || response === undefined ? new Error(`job worker exited before returning a result (${code})`) : null), response));
  });
}

export function createJobs(context) {
  const { db } = context;
  db.exec(`CREATE TABLE IF NOT EXISTS operation_jobs (
    id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE, payload_hash TEXT NOT NULL,
    intent_json TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, error_json TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS operation_job_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, at TEXT NOT NULL, event_json TEXT NOT NULL
  )`);
  let closed = false;
  let closing = false;
  let draining;
  let resolveDrain;
  let running = null;
  let scheduled = false;
  const controllers = new Map();
  const event = (id, value) => {
    if (closed) return;
    db.prepare('INSERT INTO operation_job_events (job_id,at,event_json) VALUES (?,?,?)').run(id, stamp(), JSON.stringify(value));
    context.publish?.({ type: 'job', jobId: id });
  };
  for (const row of db.prepare("SELECT id,status FROM operation_jobs WHERE status IN ('queued','running','cancel_requested')").all()) {
    db.prepare("UPDATE operation_jobs SET status='interrupted', updated_at=?, error_json=? WHERE id=?")
      .run(stamp(), JSON.stringify({ message: 'Daemon stopped before completion. Inspect progress and external state before retrying; effects were not rolled back.' }), row.id);
    event(row.id, { status: 'interrupted', previousStatus: row.status });
  }
  const project = (row) => row ? {
    id: row.id, idempotencyKey: row.idempotency_key, intent: JSON.parse(row.intent_json), status: row.status,
    result: row.result_json ? JSON.parse(row.result_json) : null, error: row.error_json ? JSON.parse(row.error_json) : null,
    createdAt: row.created_at, updatedAt: row.updated_at,
    progress: db.prepare('SELECT sequence,at,event_json FROM operation_job_events WHERE job_id=? ORDER BY sequence').all(row.id)
      .map(({ sequence, at, event_json }) => ({ sequence, at, ...JSON.parse(event_json) })),
  } : null;
  const get = (id) => {
    const result = project(db.prepare('SELECT * FROM operation_jobs WHERE id=?').get(id));
    if (!result) throw new ApiError(404, 'job not found');
    return result;
  };
  const change = (id, status, result, error) => {
    if (closed) return;
    db.prepare('UPDATE operation_jobs SET status=?,updated_at=?,result_json=?,error_json=? WHERE id=?')
      .run(status, stamp(), result === undefined ? null : JSON.stringify(result), error ? JSON.stringify(errorInfo(error)) : null, id);
    event(id, { status });
  };
  const pump = async () => {
    scheduled = false;
    if (closed || closing || running) return;
    const row = db.prepare("SELECT * FROM operation_jobs WHERE status='queued' ORDER BY created_at,rowid LIMIT 1").get();
    if (!row) return;
    running = row.id;
    const controller = new AbortController();
    controllers.set(row.id, controller);
    const intent = JSON.parse(row.intent_json);
    change(row.id, 'running');
    let result;
    try {
      context.policy?.validate(intent, intent.body?.previewRevision, { confirm: intent.body?.confirm });
      const execute = context.adapters?.runJob || ((value, options) => runWorker(context, value, options));
      result = await execute(intent, { signal: controller.signal, progress: (value) => event(row.id, value) });
      if (!closed) await context.jobCompleted?.(result, intent);
      const failed = result?.ok === false;
      change(row.id, failed ? 'failed' : 'succeeded', result, failed ? new Error('Operation stopped; inspect the partial result before retrying.') : undefined);
    } catch (error) {
      change(row.id, error.name === 'AbortError' ? 'cancelled' : 'failed', error.partialResult ?? result, error);
    } finally {
      controllers.delete(row.id);
      running = null;
      if (closing) { closed = true; resolveDrain?.(); }
      else if (!closed) schedule();
    }
  };
  const schedule = () => {
    if (closed || closing || scheduled) return;
    scheduled = true;
    setImmediate(pump);
  };
  const submit = (intent, { idempotencyKey } = {}) => {
    if (closed || closing) throw new ApiError(503, 'job service is closed');
    if (!intent || !kinds.has(intent.kind)) throw new ApiError(400, 'unsupported job intent');
    if (idempotencyKey != null && (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 200)) throw new ApiError(400, 'invalid idempotency key');
    const payload = JSON.stringify(canonical(intent));
    if (payload.length > 1024 * 1024) throw new ApiError(413, 'job intent is too large');
    const digest = createHash('sha256').update(payload).digest('hex');
    if (idempotencyKey) {
      const prior = db.prepare('SELECT * FROM operation_jobs WHERE idempotency_key=?').get(idempotencyKey);
      if (prior) {
        if (prior.payload_hash !== digest) throw new ApiError(409, 'idempotency key was already used for a different intent');
        return project(prior);
      }
    }
    context.policy?.validate(intent, intent.body?.previewRevision, { confirm: intent.body?.confirm });
    const id = randomUUID();
    const time = stamp();
    db.prepare(`INSERT INTO operation_jobs (id,idempotency_key,payload_hash,intent_json,status,created_at,updated_at)
      VALUES (?,?,?,?,'queued',?,?)`).run(id, idempotencyKey || null, digest, payload, time, time);
    event(id, { status: 'queued' });
    schedule();
    return get(id);
  };
  const cancel = (id) => {
    const job = get(id);
    if (job.status === 'queued') change(id, 'cancelled');
    else if (job.status === 'running') {
      change(id, 'cancel_requested');
      controllers.get(id)?.abort();
      event(id, { message: 'Cancellation requested between effects. An in-flight Git operation is allowed to settle; completed effects are preserved.' });
    }
    return get(id);
  };
  return { submit, get, list: () => db.prepare('SELECT * FROM operation_jobs ORDER BY created_at DESC,rowid DESC').all().map(project), cancel,
    close: () => {
      if (closed || closing) return draining;
      closing = true;
      for (const row of db.prepare("SELECT id FROM operation_jobs WHERE status='queued'").all()) cancel(row.id);
      if (!running) { closed = true; return; }
      draining = new Promise((resolve) => { resolveDrain = resolve; });
      cancel(running);
      return draining;
    },
  };
}
