import { parentPort, workerData } from 'node:worker_threads';
import { spawnSync } from 'node:child_process';
import { createApplicationContext } from './context.js';
import { executeStack } from './stack-operations.js';

const flag = new Int32Array(workerData.cancellation);
const signal = { get aborted() { return Atomics.load(flag, 0) !== 0; } };
const progress = (value) => parentPort.postMessage({ type: 'progress', value });
let context;
try {
  const runProcess = (executable, args, options) => {
    const operation = args.find((arg) => ['clone', 'fetch', 'worktree', 'rebase', 'push', 'link'].includes(arg)) || args[0];
    progress({ stage: 'process-started', executable, operation });
    const result = spawnSync(executable, args, options);
    progress({ stage: 'process-finished', executable, operation, status: result.status, error: result.error?.message });
    return result;
  };
  context = createApplicationContext({ config: workerData.config, jobWorker: true, runProcess });
  const intent = workerData.intent;
  if (signal.aborted) throw Object.assign(new Error('Cancelled before execution'), { name: 'AbortError' });
  context.policy.validate(intent, intent.body?.previewRevision, { confirm: intent.body?.confirm });
  progress({ stage: 'executing', kind: intent.kind });
  let result;
  switch (intent.kind) {
    case 'create-repo': result = context.operations.createRepo(intent.body || {}); break;
    case 'create-scratchpad': result = context.operations.createScratchpad(intent.body || {}); break;
    case 'action': result = context.operations.execute(intent.target, intent.command, intent.body || {}); break;
    case 'stack-rebase': case 'stack-link': result = executeStack(context, intent, { signal, progress }); break;
    default: throw new Error('Unsupported job intent');
  }
  parentPort.postMessage({ type: 'result', value: result });
} catch (error) {
  parentPort.postMessage({ type: 'error', value: { name: error.name, message: error.message, status: error.status, details: error.details, partialResult: error.partialResult } });
} finally {
  context?.close();
}
