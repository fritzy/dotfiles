// Behavioral test for the combined Local/Workstation sidebar: unlike the rest
// of the web-v2 suite, this mounts the real App.jsx under jsdom so it catches a
// regression that unmounts a daemon pane (and drops that machine's terminals).
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actCall, dispatchKey, fakeModule, flush, mountReact, registerJsxLoader, setupJsdom, teardownJsdom,
} from './helpers/dom-react.js';

registerJsxLoader();
const localTerminalUrl = new URL('../web-v2/src/LocalTerminal.jsx', import.meta.url).href;
const fakeTerminalUrl = new URL('./helpers/FakeLocalTerminal.jsx', import.meta.url).href;
fakeModule(localTerminalUrl, `export { default } from ${JSON.stringify(fakeTerminalUrl)};`);

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
    if (path.includes('/browser/state')) {
      const workstation = path.startsWith('http://127.1.1.2');
      return {
        ok: true,
        json: async () => ({ state: { terminals: [{
          id: workstation ? 'terminal-workstation' : 'terminal-local',
          kind: 'terminal',
          label: workstation ? 'terminal 2' : 'terminal 1',
          fontSize: 14,
        }] } }),
      };
    }
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

const machineSection = (container, id) => container.querySelector(`[data-sidebar-target="${id}"]`);
const machineButton = (container, id) => machineSection(container, id)?.querySelector(':scope > button');
// jsdom 30 doesn't reflect the `inert` IDL property, only the attribute React
// actually sets (https://github.com/jsdom/jsdom mirrors browsers here only
// partially), so check presence of the attribute rather than `.inert`.
const isInert = (pane) => pane.hasAttribute('inert');

test('Local and Workstation sidebar groups expose their own mounted standalone sessions', async (t) => {
  const { container } = await harness(t);

  const panes = [...container.querySelectorAll('[data-daemon-pane]')];
  assert.equal(panes.length, 2, 'both Local and Workstation panes are mounted at once');
  assert.equal(panes.filter((pane) => !isInert(pane)).length, 1, 'exactly one pane is interactive at a time');

  const localPane = container.querySelector('[data-daemon-pane="local"]');
  const workstationPane = container.querySelector('[data-daemon-pane="workstation"]');
  assert.equal(isInert(localPane), false, 'Local is the pane shown on a fresh load');
  assert.equal(isInert(workstationPane), true, 'Workstation starts backgrounded, not torn down');

  assert.equal(container.querySelectorAll('aside[aria-label="FritzWorks sidebar"]').length, 1);
  assert.equal(container.querySelectorAll('h1').length, 1, 'the machines use one shared sidebar');
  const localSectionButton = machineButton(container, 'local');
  const workstationSectionButton = machineButton(container, 'workstation');
  assert.ok(localSectionButton, 'the shared sidebar has a Local section');
  assert.ok(workstationSectionButton, 'the shared sidebar has a Workstation section');
  assert.equal(localSectionButton.getAttribute('aria-expanded'), 'true');
  assert.equal(workstationSectionButton.getAttribute('aria-expanded'), 'false');

  assert.ok(localPane.querySelector('[data-standalone-sessions="local"]'));
  assert.ok(workstationPane.querySelector('[data-standalone-sessions="workstation"]'));
  assert.ok(localSectionButton.parentElement.querySelector('button[aria-label="New Local terminal"]'));
  assert.ok(localSectionButton.parentElement.querySelector('button[aria-label="Open Local Markdown"]'));
  assert.ok(workstationSectionButton.parentElement.querySelector('button[aria-label="New Workstation terminal"]'));
  assert.ok(workstationSectionButton.parentElement.querySelector('button[aria-label="Open Workstation Markdown"]'));
  assert.ok(localSectionButton.parentElement.querySelector('[data-sidebar-standalone="terminal-local"]'));
  assert.ok(workstationSectionButton.parentElement.querySelector('[data-sidebar-standalone="terminal-workstation"]'));
  assert.equal(localPane.querySelector('[data-fake-terminal]').dataset.terminalId, 'terminal-local');
  assert.equal(workstationPane.querySelector('[data-fake-terminal]').dataset.terminalId, 'terminal-workstation');

  await actCall(() => localSectionButton.parentElement
    .querySelector('[data-sidebar-standalone="terminal-local"] > button').click());
  await flush(20);
  assert.match(localPane.querySelector('[data-panel^="standalone-local-"]').dataset.panel, /^standalone-local-/);
  assert.equal(localSectionButton.parentElement
    .querySelector('[data-sidebar-standalone="terminal-local"] > button').getAttribute('aria-current'), 'true');

  await dispatchKey(localPane.querySelector('[data-fake-terminal]'), 'h');
  await flush(10);
  assert.equal(document.activeElement.dataset.panel, 'sidebar-local-sessions', 'Ctrl-H returns to the sidebar');
  await dispatchKey(document.activeElement, 'l');
  await flush(10);
  assert.equal(document.activeElement.dataset.terminalId, 'terminal-local', 'Ctrl-L re-enters the highlighted standalone session');

  await actCall(() => workstationSectionButton.click());
  await flush(100);

  const panesAfterSwitch = [...container.querySelectorAll('[data-daemon-pane]')];
  assert.equal(panesAfterSwitch.length, 2, 'switching targets did not unmount either pane');
  assert.equal(panesAfterSwitch[0], localPane, 'the Local pane is the same DOM node, not remounted');
  assert.equal(panesAfterSwitch[1], workstationPane, 'the Workstation pane is the same DOM node, not remounted');
  assert.equal(isInert(localPane), true, 'Local is now backgrounded');
  assert.equal(isInert(workstationPane), false, 'Workstation is now the interactive pane');
  assert.equal(machineButton(container, 'workstation').getAttribute('aria-expanded'), 'true');

  await actCall(() => machineButton(container, 'workstation').parentElement
    .querySelector('[data-sidebar-standalone="terminal-workstation"] > button').click());
  await flush(20);
  assert.match(workstationPane.querySelector('[data-panel^="standalone-workstation-"]').dataset.panel, /^standalone-workstation-/);

  await actCall(() => machineButton(container, 'workstation').click());
  assert.equal(machineButton(container, 'workstation').getAttribute('aria-expanded'), 'false');
  assert.equal(isInert(workstationPane), false, 'collapsing navigation keeps its terminals mounted and selected');
});
