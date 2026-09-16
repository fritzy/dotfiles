import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actCall, dispatchKey, flush, mountReact, registerJsxLoader, setupJsdom, teardownJsdom,
} from './helpers/dom-react.js';

registerJsxLoader();

function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
}

test('Markdown path field completes with Tab and chooses ambiguous matches by keyboard', async (t) => {
  const dom = setupJsdom();
  const requests = [];
  globalThis.fetch = async (url) => {
    const path = String(url);
    requests.push(path);
    if (path === '/notes/files') {
      return { ok: true, json: async () => ({ files: [], weekly: [] }) };
    }
    const requested = new URL(path, 'http://localhost').searchParams.get('path');
    if (requested === '/tmp/pro') {
      return {
        ok: true,
        json: async () => ({
          completion: '/tmp/project/',
          matches: [{ path: '/tmp/project/', name: 'project', type: 'directory' }],
        }),
      };
    }
    if (requested === '/tmp/project/') {
      return {
        ok: true,
        json: async () => ({
          completion: '/tmp/project/',
          matches: [
            { path: '/tmp/project/README.md', name: 'README.md', type: 'file' },
            { path: '/tmp/project/RELEASE.md', name: 'RELEASE.md', type: 'file' },
          ],
        }),
      };
    }
    throw new Error(`unexpected request: ${path}`);
  };

  const React = await import('react');
  const { default: NotePicker } = await import('../web-v2/src/NotePicker.jsx');
  const mounted = await mountReact(React.createElement(NotePicker, {
    open: true,
    onClose() {},
    onOpenFile() {},
    openPaths: new Set(),
  }));
  t.after(async () => {
    await mounted.unmount();
    teardownJsdom(dom);
  });
  await flush();

  const input = mounted.container.querySelector('[aria-label="Markdown file path"]');
  await actCall(() => setInputValue(input, '/tmp/pro'));
  const firstTab = await dispatchKey(input, 'Tab', { ctrlKey: false });
  await flush();
  assert.equal(firstTab.defaultPrevented, true);
  assert.equal(input.value, '/tmp/project/');
  assert.match(mounted.container.textContent, /Directory completed/);

  await dispatchKey(input, 'Tab', { ctrlKey: false });
  await flush();
  assert.equal(mounted.container.querySelectorAll('[role="option"]').length, 2);
  assert.match(mounted.container.textContent, /2 matches/);

  await dispatchKey(input, 'ArrowDown', { ctrlKey: false });
  assert.equal(input.getAttribute('aria-activedescendant'), 'markdown-path-match-0');
  await dispatchKey(input, 'Enter', { ctrlKey: false });
  assert.equal(input.value, '/tmp/project/README.md');
  assert.equal(mounted.container.querySelectorAll('[role="option"]').length, 0);
  assert.match(mounted.container.textContent, /File completed/);
  assert.equal(requests.filter((path) => path.startsWith('/markdown/complete')).length, 2);
});
