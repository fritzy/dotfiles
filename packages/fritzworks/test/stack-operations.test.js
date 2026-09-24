import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executeStack, previewStack } from '../lib/stack-operations.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'fw-stack-'));
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE workstreams (id INTEGER PRIMARY KEY, uuid TEXT, parent_id INTEGER, branch TEXT, source TEXT, status TEXT, path TEXT)');
  const allocations = new Map();
  const heads = new Map();
  const dirty = new Map();
  const commands = [];
  let remote = 'git@github.com:example/project.git';
  let failedBranch = null;
  for (let id = 1; id <= 3; id++) {
    const path = join(root, `branch-${id}`);
    mkdirSync(path);
    db.prepare('INSERT INTO workstreams VALUES (?,?,?,?,?,?,?)').run(id, `uuid-${id}`, id === 1 ? null : id - 1, `branch-${id}`, 'origin', 'active', path);
    allocations.set(`uuid-${id}`, { path, common_dir: join(root, 'repository.git'), branch: `branch-${id}`, repository_id: 'repo', status: 'ready' });
    heads.set(path, `head-${id}`);
  }
  const context = { db, configRevision: 'config', ownerId: () => 2,
    gitStorage: { record: (uuid) => allocations.get(uuid), verify: (allocation) => { assert.ok(allocation); return allocation; } },
    runProcess: (exe, args) => {
      commands.push([exe, ...args]);
      assert.ok(['git', 'gh'].includes(exe));
      if (exe === 'gh') return { status: 0, stdout: args.includes('link') ? 'linked' : 'v1' };
      const path = args[1];
      const operation = args.slice(2);
      if (operation[0] === 'status') return { status: 0, stdout: dirty.get(path) || '' };
      if (operation[0] === 'symbolic-ref') return { status: 0, stdout: 'refs/remotes/origin/main' };
      if (operation[0] === 'remote') return { status: 0, stdout: remote };
      if (operation[0] === 'rev-parse') {
        if (operation[1] === '--git-path') return { status: 0, stdout: join(path, operation[2]) };
        return { status: 0, stdout: operation[1] === '--verify' ? 'trunk-head' : heads.get(path) };
      }
      if (operation[0] === 'rebase') {
        if (path.endsWith(failedBranch || '!')) return { status: 1, stderr: 'conflict' };
        heads.set(path, `rebased-${heads.get(path)}`);
        return { status: 0, stdout: 'success' };
      }
      throw new Error(`unexpected mocked command: ${JSON.stringify(args)}`);
    },
  };
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { context, commands, allocations, heads, dirty, setRemote: (value) => { remote = value; }, failBranch: (value) => { failedBranch = value; } };
}
const intentFor = (context, kind = 'stack-rebase', body = {}) => ({ kind, target: 'uuid-2', body: { ...body, stackRevision: previewStack(context, 'uuid-2', kind, body).revision } });

test('stack preview uses persisted storage and changes revision when HEAD, dirty, chain or remote changes', (t) => {
  const f = fixture(t);
  const first = previewStack(f.context, 'uuid-2', 'stack-link');
  assert.equal(first.available, true);
  assert.equal(first.chain[0].repositoryId, 'repo');
  const path = first.chain[1].path;
  f.heads.set(path, 'new-head');
  assert.notEqual(previewStack(f.context, 'uuid-2', 'stack-link').revision, first.revision);
  f.dirty.set(path, ' M file');
  assert.match(previewStack(f.context, 'uuid-2', 'stack-rebase').blocked.join(), /uncommitted/);
  f.dirty.clear();
  f.setRemote('/local/repository');
  assert.match(previewStack(f.context, 'uuid-2', 'stack-link').blocked.join(), /GitHub/);
  assert.equal(f.commands.some((args) => args.includes('rebase') || args.includes('link')), false);
});

test('stale preview and missing ownership prevent all rebase effects', (t) => {
  const f = fixture(t);
  const intent = intentFor(f.context);
  const path = f.allocations.get('uuid-2').path;
  f.heads.set(path, 'changed');
  assert.throws(() => executeStack(f.context, intent), /changed since preview/);
  assert.throws(() => executeStack(f.context, { kind: 'stack-rebase', target: 'uuid-2' }), /requires a current preview/);
  f.allocations.delete('uuid-2');
  assert.match(previewStack(f.context, 'uuid-2', 'stack-rebase').blocked.join(), /migrated/);
  assert.equal(f.commands.some((args) => args.includes('rebase')), false);
});

