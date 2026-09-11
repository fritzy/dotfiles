export const TERMINAL_DEBUG_STORAGE_KEY = 'fritzworks-terminal-debug';

const openSockets = new Set();
const encoder = new TextEncoder();

export function terminalDebugEnabled() {
  try {
    if (new URLSearchParams(globalThis.location?.search || '').get('terminalDebug') === '1') return true;
    return globalThis.localStorage?.getItem(TERMINAL_DEBUG_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function createTerminalDiagnostics(terminalId) {
  if (!terminalDebugEnabled()) {
    const noop = () => {};
    return {
      dispose: noop, output: noop, pending: noop, socketClosed: noop,
      socketOpened: noop, state: noop, write: noop,
    };
  }

  const token = {};
  let lifecycle = 'disconnected';
  let outputMessages = 0;
  let outputBytes = 0;
  let writeCalls = 0;
  let writeBytes = 0;
  let pendingBytes = 0;
  let socketOpen = false;

  const byteLength = (value) => encoder.encode(value).byteLength;
  const timer = setInterval(() => {
    console.debug('[FritzWorks terminal]', {
      terminalId,
      lifecycle,
      outputMessagesPerSecond: outputMessages,
      outputBytesPerSecond: outputBytes,
      writeCallsPerSecond: writeCalls,
      writeBytesPerSecond: writeBytes,
      pendingBatchSize: pendingBytes,
      browserTerminalSocketCount: openSockets.size,
    });
    outputMessages = 0;
    outputBytes = 0;
    writeCalls = 0;
    writeBytes = 0;
  }, 1000);

  return {
    dispose() {
      clearInterval(timer);
      openSockets.delete(token);
    },
    output(data) {
      outputMessages += 1;
      outputBytes += byteLength(data);
    },
    pending(size) { pendingBytes = size; },
    socketClosed() {
      socketOpen = false;
      openSockets.delete(token);
    },
    socketOpened() {
      if (socketOpen) return;
      socketOpen = true;
      openSockets.add(token);
    },
    state(value) { lifecycle = value; },
    write(data) {
      writeCalls += 1;
      writeBytes += byteLength(data);
    },
  };
}
