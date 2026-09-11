import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { addIssue, openDb, upsertWorkstream, writeBrowserUiState } from '../lib/core.js';
import {
  PanelModelError,
  addPanel,
  addResource,
  createPanelGroup,
  ensureSessionPanelGroup,
  mergeTerminalGroups,
  migrateLegacyPanelState,
  openResourcePanel,
  readPanelLayout,
  removePanel,
  removeResource,
  syncDiscoveredSessionNotes,
  terminalIdentityForPanel,
  updatePanelGroup,
  updatePanel,
} from '../lib/panels.js';
import { browserTerminalSessionName } from '../lib/zellij.js';
import { panelCapacity, panelsToMinimize } from '../web-v2/src/panel-layout.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fritzworks-panels-'));
  const data = join(root, 'data');
  const notes = join(root, 'notes');
  const scratchpads = join(root, 'scratchpads');
  mkdirSync(data, { recursive: true });
  mkdirSync(notes, { recursive: true });
  mkdirSync(scratchpads, { recursive: true });
  const db = openDb(join(data, 'workstreams.db'));
  t.after(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root, data, notes, scratchpads, db,
    config: { home: root, locations: {}, paths: { data, notes, scratchpads } },
  };
}

test('legacy panel state migrates once without changing the legacy stores', (t) => {
  const { db, root, data, notes, config } = fixture(t);
  const sessionPath = join(root, 'repo');
  mkdirSync(sessionPath, { recursive: true });
  const row = upsertWorkstream(db, {
    org: 'example', repo: 'project', branch: 'feature', source: 'origin',
    path: sessionPath, status: 'paused', created_at: '2026-01-01T00:00:00Z',
    last_joined_at: '2026-01-01T00:00:00Z',
  });
  addIssue(db, row.id, 'https://example.com/issues/1');
  writeBrowserUiState(db, 'workspaces', {
    workspaces: [{ id: String(row.id), panelMode: 'three' }],
    activeWorkspaceId: String(row.id),
  });
  writeBrowserUiState(db, 'bottom-terminals', {
    terminals: [
      { id: 'terminal-left', label: 'Left', fontSize: 13 },
      { id: 'terminal-right', label: 'Right', fontSize: 15 },
      { id: 'terminal-loose', label: 'Loose', fontSize: 14 },
    ],
    groups: [{ id: 'old-split', members: ['terminal-left', 'terminal-right'], boundaries: [35] }],
    displayedId: 'terminal-right',
  });
  const markdown = join(root, 'legacy.md');
  writeFileSync(markdown, '# Legacy\n');
  const legacyTabs = JSON.stringify({
    global: { tabs: [{ source: 'file', path: markdown, name: 'Legacy' }], activePath: markdown },
  }, null, 2) + '\n';
  writeFileSync(join(data, 'editor-tabs.json'), legacyTabs);

  const migrated = migrateLegacyPanelState(db, { dataDir: data, config, cwd: root });
  assert.equal(migrated.migrated, true);
  const layout = readPanelLayout(db);
  const session = layout.groups.find((group) => group.ownerId === String(row.id));
  assert.deepEqual(session.panels.map((panel) => panel.terminalRole), ['shell', 'editor', 'agent']);
  assert.deepEqual(session.resources.map((resource) => resource.value), ['https://example.com/issues/1']);
  assert.equal(layout.activeGroupId, session.id);

  const terminalGroups = layout.groups.filter((group) => group.type === 'terminal');
  assert.deepEqual(
    terminalGroups.map((group) => group.panels.map((panel) => panel.id).join(',')).sort(),
    ['terminal-left,terminal-right', 'terminal-loose'].sort(),
  );
  const split = terminalGroups.find((group) => group.panels.length === 2);
  assert.deepEqual(split.panels.map((panel) => panel.width), [35, 65]);
  assert.equal(
    browserTerminalSessionName(terminalIdentityForPanel(
      split.panels[0],
      { owner_id: null },
    )),
    browserTerminalSessionName({ terminalId: 'terminal-left' }),
  );
  const unassigned = layout.groups.find((group) => group.label === 'Unassigned Markdown');
  assert.ok(unassigned);
  assert.equal(unassigned.panels.find((panel) => panel.kind === 'markdown').minimized, true);
  assert.equal(unassigned.resources[0].value, markdown);
  assert.equal(readFileSync(join(data, 'editor-tabs.json'), 'utf8'), legacyTabs);

  const revision = layout.revision;
  assert.deepEqual(migrateLegacyPanelState(db, { dataDir: data, config, cwd: root }), {
    migrated: false, revision,
  });
});

