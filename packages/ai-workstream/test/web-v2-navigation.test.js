// Behavioral tests for the bottom-drawer keyboard navigation (Ctrl-H/J/K/L):
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
  const mounted = await mountReact(React.createElement(BottomTabsHarness, {
    ref, onSidebarFocus: () => { sidebarFocused.push(true); return true; },
  }));
  await flush(20);
  return { ref, sidebarFocused, ...mounted };
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

test('remembered bottom terminals mount and reattach while the drawer stays closed', async (t) => {
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
  assert.equal(container.querySelector('[role="tabpanel"]').getAttribute('aria-hidden'), 'true');
});

test('a lone note tab regains real keyboard focus after Ctrl-J, in Edit and Preview mode', async (t) => {
  const { ref, container } = await harness(t);

  await openNote(ref);
  assert.equal(document.activeElement, textarea(container), 'opening the note focuses its textarea');

  // Simulate leaving to a workspace terminal: BottomTabs.hide() only updates its
  // own bookkeeping (nothing blurs the outgoing tab, same as the real app —
  // it's the destination panel's own focus effect that steals focus away), so
  // the blur has to be simulated explicitly to reach the precondition Ctrl-J
  // actually has to recover from. Then Ctrl-J is exactly what App.jsx calls:
  // bottomTabsRef.current.focusLastUsed().
  await actCall(() => ref.current.hide());
  await flush(20);
  await actCall(() => document.activeElement.blur());
  assert.notEqual(document.activeElement, textarea(container), 'focus actually left the note');

  await actCall(() => ref.current.focusLastUsed());
  await flush(20);
  assert.equal(document.activeElement, textarea(container), 'Ctrl-J must refocus the only tab, in Edit mode');

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
    'Ctrl-J must refocus the only tab even when it is showing its Preview pane',
  );
});

test('Ctrl-H/L move both focus and the visible tab consistently between a terminal and a note', async (t) => {
  const { ref, container } = await harness(t);

  await createTerminal(ref);
  const [terminal] = fakeTerminals(container);
  assert.equal(document.activeElement, terminal, 'creating a terminal focuses it');

  await openNote(ref);
  assert.equal(document.activeElement, textarea(container), 'opening a note focuses it');

  await dispatchKey(textarea(container), 'h');
  assert.equal(document.activeElement, terminal, 'Ctrl-H from the note must focus the adjacent terminal tab');

  await dispatchKey(terminal, 'l');
  assert.equal(document.activeElement, textarea(container), 'Ctrl-L from the terminal must focus the adjacent note tab');

  // Toggling Preview while the note is the focused tab must not strand focus.
  await togglePreview(container);
  assert.equal(document.activeElement, previewPane(container));

  await dispatchKey(previewPane(container), 'h');
  assert.equal(document.activeElement, terminal, 'Ctrl-H from a Preview-mode note must still reach the terminal');

  await dispatchKey(terminal, 'l');
  assert.equal(
    document.activeElement,
    previewPane(container),
    'Ctrl-L back into a note left in Preview mode must focus its preview pane, not leave focus stranded',
  );
});

test('Ctrl-H/L always target the immediately adjacent tab across a mixed strip', async (t) => {
  const { ref, container } = await harness(t);

  await createTerminal(ref);
  await openNote(ref);
  await createTerminal(ref);
  const [firstTerminal, secondTerminal] = fakeTerminals(container);
  assert.equal(document.activeElement, secondTerminal, 'the most recently created tab is focused');

  await dispatchKey(secondTerminal, 'h');
  assert.equal(document.activeElement, textarea(container), 'one step left from the last terminal must land on the note');

  await dispatchKey(textarea(container), 'h');
  assert.equal(document.activeElement, firstTerminal, 'one step left from the note must land on the first terminal');

  await dispatchKey(firstTerminal, 'l');
  assert.equal(document.activeElement, textarea(container), 'one step right from the first terminal must land back on the note');

  await dispatchKey(textarea(container), 'l');
  assert.equal(document.activeElement, secondTerminal, 'one step right from the note must land on the last terminal');
});

test('Ctrl-H at the first tab defers to the sidebar; Ctrl-L at the last tab is a no-op', async (t) => {
  const { ref, container, sidebarFocused } = await harness(t);

  await createTerminal(ref);
  await openNote(ref);
  const [terminal] = fakeTerminals(container);

  await dispatchKey(textarea(container), 'l');
  assert.equal(document.activeElement, textarea(container), 'there is nothing to the right of the last tab');

  await dispatchKey(textarea(container), 'h');
  assert.equal(document.activeElement, terminal);

  await dispatchKey(terminal, 'h');
  assert.equal(document.activeElement, terminal, 'there is nothing to the left of the first tab');
  assert.deepEqual(sidebarFocused, [true], 'Ctrl-H at the first tab hands off to the sidebar instead');
});
