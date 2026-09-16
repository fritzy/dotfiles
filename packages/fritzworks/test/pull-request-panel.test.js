import assert from 'node:assert/strict';
import test from 'node:test';

import { actCall, flush, mountReact, registerJsxLoader, setupJsdom, teardownJsdom } from './helpers/dom-react.js';

registerJsxLoader();

test('PR links render body and comments, reload on the selected daemon, and suspend hidden views', async (t) => {
  const dom = setupJsdom();
  let calls = 0;
  let failed = false;
  globalThis.fetch = async (url) => {
    calls += 1;
    assert.equal(url, 'http://remote:7337/panel-layout/resources/pr-link/pull-request');
    return {
      ok: !failed,
      json: async () => failed ? { message: 'Please run gh auth login' } : {
        number: 123, title: 'Example PR', state: 'OPEN', author: { login: 'author' },
        body: '# Description\n\n- [x] Done\n\n<script>alert(1)</script>',
        comments: [{ id: 'comment', author: { login: 'reviewer' }, body: '**Looks good**\n\n[Unsafe](javascript:alert(1))' }],
      },
    };
  };
  const React = await import('react');
  const { default: GroupWorkspace } = await import('../web-v2/src/GroupWorkspace.jsx');
  const resource = { id: 'pr-link', kind: 'link', value: 'https://github.com/org/repo/pull/123', label: 'PR #123' };
  const group = {
    id: 'group', type: 'repository', label: 'Repository', resources: [resource],
    panels: [{ id: 'panel', kind: 'iframe', resourceId: resource.id, label: resource.label, width: 1 }],
  };
  const render = (active) => React.createElement(GroupWorkspace, {
    group, revision: 1, target: { id: 'remote', url: 'http://remote:7337' }, active, visible: active,
  });
  const mounted = await mountReact(render(true));
  t.after(async () => {
    await mounted.unmount();
    delete globalThis.fetch;
    teardownJsdom(dom);
  });
  await flush(200);
  assert.equal(calls, 1);
  const { container } = mounted;
  assert.equal(container.querySelector('iframe'), null);
  assert.match(container.textContent, /Example PR/);
  assert.equal(container.querySelector('input[type="checkbox"]').checked, true);
  assert.equal(container.querySelector('article strong').textContent, 'Looks good');
  assert.equal(container.querySelector('script'), null);
  assert.equal(container.querySelector('a[href^="javascript:"]'), null);
  assert.equal([...container.querySelectorAll('a')].find((a) => a.textContent === 'Open on GitHub').href, resource.value);
  const reload = () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Reload');
  failed = true;
  await actCall(() => reload().click());
  await flush();
  assert.match(container.querySelector('[role="alert"]').textContent, /gh auth login/);
  failed = false;
  await actCall(() => reload().click());
  await flush();
  assert.equal(container.querySelector('[role="alert"]'), null);
  assert.equal(calls, 3);
  await mounted.update(render(false));
  assert.equal(container.querySelector('.markdown-preview'), null);
  assert.equal(calls, 3);
  await mounted.update(render(true));
  await flush();
  assert.equal(calls, 4);
});
