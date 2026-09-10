import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mountReact, registerJsxLoader, setupJsdom, teardownJsdom,
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