test('panel mutations enforce revisions, one AI panel, and persistent panel identities', (t) => {
  const { db, root } = fixture(t);
  const { group } = ensureSessionPanelGroup(db, {
    id: 42, type: 'repo', name: 'Feature', path: root,
  }, { bump: true });
  let revision = readPanelLayout(db).revision;
  assert.throws(
    () => updatePanelGroup(db, group.id, { label: 'Not allowed' }, revision),
    (error) => error instanceof PanelModelError && error.status === 400,
  );
  assert.throws(
    () => addPanel(db, group.id, { kind: 'ai' }, revision),
    (error) => error instanceof PanelModelError && error.status === 409,
  );

  const added = addPanel(db, group.id, { kind: 'terminal', label: 'Tests' }, revision);
  revision = added.revision;
  const identity = terminalIdentityForPanel({
    id: added.panel.id, kind: 'terminal', terminal_role: 'shell', legacy_terminal: 0,
  }, { owner_id: '42' });
  assert.deepEqual(identity, {
    sessionId: '42', role: 'shell', terminalId: added.panel.id, panelId: added.panel.id,
  });

  const minimized = updatePanel(db, added.panel.id, { minimized: true }, revision);
  revision = minimized.revision;
  assert.equal(minimized.panel.minimized, true);
  assert.throws(
    () => updatePanel(db, added.panel.id, { minimized: false }, revision - 1),
    (error) => error instanceof PanelModelError && error.status === 409
      && error.details.revision === revision,
  );
  const removed = removePanel(db, added.panel.id, revision);
  assert.equal(removed.panel.kind, 'terminal');
  assert.equal(readPanelLayout(db).groups.find((item) => item.id === group.id).panels.some(
    (panel) => panel.id === added.panel.id,
  ), false);
});

test('terminal groups receive distinct names and merge persistently', (t) => {
  const { db } = fixture(t);
  const first = createPanelGroup(db, { type: 'terminal' }, readPanelLayout(db).revision);
  const second = createPanelGroup(db, { type: 'terminal' }, first.revision);
  let layout = readPanelLayout(db);
  assert.deepEqual(
    layout.groups.filter((group) => group.type === 'terminal').map((group) => group.label).sort(),
    ['Terminal 1', 'Terminal 2'],
  );

  const renamed = updatePanelGroup(db, first.groupId, { label: 'Build logs' }, second.revision);
  assert.equal(renamed.group.label, 'Build logs');
  assert.equal(readPanelLayout(db).groups.find((group) => group.id === first.groupId).label, 'Build logs');

  const merged = mergeTerminalGroups(db, second.groupId, first.groupId, renamed.revision);
  layout = readPanelLayout(db);
  assert.equal(layout.groups.some((group) => group.id === second.groupId), false);
  const destination = layout.groups.find((group) => group.id === first.groupId);
  assert.deepEqual(destination.panels.map((panel) => panel.label), ['Terminal 1', 'Terminal 2']);
  assert.deepEqual(destination.panels.map((panel) => panel.position), [0, 1]);
  assert.deepEqual(destination.panels.map((panel) => panel.width), [1, 1]);
  assert.equal(layout.activeGroupId, first.groupId);
  assert.equal(merged.revision, layout.revision);

  const removedFirst = removePanel(db, destination.panels[0].id, merged.revision);
  assert.equal(removedFirst.groupRemoved, false);
  assert.ok(readPanelLayout(db).groups.some((group) => group.id === first.groupId));
  const removedLast = removePanel(db, destination.panels[1].id, removedFirst.revision);
  assert.equal(removedLast.groupRemoved, true);
  layout = readPanelLayout(db);
  assert.equal(layout.groups.some((group) => group.id === first.groupId), false);
  assert.equal(layout.activeGroupId, null);
});

