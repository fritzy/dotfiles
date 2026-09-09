// Behavioral test for the Local/Workstation sidebar tabs: unlike the rest of the
// web-v2 suite, this actually mounts the real App.jsx (and therefore a real
// target switcher + two real DaemonPane instances) under jsdom, so a regression
// where switching targets reloads the page or unmounts the backgrounded
// pane's DOM (dropping its terminals) would be caught here, not just by
// reading source text.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actCall, flush, mountReact, registerJsxLoader, setupJsdom, teardownJsdom,
} from './helpers/dom-react.js';

registerJsxLoader();

class FakeWebSocket {
  constructor(url) { this.url = url; this.readyState = 0; }
  addEventListener() {}
  removeEventListener() {}
  send() {}
  close() { this.readyState = 3; }
}

function mockNetwork() {
  globalThis.WebSocket = FakeWebSocket;
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.startsWith('/daemons')) {
      return {
        ok: true,
        json: async () => ({ daemons: [{ id: 'workstation', name: 'Workstation', url: 'http://127.1.1.2:7337' }] }),
      };
    }
    if (path.includes('/ws/all/')) return { ok: true, json: async () => ({ items: [], total: 0 }) };
    if (path.includes('/notes/tabs')) return { ok: true, json: async () => ({ tabs: [], activePath: null }) };
    return { ok: true, json: async () => ({}) };
  };
}

async function harness(t) {
  const dom = setupJsdom();
  mockNetwork();
  t.after(() => teardownJsdom(dom));

  const React = await import('react');
  const { default: App } = await import('../web-v2/src/App.jsx');
  const mounted = await mountReact(React.createElement(App));
  // Longer than REFRESH_DEBOUNCE_MS (75ms) so both panes' debounced session-list
  // fetches settle before the test (and jsdom teardown) ends.
  await flush(100);
  return mounted;
}

const connectionTab = (container, name) => container.querySelector(`nav[aria-label="Connections"] button[aria-label^="Switch to ${name}"]`);
// ActiveSessionsSidebar renders exactly one <h1>FritzWorks</h1> per mounted
// DaemonPane, so its count is a direct proxy for how many panes exist in the DOM.
const brandHeadings = (container) => [...container.querySelectorAll('h1')].filter((h1) => h1.textContent === 'FritzWorks');
const paneOf = (h1) => h1.closest('.absolute.inset-0.min-h-screen.w-full');
// jsdom 30 doesn't reflect the `inert` IDL property, only the attribute React
// actually sets (https://github.com/jsdom/jsdom mirrors browsers here only
// partially), so check presence of the attribute rather than `.inert`.
const isInert = (pane) => pane.hasAttribute('inert');

test('Local and Workstation are separate always-mounted panes switched inside the sidebar', async (t) => {
  const { container } = await harness(t);

  const panes = brandHeadings(container).map(paneOf);
  assert.equal(panes.length, 2, 'both Local and Workstation panes are mounted at once');
  assert.equal(panes.filter((pane) => !isInert(pane)).length, 1, 'exactly one pane is interactive at a time');

  const [localPane, workstationPane] = panes;
  assert.equal(isInert(localPane), false, 'Local is the pane shown on a fresh load');
  assert.equal(isInert(workstationPane), true, 'Workstation starts backgrounded, not torn down');

  const localTab = connectionTab(localPane, 'Local');
  const workstationTab = connectionTab(localPane, 'Workstation');
  assert.ok(localTab, 'the sidebar shows a Local connection tab');
  assert.ok(workstationTab, 'the /daemons response added a Workstation connection tab');
  assert.ok(localTab.closest('aside[aria-label="FritzWorks sidebar"]'), 'connection tabs are inside the existing sidebar');
  const sidebarLandmarks = [...localPane.querySelectorAll('nav[aria-label="Connections"], h2')];
  assert.equal(sidebarLandmarks[0]?.getAttribute('aria-label'), 'Connections');
  assert.equal(sidebarLandmarks[1]?.textContent, 'Active & Paused');

  await actCall(() => workstationTab.click());
  await flush(100);

  const panesAfterSwitch = brandHeadings(container).map(paneOf);
  assert.equal(panesAfterSwitch.length, 2, 'switching targets did not unmount either pane');
  assert.equal(panesAfterSwitch[0], localPane, 'the Local pane is the same DOM node, not remounted');
  assert.equal(panesAfterSwitch[1], workstationPane, 'the Workstation pane is the same DOM node, not remounted');
  assert.equal(isInert(localPane), true, 'Local is now backgrounded');
  assert.equal(isInert(workstationPane), false, 'Workstation is now the interactive pane');
});
