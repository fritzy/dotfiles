import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ApiError,
  createApiService,
  encodeWebSocketFrame,
  executeWorkstreamCommand,
  openPathWithXdg,
  queryWorkstreams,
} from '../lib/api.js';
import {
  addIssue,
  listIssues,
  openDb,
  setAgentStatus,
  setConfiguredLocationAgentStatus,
  selectedAgent,
  setCachedGitClean,
  setStatus,
  upsertWorkstream,
  workstreamSlug,
} from '../lib/core.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ai-workstream-api-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(join(dir, 'workstreams.db'));
  t.after(() => db.close());
  const created = '2026-08-26T12:00:00.000Z';
  const repo = upsertWorkstream(db, {
    org: 'example', repo: 'project', branch: 'feature', source: 'origin',
    path: join(dir, 'feature'), created_at: created, last_joined_at: created,
  });
  mkdirSync(repo.path);
  const scratch = upsertWorkstream(db, {
    org: 'scratch', repo: 'scratch', branch: 'ideas', source: 'scratch',
    path: join(dir, 'ideas'), created_at: created, last_joined_at: created,
  });
  mkdirSync(scratch.path);
  const closed = upsertWorkstream(db, {
    org: 'example', repo: 'project', branch: 'done', source: 'origin',
    path: join(dir, 'done'), created_at: created, last_joined_at: created,
  });
  setStatus(db, closed.id, 'closed');
  const config = {
    paths: {
      repositories: join(dir, 'repositories'), scratchpads: join(dir, 'scratchpads'),
      dotfiles: join(dir, 'dotfiles'), notes: join(dir, 'notes'), data: dir,
    },
    locations: {
      notes: {
        id: 'notes', name: 'notes', repo: 'fritzy/notes', path: join(dir, 'notes'), branch: 'main',
        closeable: false, weeklyNotes: true,
      },
      dotfiles: {
        id: 'dotfiles', name: 'dotfiles', repo: 'fritzy/dotfiles', path: join(dir, 'dotfiles'), branch: 'main',
        closeable: false, weeklyNotes: false,
      },
      savefiles: {
        id: 'savefiles', name: 'savefiles', repo: 'fritzy/savefiles', path: join(dir, 'savefiles'), branch: 'main',
        closeable: false, weeklyNotes: false,
      },
    },
    server: { host: '127.0.0.1', port: 7337, pollInterval: 1000 },
    agent: 'claude',
    panels: ['shell', 'editor', 'agent'],
  };
  return { db, dir, repo, scratch, closed, config };
}

test('REST query model filters types and statuses and paginates consistently', (t) => {
  const { db, repo, config } = fixture(t);
  setCachedGitClean(db, repo.id, true);
  const notesPath = join(config.paths.notes, 'work', '2026', 'workstream', workstreamSlug(repo));
  mkdirSync(notesPath, { recursive: true });
  addIssue(db, repo.id, 'https://github.com/example/project/issues/42');
  setConfiguredLocationAgentStatus(db, 'dotfiles', 'ready');
  const activeRepos = queryWorkstreams(db, {
    id: 'all', type: 'repo', status: 'active_paused', page: '0', perpage: '25',
  }, {
    config,
    cwd: '/outside',
    checkGit: () => { throw new Error('GET must not run Git synchronously'); },
  });
  assert.equal(activeRepos.total, 1);
  assert.equal(activeRepos.items[0].id, repo.id);
  assert.equal(activeRepos.items[0].type, 'repo');
  assert.equal(activeRepos.items[0].repoUrl, 'https://github.com/example/project');
  assert.equal(activeRepos.items[0].gitClean, true);
  assert.equal(activeRepos.items[0].notesPath, notesPath);
  assert.equal(activeRepos.items[0].createdAt, '2026-08-26T12:00:00.000Z');
  assert.equal(activeRepos.items[0].issues[0].createdAt.length > 0, true);
  setCachedGitClean(db, repo.id, false);
  assert.equal(queryWorkstreams(db, { id: String(repo.id), status: 'all' }, { config }).items[0].gitClean, false);

  const misc = queryWorkstreams(db, { id: 'all', type: 'misc', status: 'all' }, {
    config, tabNames: ['dotfiles'],
  });
  assert.deepEqual(misc.items.map((item) => item.id), ['notes', 'dotfiles', 'savefiles']);
  assert.deepEqual(misc.items.map((item) => item.status), ['paused', 'active', 'paused']);
  assert.deepEqual(misc.items.map((item) => item.agentStatus), [null, 'ready', null]);
  assert.deepEqual(misc.items.map((item) => item.repo), ['fritzy/notes', 'fritzy/dotfiles', 'fritzy/savefiles']);
  assert.deepEqual(misc.items.map((item) => item.repoUrl), [
    'https://github.com/fritzy/notes', 'https://github.com/fritzy/dotfiles', 'https://github.com/fritzy/savefiles',
  ]);
  assert.deepEqual(misc.items.map((item) => item.branch), ['main', 'main', 'main']);
  assert.deepEqual(misc.items.map((item) => item.closeable), [false, false, false]);
  assert.deepEqual(
    queryWorkstreams(db, { id: 'all', type: 'misc', status: 'active' }, {
      config, tabNames: ['dotfiles'],
    }).items.map((item) => item.id),
    ['dotfiles'],
  );
  const all = queryWorkstreams(db, { id: 'all', status: 'all', perpage: '100' }, {
    config, tabNames: ['dotfiles'],
  });
  assert.deepEqual(all.items.map((item) => item.id), ['notes', 'dotfiles', 'savefiles', 3, 2, 1]);
  assert.equal(queryWorkstreams(db, { id: String(repo.id), status: 'all' }, { config }).total, 1);
  assert.throws(
    () => queryWorkstreams(db, { id: 'all', type: 'unknown' }, { config }),
    (error) => error instanceof ApiError && error.status === 400,
  );
});

