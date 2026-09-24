import { selectedAgent } from './core.js';
import { repositoryInput } from './git-storage.js';
import { assertRemovableNotes } from './removal-policy.js';
import { accessSync, constants, existsSync, lstatSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { API_COMMANDS, requestedPanels, requiredAgent, requiredString } from './operations.js';
import { ApiError } from './operation-error.js';

const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const digest = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const metadata = new Set(['previewRevision', 'confirm', 'idempotencyKey', 'async']);
function cleanBody(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'body must be an object');
  return Object.fromEntries(Object.entries(body).filter(([key]) => !metadata.has(key)));
}
function executable(command) {
  return (isAbsolute(command) || command.includes('/') ? [resolve(command)] : (process.env.PATH || '').split(delimiter).map((directory) => join(directory, command))).some((path) => {
    try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; }
  });
}
function fileSnapshot(path) {
  if (!existsSync(path)) return null;
  const walk = (current) => {
    const stat = lstatSync(current, { bigint: true });
    const entry = [current, String(stat.dev), String(stat.ino), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)];
    if (stat.isSymbolicLink()) entry.push(readlinkSync(current));
    else if (stat.isDirectory()) entry.push(readdirSync(current).sort().map((name) => walk(join(current, name))));
    return entry;
  };
  try { return walk(path); } catch (error) { throw new ApiError(409, `cannot inspect affected files: ${error.message}`); }
}

