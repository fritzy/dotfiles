export const DEFAULT_TERMINAL_OUTPUT_BATCH_LIMIT = 256 * 1024;

export function createTerminalOutputBatch({
  write,
  schedule = requestAnimationFrame,
  cancel = cancelAnimationFrame,
  limit = DEFAULT_TERMINAL_OUTPUT_BATCH_LIMIT,
  onPendingChange = null,
} = {}) {
  let chunks = [];
  let size = 0;
  let frame = null;

  const reportPending = () => onPendingChange?.(size);

  const flush = () => {
    if (frame != null) {
      cancel(frame);
      frame = null;
    }
    if (!chunks.length) return false;
    const data = chunks.join('');
    chunks = [];
    size = 0;
    reportPending();
    write(data);
    return true;
  };

  const enqueue = (data) => {
    if (typeof data !== 'string' || data.length === 0) return;
    if (size > 0 && size + data.length > limit) flush();
    if (data.length >= limit) {
      write(data);
      return;
    }
    chunks.push(data);
    size += data.length;
    reportPending();
    if (frame == null) {
      frame = schedule(() => {
        frame = null;
        flush();
      });
    }
  };

  const clear = () => {
    if (frame != null) cancel(frame);
    frame = null;
    chunks = [];
    size = 0;
    reportPending();
  };

  return {
    clear,
    enqueue,
    flush,
    get pendingSize() { return size; },
  };
}
