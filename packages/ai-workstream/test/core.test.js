import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  addIssue,
  addLog,
  computeTabName,
  issueKind,
  listIssues,
  listLogs,
  openDb,
  parentOf,
  resolveRow,
  setParent,
  stackLine,
  upsertWorkstream,
} from '../lib/core.js';

test('database operations preserve workstream, stack, issue, and log state', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-workstream-core-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDb(join(dir, 'workstreams.db'));
  t.after(() => db.close());
  const created = '2026-08-26T12:00:00.000Z';
  const parent = upsertWorkstream(db, {
    org: 'example', repo: 'project', branch: 'base', source: 'origin',
    path: join(dir, 'base'), created_at: created, last_joined_at: created,
  });
  let child = upsertWorkstream(db, {
    org: 'example', repo: 'project', branch: 'feature', source: 'origin',
    path: join(dir, 'feature'), created_at: created, last_joined_at: created,
  });
  child = setParent(db, child, parent);

  assert.equal(resolveRow(db, String(child.id)).branch, 'feature');
  assert.equal(resolveRow(db, 'example/project:base').id, parent.id);
  assert.equal(parentOf(db, child).id, parent.id);
  assert.deepEqual(stackLine(db, child).map((row) => row.branch), ['base', 'feature']);
  assert.equal(computeTabName(child), `${child.id}:project:feature`);

  assert.deepEqual(addIssue(db, child.id, 'https://github.com/example/project/issues/1'), {
    ref: 'https://github.com/example/project/issues/1', kind: 'github', added: true,
  });
  assert.equal(addIssue(db, child.id, 'https://github.com/example/project/issues/1').added, false);
  assert.equal(listIssues(db, child.id).length, 1);
  assert.equal(issueKind('ABC-123'), 'linear');

  addLog(db, child.id, 'found the cause');
  addLog(db, child.id, 'fixed it', true);
  assert.deepEqual(listLogs(db, child.id).map(({ body, done }) => ({ body, done })), [
    { body: 'found the cause', done: false },
    { body: 'fixed it', done: true },
  ]);
});

