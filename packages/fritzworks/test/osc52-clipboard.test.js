import assert from 'node:assert/strict';
import test from 'node:test';

import { copyTerminalSelection } from '../web-v2/src/clipboard.js';
import { trackOsc52Clipboard } from '../web-v2/src/osc52-clipboard.js';
import { setupJsdom, teardownJsdom } from './helpers/dom-react.js';

function encode(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

test('Zellij OSC 52 selections are retained for later native and keyboard copy events', async () => {
  const dom = setupJsdom();
  try {
    const element = document.createElement('div');
    document.body.append(element);
    let osc52Handler;
    let disposed = false;
    const terminal = {
      element,
      getSelection: () => '',
      hasSelection: () => false,
      parser: {
        registerOscHandler(identifier, handler) {
          assert.equal(identifier, 52);
          osc52Handler = handler;
          return { dispose() { disposed = true; } };
        },
      },
    };
    const clipboard = trackOsc52Clipboard(terminal);
    assert.equal(osc52Handler(`c;${encode('Zellij sélection')}`), true);
    assert.equal(clipboard.text, 'Zellij sélection');

    let copiedText = null;
    const event = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { setData: (type, text) => { assert.equal(type, 'text/plain'); copiedText = text; } },
    });
    element.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    assert.equal(copiedText, 'Zellij sélection');

    copiedText = null;
    document.execCommand = () => {
      const keyCopyEvent = new Event('copy', { bubbles: true, cancelable: true });
      Object.defineProperty(keyCopyEvent, 'clipboardData', {
        value: { setData: (_type, text) => { copiedText = text; } },
      });
      element.dispatchEvent(keyCopyEvent);
      return keyCopyEvent.defaultPrevented;
    };
    assert.equal(await copyTerminalSelection(terminal, {
      fallbackText: clipboard.text,
      copyEventHandlesFallback: true,
      documentObject: document,
    }), true);
    assert.equal(copiedText, 'Zellij sélection');

    clipboard.dispose();
    assert.equal(disposed, true);
  } finally {
    teardownJsdom(dom);
  }
});

test('an xterm-local selection takes priority over retained OSC 52 text', () => {
  const dom = setupJsdom();
  try {
    const element = document.createElement('div');
    document.body.append(element);
    let osc52Handler;
    const terminal = {
      element,
      hasSelection: () => true,
      parser: {
        registerOscHandler(_identifier, handler) {
          osc52Handler = handler;
          return { dispose() {} };
        },
      },
    };
    const clipboard = trackOsc52Clipboard(terminal);
    osc52Handler(`c;${encode('older Zellij selection')}`);

    const event = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', {
      value: { setData: () => assert.fail('OSC 52 text must not replace an xterm selection') },
    });
    element.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false);
    clipboard.dispose();
  } finally {
    teardownJsdom(dom);
  }
});
