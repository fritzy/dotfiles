import assert from 'node:assert/strict';
import test from 'node:test';

import { copyTerminalSelection, writeClipboardText } from '../web-v2/src/clipboard.js';
import { setupJsdom, teardownJsdom } from './helpers/dom-react.js';

test('clipboard writes use the asynchronous browser API when it is available', async () => {
  const writes = [];
  const documentObject = { execCommand() { throw new Error('legacy copy should not run'); } };

  assert.equal(await writeClipboardText('selected text', {
    navigatorObject: { clipboard: { writeText: async (text) => { writes.push(text); } } },
    documentObject,
  }), true);
  assert.deepEqual(writes, ['selected text']);
});

test('clipboard writes fall back to execCommand and restore terminal focus', async () => {
  const dom = setupJsdom();
  try {
    const terminalInput = document.createElement('textarea');
    document.body.append(terminalInput);
    terminalInput.focus();
    let copiedText = null;
    document.execCommand = (command) => {
      assert.equal(command, 'copy');
      copiedText = document.activeElement.value;
      return true;
    };

    assert.equal(await writeClipboardText('remote terminal selection', {
      navigatorObject: {},
      documentObject: document,
    }), true);
    assert.equal(copiedText, 'remote terminal selection');
    assert.equal(document.activeElement, terminalInput);
    assert.equal(document.querySelectorAll('[aria-hidden="true"]').length, 0);
  } finally {
    teardownJsdom(dom);
  }
});

test('clipboard writes fall back when the asynchronous API rejects', async () => {
  const dom = setupJsdom();
  try {
    let copyCommands = 0;
    document.execCommand = () => { copyCommands += 1; return true; };

    assert.equal(await writeClipboardText('permission fallback', {
      navigatorObject: { clipboard: { writeText: async () => { throw new Error('denied'); } } },
      documentObject: document,
    }), true);
    assert.equal(copyCommands, 1);
  } finally {
    teardownJsdom(dom);
  }
});

test('terminal copying synchronously invokes the native xterm copy event', async () => {
  const dom = setupJsdom();
  try {
    const terminalElement = document.createElement('div');
    const terminalInput = document.createElement('textarea');
    terminalElement.append(terminalInput);
    document.body.append(terminalElement);
    terminalInput.focus();

    let copiedText = null;
    terminalElement.addEventListener('copy', (event) => {
      event.clipboardData.setData('text/plain', 'xterm selection');
      event.preventDefault();
    });
    document.execCommand = (command) => {
      assert.equal(command, 'copy');
      const copyEvent = new Event('copy', { bubbles: true, cancelable: true });
      Object.defineProperty(copyEvent, 'clipboardData', {
        value: { setData: (type, text) => { assert.equal(type, 'text/plain'); copiedText = text; } },
      });
      terminalInput.dispatchEvent(copyEvent);
      return copyEvent.defaultPrevented;
    };

    assert.equal(await copyTerminalSelection({ getSelection: () => 'xterm selection' }, {
      navigatorObject: { clipboard: { writeText: () => { throw new Error('should not run'); } } },
      documentObject: document,
    }), true);
    assert.equal(copiedText, 'xterm selection');
    assert.equal(document.activeElement, terminalInput);
  } finally {
    teardownJsdom(dom);
  }
});

test('terminal copying uses retained Zellij text when xterm has no selection', async () => {
  const writes = [];
  assert.equal(await copyTerminalSelection({ getSelection: () => '' }, {
    fallbackText: 'Zellij selection',
    navigatorObject: { clipboard: { writeText: async (text) => { writes.push(text); } } },
    documentObject: { execCommand: () => assert.fail('xterm copy must not run without an xterm selection') },
  }), true);
  assert.deepEqual(writes, ['Zellij selection']);
});
