import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { stackLine } from './core.js';
import { ApiError } from './operation-error.js';

const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const githubRepository = (value) => String(value).trim().match(/^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?$/)?.[1]?.toLowerCase();
function command(context, executable, args, options = {}) {
  const result = context.runProcess(executable, args, { encoding: 'utf8', timeout: 120000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }, ...options });
  if (result.error || result.status !== 0) throw new ApiError(409,
    result.error?.message || String(result.stderr || result.stdout || `${executable} failed`).trim());
  return String(result.stdout || '').trim();
}
const git = (context, path, ...args) => command(context, 'git', ['-C', path, ...args]);
function state(context, allocation) {
  context.gitStorage.verify(allocation);
  const path = allocation.path;
  const head = git(context, path, 'rev-parse', 'HEAD');
  const dirty = git(context, path, 'status', '--porcelain', '--untracked-files=normal');
  const inProgress = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'].filter((name) => {
    const gitPath = git(context, path, 'rev-parse', '--git-path', name);
    return existsSync(isAbsolute(gitPath) ? gitPath : resolve(path, gitPath));
  });
  return { head, dirty, inProgress };
}

export function previewStack(context, target, kind, body = {}) {
  if (!['stack-rebase', 'stack-link'].includes(kind)) throw new ApiError(400, 'unsupported stack operation');
  const ownerId = context.ownerId(target);
  const row = context.db.prepare('SELECT * FROM workstreams WHERE id=?').get(ownerId);
  if (!row) throw new ApiError(400, 'stack operations require a repository session');
  const blocked = [];
  let chain;
  try { chain = stackLine(context.db, row); }
  catch (error) { throw new ApiError(409, error.message); }
  if (chain.length < 2 && !(kind === 'stack-rebase' && body.trunk)) blocked.push('a stack requires at least two repository sessions');
  const members = chain.map((member) => {
    const allocation = context.gitStorage.record(member.uuid);
    const value = { id: member.id, uuid: member.uuid, parentId: member.parent_id, branch: member.branch, status: member.status, source: member.source };
    if (!allocation || allocation.status !== 'ready' || member.path !== allocation.path) {
      blocked.push(`#${member.id} requires an available, migrated worktree allocation`);
      return value;
    }
    Object.assign(value, { path: allocation.path, commonDir: allocation.common_dir, repositoryId: allocation.repository_id });
    try {
      Object.assign(value, state(context, allocation));
      if (value.dirty) blocked.push(`#${member.id} has uncommitted changes`);
      if (value.inProgress.length) blocked.push(`#${member.id} has an unfinished Git operation`);
    } catch (error) { blocked.push(`#${member.id}: ${error.message}`); }
    return value;
  });
  if (new Set(members.map((member) => member.repositoryId)).size !== 1) blocked.push('stack worktrees must share a recorded repository');
  let trunk = null;
  let remote = null;
  if (!blocked.length && kind === 'stack-rebase' && body.trunk) {
    try {
      const ref = git(context, members[0].path, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD');
      trunk = { ref, head: git(context, members[0].path, 'rev-parse', '--verify', `${ref}^{commit}`) };
    } catch (error) { blocked.push(`default branch is unavailable; fetch and set origin/HEAD before previewing: ${error.message}`); }
  }
  if (!blocked.length && kind === 'stack-link') {
    try {
      const origin = git(context, members[0].path, 'remote', 'get-url', 'origin');
      const push = git(context, members[0].path, 'remote', 'get-url', '--push', 'origin');
      const repository = githubRepository(origin);
      remote = { origin, push, repository };
      if (!repository || repository !== githubRepository(push)) blocked.push('stack linking requires matching GitHub fetch and push destinations');
      if (chain.some((member) => member.org && member.repo && !['local', 'remote'].includes(member.org)
        && `${member.org}/${member.repo}`.toLowerCase() !== repository)) blocked.push('stack remote no longer matches its recorded GitHub repository');
      if (chain.some((member) => String(member.source).startsWith('fork:'))) blocked.push('fork branches cannot be linked as a canonical GitHub stack');
      command(context, 'gh', ['stack', '--version']);
    } catch (error) { blocked.push(`GitHub stack integration is unavailable: ${error.message}`); }
  }
  const snapshot = { kind, target: row.uuid, configRevision: context.configRevision, chain: members, trunk, remote, open: Boolean(body.open) };
  return { ...snapshot, revision: hash(snapshot), blocked, available: !blocked.length,
    effects: kind === 'stack-link'
      ? ['Push the selected branches and create or update GitHub pull requests through gh stack link.']
      : ['Rebase each branch in its recorded worktree. Stop at the first conflict and preserve completed steps.'],
  };
}

export function executeStack(context, intent, { signal, progress = () => {} } = {}) {
  if (context.policy) context.policy.validate(intent, intent.body?.previewRevision, { confirm: intent.body?.confirm });
  else if (!intent.body?.stackRevision) throw new ApiError(409, 'stack execution requires a current preview');
  const preview = previewStack(context, intent.target, intent.kind, intent.body);
  if (preview.blocked.length) throw new ApiError(409, preview.blocked.join('; '));
  // Policy validates the enclosing preview; direct callers must provide the stack revision.
  const revision = intent.body?.stackRevision;
  if (revision && revision !== preview.revision) throw new ApiError(409, 'stack changed since preview', { code: 'stale_preview' });
  const steps = [];
  const checkCancel = () => {
    if (signal?.aborted) throw Object.assign(new Error('Cancelled between stack effects; completed effects are preserved.'), { name: 'AbortError', partialResult: { ok: false, steps } });
  };
  checkCancel();
  if (intent.kind === 'stack-link') {
    progress({ stage: 'linking', branches: preview.chain.map((member) => member.branch), externalEffects: true });
    const args = ['stack', 'link', ...(preview.open ? ['--open'] : []), ...preview.chain.map((member) => member.branch)];
    try {
      const output = command(context, 'gh', args, { cwd: preview.chain[0].path,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GH_REPO: preview.remote.repository, GH_HOST: 'github.com' } });
      const result = { ok: true, output, branches: preview.chain.map((member) => member.branch) };
      progress({ stage: 'linked', result });
      return result;
    } catch (error) {
      return { ok: false, error: error.message, externalEffects: 'GitHub may have partially updated branches or pull requests. Inspect before retrying.' };
    }
  }
  const heads = new Map(preview.chain.map((member) => [member.uuid, member.head]));
  for (let i = preview.trunk ? 0 : 1; i < preview.chain.length; i++) {
    checkCancel();
    const member = preview.chain[i];
    const onto = i === 0 ? preview.trunk.head : heads.get(preview.chain[i - 1].uuid);
    const allocation = context.gitStorage.record(member.uuid);
    const row = context.db.prepare('SELECT * FROM workstreams WHERE uuid=?').get(member.uuid);
    if (!allocation || allocation.path !== member.path || allocation.common_dir !== member.commonDir
      || allocation.repository_id !== member.repositoryId || row?.parent_id !== member.parentId || row?.status !== member.status) {
      return { ok: false, steps, error: `#${member.id} allocation or stack membership changed during the job` };
    }
    let current;
    try { current = state(context, allocation); }
    catch (error) { return { ok: false, steps, error: error.message }; }
    if (current.head !== member.head || current.dirty || current.inProgress.length) {
      return { ok: false, steps, error: `#${member.id} changed after preview; no further branches were rebased` };
    }
    if (i > 0) {
      const parent = preview.chain[i - 1];
      let parentState;
      const parentAllocation = context.gitStorage.record(parent.uuid);
      if (!parentAllocation || parentAllocation.path !== parent.path || parentAllocation.repository_id !== parent.repositoryId) {
        return { ok: false, steps, error: `#${parent.id} allocation changed during the job` };
      }
      try { parentState = state(context, parentAllocation); }
      catch (error) { return { ok: false, steps, error: error.message }; }
      if (parentState.head !== heads.get(parent.uuid) || parentState.dirty || parentState.inProgress.length) {
        return { ok: false, steps, error: `#${parent.id} changed during the job; no further branches were rebased` };
      }
    }
    progress({ stage: 'rebasing', id: member.id, branch: member.branch, path: member.path, onto, completedSteps: [...steps] });
    try {
      const output = command(context, 'git', ['-C', member.path, 'rebase', onto]);
      const head = git(context, member.path, 'rev-parse', 'HEAD');
      heads.set(member.uuid, head);
      steps.push({ id: member.id, branch: member.branch, onto, path: member.path, head, ok: true, output });
    } catch (error) {
      steps.push({ id: member.id, branch: member.branch, onto, path: member.path, ok: false, error: error.message });
      progress({ stage: 'stopped', steps: [...steps], message: 'Inspect and resolve the worktree before retrying; no automatic abort or rollback was attempted.' });
      return { ok: false, steps };
    }
    progress({ stage: 'rebased', steps: [...steps] });
  }
  return { ok: true, steps };
}