test('POST command model mutates only supported workstream state', (t) => {
  const { db, repo, scratch, closed, config } = fixture(t);
  const closedTabs = [];
  let response = executeWorkstreamCommand(db, String(repo.id), 'pause', {}, {
    closeTab: (row) => { closedTabs.push(row.id); },
  });
  assert.equal(response.workstream.status, 'paused');
  assert.deepEqual(closedTabs, [repo.id]);
  response = executeWorkstreamCommand(db, String(repo.id), 'rename', { name: 'API work' });
  assert.equal(response.workstream.id, repo.id);
  response = executeWorkstreamCommand(db, String(repo.id), 'log', { body: 'served over REST', done: true });
  assert.deepEqual(response.result, { id: 1, body: 'served over REST', done: true });
  response = executeWorkstreamCommand(db, String(repo.id), 'issue-add', { refs: ['#42'] });
  assert.equal(response.result.issues[0].added, true);
  assert.equal(response.result.issues[0].ref, 'https://github.com/example/project/issues/42');
  assert.equal(listIssues(db, repo.id).length, 1);
  response = executeWorkstreamCommand(db, String(repo.id), 'issue-remove', {
    ref: 'https://github.com/example/project/issues/42',
  });
  assert.equal(response.result.removed, true);
  const openedPaths = [];
  response = executeWorkstreamCommand(db, String(repo.id), 'open-path', {}, {
    openPath: (path) => { openedPaths.push(path); return { opener: 'xdg-open', path }; },
  });
  assert.deepEqual(response.result, { opener: 'xdg-open', path: repo.path });
  assert.throws(
    () => executeWorkstreamCommand(db, String(repo.id), 'open-notes', {}, { config }),
    (error) => error instanceof ApiError && error.status === 404,
  );
  const notesPath = join(config.paths.notes, 'work', '2026', 'workstream', workstreamSlug(repo));
  mkdirSync(notesPath, { recursive: true });
  response = executeWorkstreamCommand(db, String(repo.id), 'open-notes', {}, {
    config,
    openPath: (path) => { openedPaths.push(path); return { opener: 'xdg-open', path }; },
  });
  assert.deepEqual(response.result, { opener: 'xdg-open', path: notesPath });
  executeWorkstreamCommand(db, 'notes', 'open-path', {}, {
    config,
    openPath: (path) => { openedPaths.push(path); return { opener: 'xdg-open', path }; },
  });
  assert.deepEqual(openedPaths, [repo.path, notesPath, config.paths.notes]);
  for (const id of Object.keys(config.locations)) {
    for (const body of [{}, { remove: true, force: true }]) {
      assert.throws(
        () => executeWorkstreamCommand(db, id, 'close', body, { config }),
        (error) => error instanceof ApiError && error.status === 400,
      );
    }
  }
  const configuredTabs = [];
  response = executeWorkstreamCommand(db, 'dotfiles', 'pause', {}, {
    config,
    closeTab: (row) => { configuredTabs.push(['pause', row.id, row.tab_name, row.path]); },
  });
  assert.equal(response.workstream.status, 'paused');
  response = executeWorkstreamCommand(db, 'savefiles', 'resume', {}, {
    config,
    openTab: (row) => { configuredTabs.push(['resume', row.id, row.tab_name]); },
  });
  assert.equal(response.workstream.status, 'active');
  response = executeWorkstreamCommand(db, 'notes', 'resume', {}, {
    config,
    openTab: (row, opts) => { configuredTabs.push(['resume', row.id, row.tab_name, opts.editorFile]); },
  });
  assert.equal(response.workstream.status, 'active');
  assert.deepEqual(configuredTabs[0], ['pause', 'dotfiles', 'dotfiles', config.paths.dotfiles]);
  assert.deepEqual(configuredTabs[1], ['resume', 'savefiles', 'savefiles']);
  assert.equal(configuredTabs[2][0], 'resume');
  assert.equal(configuredTabs[2][1], 'notes');
  assert.equal(configuredTabs[2][2], 'notes');
  assert.match(configuredTabs[2][3], new RegExp(`^${config.paths.notes}/work/.*-week\\.md$`));
  let configuredPanel;
  response = executeWorkstreamCommand(db, 'notes', 'panel-toggle', { panel: 'editor' }, {
    config,
    tabNames: ['notes'],
    togglePanel: (row, panel, opts) => {
      configuredPanel = { row, panel, opts };
      return { panel, open: true };
    },
  });
  assert.equal(response.workstream.status, 'active');
  assert.deepEqual(response.result, { panel: 'editor', open: true });
  assert.equal(configuredPanel.row.id, 'notes');
  assert.equal(configuredPanel.row.tab_name, 'notes');
  assert.equal(configuredPanel.panel, 'editor');
  assert.match(configuredPanel.opts.editorFile, /-week\.md$/);
  const replacements = [];
  response = executeWorkstreamCommand(db, String(repo.id), 'agent-set', { agent: 'codex' }, {
    config,
    replaceAgent: (row, agent) => {
      replacements.push([row.id, agent]);
      return { agent, tabOpen: true, panelOpen: true, replaced: true };
    },
  });
  assert.equal(response.workstream.agent, 'codex');
  assert.equal(response.result.replaced, true);
  response = executeWorkstreamCommand(db, 'dotfiles', 'agent-set', { agent: 'codex' }, {
    config,
    tabNames: ['dotfiles'],
    replaceAgent: (row, agent) => {
      replacements.push([row.id, agent]);
      return { agent, tabOpen: true, panelOpen: true, replaced: true };
    },
  });
  assert.equal(response.workstream.agent, 'codex');
  assert.deepEqual(replacements, [[repo.id, 'codex'], ['dotfiles', 'codex']]);
  assert.equal(selectedAgent(db, repo.id, 'claude'), 'codex');
  assert.equal(selectedAgent(db, 'dotfiles', 'claude'), 'codex');
  assert.throws(
    () => executeWorkstreamCommand(db, String(closed.id), 'open-path', {}, { openPath: () => ({}) }),
    (error) => error instanceof ApiError && error.status === 404,
  );
  response = executeWorkstreamCommand(db, String(repo.id), 'close', {}, { closeTab: () => false });
  assert.equal(response.workstream.status, 'closed');
  assert.deepEqual(response.result, { removed: false });
  executeWorkstreamCommand(db, String(scratch.id), 'pause', {}, { closeTab: () => false });
  let opened;
  response = executeWorkstreamCommand(db, String(scratch.id), 'resume', {}, {
    openTab: (row) => { opened = row.id; },
  });
  assert.equal(response.workstream.status, 'active');
  assert.equal(opened, scratch.id);
  response = executeWorkstreamCommand(db, String(scratch.id), 'panel-toggle', { panel: 'editor' }, {
    togglePanel: (row, panel) => ({ id: row.id, panel, open: true }),
  });
  assert.deepEqual(response.result, { id: scratch.id, panel: 'editor', open: true });
  assert.throws(
    () => executeWorkstreamCommand(db, String(repo.id), 'shell', {}),
    (error) => error instanceof ApiError && error.status === 400,
  );
});