test('cascading rebase uses actual updated parent heads and preserves partial conflict result', (t) => {
  const f = fixture(t);
  f.failBranch('branch-3');
  const events = [];
  const result = executeStack(f.context, intentFor(f.context), { progress: (event) => events.push(event) });
  assert.equal(result.ok, false);
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0].onto, 'head-1');
  assert.equal(result.steps[0].head, 'rebased-head-2');
  assert.equal(result.steps[1].onto, 'rebased-head-2');
  assert.equal(result.steps[1].error, 'conflict');
  assert.equal(events.at(-1).stage, 'stopped');
  assert.equal(f.commands.some((args) => args.includes('--abort') || args.includes('reset')), false);
});

test('cancellation stops between branches and exposes already completed effects', (t) => {
  const f = fixture(t);
  const signal = { aborted: false };
  assert.throws(() => executeStack(f.context, intentFor(f.context), { signal, progress: (event) => {
    if (event.stage === 'rebased') signal.aborted = true;
  } }), (error) => error.name === 'AbortError' && error.partialResult.steps.length === 1);
  assert.equal(f.commands.filter((args) => args.includes('rebase')).length, 1);
});

test('unfinished Git operations, repository mismatches and fork branches block stack jobs', (t) => {
  const f = fixture(t);
  const allocation = f.allocations.get('uuid-2');
  writeFileSync(join(allocation.path, 'MERGE_HEAD'), 'merge');
  assert.match(previewStack(f.context, 'uuid-2', 'stack-rebase').blocked.join(), /unfinished/);
  rmSync(join(allocation.path, 'MERGE_HEAD'));
  allocation.repository_id = 'other';
  assert.match(previewStack(f.context, 'uuid-2', 'stack-rebase').blocked.join(), /share a recorded/);
  allocation.repository_id = 'repo';
  f.context.db.prepare("UPDATE workstreams SET source='fork:other' WHERE id=2").run();
  assert.match(previewStack(f.context, 'uuid-2', 'stack-link').blocked.join(), /fork branches/);
});

test('trunk preview pins the cached default branch commit without implicit fetch', (t) => {
  const f = fixture(t);
  const result = executeStack(f.context, intentFor(f.context, 'stack-rebase', { trunk: true }));
  assert.equal(result.ok, true);
  assert.equal(result.steps[0].onto, 'trunk-head');
  assert.equal(result.steps.length, 3);
  assert.equal(f.commands.some((args) => args.includes('fetch')), false);
});

test('stack link uses persisted worktrees and reports possible partial external effects', (t) => {
  const f = fixture(t);
  const intent = intentFor(f.context, 'stack-link', { open: true });
  const run = f.context.runProcess;
  f.context.runProcess = (exe, args, options) => {
    if (exe === 'gh' && args.includes('link')) {
      assert.equal(options.cwd, f.allocations.get('uuid-1').path);
      assert.equal(options.env.GH_REPO, 'example/project');
      assert.equal(options.env.GH_HOST, 'github.com');
      assert.deepEqual(args, ['stack', 'link', '--open', 'branch-1', 'branch-2', 'branch-3']);
      return { status: 1, stderr: 'network failed after push' };
    }
    return run(exe, args, options);
  };
  const result = executeStack(f.context, intent);
  assert.equal(result.ok, false);
  assert.match(result.externalEffects, /partially/);
});

test('allocation changes between effects stop the stack and retain completed steps', (t) => {
  const f = fixture(t);
  const result = executeStack(f.context, intentFor(f.context), { progress: (event) => {
    if (event.stage === 'rebased') f.allocations.get('uuid-3').path += '-relocated';
  } });
  assert.equal(result.ok, false);
  assert.equal(result.steps.length, 1);
  assert.match(result.error, /allocation/);
  assert.equal(f.commands.filter((args) => args.includes('rebase')).length, 1);
});

test('matching fetch and push URLs cannot redirect a recorded GitHub stack to a fork', (t) => {
  const f = fixture(t);
  f.context.db.exec("ALTER TABLE workstreams ADD COLUMN org TEXT DEFAULT 'example'; ALTER TABLE workstreams ADD COLUMN repo TEXT DEFAULT 'project'");
  f.setRemote('git@github.com:other/project.git');
  assert.match(previewStack(f.context, 'uuid-2', 'stack-link').blocked.join(), /recorded GitHub repository/);
});
