import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actCall, flush, fakeModule, mountReact, registerJsxLoader, setupJsdom, teardownJsdom,
} from './helpers/dom-react.js';

registerJsxLoader();

fakeModule(import.meta.resolve('@xterm/xterm'), `
  export class Terminal {
    constructor(options) {
      this.options = options;
      this.cols = 80;
      this.rows = 24;
      this.writes = [];
      this.focusCalls = 0;
      this.blurCalls = 0;
      this.parser = { registerOscHandler: () => ({ dispose() {} }) };
      globalThis.__localTerminalInstances.push(this);
    }
    loadAddon() {}
    open(host) {
      this.element = host;
      Object.defineProperty(host, 'clientWidth', { value: 800, configurable: true });
      Object.defineProperty(host, 'clientHeight', { value: 600, configurable: true });
    }
    attachCustomKeyEventHandler() {}
    onData(listener) { this.dataListener = listener; return { dispose: () => { this.dataListener = null; } }; }
    write(data) { this.writes.push(data); }
    writeln(data) { this.writes.push(data + '\\n'); }
    focus() { this.focusCalls += 1; }
    blur() { this.blurCalls += 1; }
    paste() {}
    hasSelection() { return false; }
    getSelection() { return ''; }
    dispose() { this.disposed = true; }
  }
`);
fakeModule(import.meta.resolve('@xterm/addon-fit'), `
  export class FitAddon { fit() { this.fitCalls = (this.fitCalls || 0) + 1; } }
`);
fakeModule(import.meta.resolve('@xterm/xterm/css/xterm.css'), '');

test('LocalTerminal suspends inactive attachments, batches output, and reconnects only when active', async (t) => {
  const dom = setupJsdom();
  t.after(() => teardownJsdom(dom));
  globalThis.__localTerminalInstances = [];

  class FakeWebSocket extends window.EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      super();
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      FakeWebSocket.instances.push(this);
    }

    open() {
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new window.Event('open'));
    }

    message(message) {
      this.dispatchEvent(new window.MessageEvent('message', { data: JSON.stringify(message) }));
    }

    send(data) { this.sent.push(JSON.parse(data)); }

    close() {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      this.dispatchEvent(new window.Event('close'));
    }
  }
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  t.after(() => {
    delete globalThis.WebSocket;
    delete globalThis.ResizeObserver;
    delete globalThis.__localTerminalInstances;
  });

  const React = await import('react');
  const { default: LocalTerminal } = await import('../web-v2/src/LocalTerminal.jsx');
  const render = (active) => React.createElement(LocalTerminal, {
    active,
    visible: active,
    terminalId: 'lifecycle-test',
    label: 'Lifecycle test terminal',
  });
  const mounted = await mountReact(render(false));
  assert.equal(FakeWebSocket.instances.length, 1);
  const firstSocket = FakeWebSocket.instances[0];
  assert.equal(new URL(firstSocket.url, 'http://localhost').searchParams.get('suspended'), '1');
  await actCall(() => firstSocket.open());
  await flush();
  assert.deepEqual(firstSocket.sent, [], 'an inactive terminal does not request an attachment');

  await mounted.update(render(true));
  assert.equal(firstSocket.sent.filter((message) => message.type === 'resume').length, 1);
  await mounted.update(render(true));
  assert.equal(
    firstSocket.sent.filter((message) => message.type === 'resume').length,
    1,
    'repeated active renders are idempotent',
  );
  await actCall(() => firstSocket.message({ type: 'claimed' }));
  await flush(10);
  assert.equal(firstSocket.sent.filter((message) => message.type === 'resize').length >= 1, true);
  const terminal = globalThis.__localTerminalInstances[0];
  assert.equal(terminal.options.cursorBlink, true);

  firstSocket.message({ type: 'output', data: 'one' });
  firstSocket.message({ type: 'output', data: '-two' });
  firstSocket.message({ type: 'output', data: '-three' });
  await flush(10);
  assert.deepEqual(terminal.writes, ['one-two-three']);

  await mounted.update(render(false));
  assert.equal(firstSocket.sent.filter((message) => message.type === 'suspend').length, 1);
  assert.equal(terminal.options.cursorBlink, false);
  firstSocket.message({ type: 'output', data: 'hidden' });
  await flush(10);
  assert.deepEqual(terminal.writes, ['one-two-three'], 'hidden output never reaches xterm');

  await actCall(() => firstSocket.close());
  await flush(10);
  assert.equal(FakeWebSocket.instances.length, 1, 'intentional suspension does not reconnect');
  firstSocket.message({ type: 'output', data: 'late' });
  await mounted.update(render(true));
  assert.equal(FakeWebSocket.instances.length, 2, 'reactivation reconnects a suspended closed socket');
  assert.deepEqual(terminal.writes, ['one-two-three'], 'late output from the old connection is ignored');
  await mounted.unmount();
});
