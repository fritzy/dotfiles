import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { ApiError } from './operation-error.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const slug = (value) => value.replace(/[^A-Za-z0-9_.-]+/g, '-').slice(0, 60) || 'worktree';
const fail = (message) => { throw new ApiError(409, message, { code: 'git_storage_ownership' }); };

const githubUrl = (org, repo, config) => config.gitProtocol === 'ssh'
  ? `git@github.com:${org}/${repo}.git` : `https://github.com/${org}/${repo}.git`;

export function repositoryInput(value, config = {}) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new ApiError(400, 'repository is required');
  const source = value.trim();
  if (isAbsolute(source) || source.startsWith('./') || source.startsWith('../')) {
    const path = realpathSync(resolve(source));
    return { source: path, kind: 'local', org: 'local', repo: `${slug(basename(path))}-${hash(path).slice(0, 12)}` };
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source) && !source.split('/').some((v) => v === '.' || v === '..')) {
    const [org, repo] = source.split('/');
    return { source: githubUrl(org, repo, config), kind: 'github', org, repo };
  }
  if (!/^(https?:\/\/|ssh:\/\/|git:\/\/|file:\/\/|[\w.-]+@[\w.-]+:)/.test(source)) throw new ApiError(400, 'repository must be a local path, clone URL, or owner/repository');
  return { source, kind: 'url', org: 'remote', repo: `${slug(basename(source).replace(/\.git$/, ''))}-${hash(source).slice(0, 12)}` };
}

