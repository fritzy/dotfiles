import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actCall, flush, mountReact, registerJsxLoader, setupJsdom, teardownJsdom,
} from './helpers/dom-react.js';

registerJsxLoader();

test('Markdown preview renders GitHub-flavored tables, links, tasks, and code', async (t) => {
  const dom = setupJsdom();

  const React = await import('react');
  const { MarkdownPreview } = await import('../web-v2/src/MarkdownEditor.jsx');
  const markdown = [
    '# Release notes',
    '',
    '| Change | Status |',
    '| :--- | ---: |',
    '| Preview | ready |',
    '',
    '[Named link](https://example.com/docs) and https://example.com/auto',
    '',
    '- [x] Render task lists',
    '- [ ] Ship it',
    '',
    '~~old behavior~~',
    '',
    '```js',
    'const answer = 42;',
    '```',
    '',
    '`inlineCode()`',
  ].join('\n');
  const mounted = await mountReact(React.createElement(MarkdownPreview, null, markdown));
  t.after(async () => {
    await mounted.unmount();
    teardownJsdom(dom);
  });

  const { container } = mounted;
  assert.equal(container.querySelector('h1').textContent, 'Release notes');
  assert.equal(container.querySelectorAll('table').length, 1);
  assert.deepEqual(
    [...container.querySelectorAll('th, td')].map((cell) => cell.textContent),
    ['Change', 'Status', 'Preview', 'ready'],
  );
  assert.equal(container.querySelector('th:nth-child(1)').style.textAlign, 'left');
  assert.equal(container.querySelector('th:nth-child(2)').style.textAlign, 'right');

  const links = [...container.querySelectorAll('a')];
  assert.deepEqual(links.map((link) => link.href), [
    'https://example.com/docs', 'https://example.com/auto',
  ]);
  assert.equal(links.every((link) => link.target === '_blank'), true);
  assert.equal(links.every((link) => link.rel === 'noreferrer noopener'), true);

  const tasks = [...container.querySelectorAll('input[type="checkbox"]')];
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].checked, true);
  assert.equal(tasks[1].checked, false);
  assert.equal(tasks.every((task) => task.disabled), true);
  assert.equal(container.querySelector('del').textContent, 'old behavior');

  const codeBlock = container.querySelector('pre code.language-js');
  assert.equal(codeBlock.textContent, 'const answer = 42;\n');
  assert.equal(container.querySelector(':not(pre) > code').textContent, 'inlineCode()');
});

test('Markdown panels refresh with their session and do not overwrite local edits', async (t) => {
  const dom = setupJsdom();
  let diskContent = '# Before\n';
  let subscription = null;
  let unsubscribed = false;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /^\/markdown\/file\?path=/);
    return {
      ok: true,
      json: async () => ({
        path: '/tmp/watched.md', name: 'watched.md', content: diskContent,
        version: diskContent === '# Before\n' ? 'v1' : 'v2',
      }),
    };
  };

  const React = await import('react');
  const { default: MarkdownEditor } = await import('../web-v2/src/MarkdownEditor.jsx');
  const { MarkdownWatchProvider } = await import('../web-v2/src/markdown-watch.js');
  const watchMarkdown = (next) => {
    subscription = next;
    return () => { unsubscribed = true; };
  };
  const mounted = await mountReact(React.createElement(
    MarkdownWatchProvider,
    { value: watchMarkdown },
    React.createElement(MarkdownEditor, {
      path: '/tmp/watched.md', name: 'watched.md', source: 'file',
      focused: false, visible: true,
    }),
  ));
  t.after(async () => {
    await mounted.unmount();
    delete globalThis.fetch;
    teardownJsdom(dom);
  });
  await flush();

  assert.ok(mounted.container.querySelector('[aria-label="watched.md markdown preview"]'));
  assert.equal(mounted.container.querySelector('textarea'), null);
  const editButton = [...mounted.container.querySelectorAll('button')].find((button) => button.textContent === 'Edit');
  await actCall(() => editButton.click());
  let textarea = mounted.container.querySelector('textarea');
  assert.equal(textarea.value, '# Before\n');
  assert.equal(subscription.path, '/tmp/watched.md');
  assert.equal(subscription.source, 'file');

  await mounted.update(React.createElement(
    MarkdownWatchProvider,
    { value: watchMarkdown },
    React.createElement(MarkdownEditor, {
      path: '/tmp/watched.md', name: 'watched.md', source: 'file',
      focused: false, visible: false,
    }),
  ));
  assert.equal(unsubscribed, true);
  assert.equal(mounted.container.querySelector('textarea'), null);
  assert.ok(mounted.container.querySelector('[data-markdown-inactive="/tmp/watched.md"]'));

  diskContent = '# Changed while session was away\n';
  await mounted.update(React.createElement(
    MarkdownWatchProvider,
    { value: watchMarkdown },
    React.createElement(MarkdownEditor, {
      path: '/tmp/watched.md', name: 'watched.md', source: 'file',
      focused: false, visible: true,
    }),
  ));
  await flush();
  textarea = mounted.container.querySelector('textarea');
  assert.equal(textarea.value, '# Changed while session was away\n');

  diskContent = '# Changed in another app\n';
  await actCall(() => window.dispatchEvent(new window.Event('focus')));
  await flush();
  textarea = mounted.container.querySelector('textarea');
  assert.equal(textarea.value, '# Changed in another app\n');

  diskContent = '# External watcher update\n';
  await actCall(() => subscription.onChange());
  await flush();
  textarea = mounted.container.querySelector('textarea');
  assert.equal(textarea.value, '# External watcher update\n');

  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value',
  ).set;
  await actCall(() => {
    valueSetter.call(textarea, '# Local edit\n');
    textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  diskContent = '# Newer external edit\n';
  await actCall(() => subscription.onChange());
  await flush();
  assert.equal(textarea.value, '# Local edit\n');
  assert.match(mounted.container.textContent, /changed on disk/);

  await mounted.update(React.createElement(
    MarkdownWatchProvider,
    { value: watchMarkdown },
    React.createElement(MarkdownEditor, {
      path: '/tmp/watched.md', name: 'watched.md', source: 'file',
      focused: false, visible: false,
    }),
  ));
  assert.equal(unsubscribed, true);
});

