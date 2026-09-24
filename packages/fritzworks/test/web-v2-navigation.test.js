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
  actCall, dispatchKey, fakeModule, flush, mountReact as mountDom, registerJsxLoader, setupJsdom, teardownJsdom,
} from './helpers/dom-react.js';

registerJsxLoader();

const localTerminalUrl = new URL('../web-v2/src/LocalTerminal.jsx', import.meta.url).href;
const fakeTerminalUrl = new URL('./helpers/FakeLocalTerminal.jsx', import.meta.url).href;
fakeModule(localTerminalUrl, `export { default } from ${JSON.stringify(fakeTerminalUrl)};`);

let mountedViews = [];
function setupDom(t) {
  const dom = setupJsdom();
  const views = [];
  mountedViews = views;
  const previousFetch = globalThis.fetch;
  t.after(async () => {
    for (const view of views) await view.unmount();
    globalThis.fetch = previousFetch;
    teardownJsdom(dom);
  });
  return dom;
}
async function mountReact(element) {
  const view = await mountDom(element);
  let closed = false;
  const unmount = view.unmount;
  view.unmount = async () => { if (!closed) { closed = true; await unmount(); } };
  mountedViews.push(view);
  return view;
}
function setMockFetch(handler) {
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/capabilities')) return { ok: true, json: async () => ({ protocolVersion: 1, instanceId: 'local-instance', contracts: ['instance-bound-v1'], features: { terminals: { available: true }, jobs: { available: true } } }) };
    if (url === '/daemons') return { ok: true, json: async () => ({ daemons: [] }) };
    return handler(url, options);
  };
}

function mockFetch(browserState = {}) {
  setMockFetch(async (url, options = {}) => {
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
  });
}

