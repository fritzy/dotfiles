import assert from 'node:assert/strict';
import test from 'node:test';

import { createTerminalOutputBatch } from '../web-v2/src/terminal-output-batch.js';

function fixture(limit = 1024) {
  const writes = [];
  const callbacks = new Map();
  const cancelled = [];
  let sequence = 0;
  const batch = createTerminalOutputBatch({
    write: (data) => writes.push(data),
    schedule: (callback) => {
      sequence += 1;
      callbacks.set(sequence, callback);
      return sequence;
    },
    cancel: (id) => {
      cancelled.push(id);
      callbacks.delete(id);
    },
    limit,
  });
  const runFrame = () => {
    const entry = callbacks.entries().next().value;
    if (!entry) return;
    callbacks.delete(entry[0]);
    entry[1]();
  };
  return {
    batch, callbacks, cancelled, runFrame, writes,
  };
}

test('terminal output in one animation frame is written once in byte order', () => {
  const { batch, callbacks, runFrame, writes } = fixture();
  batch.enqueue('one');
  batch.enqueue('-two');
  batch.enqueue('-three');
  assert.equal(callbacks.size, 1);
  assert.equal(batch.pendingSize, 13);
  runFrame();
  assert.deepEqual(writes, ['one-two-three']);
  assert.equal(batch.pendingSize, 0);
});

test('terminal output bound flushes older data before accepting more', () => {
  const { batch, runFrame, writes } = fixture(8);
  batch.enqueue('12345');
  batch.enqueue('6789');
  assert.deepEqual(writes, ['12345']);
  assert.equal(batch.pendingSize, 4);
  runFrame();
  assert.deepEqual(writes, ['12345', '6789']);

  batch.enqueue('oversized');
  assert.deepEqual(writes, ['12345', '6789', 'oversized']);
  assert.equal(batch.pendingSize, 0);
});

test('clearing a terminal output batch cancels its frame and drops hidden data', () => {
  const {
    batch, callbacks, cancelled, runFrame, writes,
  } = fixture();
  batch.enqueue('hidden output');
  batch.clear();
  assert.equal(callbacks.size, 0);
  assert.deepEqual(cancelled, [1]);
  assert.equal(batch.pendingSize, 0);
  runFrame();
  assert.deepEqual(writes, []);
});
