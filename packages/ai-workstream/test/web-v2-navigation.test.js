// Behavioral tests for standalone-session keyboard navigation (Ctrl-H/J/K/L):
// unlike the rest of the web-v2 suite, these actually mount the real
// BottomTabs.jsx and MarkdownEditor.jsx (LocalTerminal is swapped for a
// lightweight stand-in — xterm/canvas aren't meaningful under jsdom, and its
// own Ctrl-key contract is already covered by source-pattern assertions in
// web-v2.test.js). Bugs where a tab is visually "brought up" but never
// actually receives keyboard focus can only be caught by inspecting
// document.activeElement after a real render, not by reading source text.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actCall, dispatchKey, fakeModule, flush, mountReact, registerJsxLoader, setupJsdom, teardownJsdom,
} from './helpers/dom-react.js';

registerJsxLoader();

const localTerminalUrl = new URL('../web-v2/src/LocalTerminal.jsx', import.meta.url).href;
const fakeTerminalUrl = new URL('./helpers/FakeLocalTerminal.jsx', import.meta.url).href;
fakeModule(localTerminalUrl, `export { default } from ${JSON.stringify(fakeTerminalUrl)};`);

function mockFetch(browserState = {}) {
  globalThis.fetch = async (url, options = {}) => {
    const path = String(url);
    if (path.includes('/browser/state')) {
      return { ok: true, json: async () => options.method === 'PUT' ? {} : { state: browserState } };
    }
    if (path.includes('/notes/tabs')) return { ok: true, json: async () => ({ tabs: [], activePath: null }) };
    if (path.includes('/notes/file')) {
      const parsed = new URL(path, 'http://localhost/');
      const notePath = parsed.searchParams.get('path');
      return { ok: true, json: async () => ({ content: `# ${notePath}\ncontent`, version: 1, todayHeading: '' }) };
    }
    return { ok: true, json: async () => ({}) };
  };
}

async function harness(t, { browserState = {} } = {}) {
  const dom = setupJsdom();
  mockFetch(browserState);
  t.after(() => teardownJsdom(dom));

  const React = await import('react');
  const { default: BottomTabsHarness } = await import('./helpers/BottomTabsHarness.jsx');
  const ref = React.createRef();
  const sidebarFocused = [];
  const sessionStates = [];
  const mounted = await mountReact(React.createElement(BottomTabsHarness, {
    ref, onSidebarFocus: () => { sidebarFocused.push(true); return true; },
    onSessionsChange: (state) => sessionStates.push(state),
  }));
  await flush(20);
  return { ref, sessionStates, sidebarFocused, ...mounted };
}

const fakeTerminals = (container) => [...container.querySelectorAll('[data-fake-terminal]')];
const textarea = (container) => container.querySelector('textarea');
const previewPane = (container) => container.querySelector('[aria-label$="markdown preview"]');

async function openNote(ref, path = '/notes/a.md') {
  await actCall(() => ref.current.openNote({ path, name: path.split('/').pop() }));
  await flush(20);
}

async function createTerminal(ref) {
  await actCall(() => ref.current.createTerminal());
  await flush(20);
}

async function togglePreview(container) {
  const button = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Preview');
  await actCall(() => button.click());
  await flush(20);
}

test('Ctrl-E toggles a Markdown tab between Edit and Preview', async (t) => {
  const { ref, container } = await harness(t);

  await openNote(ref);
  const editPane = textarea(container);
  const toPreview = await dispatchKey(editPane, 'e');
  assert.equal(toPreview.defaultPrevented, true, 'Ctrl-E must not reach the browser');
  assert.equal(textarea(container), null);
  assert.equal(document.activeElement, previewPane(container), 'Ctrl-E focuses Preview after switching to it');

  const toEdit = await dispatchKey(previewPane(container), 'e');
  assert.equal(toEdit.defaultPrevented, true, 'Ctrl-E is captured in Preview too');
  assert.equal(previewPane(container), null);
  assert.equal(document.activeElement, textarea(container), 'a second Ctrl-E returns focus to Edit');
});

test('remembered standalone terminals mount and reattach while no session is selected', async (t) => {
  const { container } = await harness(t, {
    browserState: {
      terminals: [
        { id: 'terminal-one', kind: 'terminal', label: 'terminal 1', fontSize: 13 },
        { id: 'terminal-two', kind: 'terminal', label: 'terminal 2', fontSize: 15 },
      ],
      displayedId: 'terminal-two',
    },
  });

  await flush(20);
  assert.deepEqual(
    fakeTerminals(container).map((terminal) => terminal.dataset.terminalId),
    ['terminal-one', 'terminal-two'],
    'all restored terminals mount, so each one attempts its Zellij claim',
  );
  assert.equal(container.querySelector('[data-standalone-sessions] > section').getAttribute('aria-hidden'), 'true');
});