test('path opener invokes xdg-open without shell interpolation', () => {
  const calls = [];
  const run = (...args) => { calls.push(args); return { status: 0 }; };
  assert.deepEqual(openPathWithXdg('/tmp/a directory', { run }), {
    opener: 'xdg-open', path: '/tmp/a directory',
  });
  assert.deepEqual(calls, [['xdg-open', ['/tmp/a directory'], { stdio: 'ignore' }]]);
});

test('WebSocket frame encoder supports short and extended payloads', () => {
  const short = encodeWebSocketFrame('ok');
  assert.deepEqual([...short], [0x81, 2, 0x6f, 0x6b]);
  const extended = encodeWebSocketFrame('x'.repeat(130));
  assert.equal(extended[0], 0x81);
  assert.equal(extended[1], 126);
  assert.equal(extended.readUInt16BE(2), 130);
});

test('HTTP service serves assets, REST commands, and WebSocket invalidations', async (t) => {
  const { db, dir, repo, config } = fixture(t);
  const openedTabs = [];
  const openedTabOptions = [];
  const openedPaths = [];
  const closedTabs = [];
  const toggledPanels = [];
  const focusedAgents = [];
  const replacedAgents = [];
  const openTabSet = new Set(['dotfiles']);
  let checkedRepoClean = false;
  let createdRepoGitChecks = 0;
  const service = createApiService({
    db,
    config,
    cwd: '/outside',
    pollInterval: 20,
    checkGit: async (path) => {
      if (path.startsWith(`${join(dir, 'created')}/`)) {
        await new Promise((resolve) => setImmediate(resolve));
        createdRepoGitChecks += 1;
        return false;
      }
      return path === repo.path ? checkedRepoClean : null;
    },
    listOpenTabs: () => [...openTabSet],
    openTab: (row, options) => {
      openedTabs.push(row.id);
      openedTabOptions.push(options);
      openTabSet.add(String(row.id));
    },
    materialize: (org, repository, branch) => {
      const path = join(dir, 'created', org, repository, branch.replaceAll('/', '-'));
      mkdirSync(path, { recursive: true });
      return path;
    },
    clock: () => '2026-08-26T14:00:00.000Z',
    createScratchpadEntry: (database, rawName) => {
      const name = (rawName || 'random-scratch').replace(/[^A-Za-z0-9._-]+/g, '-');
      const path = join(dir, 'scratchpads', name);
      mkdirSync(path, { recursive: true });
      return upsertWorkstream(database, {
        org: 'scratch', repo: 'scratch', branch: name, source: 'scratch', path,
        created_at: '2026-08-26T14:00:00.000Z', last_joined_at: '2026-08-26T14:00:00.000Z',
      });
    },
    openPath: (path) => { openedPaths.push(path); return { opener: 'xdg-open', path }; },
    closeTab: (row) => { closedTabs.push(row.id); openTabSet.delete(String(row.id)); },
    panelState: () => ({ tabOpen: true, shell: true, editor: false, agent: true }),
    togglePanel: (row, panel) => {
      toggledPanels.push({ id: row.id, panel });
      return { panel, open: true };
    },
    replaceAgent: (row, agent) => {
      replacedAgents.push({ id: row.id, agent });
      return { agent, tabOpen: true, panelOpen: true, replaced: true };
    },
    focusAgent: (row) => {
      focusedAgents.push(row.id);
      return { session: 'ws', tabName: `tab-${row.id}`, paneId: 'terminal_7' };
    },
    focusTerminal: (session) => ({ focused: true, terminal: 'test', session }),
  });
  try {
    await new Promise((resolve, reject) => {
      service.server.once('error', reject);
      service.server.listen(0, '127.0.0.1', resolve);
    });
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') {
      t.skip(`local sockets unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  t.after(() => service.close());
  const { port } = service.server.address();
  const base = `http://127.0.0.1:${port}`;

  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  const indexHtml = await index.text();
  assert.match(indexHtml, /id="session-modal"/);
  assert.match(indexHtml, /<title>FritzWorks<\/title>/);
  assert.match(indexHtml, /<h1>FritzWorks<\/h1>/);
  assert.doesNotMatch(indexHtml, /Placeholder client/);
  assert.match(indexHtml, /class="status-pill"/);
  assert.match(indexHtml, /data-command="close"/);
  assert.match(indexHtml, /data-command="pause"/);
  assert.match(indexHtml, /data-command="resume"/);
  assert.match(indexHtml, /data-panel="shell"/);
  assert.match(indexHtml, /data-panel="editor"/);
  assert.match(indexHtml, /data-panel="agent"/);
  assert.doesNotMatch(indexHtml, /<th>Path<\/th>/);
  assert.doesNotMatch(indexHtml, /<th>Type<\/th>/);
  assert.doesNotMatch(indexHtml, /<thead/);
  assert.match(indexHtml, /<select name="type" aria-label="Type">/);
  assert.match(indexHtml, /value="active_paused">Active &amp; Paused/);
  assert.doesNotMatch(indexHtml, />Refresh<\/button>/);
  assert.match(indexHtml, /id="pagination"/);
  assert.match(indexHtml, /id="page-numbers"/);
  assert.match(indexHtml, /id="perpage"/);
  assert.match(indexHtml, /<option value="25" selected>25 Per Page<\/option>/);
  assert.match(indexHtml, /class="modal-status-bar"/);
  assert.match(indexHtml, /class="modal-dismiss" aria-label="Close session details"/);
  assert.match(indexHtml, /<svg viewBox="0 0 24 24"/);
  assert.doesNotMatch(indexHtml, />Dismiss<\/button>/);
  assert.ok(indexHtml.indexOf('class="modal-actions"') < indexHtml.indexOf('<dl class="detail-grid">'));
  assert.doesNotMatch(indexHtml, /id="modal-id"/);
  assert.doesNotMatch(indexHtml, /id="modal-type"/);
  assert.doesNotMatch(indexHtml, /<dt>Worktree<\/dt>/);
  assert.match(indexHtml, /id="modal-path-presence"/);
  assert.match(indexHtml, /id="modal-path" class="path-action"/);
  assert.match(indexHtml, /id="modal-agent-select"/);
  assert.match(indexHtml, /<option value="claude">Claude<\/option>/);
  assert.match(indexHtml, /<option value="codex">Codex<\/option>/);
  assert.match(indexHtml, /id="modal-links-input"/);
  assert.match(indexHtml, /id="theme-select"/);
  assert.match(indexHtml, /id="theme-select" aria-label="Theme"/);
  assert.ok(indexHtml.indexOf('id="theme-credit"') > indexHtml.indexOf('id="theme-select"'));
  assert.match(indexHtml, /id="new-repo-button"/);
  assert.match(indexHtml, /id="new-repo-modal"/);
  assert.match(indexHtml, /id="new-repo-repository"/);
  assert.match(indexHtml, /id="new-repo-selector"/);
  assert.match(indexHtml, /id="new-repo-source"/);
  assert.match(indexHtml, /id="new-repo-agent"/);
  assert.match(indexHtml, /id="new-repo-path"/);
  assert.match(indexHtml, /id="new-repo-links"/);
  assert.match(indexHtml, /class="new-panel-toggle" data-panel="agent"/);
  assert.match(indexHtml, /id="new-repo-submit"/);
  assert.match(indexHtml, /id="new-repo-submitting" class="new-session-submit-overlay"/);
  const newRepoModalHtml = indexHtml.slice(indexHtml.indexOf('<dialog id="new-repo-modal"'));
  assert.doesNotMatch(newRepoModalHtml, /modal-status-bar/);
  assert.doesNotMatch(newRepoModalHtml, />Created</);
  assert.doesNotMatch(newRepoModalHtml, />Last joined</);
  assert.doesNotMatch(newRepoModalHtml, />Stack</);
  assert.match(indexHtml, /id="new-scratchpad-button"/);
  assert.ok(indexHtml.indexOf('id="new-repo-button"') < indexHtml.indexOf('class="header-controls"'));
  assert.ok(indexHtml.indexOf('id="new-scratchpad-button"') < indexHtml.indexOf('class="header-controls"'));
  assert.ok(indexHtml.indexOf('id="connection"') > indexHtml.indexOf('id="theme-credit"'));
  assert.match(indexHtml, /id="new-scratchpad-modal"/);
  assert.match(indexHtml, /id="new-scratchpad-name"/);
  assert.match(indexHtml, /id="new-scratchpad-agent"/);
  assert.match(indexHtml, /id="new-scratchpad-path"/);
  assert.match(indexHtml, /id="new-scratchpad-links"/);
  assert.match(indexHtml, /class="new-scratchpad-panel-toggle" data-panel="agent"/);
  assert.match(indexHtml, /id="new-scratchpad-submit"/);
  assert.match(indexHtml, /id="new-scratchpad-submitting" class="new-session-submit-overlay"/);
  const newScratchpadModalHtml = indexHtml.slice(indexHtml.indexOf('<dialog id="new-scratchpad-modal"'));
  assert.doesNotMatch(newScratchpadModalHtml, /modal-status-bar/);
  assert.doesNotMatch(newScratchpadModalHtml, />Created</);
  assert.doesNotMatch(newScratchpadModalHtml, />Last joined</);
  assert.doesNotMatch(newScratchpadModalHtml, />Stack</);
  assert.match(indexHtml, /value="curiosities">Curiosities/);
  assert.match(indexHtml, /value="clement-8">Clément 8/);
  assert.match(indexHtml, /value="oil-6">Oil 6/);
  assert.match(indexHtml, /value="slso8">SLSO8/);
  assert.match(indexHtml, /value="endesga-8">Endesga 8/);
  assert.match(indexHtml, /value="funkyfuture-8">FunkyFuture 8/);
  assert.match(indexHtml, /value="dracula">Dracula/);
  assert.match(indexHtml, /value="nord">Nord/);
  assert.match(indexHtml, /#000871/);
  assert.match(indexHtml, /#63ffba/);
  assert.match(indexHtml, /#ff8c5c/);
  assert.match(indexHtml, /#fbf5ef/);
  assert.match(indexHtml, /#0d2b45/);
  assert.match(indexHtml, /#1b1c33/);
  assert.match(indexHtml, /#2b0f54/);
  assert.match(indexHtml, /#282a36/);
  assert.match(indexHtml, /#2e3440/);
  assert.match(indexHtml, /--row-highlight-fg: #282a36/);
  assert.match(indexHtml, /--row-highlight-fg: #2e3440/);
  const webClient = await (await fetch(`${base}/webclient.js`)).text();
  for (const icon of ['claude.svg', 'folder.svg', 'notes.svg', 'openai.svg']) {
    const response = await fetch(`${base}/icons/${icon}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/svg+xml');
    assert.match(await response.text(), /<svg/);
  }
  assert.match(webClient, /message\.type/);
  assert.match(webClient, /agent_status/);
  assert.match(webClient, /className = 'issue-pill'/);
  assert.match(webClient, /className = 'issue-pill-icon'/);
  assert.match(webClient, /icon: 'github'/);
  assert.match(webClient, /icon: 'linear'/);
  assert.match(webClient, /function updateThemeContrast/);
  assert.match(webClient, /function contrastRatio/);
  assert.match(webClient, /function branchCell/);
  assert.match(webClient, /function repoCell/);
  assert.doesNotMatch(webClient, /const branch = document\.createElement\('code'\)/);
  assert.doesNotMatch(indexHtml, /<code id="modal-branch"/);
  assert.doesNotMatch(webClient, /cell\(row, item\.id\)/);
  assert.match(webClient, /newRepoSubmitting\.hidden = !busy/);
  assert.match(webClient, /newScratchpadSubmitting\.hidden = !busy/);
  assert.match(webClient, /item\.type === 'scratchpad' \? '' : item\.repo/);
  assert.match(webClient, /branch-icon-folder/);
  assert.match(webClient, /item\.gitClean === true/);
  assert.match(webClient, /item\.gitClean === false/);
  assert.match(webClient, /target = '_blank'/);
  assert.match(webClient, /github\.com/);
  assert.match(webClient, /linear\.app/);
  assert.match(webClient, /openSession\(message\.id\)/);
  assert.match(webClient, /panel-toggle/);
  assert.match(webClient, /status-action/);
  assert.match(webClient, /const actionable = item\.status === 'active' \|\| item\.status === 'paused'/);
  assert.match(webClient, /runStatusAction/);
  assert.match(webClient, /lastUsedCell\(row, item\.lastJoined\)/);
  assert.match(webClient, /agentCell\(row, item\)/);
  assert.match(webClient, /item\.agentStatus === 'working'/);
  assert.match(webClient, /item\.agentStatus === 'ready'/);
  assert.doesNotMatch(webClient, /item\.type !== 'misc' && item\.status === 'active' && item\.agentStatus/);
  assert.match(webClient, /className = 'agent-pill'/);
  assert.match(webClient, /if \(item\.status !== 'active'\)/);
  assert.match(webClient, /const indicator = document\.createElement\('button'\)/);
  assert.doesNotMatch(webClient, /createElement\(focusable \? 'button' : 'span'\)/);
  assert.match(webClient, /\/icons\/openai\.svg/);
  assert.match(webClient, /\/icons\/claude\.svg/);
  assert.match(webClient, /agent-icon-codex/);
  assert.match(webClient, /focusAgent\(item, indicator\)/);
  assert.match(webClient, /focus-agent/);
  assert.match(webClient, /'agent-set', \{ agent \}/);
  assert.match(webClient, /date\.toLocaleDateString\(\)/);
  assert.match(webClient, /filters\.addEventListener\('change', \(\) =>/);
  assert.match(webClient, /location\.search/);
  assert.match(webClient, /history\.pushState/);
  assert.match(webClient, /url\.searchParams\.set\('session', session\)/);
  assert.match(webClient, /history\.back\(\)/);
  assert.match(webClient, /function syncModalFromUrl/);
  assert.match(webClient, /openSession\(session, \{ expectedSession: session \}\)/);
  assert.match(webClient, /popstate/);
  assert.match(webClient, /function renderPagination/);
  assert.match(webClient, /function goToPage/);
  assert.match(webClient, /query\.set\('page', String\(currentPage\)\)/);
  assert.match(webClient, /query\.set\('perpage', perpageSelect\.value\)/);
  assert.match(webClient, /function saveAssociatedLinks/);
  assert.match(webClient, /function openSelectedPath/);
  assert.match(webClient, /postWorkstreamCommand\(id, 'open-path', \{\}\)/);
  assert.match(webClient, /'issue-add', \{ refs: additions \}/);
  assert.match(webClient, /'issue-remove', \{ ref \}/);
  assert.match(webClient, /linkInput\.addEventListener\('blur', saveAssociatedLinks\)/);
  assert.match(webClient, /row-action/);
  assert.match(webClient, /item\.notesPath/);
  assert.match(webClient, /item\.worktreePresent/);
  assert.match(webClient, /\/icons\/folder\.svg/);
  assert.match(webClient, /\/icons\/notes\.svg/);
  assert.match(webClient, /'open-notes'/);
  assert.match(webClient, /Re-Open/);
  assert.match(webClient, /function refreshActionIcon/);
  assert.match(webClient, /classList\.add\('refresh-action-icon'\)/);
  assert.match(webClient, /ai-workstream-theme/);
  assert.match(webClient, /socket\.addEventListener\('error',.*scheduleReconnect/s);
  assert.match(webClient, /fetch\('\/ws\/new'\)/);
  assert.match(webClient, /fetch\('\/ws', \{/);
  assert.match(webClient, /createNewRepoSession/);
  assert.match(webClient, /newRepoModal\.showModal\(\)/);
  assert.match(webClient, /openSession\(id, \{ pushHistory: true \}\)/);
  assert.match(webClient, /fetch\('\/ws\/scratchpad', \{/);
  assert.match(webClient, /createNewScratchpadSession/);
  assert.match(webClient, /newScratchpadModal\.showModal\(\)/);
  assert.match(webClient, /scratchpadSlug/);
  const listing = await fetch(`${base}/ws/all/?type=repo&status=all&page=0&perpage=25`);
  assert.equal(listing.status, 200);
  const listingBody = await listing.json();
  assert.equal(listingBody.total, 2);
  assert.equal(listingBody.items.find((item) => item.id === repo.id).gitClean, null);
  const miscListing = await (await fetch(`${base}/ws/all/?type=misc&status=all`)).json();
  assert.deepEqual(
    miscListing.items.map((item) => [item.id, item.status]),
    [['notes', 'paused'], ['dotfiles', 'active'], ['savefiles', 'paused']],
  );
  const savefilesDetail = await (await fetch(`${base}/ws/savefiles/?status=all`)).json();
  assert.equal(savefilesDetail.items[0].repo, 'fritzy/savefiles');
  assert.equal(savefilesDetail.items[0].branch, 'main');
  assert.equal(savefilesDetail.items[0].closeable, false);
  const closedMisc = await (await fetch(`${base}/ws/all/?type=misc&status=closed`)).json();
  assert.equal(closedMisc.total, 0);
  const newDefaults = await (await fetch(`${base}/ws/new`)).json();
  assert.deepEqual(newDefaults, {
    repositoryRoot: config.paths.repositories,
    scratchpadRoot: config.paths.scratchpads,
    agent: 'claude',
    panels: config.panels,
  });
  const detail = await (await fetch(`${base}/ws/${repo.id}/?status=all`)).json();
  assert.equal(detail.items[0].gitClean, false);
  assert.deepEqual(detail.items[0].panels, {
    tabOpen: true, shell: true, editor: false, agent: true,
  });
  const pathOpened = await fetch(`${base}/ws/${repo.id}/open-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(pathOpened.status, 200);
  assert.deepEqual((await pathOpened.json()).result, { opener: 'xdg-open', path: repo.path });
  assert.deepEqual(openedPaths, [repo.path]);

  const agentFocused = await fetch(`${base}/ws/${repo.id}/focus-agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(agentFocused.status, 200);
  assert.deepEqual((await agentFocused.json()).result, {
    session: 'ws', tabName: `tab-${repo.id}`, paneId: 'terminal_7',
    terminalFocus: { focused: true, terminal: 'test', session: 'ws' },
  });
  assert.deepEqual(focusedAgents, [repo.id]);

  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/events`);
  t.after(() => socket.close());
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('websocket failed')), { once: true });
  });

  const nextMessage = () => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for websocket message')), 1000);
    socket.addEventListener('message', (event) => {
      clearTimeout(timeout);
      resolve(JSON.parse(event.data));
    }, { once: true });
  });

  checkedRepoClean = true;
  const gitStatusPromise = nextMessage();
  const staleGitDetail = await (await fetch(`${base}/ws/${repo.id}/?status=all`)).json();
  assert.equal(staleGitDetail.items[0].gitClean, false);
  assert.deepEqual(await gitStatusPromise, { id: repo.id, type: 'update_session' });
  const freshGitDetail = await (await fetch(`${base}/ws/${repo.id}/?status=all`)).json();
  assert.equal(freshGitDetail.items[0].gitClean, true);

  const createdPromise = nextMessage();
  const createdResponse = await fetch(`${base}/ws`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repository: 'example/project',
      selector: 'from-web',
      agent: 'codex',
      panels: ['editor', 'agent'],
      links: ['#321'],
    }),
  });
  assert.equal(createdResponse.status, 201);
  const createdFromWeb = await createdResponse.json();
  assert.equal(createdFromWeb.workstream.branch, 'from-web');
  assert.equal(createdFromWeb.workstream.agent, 'codex');
  assert.equal(createdFromWeb.workstream.gitClean, false);
  assert.equal(createdRepoGitChecks > 0, true);
  assert.equal(createdFromWeb.workstream.issues[0].ref, 'https://github.com/example/project/issues/321');
  assert.deepEqual(openedTabs, [createdFromWeb.workstream.id]);
  assert.deepEqual(openedTabOptions, [{ agent: 'codex', panels: ['editor', 'agent'] }]);
  assert.deepEqual(await createdPromise, { id: createdFromWeb.workstream.id, type: 'new_session' });

  const scratchCreatedPromise = nextMessage();
  const scratchCreatedResponse = await fetch(`${base}/ws/scratchpad`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'web notes',
      agent: 'claude',
      panels: ['shell', 'agent'],
      links: ['example/project#654'],
    }),
  });
  assert.equal(scratchCreatedResponse.status, 201);
  const scratchCreated = await scratchCreatedResponse.json();
  assert.equal(scratchCreated.workstream.type, 'scratchpad');
  assert.equal(scratchCreated.workstream.branch, 'web-notes');
  assert.equal(scratchCreated.workstream.issues[0].ref, 'https://github.com/example/project/issues/654');
  assert.deepEqual(openedTabs, [createdFromWeb.workstream.id, scratchCreated.workstream.id]);
  assert.deepEqual(openedTabOptions.at(-1), { agent: 'claude', panels: ['shell', 'agent'] });
  assert.deepEqual(await scratchCreatedPromise, { id: scratchCreated.workstream.id, type: 'new_session' });

  const addedPromise = nextMessage();
  const added = upsertWorkstream(db, {
    org: 'example', repo: 'project', branch: 'new-session', source: 'origin',
    path: join(dir, 'new-session'),
    created_at: '2026-08-26T13:00:00.000Z',
    last_joined_at: '2026-08-26T13:00:00.000Z',
  });
  assert.deepEqual(await addedPromise, { id: added.id, type: 'new_session' });

  const updatePromise = nextMessage();
  const paused = await fetch(`${base}/ws/${repo.id}/pause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(paused.status, 200);
  assert.equal((await paused.json()).workstream.status, 'paused');
  assert.deepEqual(closedTabs, [repo.id]);
  assert.deepEqual(await updatePromise, { id: repo.id, type: 'update_session' });

  const resumePromise = nextMessage();
  const resumed = await fetch(`${base}/ws/${repo.id}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(resumed.status, 200);
  assert.equal((await resumed.json()).workstream.status, 'active');
  assert.deepEqual(openedTabs, [createdFromWeb.workstream.id, scratchCreated.workstream.id, repo.id]);
  assert.deepEqual(await resumePromise, { id: repo.id, type: 'update_session' });

  const panelPromise = nextMessage();
  const toggled = await fetch(`${base}/ws/${repo.id}/panel-toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ panel: 'editor' }),
  });
  assert.equal(toggled.status, 200);
  assert.deepEqual((await toggled.json()).result, { panel: 'editor', open: true });
  assert.deepEqual(toggledPanels, [{ id: repo.id, panel: 'editor' }]);
  assert.deepEqual(await panelPromise, { id: repo.id, type: 'update_session' });

  const linkedPromise = nextMessage();
  const linked = await fetch(`${base}/ws/${repo.id}/issue-add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: '#123' }),
  });
  assert.equal(linked.status, 200);
  assert.equal((await linked.json()).result.issues[0].ref, 'https://github.com/example/project/issues/123');
  assert.deepEqual(await linkedPromise, { id: repo.id, type: 'update_session' });

  const unlinkedPromise = nextMessage();
  const unlinked = await fetch(`${base}/ws/${repo.id}/issue-remove`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ref: 'https://github.com/example/project/issues/123' }),
  });
  assert.equal(unlinked.status, 200);
  assert.deepEqual(await unlinkedPromise, { id: repo.id, type: 'update_session' });

  const agentStatusPromise = nextMessage();
  setAgentStatus(db, repo.id, 'working');
  assert.deepEqual(await agentStatusPromise, {
    id: repo.id,
    type: 'agent_status',
    status: 'working',
  });
  const statusDetail = await (await fetch(`${base}/ws/${repo.id}/?status=all`)).json();
  assert.equal(statusDetail.items[0].agentStatus, 'working');

  const configuredAgentPromise = nextMessage();
  setConfiguredLocationAgentStatus(db, 'dotfiles', 'ready');
  assert.deepEqual(await configuredAgentPromise, {
    id: 'dotfiles',
    type: 'agent_status',
    status: 'ready',
  });
  const dotfilesDetail = await (await fetch(`${base}/ws/dotfiles/?status=all`)).json();
  assert.equal(dotfilesDetail.items[0].agentStatus, 'ready');
  assert.equal(dotfilesDetail.items[0].agent, 'claude');
  assert.deepEqual(dotfilesDetail.items[0].panels, {
    tabOpen: true, shell: true, editor: false, agent: true,
  });

  const dotfilesFocused = await fetch(`${base}/ws/dotfiles/focus-agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(dotfilesFocused.status, 200);
  assert.equal((await dotfilesFocused.json()).result.paneId, 'terminal_7');
  assert.deepEqual(focusedAgents, [repo.id, 'dotfiles']);

  const dotfilesPanelPromise = nextMessage();
  const dotfilesPanel = await fetch(`${base}/ws/dotfiles/panel-toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ panel: 'editor' }),
  });
  assert.equal(dotfilesPanel.status, 200);
  assert.deepEqual((await dotfilesPanel.json()).result, { panel: 'editor', open: true });
  assert.deepEqual(toggledPanels.at(-1), { id: 'dotfiles', panel: 'editor' });
  assert.deepEqual(await dotfilesPanelPromise, { id: 'dotfiles', type: 'update_session' });

  const dotfilesAgentSetPromise = nextMessage();
  const dotfilesAgentSet = await fetch(`${base}/ws/dotfiles/agent-set`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent: 'codex' }),
  });
  assert.equal(dotfilesAgentSet.status, 200);
  const dotfilesAgentSetBody = await dotfilesAgentSet.json();
  assert.equal(dotfilesAgentSetBody.workstream.agent, 'codex');
  assert.equal(dotfilesAgentSetBody.workstream.agentStatus, null);
  assert.equal(dotfilesAgentSetBody.result.replaced, true);
  assert.deepEqual(replacedAgents, [{ id: 'dotfiles', agent: 'codex' }]);
  assert.deepEqual(await dotfilesAgentSetPromise, { id: 'dotfiles', type: 'update_session' });

  const dotfilesPausePromise = nextMessage();
  const dotfilesPaused = await fetch(`${base}/ws/dotfiles/pause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(dotfilesPaused.status, 200);
  assert.equal((await dotfilesPaused.json()).workstream.status, 'paused');
  assert.deepEqual(await dotfilesPausePromise, { id: 'dotfiles', type: 'update_session' });

  const notesResumePromise = nextMessage();
  const notesResumed = await fetch(`${base}/ws/notes/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(notesResumed.status, 200);
  assert.equal((await notesResumed.json()).workstream.status, 'active');
  assert.deepEqual(await notesResumePromise, { id: 'notes', type: 'update_session' });
  const notesDetail = await (await fetch(`${base}/ws/notes/?status=all`)).json();
  assert.equal(notesDetail.items[0].status, 'active');

  for (const body of [{}, { remove: true, force: true }]) {
    const rejected = await fetch(`${base}/ws/notes/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(rejected.status, 400);
  }
  assert.equal(openTabSet.has('notes'), true);
});
