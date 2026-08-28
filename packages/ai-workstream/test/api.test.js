import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
  linkPr,
  listIssues,
  openDb,
  setAgentStatus,
  setConfiguredLocationAgentStatus,
  setConfiguredLocationShellStatus,
  selectedAgent,
  setCachedGitClean,
  setStatus,
  setShellStatus,
  upsertWorkstream,
  workstreamSlug,
} from '../lib/core.js';

async function waitUntil(predicate, message, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

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
    commands: {
      shell: ['zsh', '-l'], editor: ['nvim', '--clean'], claude: ['claude'], codex: ['codex'],
    },
    models: {
      claude: { default: 'opus', scratch: 'sonnet' },
      codex: { default: null, scratch: null },
    },
  };
  return { db, dir, repo, scratch, closed, config };
}

test('REST query model filters types and statuses and paginates consistently', (t) => {
  const { db, repo, config } = fixture(t);
  setCachedGitClean(db, repo.id, true);
  setShellStatus(db, repo.id, 'ready');
  const notesPath = join(config.paths.notes, 'work', '2026', 'workstream', workstreamSlug(repo));
  mkdirSync(notesPath, { recursive: true });
  addIssue(db, repo.id, 'https://github.com/example/project/issues/42');
  setConfiguredLocationAgentStatus(db, 'dotfiles', 'ready');
  setConfiguredLocationShellStatus(db, 'dotfiles', 'working');
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
  assert.equal(activeRepos.items[0].shellStatus, 'ready');
  assert.equal(activeRepos.items[0].notesPath, notesPath);
  assert.equal(activeRepos.items[0].createdAt, '2026-08-26T12:00:00.000Z');
  assert.equal(activeRepos.items[0].issues[0].createdAt.length > 0, true);
  setCachedGitClean(db, repo.id, false);
  assert.equal(queryWorkstreams(db, { id: String(repo.id), status: 'all' }, { config }).items[0].gitClean, false);

  const misc = queryWorkstreams(db, { id: 'all', type: 'misc', status: 'all' }, {
    config, terminalSessionIds: ['dotfiles'],
  });
  assert.deepEqual(misc.items.map((item) => item.id), ['notes', 'dotfiles', 'savefiles']);
  assert.deepEqual(misc.items.map((item) => item.status), ['paused', 'active', 'paused']);
  assert.deepEqual(misc.items.map((item) => item.agentStatus), [null, 'ready', null]);
  assert.deepEqual(misc.items.map((item) => item.shellStatus), [null, 'working', null]);
  assert.deepEqual(misc.items.map((item) => item.repo), ['fritzy/notes', 'fritzy/dotfiles', 'fritzy/savefiles']);
  assert.deepEqual(misc.items.map((item) => item.repoUrl), [
    'https://github.com/fritzy/notes', 'https://github.com/fritzy/dotfiles', 'https://github.com/fritzy/savefiles',
  ]);
  assert.deepEqual(misc.items.map((item) => item.branch), ['main', 'main', 'main']);
  assert.deepEqual(misc.items.map((item) => item.closeable), [false, false, false]);
  assert.deepEqual(
    queryWorkstreams(db, { id: 'all', type: 'misc', status: 'active' }, {
      config, terminalSessionIds: ['dotfiles'],
    }).items.map((item) => item.id),
    ['dotfiles'],
  );
  const all = queryWorkstreams(db, { id: 'all', status: 'all', perpage: '100' }, {
    config, terminalSessionIds: ['dotfiles'],
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
  assert.deepEqual(response.result, { browserTerminals: 'pause_requested' });
  assert.deepEqual(closedTabs, []);
  response = executeWorkstreamCommand(db, String(repo.id), 'rename', { name: 'API work' });
  assert.equal(response.workstream.id, repo.id);
  const scratchPath = scratch.path;
  const renamedTabs = [];
  response = executeWorkstreamCommand(db, String(scratch.id), 'rename', { name: 'Project ideas' }, {
    renameTab: (oldName, newName) => {
      renamedTabs.push([oldName, newName]);
      return true;
    },
  });
  assert.equal(response.workstream.name, 'Project ideas');
  assert.equal(response.workstream.branch, 'ideas');
  assert.equal(response.workstream.path, scratchPath);
  assert.equal(response.result.tabRenamed, true);
  assert.deepEqual(renamedTabs, [[
    `${scratch.id}:scratchpad:ideas`, `${scratch.id}:Project ideas`,
  ]]);
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
  response = executeWorkstreamCommand(db, 'dotfiles', 'pause', {}, {
    config,
  });
  assert.equal(response.workstream.status, 'paused');
  response = executeWorkstreamCommand(db, 'savefiles', 'resume', { panels: ['shell', 'agent'] }, {
    config,
  });
  assert.equal(response.workstream.status, 'paused');
  assert.deepEqual(response.result, { browserTerminals: 'resume_requested', panels: ['shell', 'agent'] });
  response = executeWorkstreamCommand(db, 'notes', 'resume', { panels: ['shell', 'editor', 'agent'] }, {
    config,
  });
  assert.equal(response.workstream.status, 'paused');
  assert.deepEqual(response.result, {
    browserTerminals: 'resume_requested', panels: ['shell', 'editor', 'agent'],
  });
  let configuredPanel;
  response = executeWorkstreamCommand(db, 'notes', 'panel-toggle', { panel: 'editor' }, {
    config,
    terminalSessionIds: ['notes'],
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
    terminalSessionIds: ['dotfiles'],
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
  response = executeWorkstreamCommand(db, String(scratch.id), 'resume', { panels: ['shell', 'agent'] }, {
    openTab: (row, opts) => { opened = { id: row.id, opts }; },
  });
  assert.equal(response.workstream.status, 'paused');
  assert.equal(opened, undefined);
  assert.deepEqual(response.result, { browserTerminals: 'resume_requested', panels: ['shell', 'agent'] });
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
  const focusedShells = [];
  const replacedAgents = [];
  const renamedSessionTabs = [];
  const openTabSet = new Set(['dotfiles']);
  let checkedRepoClean = false;
  let createdRepoGitChecks = 0;
  let linearSuggestionLoads = 0;
  let linearSearchLoads = 0;
  let githubSuggestionLoads = 0;
  let serviceTime = Date.parse('2026-08-26T14:00:00.000Z');
  const prChecks = [];
  const seededSessions = [];
  const terminalPtys = [];
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
    checkPr: async (database, row, { checkedAt }) => {
      prChecks.push({ id: row.id, branch: row.branch, checkedAt });
      const prs = {
        feature: {
          number: 41,
          url: 'https://github.com/example/project/pull/41',
          state: 'MERGED',
        },
        'from-web': {
          number: 322,
          url: 'https://github.com/example/project/pull/322',
          state: 'OPEN',
        },
        done: {
          number: 40,
          url: 'https://github.com/example/project/pull/40',
          state: 'CLOSED',
        },
      };
      const pr = prs[row.branch];
      return linkPr(database, row, {
        checkedAt,
        run: () => ({
          status: 0,
          stdout: JSON.stringify(pr ? [{ ...pr, createdAt: checkedAt }] : []),
        }),
      });
    },
    listOpenTabs: () => [...openTabSet],
    openTab: (row, options) => {
      openedTabs.push(row.id);
      openedTabOptions.push(options);
      openTabSet.add(String(row.id));
    },
    writeSeed: (row, content) => {
      const path = join(dir, 'seeds', `${row.id}.md`);
      seededSessions.push({ id: row.id, content, path });
      return path;
    },
    materialize: (org, repository, branch) => {
      const path = join(dir, 'created', org, repository, branch.replaceAll('/', '-'));
      mkdirSync(path, { recursive: true });
      return path;
    },
    clock: () => new Date(serviceTime).toISOString(),
    createScratchpadEntry: (database, rawName) => {
      const name = (rawName || 'random-scratch').replace(/[^A-Za-z0-9._-]+/g, '-');
      const path = join(dir, 'scratchpads', name);
      mkdirSync(path, { recursive: true });
      return upsertWorkstream(database, {
        org: 'scratch', repo: 'scratch', branch: name, source: 'scratch', path,
        status: 'paused',
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
    renameTab: (oldName, newName) => {
      renamedSessionTabs.push([oldName, newName]);
      return true;
    },
    focusAgent: (row) => {
      focusedAgents.push(row.id);
      return { session: 'ws', tabName: `tab-${row.id}`, paneId: 'terminal_7' };
    },
    focusShell: (row) => {
      focusedShells.push(row.id);
      return { session: 'ws', tabName: `tab-${row.id}`, paneId: 'terminal_8' };
    },
    focusTerminal: (session) => ({ focused: true, terminal: 'test', session }),
    linearSuggestions: async () => {
      linearSuggestionLoads += 1;
      return [{
        provider: 'linear', id: 'ECO-42', title: 'Cycle issue', url: 'https://linear.app/acme/issue/ECO-42',
        group: 'Current ECO cycle', meta: 'Todo · unassigned',
      }];
    },
    linearSearch: async (query) => {
      linearSearchLoads += 1;
      return [{
        provider: 'linear', id: 'ECO-3380', title: `${query} result`,
        url: 'https://linear.app/chainguard/issue/ECO-3380/example',
        group: 'Linear search', meta: 'Triage · Nathan Fritz',
      }];
    },
    githubSuggestions: async () => {
      githubSuggestionLoads += 1;
      return [
        {
          provider: 'github', id: 'customer-issues#7', title: 'Escalation',
          url: 'https://github.com/chainguard-dev/customer-issues/issues/7',
          repository: 'chainguard-dev/customer-issues', group: 'Customer escalations',
        },
        {
          provider: 'github', id: 'mono#8', title: 'Review this',
          url: 'https://github.com/chainguard-dev/mono/pull/8',
          repository: 'chainguard-dev/mono', group: 'mono PRs',
        },
      ];
    },
    spawnTerminal: (options) => {
      let dataListener = null;
      const terminal = {
        options,
        writes: [],
        resizes: [],
        killed: false,
        onData(listener) {
          dataListener = listener;
          setImmediate(() => dataListener?.('\u001b[32mPTY_READY\u001b[0m'));
          return { dispose: () => { dataListener = null; } };
        },
        onExit() { return { dispose() {} }; },
        write(data) { this.writes.push(data); },
        resize(cols, rows) { this.resizes.push([cols, rows]); },
        kill() { this.killed = true; },
      };
      terminalPtys.push(terminal);
      return terminal;
    },
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

  const health = await (await fetch(`${base}/health`)).json();
  assert.match(health.revision, /^[a-f0-9]{16}$/);
  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  // Markdown previews load images a note links to; everything else stays same-origin.
  const csp = index.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /img-src 'self' data: blob: https:/);
  assert.match(index.headers.get('content-type'), /^text\/html/);
  const rootHtml = await index.text();
  assert.match(rootHtml, /<title>FritzWorks<\/title>/);
  assert.match(rootHtml, /<div id="root"><\/div>/);
  const v2Response = await fetch(`${base}/v2/`);
  assert.equal(v2Response.status, 200);
  assert.match(v2Response.headers.get('content-type'), /^text\/html/);
  const v2Html = await v2Response.text();
  assert.match(v2Html, /<title>FritzWorks<\/title>/);
  assert.match(v2Html, /<div id="root"><\/div>/);
  const v2Assets = [...v2Html.matchAll(/(?:src|href)="(\/v2\/assets\/[^"]+)"/g)]
    .map((match) => match[1]);
  assert.equal(v2Assets.length, 2);
  let v2MainJavascript = '';
  for (const asset of v2Assets) {
    const response = await fetch(`${base}${asset}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), asset.endsWith('.css') ? /^text\/css/ : /^text\/javascript/);
    const body = await response.text();
    assert.equal(body.length > 100, true);
    if (asset.endsWith('.js')) v2MainJavascript = body;
  }
  const terminalAssets = [...new Set(
    [...v2MainJavascript.matchAll(/LocalTerminal-[A-Za-z0-9_-]+\.(?:css|js)/g)].map((match) => match[0]),
  )];
  assert.equal(terminalAssets.length, 2);
  for (const asset of terminalAssets) {
    const response = await fetch(`${base}/v2/assets/${asset}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), asset.endsWith('.css') ? /^text\/css/ : /^text\/javascript/);
  }
  const fontResponse = await fetch(`${base}/v2/fonts/roboto-mono-latin.woff2`);
  assert.equal(fontResponse.status, 200);
  assert.equal(fontResponse.headers.get('content-type'), 'font/woff2');
  assert.equal((await fontResponse.arrayBuffer()).byteLength > 10_000, true);
  const fontLicenseResponse = await fetch(`${base}/v2/fonts/Roboto-Mono-OFL.txt`);
  assert.equal(fontLicenseResponse.status, 200);
  assert.match(fontLicenseResponse.headers.get('content-type'), /^text\/plain/);
  assert.match(await fontLicenseResponse.text(), /SIL OPEN FONT LICENSE/);
  for (const icon of ['check.svg', 'claude.svg', 'folder.svg', 'notes.svg', 'openai.svg']) {
    const response = await fetch(`${base}/icons/${icon}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/svg+xml');
    const svg = await response.text();
    assert.match(svg, /<svg/);
    if (icon === 'claude.svg') assert.match(svg, /fill="#000000"/);
  }
  const listing = await fetch(`${base}/ws/all/?type=repo&status=all&page=0&perpage=25`);
  assert.equal(listing.status, 200);
  const listingBody = await listing.json();
  assert.equal(listingBody.total, 2);
  assert.equal(listingBody.items.find((item) => item.id === repo.id).gitClean, null);
  assert.equal(listingBody.items.find((item) => item.id === repo.id).prDone, null);
  const miscListing = await (await fetch(`${base}/ws/all/?type=misc&status=all`)).json();
  assert.deepEqual(
    miscListing.items.map((item) => [item.id, item.status]),
    [['notes', 'paused'], ['dotfiles', 'paused'], ['savefiles', 'paused']],
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
    recentRepositories: ['example/project'],
    agent: 'claude',
    panels: config.panels,
  });
  const linearLinks = await (await fetch(`${base}/ws/link-suggestions/linear`)).json();
  assert.deepEqual(linearLinks.items.map((item) => item.id), ['ECO-42']);
  const searchedLinearLinks = await (await fetch(`${base}/ws/link-suggestions/linear?q=axlotl`)).json();
  assert.deepEqual(searchedLinearLinks.items.map((item) => item.id), ['ECO-3380']);
  const monoLinks = await (await fetch(`${base}/ws/link-suggestions/github?q=mono`)).json();
  assert.deepEqual(monoLinks.items.map((item) => item.id), ['mono#8']);
  await fetch(`${base}/ws/link-suggestions/linear`);
  await fetch(`${base}/ws/link-suggestions/linear?q=axlotl`);
  await fetch(`${base}/ws/link-suggestions/github`);
  assert.equal(linearSuggestionLoads, 1);
  assert.equal(linearSearchLoads, 1);
  assert.equal(githubSuggestionLoads, 2);
  const invalidLinks = await fetch(`${base}/ws/link-suggestions/gitlab`);
  assert.equal(invalidLinks.status, 400);
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

  const shellFocused = await fetch(`${base}/ws/${repo.id}/focus-shell`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(shellFocused.status, 200);
  assert.deepEqual((await shellFocused.json()).result, {
    session: 'ws', tabName: `tab-${repo.id}`, paneId: 'terminal_8',
    terminalFocus: { focused: true, terminal: 'test', session: 'ws' },
  });
  assert.deepEqual(focusedShells, [repo.id]);

  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/events`);
  t.after(() => socket.close());
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('websocket failed')), { once: true });
  });
  const nextMessage = (label = '') => new Promise((resolve, reject) => {
    const timeoutError = new Error(`timed out waiting for websocket message${label ? `: ${label}` : ''}`);
    const timeout = setTimeout(() => reject(timeoutError), 1000);
    socket.addEventListener('message', (event) => {
      clearTimeout(timeout);
      resolve(JSON.parse(event.data));
    }, { once: true });
  });

  const terminalUpgrade = await fetch(`${base}/ws/terminal`);
  assert.equal(terminalUpgrade.status, 426);
  assert.deepEqual(await terminalUpgrade.json(), { error: 'upgrade_required', websocket: '/ws/terminal' });
  const terminalSocket = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal`);
  const firstTerminalMessage = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('timed out waiting for terminal output')), 1000);
    terminalSocket.addEventListener('message', (event) => {
      clearTimeout(timeout);
      resolve(JSON.parse(event.data));
    }, { once: true });
  });
  await new Promise((resolve, reject) => {
    terminalSocket.addEventListener('open', resolve, { once: true });
    terminalSocket.addEventListener('error', () => reject(new Error('terminal websocket failed')), { once: true });
  });
  assert.deepEqual(await firstTerminalMessage, { type: 'output', data: '\u001b[32mPTY_READY\u001b[0m' });
  terminalSocket.send(JSON.stringify({ type: 'input', data: 'print hello\r' }));
  terminalSocket.send(JSON.stringify({ type: 'resize', cols: 132, rows: 41 }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(terminalPtys[0].writes, ['print hello\r']);
  assert.deepEqual(terminalPtys[0].resizes, [[132, 41]]);
  assert.equal(terminalPtys[0].options.cols, 80);
  assert.equal(terminalPtys[0].options.rows, 24);
  const terminalClosed = new Promise((resolve) => terminalSocket.addEventListener('close', resolve, { once: true }));
  terminalSocket.close();
  await terminalClosed;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(terminalPtys[0].killed, true);

  const beforeBrowserTerminal = await (await fetch(`${base}/ws/${repo.id}/?status=all`)).json();
  assert.equal(beforeBrowserTerminal.items[0].status, 'paused');
  const activeTerminalPromise = nextMessage('browser terminal active');
  const sessionTerminalSocket = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?session=${repo.id}`);
  await new Promise((resolve, reject) => {
    sessionTerminalSocket.addEventListener('open', resolve, { once: true });
    sessionTerminalSocket.addEventListener('error', () => reject(new Error('session terminal websocket failed')), { once: true });
  });
  assert.deepEqual(await activeTerminalPromise, { id: repo.id, type: 'update_session' });
  assert.equal(terminalPtys[1].options.cwd, repo.path);
  assert.equal(terminalPtys[1].options.command, 'zsh');
  assert.deepEqual(terminalPtys[1].options.args, ['-l']);
  assert.equal(terminalPtys[1].options.env.AI_WORKSTREAM_ID, String(repo.id));
  const activeBrowserTerminal = await (await fetch(`${base}/ws/${repo.id}/?status=all`)).json();
  assert.equal(activeBrowserTerminal.items[0].status, 'active');
  await waitUntil(
    () => prChecks.some((check) => check.id === repo.id),
    'terminal output did not trigger a branch PR check',
  );
  const checkedPrDetail = await (await fetch(`${base}/ws/${repo.id}/?status=all`)).json();
  assert.equal(checkedPrDetail.items[0].prDone, true);
  assert.equal(checkedPrDetail.items[0].issues.some(
    (issue) => issue.ref === 'https://github.com/example/project/pull/41'
  ), true);
  const initialTerminalPrChecks = prChecks.filter((check) => check.id === repo.id).length;
  sessionTerminalSocket.send(JSON.stringify({ type: 'input', data: 'within throttle\r' }));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(prChecks.filter((check) => check.id === repo.id).length, initialTerminalPrChecks);
  serviceTime += 3 * 60_000 + 1;
  sessionTerminalSocket.send(JSON.stringify({ type: 'input', data: 'after throttle\r' }));
  await waitUntil(
    () => prChecks.filter((check) => check.id === repo.id).length === initialTerminalPrChecks + 1,
    'terminal input did not recheck the branch PR after three minutes',
  );
  assert.deepEqual(await (await fetch(`${base}/ws/terminal-sessions`)).json(), {
    sessions: [{ id: repo.id, count: 1 }],
  });
  const secondSessionTerminalSocket = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?session=${repo.id}&role=editor`);
  await new Promise((resolve, reject) => {
    secondSessionTerminalSocket.addEventListener('open', resolve, { once: true });
    secondSessionTerminalSocket.addEventListener('error', () => reject(new Error('second session terminal websocket failed')), { once: true });
  });
  assert.deepEqual(await (await fetch(`${base}/ws/terminal-sessions`)).json(), {
    sessions: [{ id: repo.id, count: 2 }],
  });
  assert.equal(terminalPtys[2].options.command, 'nvim');
  assert.deepEqual(terminalPtys[2].options.args, ['--clean']);
  const pausedTerminalPromise = nextMessage('browser terminal paused');
  const sessionTerminalClosed = new Promise((resolve) => sessionTerminalSocket.addEventListener('close', resolve, { once: true }));
  sessionTerminalSocket.close();
  await sessionTerminalClosed;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(terminalPtys[1].killed, true);
  const stillActiveBrowserTerminal = await (await fetch(`${base}/ws/${repo.id}/?status=all`)).json();
  assert.equal(stillActiveBrowserTerminal.items[0].status, 'active');
  const secondSessionTerminalClosed = new Promise((resolve) => secondSessionTerminalSocket.addEventListener('close', resolve, { once: true }));
  secondSessionTerminalSocket.close();
  await secondSessionTerminalClosed;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(terminalPtys[2].killed, true);
  assert.deepEqual(await pausedTerminalPromise, { id: repo.id, type: 'update_session' });
  const pausedBrowserTerminal = await (await fetch(`${base}/ws/${repo.id}/?status=all`)).json();
  assert.equal(pausedBrowserTerminal.items[0].status, 'paused');

  mkdirSync(config.paths.dotfiles, { recursive: true });
  const dotfilesActivePromise = nextMessage('configured browser terminal active');
  let dotfilesTerminalSocket = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?session=dotfiles&role=agent`);
  await new Promise((resolve, reject) => {
    dotfilesTerminalSocket.addEventListener('open', resolve, { once: true });
    dotfilesTerminalSocket.addEventListener('error', () => reject(new Error('configured terminal websocket failed')), { once: true });
  });
  assert.deepEqual(await dotfilesActivePromise, { id: 'dotfiles', type: 'update_session' });
  assert.equal(terminalPtys[3].options.command, 'sh');
  assert.match(terminalPtys[3].options.args[1], /'claude' '--model' 'sonnet' '--continue'/);
  const activeDotfiles = await (await fetch(`${base}/ws/dotfiles/?status=all`)).json();
  assert.equal(activeDotfiles.items[0].status, 'active');

  checkedRepoClean = true;
  const gitStatusPromise = nextMessage('git status refresh');
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
  assert.equal(createdFromWeb.workstream.status, 'paused');
  assert.equal(createdFromWeb.workstream.gitClean, false);
  assert.equal(createdFromWeb.workstream.prDone, false);
  assert.equal(createdRepoGitChecks > 0, true);
  assert.equal(createdFromWeb.workstream.issues[0].ref, 'https://github.com/example/project/issues/321');
  assert.equal(createdFromWeb.workstream.issues.some(
    (issue) => issue.ref === 'https://github.com/example/project/pull/322'
  ), true);
  assert.equal(prChecks.filter((check) => check.id === createdFromWeb.workstream.id).length, 1);
  assert.deepEqual(openedTabs, []);
  assert.deepEqual(openedTabOptions, []);
  const createdRepoSeed = seededSessions.filter(
    (seeded) => seeded.id === createdFromWeb.workstream.id
  ).at(-1);
  assert.equal(createdRepoSeed.content, [
    'This is a new ws session to work on a repo. The following links are associated with this session. Use the linear skill with the cli and/or the gh cli to retrieve authed information.',
    '* https://github.com/example/project/issues/321',
    '* https://github.com/example/project/pull/322',
    'These links are for context. No action is to be taken based on these links nor their contents alone.',
    '',
  ].join('\n'));
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
  assert.equal(scratchCreated.workstream.status, 'paused');
  assert.equal(scratchCreated.workstream.issues[0].ref, 'https://github.com/example/project/issues/654');
  assert.deepEqual(openedTabs, []);
  assert.deepEqual(openedTabOptions, []);
  const scratchSeed = seededSessions.find((seeded) => seeded.id === scratchCreated.workstream.id);
  assert.equal(scratchSeed.content, [
    'This is a new ws session to work on a scratchpad. The following links are associated with this session. Use the linear skill with the cli and/or the gh cli to retrieve authed information.',
    '* https://github.com/example/project/issues/654',
    'These links are for context. No action is to be taken based on these links nor their contents alone.',
    '',
  ].join('\n'));
  assert.deepEqual(await scratchCreatedPromise, { id: scratchCreated.workstream.id, type: 'new_session' });

  const scratchRenamedPromise = nextMessage();
  const originalScratchPath = scratchCreated.workstream.path;
  const scratchRenamedResponse = await fetch(`${base}/ws/${scratchCreated.workstream.id}/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Web research notes' }),
  });
  assert.equal(scratchRenamedResponse.status, 200);
  const scratchRenamed = await scratchRenamedResponse.json();
  assert.equal(scratchRenamed.workstream.name, 'Web research notes');
  assert.equal(scratchRenamed.workstream.branch, 'web-notes');
  assert.equal(scratchRenamed.workstream.path, originalScratchPath);
  assert.deepEqual(renamedSessionTabs, [[
    `${scratchCreated.workstream.id}:scratchpad:web-notes`,
    `${scratchCreated.workstream.id}:Web research notes`,
  ]]);
  assert.deepEqual(await scratchRenamedPromise, {
    id: scratchCreated.workstream.id, type: 'update_session',
  });

  const addedPromise = nextMessage();
  const added = upsertWorkstream(db, {
    org: 'example', repo: 'project', branch: 'new-session', source: 'origin',
    path: join(dir, 'new-session'),
    status: 'paused',
    created_at: '2026-08-26T13:00:00.000Z',
    last_joined_at: '2026-08-26T13:00:00.000Z',
  });
  assert.deepEqual(await addedPromise, { id: added.id, type: 'new_session' });

  const checksBeforePause = prChecks.filter((check) => check.id === repo.id).length;
  const paused = await fetch(`${base}/ws/${repo.id}/pause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(paused.status, 200);
  assert.equal((await paused.json()).workstream.status, 'paused');
  assert.equal(prChecks.filter((check) => check.id === repo.id).length, checksBeforePause + 1);
  assert.deepEqual(closedTabs, []);

  const checksBeforeResume = prChecks.filter((check) => check.id === repo.id).length;
  const resumed = await fetch(`${base}/ws/${repo.id}/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ panels: ['shell', 'agent'] }),
  });
  assert.equal(resumed.status, 200);
  const resumedBody = await resumed.json();
  assert.equal(resumedBody.workstream.status, 'paused');
  assert.equal(prChecks.filter((check) => check.id === repo.id).length, checksBeforeResume + 1);
  assert.deepEqual(resumedBody.result, { browserTerminals: 'resume_requested', panels: ['shell', 'agent'] });
  assert.deepEqual(openedTabs, []);
  assert.deepEqual(openedTabOptions, []);

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

  const shellStatusPromise = nextMessage();
  setShellStatus(db, repo.id, 'ready');
  assert.deepEqual(await shellStatusPromise, {
    id: repo.id,
    type: 'shell_status',
    status: 'ready',
  });
  const shellStatusDetail = await (await fetch(`${base}/ws/${repo.id}/?status=all`)).json();
  assert.equal(shellStatusDetail.items[0].shellStatus, 'ready');

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

  const dotfilesShellFocused = await fetch(`${base}/ws/dotfiles/focus-shell`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(dotfilesShellFocused.status, 200);
  assert.equal((await dotfilesShellFocused.json()).result.paneId, 'terminal_8');
  assert.deepEqual(focusedShells, [repo.id, 'dotfiles']);

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
  const previousDotfilesAgentClosed = new Promise((resolve) => dotfilesTerminalSocket.addEventListener('close', resolve, { once: true }));
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
  assert.equal(dotfilesAgentSetBody.result.browserTerminalRestart, true);
  assert.deepEqual(replacedAgents, []);
  assert.deepEqual(await dotfilesAgentSetPromise, { id: 'dotfiles', type: 'update_session' });
  await previousDotfilesAgentClosed;
  assert.equal(terminalPtys[3].killed, true);
  dotfilesTerminalSocket = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?session=dotfiles&role=agent`);
  await new Promise((resolve, reject) => {
    dotfilesTerminalSocket.addEventListener('open', resolve, { once: true });
    dotfilesTerminalSocket.addEventListener('error', () => reject(new Error('replacement configured terminal websocket failed')), { once: true });
  });
  assert.equal(terminalPtys.at(-1).options.command, 'sh');
  assert.match(terminalPtys.at(-1).options.args[1], /codex/);
  assert.match(terminalPtys.at(-1).options.args[1], /resume/);

  const dotfilesPausePromise = nextMessage('configured browser terminal paused');
  const dotfilesTerminalClosed = new Promise((resolve) => dotfilesTerminalSocket.addEventListener('close', resolve, { once: true }));
  const dotfilesPaused = await fetch(`${base}/ws/dotfiles/pause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(dotfilesPaused.status, 200);
  assert.equal((await dotfilesPaused.json()).workstream.status, 'paused');
  await dotfilesTerminalClosed;
  assert.deepEqual(await dotfilesPausePromise, { id: 'dotfiles', type: 'update_session' });

  const notesResumed = await fetch(`${base}/ws/notes/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ panels: ['shell', 'agent'] }),
  });
  assert.equal(notesResumed.status, 200);
  assert.equal((await notesResumed.json()).workstream.status, 'paused');
  assert.deepEqual(openedTabOptions, []);
  const notesDetail = await (await fetch(`${base}/ws/notes/?status=all`)).json();
  assert.equal(notesDetail.items[0].status, 'paused');

  for (const body of [{}, { remove: true, force: true }]) {
    const rejected = await fetch(`${base}/ws/notes/close`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(rejected.status, 400);
  }
  assert.equal(openTabSet.has('notes'), false);

  const checksBeforeClose = prChecks.filter(
    (check) => check.id === createdFromWeb.workstream.id
  ).length;
  const closedRepo = await fetch(`${base}/ws/${createdFromWeb.workstream.id}/close`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(closedRepo.status, 200);
  assert.equal((await closedRepo.json()).workstream.status, 'closed');
  assert.equal(prChecks.filter(
    (check) => check.id === createdFromWeb.workstream.id
  ).length, checksBeforeClose + 1);
});