export function createOperationPolicy(context) {
  const { db, config } = context;
  const providers = ['claude', 'codex'].map((id) => {
    const command = config.commands?.[id]?.[0] || id;
    const available = context.adapters.providerAvailable?.(id) ?? executable(command);
    return { id, command, available, ...(available ? {} : { reason: `configured executable is unavailable: ${command}` }) };
  });
  const requireProvider = (id) => { const provider = providers.find((item) => item.id === id); if (!provider?.available) throw new ApiError(409, provider?.reason || 'unknown provider'); };
  const commands = Object.fromEntries(['shell', 'editor', 'git', 'zellij'].map((id) => {
    const command = config.commands?.[id]?.[0] || id;
    const available = context.adapters.commandAvailable?.(id) ?? executable(command);
    return [id, { command, available, ...(available ? {} : { reason: `configured executable is unavailable: ${command}` }) }];
  }));
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const nativeOpenAvailable = context.adapters.nativeOpenAvailable?.() ?? ((process.platform === 'darwin' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) && executable(opener));
  const nativeOpen = { available: nativeOpenAvailable, ...(nativeOpenAvailable ? {} : { reason: 'No native file opener is available on this daemon' }) };
  const defaultPanels = () => providers.some((item) => item.id === config.agent && item.available)
    ? ['shell', 'agent'] : ['shell'];
  const rowFor = (target) => target.kind === 'location' ? { ...config.locations[target.id], id: target.id, source: 'configured', status: 'paused' }
    : db.prepare('SELECT * FROM workstreams WHERE uuid=?').get(target.id);
  const projection = (target) => {
    const row = rowFor(target);
    return { ...row, type: target.kind === 'location' ? 'misc' : row.source === 'scratch' ? 'scratchpad' : 'repo',
      name: row.name || row.label || row.branch, target, availableActions: actions(target) };
  };
  const actions = (target) => {
    const row = rowFor(target);
    const owned = context.terminalOwnership.status === 'owned';
    return Object.fromEntries(API_COMMANDS.map((command) => {
      let reason = null;
      if (target.kind === 'location' && !['pause', 'resume', 'open-path', 'open-notes', 'agent-set', 'terminal-reset'].includes(command)) reason = 'configured locations retain their files and identity';
      if (['archive', 'close'].includes(command) && row.status === 'closed') reason = 'session is already closed';
      if (command === 'resume' && (!commands.shell.available || !commands.zellij.available)) reason = commands.shell.reason || commands.zellij.reason;
      if (command === 'open-path' && !nativeOpen.available) reason = nativeOpen.reason;
      if (command === 'agent-set' && !providers.some((item) => item.available)) reason = 'no configured agent is available';
      if (['pause', 'resume', 'archive', 'close', 'agent-set', 'terminal-reset'].includes(command) && !owned) reason = 'terminal ownership migration is required';
      return [command, { available: !reason, ...(reason ? { reason } : {}) }];
    }));
  };
  function resolveContext(body = {}) {
    if (body.remote && !body.selector) throw new ApiError(400, 'remote context requires an explicit selector');
    if (body.selector !== undefined && body.selector !== null && body.selector !== '') {
      const target = context.resolveTarget(body.selector);
      return { target, workstream: projection(target), candidates: [] };
    }
    if (body.sessionId) {
      const target = context.resolveTarget(String(body.sessionId));
      return { target, workstream: projection(target), candidates: [] };
    }
    let targets = db.prepare('SELECT uuid, path FROM workstreams').all().map((row) => ({ target: { kind: 'session', id: row.uuid }, path: row.path }));
    targets.push(...Object.values(config.locations).map((row) => ({ target: { kind: 'location', id: row.id }, path: row.path })));
    if (body.cwd) {
      if (typeof body.cwd !== 'string' || !isAbsolute(body.cwd)) throw new ApiError(400, 'cwd must be an absolute path');
      const cwd = resolve(body.cwd);
      const matches = targets.filter(({ path }) => cwd === resolve(path) || cwd.startsWith(resolve(path) + '/')).sort((a, b) => b.path.length - a.path.length);
      if (matches.length && (matches.length === 1 || matches[0].path.length > matches[1].path.length)) {
        const target = matches[0].target;
        return { target, workstream: projection(target), candidates: [] };
      }
      targets = matches;
    }
    return { target: null, workstream: null, candidates: targets.map(({ target }) => projection(target)) };
  }
  function capabilities() {
    return { protocolVersion: 1, contracts: ['instance-bound-v1'], instanceId: context.instanceId, configRevision: context.configRevision,
      defaults: { agent: config.agent, panels: defaultPanels() }, providers,
      locations: Object.values(config.locations), creationModes: ['repository', 'scratchpad'],
      creation: { repository: !commands.shell.available ? commands.shell : commands.git, scratchpad: commands.shell },
      commands, features: { nativeOpen, shell: commands.shell, editor: commands.editor, git: commands.git, terminals: commands.zellij, agent: { available: providers.some((item) => item.available) },
        weeklyNotes: { available: config.notes?.weekly?.enabled === true }, jobs: { available: true } } };
  }
  function preview(input) {
    if (!input || typeof input !== 'object') throw new ApiError(400, 'intent is required');
    const body = cleanBody(input.body);
    const intent = { kind: input.kind, ...(input.command ? { command: input.command } : {}), body };
    const consequences = [];
    const snapshot = { instanceId: context.instanceId, configRevision: context.configRevision };
    let resolved = {};
    let confirmationRequired = false;
    if (['create-repo', 'create-scratchpad'].includes(intent.kind)) {
      context.assertTerminalOwnership();
      body.panels = requestedPanels(body.panels, body.agent ? ['shell', 'agent'] : defaultPanels());
      if (!commands.shell.available) throw new ApiError(409, commands.shell.reason);
      body.agent = requiredAgent(body.agent ?? config.agent);
      if (body.panels.includes('agent')) requireProvider(body.agent);
      if (body.panels.includes('editor') && !commands.editor.available) throw new ApiError(409, commands.editor.reason);
      if (body.seed != null && (typeof body.seed !== 'string' || Buffer.byteLength(body.seed) > 65536)) throw new ApiError(400, 'seed must be at most 64 KiB of markdown text');
      if (body.links !== undefined && !Array.isArray(body.links)) throw new ApiError(400, 'links must be an array');
      if (body.parent) {
        const parent = context.resolveTarget(String(body.parent));
        const row = rowFor(parent);
        if (parent.kind !== 'session' || row.source === 'scratch') throw new ApiError(400, 'parent must be a repository session');
        snapshot.parent = row;
      }
      if (intent.kind === 'create-repo') {
        if (!commands.git.available) throw new ApiError(409, commands.git.reason);
        body.repository = requiredString(body.repository, 'repository');
        body.selector = requiredString(body.selector, 'branch or ref');
        let repository;
        try { repository = repositoryInput(body.repository, config); } catch (error) { throw new ApiError(400, error.message); }
        if (/[\x00-\x20~^?*\[\]\\]/.test(body.selector) || body.selector.startsWith('-') || body.selector.includes('..') || body.selector.includes('@{')) throw new ApiError(400, 'invalid branch or ref');
        const providerLookup = repository.kind === 'github' && (/^#?\d+$/.test(body.selector) || body.selector.includes(':'));
        resolved = { source: providerLookup ? 'provider lookup required' : 'branch', branch: providerLookup ? null : body.selector,
          path: null, storageRoot: config.paths.worktrees || config.paths.repositories, providerLookup,
          panels: body.panels, agent: body.agent };
      } else {
        if (body.name !== undefined && typeof body.name !== 'string') throw new ApiError(400, 'name must be a string');
        resolved = { source: 'scratch', path: null, storageRoot: config.paths.scratchpads, panels: body.panels, agent: body.agent };
      }
      snapshot.sessions = db.prepare('SELECT uuid, org, repo, branch, path, parent_id, status FROM workstreams ORDER BY id').all();
      consequences.push('Allocate or reuse a session directory; retain existing session notes.');
    } else if (intent.kind === 'terminal-reset-all') {
      context.assertTerminalOwnership();
      snapshot.panels = db.prepare('SELECT * FROM panels ORDER BY id').all();
      snapshot.generations = db.prepare('SELECT * FROM terminal_hook_generations ORDER BY owner,provider,terminal').all();
      confirmationRequired = true;
      consequences.push('Restart all terminals owned by this daemon; running commands will stop.');
    } else if (['action', 'stack-rebase', 'stack-link'].includes(intent.kind)) {
      intent.target = context.resolveTarget(input.target);
      const row = rowFor(intent.target);
      snapshot.row = row;
      snapshot.generations = db.prepare('SELECT * FROM terminal_hook_generations WHERE owner=? ORDER BY provider,terminal').all(String(row.id));
      snapshot.panels = db.prepare('SELECT * FROM panels ORDER BY id').all();
      resolved = { target: intent.target, id: row.id, path: row.path, panels: defaultPanels() };
      if (intent.kind === 'action') {
        if (!API_COMMANDS.includes(intent.command)) throw new ApiError(400, 'unknown action');
        const permission = actions(intent.target)[intent.command];
        // Closing an already closed session remains idempotent.
        if (!permission.available && !(row.status === 'closed' && ['archive', 'close'].includes(intent.command) && intent.target.kind === 'session')) throw new ApiError(intent.target.kind === 'location' ? 400 : 409, permission.reason);
        if (['archive', 'close'].includes(intent.command)) {
          body.remove = body.keep === true ? false : body.remove === true || body.discard === true || (body.retention === 'automatic' && row.source !== 'scratch');
          if (body.remove) {
            confirmationRequired = true;
            snapshot.files = fileSnapshot(row.path);
            snapshot.notes = db.prepare('SELECT * FROM storage_owners WHERE owner_key=?').get(`session:${row.uuid}`);
            snapshot.allocation = db.prepare('SELECT * FROM worktree_storage WHERE session_uuid=?').get(row.uuid);
            assertRemovableNotes(db, row);
            snapshot.allNotes = db.prepare('SELECT * FROM storage_owners ORDER BY owner_key').all();
            if (row.source !== 'scratch' && existsSync(row.path)) {
              const dirty = context.adapters.worktreeDirty ? context.adapters.worktreeDirty(row.path) : (() => {
                const result = context.runProcess('git', ['-C', row.path, 'status', '--porcelain'], { encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
                if (result.error || result.status !== 0) throw new ApiError(409, 'cannot inspect worktree changes');
                return result.stdout.trim();
              })();
              resolved.dirty = dirty || null;
              if (dirty && body.force !== true) throw new ApiError(409, 'worktree has uncommitted changes; choose force to remove it', { code: 'dirty_worktree', dirty });
            }
            consequences.push(`Remove the owned session directory ${row.path}; retain session notes.`);
          } else consequences.push('Close the session and stop its terminals; retain files and notes.');
        }
        if (intent.command === 'terminal-reset') { confirmationRequired = true; consequences.push('Restart this session’s terminals; running commands will stop.'); }
        if (intent.command === 'resume') {
          const savedRoles = db.prepare("SELECT p.kind,p.terminal_role FROM panels p JOIN panel_groups g ON g.id=p.group_id WHERE g.owner_id=? ORDER BY p.position").all(String(row.id))
            .filter((panel) => ['terminal', 'ai'].includes(panel.kind)).map((panel) => panel.kind === 'ai' ? 'agent' : panel.terminal_role || 'shell');
          body.panels = requestedPanels(body.panels, savedRoles.includes('shell') ? [...new Set(savedRoles)] : defaultPanels());
          if (body.agent !== undefined) requiredAgent(body.agent);
        }
        if (intent.command === 'agent-set') requireProvider(requiredAgent(body.agent));
        if (intent.command === 'resume' && body.panels.includes('agent')) requireProvider(body.agent ?? selectedAgent(db, row.id, config.agent));
      } else {
        if (intent.target.kind !== 'session') throw new ApiError(400, 'stacks require a session');
        confirmationRequired = true;
        snapshot.stack = db.prepare('SELECT * FROM workstreams ORDER BY id').all();
        snapshot.stackState = context.previewStack?.(intent.target, intent.kind, body);
        resolved.stack = snapshot.stackState;
        if (snapshot.stackState?.blocked.length) throw new ApiError(409, snapshot.stackState.blocked.join('; '), { code: 'stack_unavailable', stack: snapshot.stackState });
        consequences.push(intent.kind === 'stack-rebase' ? 'Rebase stack branches; stop on conflict and retain the partial result.' : 'Push branches and update the GitHub pull-request stack.');
      }
    } else throw new ApiError(400, 'unknown intent kind');
    return { revision: digest({ intent, snapshot }), intent, resolved, consequences, confirmationRequired };
  }
  function validate(intent, revision, { confirm = false } = {}) {
    const result = preview(intent);
    if (revision !== undefined && revision !== result.revision) throw new ApiError(409, 'preview is stale; preview the action again', { code: 'stale_preview', preview: result });
    if (result.confirmationRequired && (!revision || confirm !== true)) throw new ApiError(409, 'review and confirm the action preview', { code: 'confirmation_required', preview: result });
    return result;
  }
  return { preview, validate, actions, resolveContext, capabilities, defaultPanels, projection };
}