async function harness(t, { browserState = {} } = {}) {
  const dom = setupDom(t);
  mockFetch(browserState);

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

test('Markdown and HTML association open only when requested in the dialog', async (t) => {
  const dom = setupDom(t);
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  const requests = [];
  setMockFetch(async (url, options = {}) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, json: async () => ({ revision: 8 }) };
  });
  const React = await import('react');
  const { default: GroupWorkspace } = await import('../web-v2/src/GroupWorkspace.jsx');
  const mounted = await mountReact(React.createElement(GroupWorkspace, {
    group: { id: 'session-1', type: 'repository', ownerId: '1', label: 'Session', path: '/tmp', resources: [], panels: [] },
    revision: 7, target: { id: 'local', name: 'Local', url: null },
    onRefresh: async () => {},
  }));
  const { container } = mounted;
  for (const [kind, name, value, open] of [
    ['markdown', 'Markdown', 'plan.md', false], ['markdown', 'Markdown', 'plan.md', true],
    ['html', 'HTML', 'preview.html', false], ['html', 'HTML', 'preview.html', true],
  ]) {
    await actCall(() => container.querySelector(`[aria-label="Associate ${name} panel"]`).click());
    const checkbox = container.querySelector('input[type="checkbox"]');
    assert.equal(checkbox.checked, false, 'each association starts with opening disabled');
    const input = container.querySelector('dialog input:not([type="checkbox"])');
    await actCall(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    if (open) await actCall(() => checkbox.click());
    await actCall(() => container.querySelector('form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));
    await flush();
    assert.equal(container.querySelector('dialog'), null);
    assert.equal(requests.at(-1).url, '/panel-layout/groups/session-1/resources');
    const { client, ...body } = requests.at(-1).body;
    assert.ok(client);
    assert.deepEqual(body, { revision: 7, kind, value, open });
  }
});

test('a terminal group can be renamed from its workspace header', async (t) => {
  const dom = setupDom(t);
  const requests = [];
  setMockFetch(async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return { ok: true, json: async () => ({ ok: true, revision: 8 }) };
  });

  const React = await import('react');
  const { default: GroupWorkspace } = await import('../web-v2/src/GroupWorkspace.jsx');
  const group = {
    id: 'terminal-group-1',
    type: 'terminal',
    ownerId: null,
    label: 'Terminal 1',
    path: null,
    resources: [],
    panels: [{
      id: 'terminal-panel-1', groupId: 'terminal-group-1', position: 0,
      kind: 'terminal', minimized: false, width: 1, label: 'Shell',
      terminalRole: 'shell', fontSize: 14,
    }],
  };
  const { container } = await mountReact(React.createElement(GroupWorkspace, {
    group,
    revision: 7,
    target: { id: 'local', name: 'Local', url: null },
    terminalMode: 'dark',
    fontFamily: 'monospace',
    onRefresh: async () => {},
  }));

  const renameButton = container.querySelector('button[aria-label="Rename Terminal 1"]');
  assert.ok(renameButton, 'the group name in the top header is clickable');
  await actCall(() => renameButton.click());
  const renameInput = container.querySelector('input[aria-label="Rename Terminal 1"]');
  await actCall(() => {
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setValue.call(renameInput, 'Build logs');
    renameInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await dispatchKey(renameInput, 'Enter', { ctrlKey: false });
  await flush(20);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/panel-layout/groups/terminal-group-1');
  assert.equal(requests[0].options.method, 'PUT');
  const body = JSON.parse(requests[0].options.body);
  assert.equal(typeof body.client, 'string');
  assert.equal(body.revision, 7);
  assert.equal(body.label, 'Build logs');
});

test('repository and scratchpad headers explicitly sync their sessions', async (t) => {
  const dom = setupDom(t);
  const React = await import('react');
  const { default: GroupWorkspace } = await import('../web-v2/src/GroupWorkspace.jsx');
  const requests = [];
  let refreshes = 0;
  setMockFetch(async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return { ok: true, json: async () => ({ ok: true }) };
  });

  for (const [groupType, sessionType] of [['repository', 'repo'], ['scratchpad', 'scratchpad']]) {
    const session = {
      id: `${sessionType}-1`, type: sessionType, name: `${sessionType} session`,
      branch: 'feature', agent: 'claude', issues: [],
    };
    const group = {
      id: `${groupType}-group`, type: groupType, ownerId: session.id,
      label: session.name, path: `/tmp/${session.id}`, resources: [], panels: [],
    };
    const mounted = await mountReact(React.createElement(GroupWorkspace, {
      group,
      revision: 7,
      target: { id: 'local', name: 'Local', url: null },
      session,
      terminalMode: 'dark',
      fontFamily: 'monospace',
      onRefresh: async () => { refreshes += 1; },
    }));
    const button = mounted.container.querySelector('button[aria-label="Refresh session"]');
    assert.ok(button, `${groupType} session has a refresh button`);
    await actCall(() => button.click());
    await flush(20);
    await mounted.unmount();
  }

  assert.deepEqual(requests.map(({ url, options }) => ({
    url, method: options.method, body: options.body,
  })), [
    { url: '/fw/repo-1/sync', method: 'POST', body: '{}' },
    { url: '/fw/scratchpad-1/sync', method: 'POST', body: '{}' },
  ]);
  assert.equal(refreshes, 0, 'the WebSocket invalidation owns client refresh');
});

test('minimizing a group terminal keeps its renderer mounted and deactivates its attachment', async (t) => {
  const dom = setupDom(t);
  const React = await import('react');
  const { default: GroupWorkspace } = await import('../web-v2/src/GroupWorkspace.jsx');
  const panel = {
    id: 'terminal-panel-idle', groupId: 'terminal-group-idle', position: 0,
    kind: 'terminal', minimized: false, width: 1, label: 'Shell',
    terminalRole: 'shell', fontSize: 14,
  };
  const group = {
    id: 'terminal-group-idle', type: 'terminal', ownerId: null,
    label: 'Idle terminals', path: null, resources: [], panels: [panel],
  };
  const render = (nextGroup) => React.createElement(GroupWorkspace, {
    group: nextGroup,
    revision: 1,
    target: { id: 'local', name: 'Local', url: null },
    visible: true,
    active: true,
    terminalMode: 'dark',
    fontFamily: 'monospace',
    onRefresh: async () => {},
  });
  const mounted = await mountReact(render(group));
  const terminal = mounted.container.querySelector('[data-terminal-id="terminal-panel-idle"]');
  assert.ok(terminal);
  assert.equal(terminal.dataset.terminalActive, 'true');

  await mounted.update(render({ ...group, panels: [{ ...panel, minimized: true }] }));
  const minimized = mounted.container.querySelector('[data-terminal-id="terminal-panel-idle"]');
  assert.equal(minimized, terminal, 'the same renderer survives minimization');
  assert.equal(minimized.dataset.terminalActive, 'false');
  await mounted.unmount();
});

test('Ctrl-E toggles a Markdown tab between Edit and Preview', async (t) => {
  const { ref, container } = await harness(t);

  await openNote(ref);
  assert.equal(textarea(container), null);
  assert.equal(document.activeElement, previewPane(container), 'opening a note focuses Preview by default');

  const toEdit = await dispatchKey(previewPane(container), 'e');
  assert.equal(toEdit.defaultPrevented, true, 'Ctrl-E is captured in Preview too');
  assert.equal(previewPane(container), null);
  assert.equal(document.activeElement, textarea(container), 'Ctrl-E focuses Edit');

  const toPreview = await dispatchKey(textarea(container), 'e');
  assert.equal(toPreview.defaultPrevented, true, 'Ctrl-E must not reach the browser');
  assert.equal(textarea(container), null);
  assert.equal(document.activeElement, previewPane(container), 'a second Ctrl-E returns focus to Preview');
});

test('remembered standalone terminals stay mounted but only the selected view is active', async (t) => {
  const { container, ref } = await harness(t, {
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
    'all restored terminal renderers remain mounted',
  );
  assert.deepEqual(
    fakeTerminals(container).map((terminal) => terminal.dataset.terminalActive),
    ['false', 'false'],
    'restored terminals do not attach while no standalone view is selected',
  );
  await actCall(() => ref.current.activate('terminal-two'));
  await flush(20);
  assert.deepEqual(
    fakeTerminals(container).map((terminal) => terminal.dataset.terminalActive),
    ['false', 'true'],
    'only the selected terminal attachment becomes active',
  );
  await actCall(() => ref.current.hide());
  await flush(20);
  assert.deepEqual(
    fakeTerminals(container).map((terminal) => terminal.dataset.terminalActive),
    ['false', 'false'],
  );
  assert.equal(container.querySelector('[data-standalone-sessions] > section').getAttribute('aria-hidden'), 'true');
});

test('a lone Markdown session regains keyboard focus in Edit and Preview mode', async (t) => {
  const { ref, container } = await harness(t);

  await openNote(ref);
  await dispatchKey(previewPane(container), 'e');
  assert.equal(document.activeElement, textarea(container), 'switching to Edit focuses the textarea');

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
  await dispatchKey(previewPane(container), 'e');
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
  const dom = setupDom(t);
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


test('HTML previews use the owning daemon and never mount an editor', async (t) => {
  const dom = setupDom(t);
  const React = await import('react');
  const { default: GroupWorkspace } = await import('../web-v2/src/GroupWorkspace.jsx');
  const resource = { id: 'html-preview', kind: 'html', value: '/repo/preview one.html', label: 'Preview' };
  const panel = { id: 'html-panel', kind: 'iframe', resourceId: resource.id, label: 'Preview', width: 1, minimized: false };
  const group = { id: 'session-1', type: 'repository', ownerId: '1', label: 'Session', resources: [resource], panels: [panel] };
  const render = (target) => React.createElement(GroupWorkspace, { group, revision: 1, target });
  const mounted = await mountReact(render({ id: 'remote', url: 'http://127.1.1.2:7337', instanceId: 'remote-instance' }));
  const { container } = mounted;
  const frame = container.querySelector('iframe');
  assert.equal(frame.src, 'http://127.1.1.2:7337/resource-files/remote-instance/html-preview/preview%20one.html');
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(container.querySelector('textarea'), null);
  assert.equal([...container.querySelectorAll('button')].some((button) => button.textContent === 'Edit'), false);
  const reload = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Reload');
  await actCall(() => reload.click());
  assert.notEqual(container.querySelector('iframe'), frame);
  await mounted.update(render({ id: 'local', url: null, instanceId: 'local-instance' }));
  assert.equal(container.querySelector('iframe').getAttribute('src'), '/resource-files/local-instance/html-preview/preview%20one.html');
});


test('confirmed editor close discards only its journal; cancelled close preserves the dirty buffer', async (t) => {
  setupDom(t);
  let writes = 0;
  setMockFetch(async (url, options = {}) => {
    if (String(url).includes('/notes/file')) {
      if (options.method === 'PUT') writes += 1;
      return Response.json({ content: 'saved text', version: 1 });
    }
    return Response.json({ tabs: [], state: {} });
  });
  const React = await import('react');
  const { TargetProvider } = await import('../web-v2/src/target-context.js');
  const { connections } = await import('../web-v2/src/connections.js');
  const { readDraft, retainDraft } = await import('../web-v2/src/markdown-drafts.js');
  const { default: BottomTabsHarness } = await import('./helpers/BottomTabsHarness.jsx');
  const target = { id: 'local', name: 'Local', url: null, instanceId: 'local-instance' };
  await connections.inspect(target);
  const ref = React.createRef();
  const { container } = await mountReact(React.createElement(TargetProvider, { value: target },
    React.createElement(BottomTabsHarness, { ref })));
  await flush(20);
  await openNote(ref);
  await dispatchKey(previewPane(container), 'e');
  await actCall(() => {
    const field = textarea(container);
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(field, 'discard me');
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  const id = 'editor:notes:/notes/a.md';
  retainDraft(target, '/notes/a.md', 'notes', 'other editor draft', 'saved text', 1, 'other-editor', 'other-owner');
  assert.equal(readDraft(target, '/notes/a.md', 'notes', id).content, 'discard me');
  window.confirm = () => false;
  await actCall(() => assert.equal(ref.current.close(id), false));
  assert.equal(textarea(container).value, 'discard me');
  assert.equal(readDraft(target, '/notes/a.md', 'notes', id).content, 'discard me');
  window.confirm = () => true;
  await actCall(() => assert.equal(ref.current.close(id), true));
  assert.equal(readDraft(target, '/notes/a.md', 'notes', id), undefined);
  assert.equal(readDraft(target, '/notes/a.md', 'notes', 'other-editor').content, 'other editor draft');
  await openNote(ref);
  await dispatchKey(previewPane(container), 'e');
  assert.equal(textarea(container).value, 'saved text');
  await flush(1300);
  assert.equal(writes, 0, 'reopening never autosaves the discarded buffer');
});

test('resource disassociation preserves drafts on cancel or failure and clears only affected panels after success', async (t) => {
  setupDom(t);
  let attempts = 0;
  let fail = true;
  let refreshes = 0;
  setMockFetch(async (url) => {
    if (String(url).endsWith('/disassociate')) {
      attempts += 1;
      return fail ? Response.json({ message: 'disassociation failed' }, { status: 500 }) : Response.json({ revision: 2 });
    }
    return Response.json({ content: 'saved text', version: 1 });
  });
  const React = await import('react');
  const { TargetProvider } = await import('../web-v2/src/target-context.js');
  const { connections } = await import('../web-v2/src/connections.js');
  const { readDraft, retainDraft } = await import('../web-v2/src/markdown-drafts.js');
  const { default: GroupWorkspace } = await import('../web-v2/src/GroupWorkspace.jsx');
  const target = { id: 'local', name: 'Local', url: null, instanceId: 'local-instance' };
  await connections.inspect(target);
  const path = '/tmp/notes/plan.md';
  const group = { id: 'notes-group', type: 'repository', ownerId: '1', label: 'Notes', path: '/tmp/notes',
    resources: [{ id: 'notes-resource', kind: 'markdown', value: path, label: 'Plan', disassociate: true }],
    panels: [{ id: 'notes-editor', kind: 'markdown', resourceId: 'notes-resource', label: 'Plan', width: 1, fontSize: 14, markdownMode: 'edit' }],
  };
  const render = (current) => React.createElement(TargetProvider, { value: target }, React.createElement(GroupWorkspace, {
    group: current, target, revision: 1, active: true,
    onRefresh: async () => { refreshes += 1; await mounted.update(render({ ...group, resources: [], panels: [] })); },
  }));
  const mounted = await mountReact(render(group));
  const { container } = mounted;
  await flush(20);
  await actCall(() => {
    const field = textarea(container);
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(field, 'dirty plan');
    field.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  retainDraft(target, path, 'file', 'other draft', 'saved text', 1, 'unrelated-editor', 'other-owner');
  await actCall(() => [...container.querySelectorAll('button')].find((button) => button.textContent.includes('Files (')).click());
  const disassociate = () => container.querySelector('[aria-label="Disassociate Plan"]').click();
  window.confirm = () => false;
  await actCall(disassociate);
  assert.equal(attempts, 0);
  assert.equal(readDraft(target, path, 'file', 'notes-editor').content, 'dirty plan');
  window.confirm = () => true;
  await actCall(disassociate);
  await flush(20);
  assert.equal(attempts, 1);
  assert.equal(refreshes, 0);
  assert.match(container.textContent, /disassociation failed/);
  assert.equal(readDraft(target, path, 'file', 'notes-editor').content, 'dirty plan');
  fail = false;
  await actCall(disassociate);
  await flush(20);
  assert.equal(attempts, 2);
  assert.equal(refreshes, 1);
  assert.equal(readDraft(target, path, 'file', 'notes-editor'), undefined);
  assert.equal(readDraft(target, path, 'file', 'unrelated-editor').content, 'other draft');
  assert.equal(textarea(container), null);
});