test('notes editor endpoints read, write, and remember markdown files', async (t) => {
  const { db, dir, config } = fixture(t);
  const service = createApiService({
    db,
    config,
    cwd: '/outside',
    pollInterval: 0,
    // A Thursday, so "this week" is the 2026-06-22 week.
    clock: () => '2026-06-25T16:30:00.000Z',
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
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const today = `## ${new Date('2026-06-25T16:30:00.000Z').toLocaleDateString('en-US', { weekday: 'long' })}`;

  const empty = await (await fetch(`${base}/notes/files`)).json();
  assert.equal(empty.root, join(dir, 'notes'));
  // Only the work tree is offered: no journal, and no per-session `ws note` files.
  assert.deepEqual(empty.weekly.map((entry) => [entry.kind, entry.exists]), [['work', false]]);
  assert.deepEqual(empty.files, []);

  const weekly = await fetch(`${base}/notes/weekly`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'work' }),
  });
  assert.equal(weekly.status, 200);
  const note = await weekly.json();
  assert.equal(note.created, true);
  assert.equal(note.path, join('work', '2026', '2026-06-22-week.md'));
  assert.match(note.todayHeading, new RegExp(`^${today}`));
  assert.equal(note.todayLine > 0, true);

  mkdirSync(join(dir, 'notes', 'journal', '2026'), { recursive: true });
  writeFileSync(join(dir, 'notes', 'journal', '2026', '2026-06-22-week.md'), '# private');
  mkdirSync(join(dir, 'notes', 'work', '2026', 'workstream', '7-example'), { recursive: true });
  writeFileSync(join(dir, 'notes', 'work', '2026', 'workstream', '7-example', 'note.md'), '# session note');

  const listed = await (await fetch(`${base}/notes/files`)).json();
  assert.deepEqual(listed.files.map((file) => file.path), [note.path]);
  assert.equal(listed.weekly.length, 1);
  assert.equal(listed.weekly[0].exists, true);

  const saved = await fetch(`${base}/notes/file`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: note.path, content: `${note.content}- [x] wrote the editor`, version: note.version }),
  });
  assert.equal(saved.status, 200);
  const reread = await (await fetch(`${base}/notes/file?path=${encodeURIComponent(note.path)}`)).json();
  assert.match(reread.content, /- \[x\] wrote the editor\n$/);

  const stale = await fetch(`${base}/notes/file`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: note.path, content: 'clobbered', version: note.version }),
  });
  assert.equal(stale.status, 409);

  const escape = await fetch(`${base}/notes/file?path=${encodeURIComponent('../../etc/passwd')}`);
  assert.equal(escape.status, 400);
  assert.equal((await fetch(`${base}/notes/file?path=work/2026/absent.md`)).status, 404);
  assert.equal((await fetch(`${base}/notes/nope`)).status, 404);

  const tabs = await fetch(`${base}/notes/tabs`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope: 'global', tabs: [{ path: note.path }], activePath: note.path }),
  });
  assert.equal(tabs.status, 200);
  const remembered = await (await fetch(`${base}/notes/tabs?scope=global`)).json();
  assert.deepEqual(remembered.tabs.map((tab) => tab.path), [note.path]);
  assert.equal(remembered.activePath, note.path);
  assert.deepEqual((await (await fetch(`${base}/notes/tabs?scope=other`)).json()).tabs, []);

  const rejected = await fetch(`${base}/notes/tabs`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tabs: [{ path: '../escape.md' }] }),
  });
  assert.equal(rejected.status, 400);
});
