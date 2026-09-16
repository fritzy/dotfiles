import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actCall, dispatchKey, fakeModule, mountReact, registerJsxLoader, setupJsdom, teardownJsdom,
} from './helpers/dom-react.js';

registerJsxLoader();
fakeModule(new URL('../web-v2/src/LocalTerminal.jsx', import.meta.url).href, 'export default function LocalTerminal() { return null; }');

test('header files dropdown tracks panels, opens files, and keeps link removal separate', async (t) => {
  const dom = setupJsdom();
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 1600, height: 900, top: 0, left: 0, right: 1600, bottom: 900 });
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method });
    return { ok: true, json: async () => ({ revision: 2 }) };
  };
  const React = await import('react');
  const { default: GroupWorkspace } = await import('../web-v2/src/GroupWorkspace.jsx');
  const resources = [
    { id: 'link', kind: 'link', label: 'Docs', value: 'https://example.com', disassociate: true },
    { id: 'plan', kind: 'markdown', label: 'Plan', value: '/repo/plan.md', discovered: true },
    { id: 'preview', kind: 'html', label: 'Preview', value: '/repo/preview.html', disassociate: true },
    { id: 'notes', kind: 'markdown', label: 'Notes', value: '/repo/notes.md', disassociate: true },
  ];
  const panels = [
    { id: 'plan-panel', kind: 'markdown', resourceId: 'plan', label: 'Plan', width: 1, minimized: true },
    { id: 'preview-panel', kind: 'iframe', resourceId: 'preview', label: 'Preview', width: 1, minimized: false },
  ];
  const focused = [];
  const render = (nextPanels = panels) => React.createElement(GroupWorkspace, {
    group: { id: 'session-1', type: 'repository', label: 'Session', resources, panels: nextPanels },
    revision: 1, target: { id: 'local', url: null }, onRefresh: async () => {},
    onPanelFocus: (id) => focused.push(id),
  });
  const mounted = await mountReact(render());
  t.after(async () => {
    await mounted.unmount();
    globalThis.fetch = originalFetch;
    teardownJsdom(dom);
  });
  const { container } = mounted;
  const header = container.querySelector('header');
  const trigger = header.querySelector('[aria-expanded]');
  const list = () => header.querySelector('[aria-label="Associated files"]');
  const fileButton = (label) => [...list().querySelectorAll('button')].find((button) => button.querySelector('.font-semibold')?.textContent === label);
  assert.equal(trigger.textContent, 'Files (3)');
  assert.equal(list(), null);
  assert.ok(header.textContent.includes('Docs'));
  assert.ok(!header.textContent.includes('Plan'));
  const removeLink = header.querySelector('[aria-label="Disassociate Docs"]');
  assert.equal(removeLink.textContent, '');
  assert.ok(removeLink.querySelector('svg'));

  await actCall(() => trigger.click());
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(list().id, trigger.getAttribute('aria-controls'));
  assert.equal(list().children.length, 3);
  assert.match(fileButton('Plan').textContent, /Minimized$/);
  assert.match(fileButton('Preview').textContent, /Open$/);
  assert.doesNotMatch(fileButton('Notes').textContent, /Open|Minimized/);
  assert.equal(list().querySelector('[aria-label="Disassociate Plan"]'), null);

  await actCall(() => fileButton('Preview').click());
  assert.deepEqual(focused, ['group-panel-local-preview-panel']);
  assert.equal(requests.length, 0, 'an open file focuses its existing panel');
  assert.equal(list(), null);
  await actCall(() => trigger.click());
  await actCall(() => fileButton('Plan').click());
  assert.equal(requests.at(-1).url, '/panel-layout/resources/plan/open');
  await actCall(() => trigger.click());
  await actCall(() => fileButton('Notes').click());
  assert.equal(requests.at(-1).url, '/panel-layout/resources/notes/open');

  await actCall(() => trigger.click());
  await mounted.update(render(panels.map((panel) => ({ ...panel, minimized: true }))));
  assert.match(fileButton('Preview').textContent, /Minimized$/);
  await mounted.update(render([]));
  assert.doesNotMatch(fileButton('Preview').textContent, /Open|Minimized/);

  await actCall(() => fileButton('Notes').focus());
  await dispatchKey(document.activeElement, 'Escape', { ctrlKey: false });
  assert.equal(list(), null);
  assert.equal(document.activeElement, trigger);
  await actCall(() => trigger.click());
  await actCall(() => document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true })));
  assert.equal(list(), null);
  await actCall(() => trigger.click());
  await actCall(() => fileButton('Notes').focus());
  await actCall(() => removeLink.focus());
  assert.equal(list(), null, 'moving keyboard focus outside dismisses the dropdown');

  await actCall(() => removeLink.click());
  assert.deepEqual(requests.at(-1), { url: '/panel-layout/resources/link/disassociate', method: 'POST' });
  await actCall(() => trigger.click());
  await actCall(() => list().querySelector('[aria-label="Disassociate Notes"]').click());
  assert.deepEqual(requests.at(-1), { url: '/panel-layout/resources/notes/disassociate', method: 'POST' });
});