test('a lone Markdown session regains keyboard focus in Edit and Preview mode', async (t) => {
  const { ref, container } = await harness(t);

  await openNote(ref);
  assert.equal(document.activeElement, textarea(container), 'opening the note focuses its textarea');

  // Simulate leaving for a workstream. The destination panel normally steals
  // focus, so blur explicitly before exercising the same imperative handoff.
  await actCall(() => ref.current.hide());
  await flush(20);
  await actCall(() => document.activeElement.blur());
  assert.notEqual(document.activeElement, textarea(container), 'focus actually left the note');

  await actCall(() => ref.current.focusLastUsed());
  await flush(20);
  assert.equal(document.activeElement, textarea(container), 'the only Markdown session is refocused in Edit mode');

  // Now the same round trip with the note left in Preview mode.
  await togglePreview(container);
  assert.equal(textarea(container), null, 'Preview mode has no textarea');
  assert.equal(document.activeElement, previewPane(container), 'toggling Preview while focused refocuses the preview pane');

  await actCall(() => ref.current.hide());
  await flush(20);
  await actCall(() => document.activeElement.blur());
  await actCall(() => ref.current.focusLastUsed());
  await flush(20);
  assert.equal(
    document.activeElement,
    previewPane(container),
    'the only Markdown session is refocused even when it is showing its Preview pane',
  );
});

test('Ctrl-H from a standalone terminal returns to the sidebar; J/K/L stay in place', async (t) => {
  const { ref, container, sidebarFocused } = await harness(t);

  await createTerminal(ref);
  const terminal = fakeTerminals(container)[0];
  assert.equal(document.activeElement, terminal, 'creating a terminal focuses it');

  for (const key of ['j', 'k', 'l']) {
    const event = await dispatchKey(terminal, key);
    assert.equal(event.defaultPrevented, true, `Ctrl-${key.toUpperCase()} must not reach the shell`);
    assert.deepEqual(sidebarFocused, []);
  }

  const event = await dispatchKey(terminal, 'h');
  assert.equal(event.defaultPrevented, true, 'Ctrl-H must not reach the shell');
  assert.deepEqual(sidebarFocused, [true], 'Ctrl-H hands the standalone session back to the left sidebar');
});

test('Ctrl-H returns Markdown Edit and Preview sessions to the sidebar', async (t) => {
  const { ref, container, sidebarFocused } = await harness(t);

  await openNote(ref);
  const edit = textarea(container);
  for (const key of ['j', 'k', 'l']) {
    const event = await dispatchKey(edit, key);
    assert.equal(event.defaultPrevented, true, `Ctrl-${key.toUpperCase()} must stay within the standalone editor`);
    assert.deepEqual(sidebarFocused, []);
  }
  await dispatchKey(edit, 'h');
  assert.deepEqual(sidebarFocused, [true]);

  await actCall(() => ref.current.focusLastUsed());
  await flush(20);
  await togglePreview(container);
  await dispatchKey(previewPane(container), 'h');
  assert.deepEqual(sidebarFocused, [true, true]);
});