test('hidden Markdown previews retain state without retaining the parsed document', async (t) => {
  const dom = setupJsdom();
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      path: '/tmp/large.md', name: 'large.md',
      content: '# Large\n\n' + '- rendered row\n'.repeat(500), version: 'v1',
    }),
  });
  const React = await import('react');
  const { default: MarkdownEditor } = await import('../web-v2/src/MarkdownEditor.jsx');
  const render = (visible) => React.createElement(MarkdownEditor, {
    path: '/tmp/large.md', name: 'large.md', source: 'file',
    focused: false, visible, initialMode: 'preview',
  });
  const mounted = await mountReact(render(true));
  t.after(async () => {
    await mounted.unmount();
    delete globalThis.fetch;
    teardownJsdom(dom);
  });
  await flush();
  assert.ok(mounted.container.querySelector('[aria-label="large.md markdown preview"]'));
  assert.equal(mounted.container.querySelectorAll('li').length, 500);

  await mounted.update(render(false));
  assert.equal(mounted.container.querySelector('[aria-label="large.md markdown preview"]'), null);
  assert.ok(mounted.container.querySelector('[data-markdown-inactive="/tmp/large.md"]'));

  await mounted.update(render(true));
  await flush();
  assert.equal(mounted.container.querySelectorAll('li').length, 500, 'the retained content renders again');
});

test('group Markdown dirty-state reporting settles without a render feedback loop', async (t) => {
  const dom = setupJsdom();
  let fetches = 0;
  let dirtyReports = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return {
      ok: true,
      json: async () => ({
        path: '/tmp/group.md', name: 'group.md', content: '# Group\n', version: 'v1',
      }),
    };
  };
  const React = await import('react');
  const { default: GroupWorkspace } = await import('../web-v2/src/GroupWorkspace.jsx');
  const group = {
    id: 'markdown-group', type: 'repository', ownerId: '1',
    label: 'Markdown group', path: '/tmp',
    resources: [{ id: 'markdown-resource', kind: 'markdown', label: 'group.md', value: '/tmp/group.md' }],
    panels: [{
      id: 'markdown-panel', groupId: 'markdown-group', position: 0,
      kind: 'markdown', minimized: false, width: 1, label: 'group.md',
      resourceId: 'markdown-resource', fontSize: 14, markdownMode: 'preview',
    }],
  };
  const mounted = await mountReact(React.createElement(GroupWorkspace, {
    group, revision: 1, target: { id: 'local', name: 'Local', url: null },
    visible: true, active: true, terminalMode: 'dark', fontFamily: 'monospace',
    onRefresh: async () => {},
    onResourceDirtyChange: () => { dirtyReports += 1; },
  }));
  t.after(async () => {
    await mounted.unmount();
    delete globalThis.fetch;
    teardownJsdom(dom);
  });
  await flush(100);
  assert.equal(fetches, 1);
  assert.equal(dirtyReports, 0);
  assert.ok(mounted.container.querySelector('[aria-label="group.md markdown preview"]'));
});