export function createGitStorage(db, config, { run, instanceId }) {
  const query = (args, statuses = [0]) => {
    const result = run('git', args, { encoding: 'utf8', timeout: 120000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    if (result.error || !statuses.includes(result.status)) throw new Error(result.error?.message || String(result.stderr || 'Git operation failed').trim());
    return result;
  };
  const git = (args) => String(query(args).stdout || '').trim();
  const hasRef = (common, ref) => query(['--git-dir', common, 'show-ref', '--verify', '--quiet', ref], [0, 1]).status === 0;
  const commonDirectory = (path) => realpathSync(git(['-C', path, 'rev-parse', '--path-format=absolute', '--git-common-dir']));
  const record = (uuid) => db.prepare(`SELECT w.*, r.common_dir, r.kind, r.source AS repository_source
    FROM worktree_storage w JOIN repository_storage r ON r.id=w.repository_id WHERE session_uuid=?`).get(uuid);
  const verify = (allocation) => {
    if (!existsSync(allocation.path)) fail(`worktree unavailable: ${allocation.path}`);
    if (commonDirectory(allocation.path) !== realpathSync(allocation.common_dir)) fail('worktree belongs to a different repository');
    const branch = git(['-C', allocation.path, 'symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (branch !== allocation.branch) fail('worktree branch no longer matches its allocation');
    const listing = git(['--git-dir', allocation.common_dir, 'worktree', 'list', '--porcelain']);
    if (!listing.split('\n').includes(`worktree ${realpathSync(allocation.path)}`)) fail('worktree is not registered with its recorded repository');
    return allocation;
  };
  const verifyRemoved = (allocation) => {
    try { lstatSync(allocation.path); fail('removed worktree path is occupied'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (realpathSync(dirname(allocation.path)) !== allocation.removed_parent
      || realpathSync(allocation.common_dir) !== join(allocation.removed_parent, '.bare')) fail('removed worktree storage binding changed');
    if (git(['--git-dir', allocation.common_dir, 'rev-parse', '--is-bare-repository']) !== 'true') fail('legacy cache is not a bare repository');
    if (!hasRef(allocation.common_dir, `refs/heads/${allocation.branch}`)) fail('removed worktree branch is unavailable');
    const listing = git(['--git-dir', allocation.common_dir, 'worktree', 'list', '--porcelain']);
    for (const line of listing.split('\n')) {
      if (line === `branch refs/heads/${allocation.branch}`
        || (line.startsWith('worktree ') && resolve(line.slice(9)) === join(allocation.removed_parent, basename(allocation.path)))) {
        fail('missing worktree still has a repository registration');
      }
    }
    return allocation;
  };
  const repository = (input) => {
    let saved = db.prepare('SELECT * FROM repository_storage WHERE source=?').get(input.source);
    if (saved) {
      if (!existsSync(saved.common_dir)) fail(`repository storage unavailable: ${saved.common_dir}`);
      return saved;
    }
    const id = hash(input.source);
    let common;
    if (input.kind === 'local') common = commonDirectory(input.source);
    else {
      const container = join(config.paths.repositories, id);
      common = join(container, 'repository.git');
      mkdirSync(dirname(container), { recursive: true });
      const ownerPath = join(container, 'owner.json');
      if (!existsSync(container)) {
        mkdirSync(container);
        writeFileSync(ownerPath, JSON.stringify({ instanceId, source: input.source, common }), { flag: 'wx', mode: 0o600 });
      }
      let owner;
      try { owner = JSON.parse(readFileSync(ownerPath, 'utf8')); }
      catch { fail(`unowned repository cache: ${container}`); }
      if (owner.instanceId !== instanceId || owner.source !== input.source) fail(`unowned repository cache: ${container}`);
      common = owner.common || common;
      if (dirname(common) !== container) fail('repository cache reservation escapes its container');
      const complete = () => {
        try { return git(['--git-dir', common, 'rev-parse', '--is-bare-repository']) === 'true'; }
        catch { return false; }
      };
      if (!owner.complete || !existsSync(common) || !complete()) {
        // Preserve interrupted clones; retry in a newly reserved directory.
        if (existsSync(common)) common = join(container, `repository-${randomUUID()}.git`);
        const pending = `${ownerPath}.next`;
        writeFileSync(pending, JSON.stringify({ instanceId, source: input.source, common }), { mode: 0o600 });
        renameSync(pending, ownerPath);
        git(['clone', '--bare', '--', input.source, common]);
        if (!complete()) fail('cloned cache is not a verified bare repository');
        writeFileSync(pending, JSON.stringify({ instanceId, source: input.source, common, complete: true }), { mode: 0o600 });
        renameSync(pending, ownerPath);
      }
    }
    db.prepare('INSERT INTO repository_storage (id, source, common_dir, kind, layout_version) VALUES (?, ?, ?, ?, 2)')
      .run(id, input.source, common, input.kind);
    return db.prepare('SELECT * FROM repository_storage WHERE id=?').get(id);
  };
  const materialize = (row, { input, base } = {}) => {
    if (db.prepare("SELECT 1 FROM storage_migrations WHERE kind='relocation' AND status!='complete' AND json_extract(plan_json,'$.uuid')=?").get(row.uuid)) fail('worktree has an interrupted relocation; recover it first');
    let saved = record(row.uuid);
    if (!saved) {
      if (!input) fail('worktree requires explicit storage migration');
      const repo = repository(input);
      const path = join(config.paths.worktrees || join(config.paths.repositories, 'worktrees'), `${slug(row.branch)}-${row.uuid}`);
      if (existsSync(path)) fail(`unowned worktree destination: ${path}`);
      db.prepare(`INSERT INTO worktree_storage (session_uuid, repository_id, path, branch, source, layout_version, status)
        VALUES (?, ?, ?, ?, ?, 2, 'allocating')`).run(row.uuid, repo.id, path, row.branch, row.source);
      saved = record(row.uuid);
    }
    if (existsSync(saved.path)) {
      verify(saved);
      db.prepare("UPDATE worktree_storage SET status='ready' WHERE session_uuid=?").run(row.uuid);
      return saved.path;
    }
    if (!existsSync(saved.common_dir)) fail(`repository storage unavailable: ${saved.common_dir}`);
    mkdirSync(dirname(saved.path), { recursive: true });
    git(['check-ref-format', '--branch', saved.branch]);
    const branchExists = hasRef(saved.common_dir, `refs/heads/${saved.branch}`);
    let start = base || 'HEAD';
    if (!branchExists && !base && row.source?.startsWith('pr:')) {
      git(['--git-dir', saved.common_dir, 'fetch', 'origin', `refs/pull/${row.source.slice(3)}/head`]);
      start = 'FETCH_HEAD';
    } else if (!branchExists && !base && row.source?.startsWith('fork:')) {
      git(['--git-dir', saved.common_dir, 'fetch', githubUrl(row.source.slice(5), row.repo, config), row.branch]);
      start = 'FETCH_HEAD';
    } else if (!branchExists && !base) {
      const tracking = `refs/remotes/origin/${saved.branch}`;
      if (saved.kind === 'local') {
        if (hasRef(saved.common_dir, tracking)) start = tracking;
      } else {
        const remote = query(['--git-dir', saved.common_dir, 'ls-remote', '--exit-code', 'origin', `refs/heads/${saved.branch}`], [0, 2]);
        if (remote.status === 0) {
          git(['--git-dir', saved.common_dir, 'fetch', 'origin', `+refs/heads/${saved.branch}:${tracking}`]);
          start = tracking;
        }
      }
    }
    git(['--git-dir', saved.common_dir, 'worktree', 'add', ...(branchExists ? [saved.path, saved.branch] : ['-b', saved.branch, saved.path, start])]);
    verify(saved);
    db.prepare("UPDATE worktree_storage SET status='ready' WHERE session_uuid=?").run(row.uuid);
    return saved.path;
  };
  const remove = (row) => {
    if (db.prepare("SELECT 1 FROM storage_migrations WHERE kind='relocation' AND status!='complete' AND json_extract(plan_json,'$.uuid')=?").get(row.uuid)) fail('worktree has an interrupted relocation; recover it first');
    const saved = record(row.uuid);
    if (!saved || resolve(row.path) !== resolve(saved.path)) fail('worktree requires explicit storage migration');
    verify(saved);
    git(['--git-dir', saved.common_dir, 'worktree', 'remove', '--force', saved.path]);
    db.prepare("UPDATE worktree_storage SET status='removed' WHERE session_uuid=?").run(row.uuid);
  };
  const pendingUuid = (input, branch) => db.prepare(`SELECT w.session_uuid FROM worktree_storage w JOIN repository_storage r ON r.id=w.repository_id
    WHERE r.source=? AND w.branch=? AND w.status='allocating'`).get(input.source, branch)?.session_uuid;
  return { pendingUuid, record, verify, verifyRemoved, materialize, remove, git, commonDirectory };
}