test('standalone terminals split, navigate, fullscreen, rename, and minimize without stopping', async (t) => {
  const { ref, container, sessionStates, sidebarFocused } = await harness(t, {
    browserState: {
      terminals: [
        { id: 'terminal-one', kind: 'terminal', label: 'Alpha', fontSize: 13 },
        { id: 'terminal-two', kind: 'terminal', label: 'Beta', fontSize: 15 },
      ],
      displayedId: 'terminal-one',
    },
  });
  const visiblePanels = () => [...container.querySelectorAll('[data-panel^="standalone-local-terminal-"]')]
    .filter((panel) => panel.getAttribute('aria-hidden') === 'false');
  const terminal = (id) => container.querySelector(`[data-terminal-id="${id}"]`);

  await actCall(() => ref.current.activate('terminal-one'));
  await flush(20);
  const drop = new window.Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', {
    value: {
      getData: () => JSON.stringify({ targetId: 'local', terminalId: 'terminal-two' }),
    },
  });
  await actCall(() => container.querySelector('[data-standalone-terminal-group]').dispatchEvent(drop));
  await flush(20);
  assert.equal(drop.defaultPrevented, true);
  assert.equal(visiblePanels().length, 2, 'dropping a second terminal creates a visible split');

  await actCall(() => ref.current.activate('terminal-one'));
  await flush(20);
  assert.equal(visiblePanels().length, 2, 'selecting the first member restores the entire group');
  assert.equal(document.activeElement, terminal('terminal-one'));
  await dispatchKey(terminal('terminal-one'), 'l');
  await flush(20);
  assert.equal(document.activeElement, terminal('terminal-two'), 'Ctrl-L focuses the right terminal');
  await dispatchKey(terminal('terminal-two'), 'h');
  await flush(20);
  assert.equal(document.activeElement, terminal('terminal-one'), 'Ctrl-H focuses the left terminal');
  await dispatchKey(terminal('terminal-one'), 'h');
  assert.deepEqual(sidebarFocused, [true], 'Ctrl-H at the left boundary returns to the sidebar');

  await actCall(() => ref.current.activate('terminal-one'));
  await flush(20);
  await dispatchKey(terminal('terminal-one'), 'f');
  await flush(20);
  assert.equal(visiblePanels().length, 1, 'fullscreen suppresses the other group member');
  assert.equal(visiblePanels()[0].dataset.terminalFullscreen, 'true');
  await dispatchKey(terminal('terminal-one'), 'f');
  await flush(20);
  assert.equal(visiblePanels().length, 2, 'leaving fullscreen restores the group');

  await actCall(() => ref.current.activate('terminal-two'));
  await flush(20);
  const renameButton = container.querySelector('button[aria-label="Rename Beta"]');
  await actCall(() => renameButton.click());
  const renameInput = container.querySelector('input[aria-label="Rename Beta"]');
  await actCall(() => {
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setValue.call(renameInput, 'Build logs');
    renameInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await dispatchKey(renameInput, 'Enter', { ctrlKey: false });
  await flush(20);
  assert.equal(sessionStates.at(-1).items.find((item) => item.id === 'terminal-two').label, 'Build logs');

  const minimize = container.querySelector('button[aria-label="Minimize Build logs from split group"]');
  await actCall(() => minimize.click());
  await flush(20);
  assert.equal(visiblePanels().length, 1, 'minimizing dissolves a two-terminal group');
  assert.equal(fakeTerminals(container).length, 2, 'the minimized terminal remains mounted and running');
  assert.equal(sessionStates.at(-1).items.every((item) => !item.splitGroupId), true);

  await actCall(() => ref.current.groupTerminals('terminal-one', 'terminal-two', 'right'));
  await flush(20);
  assert.equal(visiblePanels().length, 2, 'sidebar-style terminal-to-terminal grouping displays the group');
  assert.equal(document.activeElement, terminal('terminal-one'), 'the dragged terminal becomes the focused group member');
});

test('restored split groups reject stale, duplicate, and excess members', async () => {
  const { normalizeTerminalSplitGroups } = await import('../web-v2/src/BottomTabs.jsx');
  assert.deepEqual(normalizeTerminalSplitGroups([
    { id: 'split-valid', members: ['one', 'two', 'three', 'four'], boundaries: [20, 60, 80] },
    { id: 'split-overlap', members: ['three', 'four'], boundaries: [50] },
    { id: 'split-stale', members: ['missing', 'four'], boundaries: [50] },
  ], ['one', 'two', 'three', 'four']), [{
    id: 'split-valid', members: ['one', 'two', 'three'], boundaries: [20, 60],
  }]);
});

test('session workspaces use the shared terminal panel navigation and fullscreen contract', async (t) => {
  const dom = setupJsdom();
  t.after(() => teardownJsdom(dom));
  const React = await import('react');
  const { default: SessionWorkspaceHarness } = await import('./helpers/SessionWorkspaceHarness.jsx');
  const sidebarFocused = [];
  const { container } = await mountReact(React.createElement(SessionWorkspaceHarness, {
    onSidebarFocus: () => sidebarFocused.push(true),
  }));
  await flush(20);
  const terminal = (id) => container.querySelector(`[data-terminal-id="${id}"]`);
  const visiblePanels = () => [...container.querySelectorAll('[data-panel^="workspace-local-workspace-test-"]')]
    .filter((panel) => panel.getAttribute('aria-hidden') === 'false');

  assert.equal(document.activeElement, terminal('workspace-shell'));
  await dispatchKey(terminal('workspace-shell'), 'l');
  await flush(20);
  assert.equal(document.activeElement, terminal('workspace-agent'));
  await dispatchKey(terminal('workspace-agent'), 'h');
  await flush(20);
  assert.equal(document.activeElement, terminal('workspace-shell'));
  await dispatchKey(terminal('workspace-shell'), 'h');
  assert.deepEqual(sidebarFocused, [true]);

  await dispatchKey(terminal('workspace-shell'), 'f');
  await flush(20);
  assert.equal(visiblePanels().length, 1);
  assert.equal(visiblePanels()[0].dataset.terminalFullscreen, 'true');
  await dispatchKey(terminal('workspace-shell'), 'f');
  await flush(20);
  assert.equal(visiblePanels().length, 2);
});
