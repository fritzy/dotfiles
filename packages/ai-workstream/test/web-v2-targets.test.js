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

function mockNetwork({ groupedLocal = false, panelModel = false, requests = [] } = {}) {
  globalThis.WebSocket = FakeWebSocket;
  globalThis.fetch = async (url) => {
    const path = String(url);
    requests.push(path);
    if (path.startsWith('/daemons')) {
      return {
        ok: true,
        json: async () => ({ daemons: [{ id: 'workstation', name: 'Workstation', url: 'http://127.1.1.2:7337' }] }),
      };
    }
    if (path.includes('/ws/all/')) {
      const items = panelModel ? [
        { id: 1, type: 'repo', repo: 'acme/project', branch: 'leaf', name: 'Leaf', status: 'paused', path: '/tmp/leaf' },
        { id: 2, type: 'repo', repo: 'acme/project', branch: 'notes', name: 'With notes', status: 'paused', path: '/tmp/notes' },
      ] : [];
      return { ok: true, json: async () => ({ items, total: items.length }) };
    }
    if (path.includes('/panel-layout') && panelModel) {
      return {
        ok: true,
        json: async () => ({
          version: 1,
          revision: 1,
          activeGroupId: null,
          groups: [
            {
              id: 'leaf-group', type: 'repository', ownerId: '1', label: 'Leaf', path: '/tmp/leaf', panels: [], resources: [],
            },
            {
              id: 'notes-group', type: 'repository', ownerId: '2', label: 'With notes', path: '/tmp/notes', panels: [],
              resources: [{ id: 'notes-resource', kind: 'markdown', value: '/tmp/notes/plan.md', label: 'Plan' }],
            },
          ],
        }),
      };
    }
    if (path.includes('/notes/tabs')) return { ok: true, json: async () => ({ tabs: [], activePath: null }) };
    if (path.includes('/browser/state')) {
      const workstation = path.startsWith('http://127.1.1.2');
      const localTerminals = groupedLocal ? [
        { id: 'terminal-right', kind: 'terminal', label: 'Right', fontSize: 14 },
        { id: 'terminal-loose', kind: 'terminal', label: 'Loose', fontSize: 14 },
        { id: 'terminal-left', kind: 'terminal', label: 'Left', fontSize: 14 },
      ] : [{
        id: 'terminal-local', kind: 'terminal', label: 'terminal 1', fontSize: 14,
      }];
      return {
        ok: true,
        json: async () => ({ state: workstation ? { terminals: [{
          id: 'terminal-workstation', kind: 'terminal', label: 'terminal 2', fontSize: 14,
        }] } : {
          terminals: localTerminals,
          groups: groupedLocal ? [{
            id: 'split-local', members: ['terminal-left', 'terminal-right'], boundaries: [50],
          }] : [],
          displayedId: groupedLocal ? 'terminal-right' : 'terminal-local',
        } }),
      };
    }
    return { ok: true, json: async () => ({}) };
  };
}