test('terminals added to terminal-only groups do not acquire a workstream role', (t) => {
  const { db } = fixture(t);
  const created = createPanelGroup(db, { type: 'terminal' }, readPanelLayout(db).revision);
  const added = addPanel(db, created.groupId, { kind: 'terminal' }, created.revision);
  assert.equal(added.panel.terminalRole, null);
  assert.deepEqual(
    terminalIdentityForPanel(added.panel, { owner_id: null }),
    { sessionId: null, role: 'shell', terminalId: added.panel.id, panelId: added.panel.id },
  );
});

test('resources resolve from their owning session and protect discovered and dirty Markdown', (t) => {
  const { db, root, notes } = fixture(t);
  const sessionPath = join(root, 'session');
  mkdirSync(sessionPath, { recursive: true });
  const markdown = join(sessionPath, 'plan.md');
  writeFileSync(markdown, '# Plan\n');
  const row = upsertWorkstream(db, {
    org: 'example', repo: 'project', branch: 'resources', source: 'origin',
    path: sessionPath, status: 'paused', created_at: '2026-01-01T00:00:00Z',
    last_joined_at: '2026-01-01T00:00:00Z',
  });
  const { group } = ensureSessionPanelGroup(db, {
    id: row.id, type: 'repo', name: 'Resources', path: sessionPath,
  }, { bump: true });
  let revision = readPanelLayout(db).revision;
  const association = addResource(db, group.id, {
    kind: 'markdown', value: 'plan.md', label: 'Plan',
  }, revision, { cwd: root, home: root });
  assert.equal(association.resource.value, markdown);
  revision = association.revision;
  const opened = openResourcePanel(db, association.resource.id, {}, revision);
  revision = opened.revision;
  assert.equal(opened.panel.kind, 'markdown');
  assert.throws(
    () => removeResource(db, association.resource.id, { dirty: true }, revision),
    (error) => error instanceof PanelModelError && error.status === 409,
  );

  const discoveredDir = join(notes, 'work', '2025', 'workstream', `${row.id}-project-resources`);
  mkdirSync(discoveredDir, { recursive: true });
  writeFileSync(join(discoveredDir, '2025-12-31-note.md'), '# Note\n');
  syncDiscoveredSessionNotes(db, notes);
  const discovered = readPanelLayout(db).groups.find((item) => item.id === group.id)
    .resources.find((resource) => resource.discovered);
  assert.ok(discovered);
  assert.equal(discovered.disassociate, false);
  openResourcePanel(db, discovered.id, {}, readPanelLayout(db).revision);
  rmSync(discovered.value);
  syncDiscoveredSessionNotes(db, notes);
  const afterRemoval = addPanel(db, group.id, { kind: 'terminal', label: 'After note' }, readPanelLayout(db).revision);
  assert.equal(afterRemoval.panel.position, 3);
  assert.throws(
    () => removeResource(db, discovered.id, {}, readPanelLayout(db).revision),
    (error) => error instanceof PanelModelError && error.status === 404,
  );

  const discoveredAgainDir = join(notes, 'work', '2024', 'workstream', `${row.id}-project-resources`);
  mkdirSync(discoveredAgainDir, { recursive: true });
  writeFileSync(join(discoveredAgainDir, '2024-note.md'), '# Older note\n');
  syncDiscoveredSessionNotes(db, notes);
  const discoveredAgain = readPanelLayout(db).groups.find((item) => item.id === group.id)
    .resources.find((resource) => resource.discovered);
  assert.throws(
    () => removeResource(db, discoveredAgain.id, {}, readPanelLayout(db).revision),
    (error) => error instanceof PanelModelError && error.status === 403,
  );
});

test('capacity minimization is right-to-left, ignores pills, and retains one panel', () => {
  const panels = [
    { id: 'left', minimized: false },
    { id: 'already-minimized', minimized: true },
    { id: 'middle', minimized: false },
    { id: 'right', minimized: false },
  ];
  assert.equal(panelCapacity(1000), 3);
  assert.deepEqual(panelsToMinimize(panels, 700), ['right']);
  assert.deepEqual(panelsToMinimize(panels, 100), ['right', 'middle']);
  assert.deepEqual(panelsToMinimize([{ id: 'only', minimized: false }], 1), []);
});