async function harness(t, options = {}) {
  const dom = setupJsdom();
  window.HTMLDialogElement.prototype.showModal ||= function showModal() {
    this.setAttribute('open', '');
  };
  mockNetwork(options);
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
  assert.ok(localSectionButton.querySelector('span[style*="/icons/local.svg"]'));
  assert.ok(workstationSectionButton.querySelector('span[style*="/icons/remote.svg"]'));
  assert.equal(localSectionButton.getAttribute('aria-expanded'), 'false');
  assert.equal(workstationSectionButton.getAttribute('aria-expanded'), 'false');

  await actCall(() => localSectionButton.click());
  await flush(20);
  assert.equal(machineButton(container, 'local').getAttribute('aria-expanded'), 'true');
  const localTerminalsGroup = localSectionButton.parentElement
    .querySelector('[data-sidebar-group="Terminals"]');
  assert.equal(localTerminalsGroup.getAttribute('aria-expanded'), 'false');
  await actCall(() => localTerminalsGroup.click());
  assert.equal(localTerminalsGroup.getAttribute('aria-expanded'), 'true');

  assert.ok(localPane.querySelector('[data-standalone-sessions="local"]'));
  assert.ok(workstationPane.querySelector('[data-standalone-sessions="workstation"]'));
  assert.ok(localSectionButton.parentElement.querySelector('button[aria-label="New repository session on Local"]'));
  assert.ok(localSectionButton.parentElement.querySelector('button[aria-label="New scratchpad session on Local"]'));
  assert.ok(localSectionButton.parentElement.querySelector('button[aria-label="New Local terminal"]'));
  assert.ok(localSectionButton.parentElement.querySelector('button[aria-label="Open Local Markdown"]'));
  assert.ok(workstationSectionButton.parentElement.querySelector('button[aria-label="New repository session on Workstation"]'));
  assert.ok(workstationSectionButton.parentElement.querySelector('button[aria-label="New scratchpad session on Workstation"]'));
  assert.ok(workstationSectionButton.parentElement.querySelector('button[aria-label="New Workstation terminal"]'));
  assert.ok(workstationSectionButton.parentElement.querySelector('button[aria-label="Open Workstation Markdown"]'));
  assert.ok(localSectionButton.parentElement.querySelector('[data-sidebar-standalone="terminal-local"]'));
  assert.ok(workstationSectionButton.parentElement.querySelector('[data-sidebar-standalone="terminal-workstation"]'));
  assert.equal(localPane.querySelector('[data-fake-terminal]').dataset.terminalId, 'terminal-local');
  assert.equal(workstationPane.querySelector('[data-fake-terminal]').dataset.terminalId, 'terminal-workstation');
  const localHeaderTarget = localPane.querySelector('[data-panel] span[aria-label="Working on Local"]');
  const workstationHeaderTarget = workstationPane.querySelector('[data-panel] span[aria-label="Working on Workstation"]');
  assert.ok(localHeaderTarget?.getAttribute('style').includes('/icons/local.svg'));
  assert.ok(workstationHeaderTarget?.getAttribute('style').includes('/icons/remote.svg'));

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

test('session creation controls select and open on their owning machine', async (t) => {
  const requests = [];
  const { container } = await harness(t, { requests });
  const workstationSection = machineSection(container, 'workstation');

  assert.equal(
    container.querySelector('h1').parentElement.parentElement
      .querySelector('button[aria-label^="New repository session"]'),
    null,
    'session creation controls are no longer global header actions',
  );

  await actCall(() => workstationSection
    .querySelector('button[aria-label="New repository session on Workstation"]').click());
  await flush(20);

  assert.equal(
    isInert(container.querySelector('[data-daemon-pane="workstation"]')),
    false,
    'the owning remote becomes the active machine',
  );
  assert.equal(container.querySelector('dialog h2')?.textContent, 'New repository session');
  assert.ok(
    requests.includes('http://127.1.1.2:7337/ws/new'),
    'the creation modal loads defaults from the owning remote',
  );
});

test('the sidebar orders and links split terminals and can minimize one without closing it', async (t) => {
  const { container } = await harness(t, { groupedLocal: true });
  const localSection = machineSection(container, 'local');
  const rows = () => [...localSection.querySelectorAll('[data-sidebar-standalone]')];

  assert.deepEqual(
    rows().map((row) => row.dataset.sidebarStandalone),
    ['terminal-left', 'terminal-right', 'terminal-loose'],
    'split members are contiguous and follow their left-to-right pane order',
  );
  assert.deepEqual(
    rows().map((row) => row.dataset.terminalGroupPosition || null),
    ['start', 'end', null],
    'the first and last rows expose the connected-group rail endpoints',
  );
  assert.equal(localSection.querySelectorAll('button[aria-label^="Minimize "]').length, 2);

  await actCall(() => localSection
    .querySelector('button[aria-label="Minimize Left from split group"]').click());
  await flush(20);

  assert.equal(localSection.querySelectorAll('[data-standalone-split-group]').length, 0);
  assert.equal(localSection.querySelectorAll('button[aria-label^="Minimize "]').length, 0);
  assert.equal(
    container.querySelectorAll('[data-daemon-pane="local"] [data-fake-terminal]').length,
    3,
    'removing the pane from its split leaves every terminal mounted and running',
  );
});

test('sidebar tree expansion survives a client remount in local storage', async (t) => {
  const first = await harness(t);
  await actCall(() => machineButton(first.container, 'local').click());
  const terminals = machineSection(first.container, 'local')
    .querySelector('[data-sidebar-group="Terminals"]');
  await actCall(() => terminals.click());
  await flush(20);

  const stored = JSON.parse(localStorage.getItem('ai-workstream-sidebar-tree'));
  assert.deepEqual(stored.targets, ['local']);
  assert.deepEqual(stored.groups, ['group:local:standalone:Terminals']);

  await first.unmount();
  const React = await import('react');
  const { default: App } = await import('../web-v2/src/App.jsx');
  const second = await mountReact(React.createElement(App));
  await flush(100);

  assert.equal(machineButton(second.container, 'local').getAttribute('aria-expanded'), 'true');
  assert.equal(
    machineSection(second.container, 'local')
      .querySelector('[data-sidebar-group="Terminals"]').getAttribute('aria-expanded'),
    'true',
  );
  assert.equal(machineButton(second.container, 'workstation').getAttribute('aria-expanded'), 'false');
  await second.unmount();
});

test('panel-group leaves have no tree control and populated groups start collapsed', async (t) => {
  const { container } = await harness(t, { panelModel: true });
  const localSectionButton = machineButton(container, 'local');
  assert.equal(localSectionButton.getAttribute('aria-expanded'), 'false');
  await actCall(() => localSectionButton.click());

  const collection = machineSection(container, 'local')
    .querySelector('[data-sidebar-group="acme/project"]');
  assert.equal(collection.getAttribute('aria-expanded'), 'false');
  await actCall(() => collection.click());

  const leaf = container.querySelector('[data-sidebar-panel-group="leaf-group"]');
  assert.ok(leaf);
  assert.equal(leaf.querySelector('button[aria-label="Expand Leaf"]'), null);
  assert.equal(leaf.querySelector('button[aria-label="Collapse Leaf"]'), null);

  const populated = container.querySelector('[data-sidebar-panel-group="notes-group"]');
  const populatedTreeControl = populated.querySelector('button[aria-label="Expand With notes"]');
  assert.ok(populatedTreeControl);
  assert.equal(populatedTreeControl.getAttribute('aria-expanded'), 'false');
});
