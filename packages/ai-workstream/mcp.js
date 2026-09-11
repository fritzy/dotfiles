#!/usr/bin/env -S node --no-warnings
// ai-workstream MCP server — exposes FritzWorks operations to AI agents. Session
// lifecycle calls use the daemon's HTTP API and shared browser workspace state;
// this stdio process never creates or manipulates terminal tabs.
//
// Transport is stdio (JSON-RPC over stdin/stdout) — no sockets, which also keeps
// it clear of the Falcon socket-exec issue noted in memory. core.js writes its
// diagnostics to stderr only, so stdout stays a clean protocol stream.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { readFileSync } from 'node:fs';

import { CONFIG } from './lib/config.js';
import {
  openDb, resolveRow, currentWorkstream,
} from './lib/core.js';
import {
  daemonTargets, requestDaemonService, resolveDaemonTarget, workstreamCommand,
} from './lib/client.js';

const PACKAGE = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const json = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });

// Resolve the workstream a tool acts on: explicit selector, else the worktree
// containing the server's current directory. Throws if neither is available.
function targetRow(db, selector) {
  if (selector) {
    const row = resolveRow(db, selector);
    if (!row) throw new Error(`no workstream matching "${selector}"`);
    return row;
  }
  const cur = currentWorkstream(db, process.cwd());
  if (cur) return cur;
  throw new Error('no workstream in context — run from inside a worktree or pass "workstream"');
}

function lifecycleTarget(db, selector) {
  if (selector && CONFIG.locations?.[selector]) return String(selector);
  return String(targetRow(db, selector).id);
}

const daemonView = (daemon) => ({
  id: daemon.id, name: daemon.name, url: daemon.url, local: daemon.local,
});

const serviceJson = (service, data) => json({ daemon: daemonView(service.daemon), ...data });

function workstreamTarget(selector, daemon, { configuredLocation = false } = {}) {
  const selectedDaemon = resolveDaemonTarget(daemon, CONFIG);
  if (!selectedDaemon.local) {
    if (!selector) {
      throw new Error(`workstream is required when targeting remote daemon "${selectedDaemon.id}"`);
    }
    return String(selector);
  }
  const db = openDb();
  return configuredLocation
    ? lifecycleTarget(db, selector)
    : String(targetRow(db, selector).id);
}

const workstreamPath = (id, suffix = '') => (
  `/ws/${encodeURIComponent(id)}${suffix ? `/${suffix}` : ''}`
);

function browserOpts({ seed, noVim, noEditor, agent, panels } = {}) {
  return {
    ...(seed ? { seed } : {}),
    ...(agent ? { agent } : {}),
    ...(noVim || noEditor ? { panels: ['shell', 'agent'] } : panels ? { panels } : {}),
  };
}
const noVimArg = z.boolean().optional()
  .describe('Deprecated alias for noEditor.');
const noEditorArg = z.boolean().optional()
  .describe('Use the two-panel browser workspace (shell and agent).');
const agentArg = z.enum(['claude', 'codex']).optional()
  .describe('Persist Claude Code or Codex as the browser workspace agent.');
const panelsArg = z.array(z.enum(['shell', 'editor', 'agent'])).min(1).optional()
  .describe('Browser layout: [shell, agent] or [shell, editor, agent].');
const seedArg = z.string().optional()
  .describe('Markdown prompt for the next newly-created browser agent terminal. Make it self-contained.');
const linksArg = z.array(z.string().min(1)).min(1).optional()
  .describe('Associated Linear/GitHub references or URLs. They are included in the new session\'s initial agent briefing.');
const daemonIds = daemonTargets(CONFIG).map((daemon) => daemon.id);
const daemonArg = z.enum(daemonIds).optional()
  .describe('Daemon id from ws_daemons. Defaults to local. Remote workstream actions require an explicit workstream selector.');
const workstreamArg = z.string().optional()
  .describe('Workstream selector: numeric id, branch name, or org/repo:branch. On local, defaults to the worktree containing the current directory; required for a remote daemon.');
const withDaemon = (schema = {}) => ({ ...schema, daemon: daemonArg });

const server = new McpServer({ name: 'ai-workstream', version: PACKAGE.version });

server.registerTool('ws_config', {
  description: 'Show the resolved FritzWorks configuration, including paths, commands, service, and agent defaults.',
  inputSchema: withDaemon(),
}, async ({ daemon }) => {
  const service = await requestDaemonService('/config', { daemon });
  return serviceJson(service, { config: service.result });
});

server.registerTool('ws_browser_refresh', {
  description: 'Ask every browser connected to the selected daemon to reload the full page and re-request its HTML, JavaScript, styles, images, and SVG assets.',
  inputSchema: withDaemon(),
}, async ({ daemon }) => {
  const service = await requestDaemonService('/browser/refresh', {
    daemon, method: 'POST', body: {},
  });
  return serviceJson(service, service.result);
});

server.registerTool('ws_daemons', {
  description: 'List daemon ids available to this MCP server. Pass one of these ids as daemon to any other ws tool.',
  inputSchema: withDaemon(),
}, async ({ daemon }) => json({
  selected: daemonView(resolveDaemonTarget(daemon, CONFIG)),
  daemons: daemonTargets(CONFIG).map(daemonView),
}));

server.registerTool('ws_list', {
  description: 'List ws-managed workstreams (git worktrees + their linked issues). '
    + 'Each has a status (active/paused/closed), whether its worktree is present on disk, '
    + 'and which one contains the current directory.',
  inputSchema: withDaemon({
    all: z.boolean().optional().describe('Include closed workstreams (default: only active + paused).'),
  }),
}, async ({ all, daemon }) => {
  const service = await requestDaemonService(
    `/ws/all?status=${all ? 'all' : 'active_paused'}&perpage=100`,
    { daemon },
  );
  const current = resolveDaemonTarget(daemon, CONFIG).local
    ? currentWorkstream(openDb(), process.cwd())?.id || null
    : null;
  return serviceJson(service, {
    current,
    workstreams: service.result.items,
  });
});

server.registerTool('ws_sync', {
  description: 'Explicitly sync a session’s Markdown resources and, when needed, look up its current branch PR.',
  inputSchema: withDaemon({ workstream: workstreamArg }),
}, async ({ workstream, daemon }) => {
  const id = workstreamTarget(workstream, daemon);
  const service = await requestDaemonService(workstreamPath(id, 'sync'), {
    daemon, method: 'POST', body: {},
  });
  return serviceJson(service, service.result);
});

async function currentPanelLayout(daemon) {
  return requestDaemonService('/panel-layout', { daemon });
}

async function mutatePanelLayout(path, body, daemon, current = null) {
  current ||= await currentPanelLayout(daemon);
  return requestDaemonService(path, {
    daemon,
    method: path.endsWith('/order') || /^\/panel-layout\/panels\/[^/]+$/.test(path) ? 'PUT' : 'POST',
    body: { client: 'mcp', revision: current.result.revision, ...body },
  });
}

async function selectedResourceGroup({ daemon, group, workstream }) {
  if (group && workstream) throw new Error('group and workstream are mutually exclusive');
  const current = await currentPanelLayout(daemon);
  if (group) {
    const selected = current.result.groups.find((item) => item.id === group);
    if (!selected) throw new Error(`no panel group "${group}"`);
    return { current, group: selected };
  }
  const target = workstreamTarget(workstream, daemon, { configuredLocation: true });
  let ownerId = target;
  let selected = current.result.groups.find((item) => String(item.ownerId) === ownerId);
  if (!selected) {
    const detail = await requestDaemonService(`${workstreamPath(target)}?status=all`, { daemon });
    ownerId = String(detail.result.items?.[0]?.id ?? target);
    selected = current.result.groups.find((item) => String(item.ownerId) === ownerId);
  }
  if (!selected) throw new Error(`no resource group for workstream "${target}"`);
  return { current, group: selected };
}

server.registerTool('ws_panel_layout', {
  description: 'List this daemon’s panel groups, ordered panels, associated resources, active group, and optimistic revision.',
  inputSchema: withDaemon(),
}, async ({ daemon }) => {
  const service = await currentPanelLayout(daemon);
  return serviceJson(service, { layout: service.result });
});

server.registerTool('ws_panel_add', {
  description: 'Add a persistent terminal or the single allowed AI panel to an existing panel group.',
  inputSchema: withDaemon({
    group: z.string().min(1).describe('Panel group id from ws_panel_layout.'),
    kind: z.enum(['terminal', 'ai']),
    label: z.string().min(1).optional(),
    minimized: z.boolean().optional(),
  }),
}, async ({ group, kind, label, minimized, daemon }) => {
  const service = await mutatePanelLayout(
    `/panel-layout/groups/${encodeURIComponent(group)}/panels`,
    { kind, ...(label ? { label } : {}), ...(minimized === undefined ? {} : { minimized }) },
    daemon,
  );
  return serviceJson(service, service.result);
});

server.registerTool('ws_panel_update', {
  description: 'Minimize, restore, rename, resize, or change the Edit/Preview mode of a panel.',
  inputSchema: withDaemon({
    panel: z.string().min(1).describe('Panel id from ws_panel_layout.'),
    minimized: z.boolean().optional(),
    label: z.string().min(1).optional(),
    width: z.number().positive().optional(),
    markdownMode: z.enum(['edit', 'preview']).optional(),
  }),
}, async ({ panel, daemon, ...changes }) => {
  if (Object.values(changes).every((value) => value === undefined)) throw new Error('provide at least one panel change');
  const service = await mutatePanelLayout(
    `/panel-layout/panels/${encodeURIComponent(panel)}`,
    Object.fromEntries(Object.entries(changes).filter(([, value]) => value !== undefined)),
    daemon,
  );
  return serviceJson(service, service.result);
});

server.registerTool('ws_panel_close', {
  description: 'Close a terminal or AI panel and kill its persistent process. Minimize it instead to keep the process running.',
  inputSchema: withDaemon({ panel: z.string().min(1).describe('Panel id from ws_panel_layout.') }),
}, async ({ panel, daemon }) => {
  const service = await mutatePanelLayout(
    `/panel-layout/panels/${encodeURIComponent(panel)}/close`, {}, daemon,
  );
  return serviceJson(service, service.result);
});

server.registerTool('ws_resource_add', {
  description: 'Add a link or Markdown resource. With content and no value, creates Markdown in the workstream’s configured session-notes directory.',
  inputSchema: withDaemon({
    group: z.string().min(1).optional().describe('Panel group id. Otherwise resolve workstream.'),
    workstream: workstreamArg,
    kind: z.enum(['link', 'markdown']).optional().describe('Defaults to markdown when content is supplied.'),
    value: z.string().min(1).optional().describe('URL or Markdown path. Omit when creating a session note.'),
    content: z.string().min(1).optional().describe('Create a new Markdown file with this content.'),
    title: z.string().min(1).optional().describe('Optional H1, filename slug, and label for new Markdown.'),
    label: z.string().min(1).optional(),
    open: z.boolean().optional()
      .describe('Defaults to false. Set true to immediately open the resource as a panel if its owning session is active. Markdown opens in Preview. Does not focus the session.'),
  }),
}, async ({ group, workstream, kind, value, content, title, label, open, daemon }) => {
  if (content === undefined && (!kind || !value)) {
    throw new Error('provide kind and value, or provide content to create Markdown');
  }
  if (content !== undefined && kind && kind !== 'markdown') {
    throw new Error('content can only create a Markdown resource');
  }
  const selected = await selectedResourceGroup({ daemon, group, workstream });
  const service = await mutatePanelLayout(
    `/panel-layout/groups/${encodeURIComponent(selected.group.id)}/resources`,
    {
      kind: kind || 'markdown',
      ...(value ? { value } : {}),
      ...(content !== undefined ? { content } : {}),
      ...(title ? { title } : {}),
      ...(label ? { label } : {}),
      ...(open === undefined ? {} : { open }),
    }, daemon, selected.current,
  );
  return serviceJson(service, service.result);
});

server.registerTool('ws_resource_list', {
  description: 'List resources for a workstream or group. Defaults to the current local workstream.',
  inputSchema: withDaemon({
    group: z.string().min(1).optional().describe('Panel group id. Otherwise resolve workstream.'),
    workstream: workstreamArg,
    kind: z.enum(['link', 'markdown']).optional(),
    all: z.boolean().optional().describe('List resources across every group on the daemon.'),
  }),
}, async ({ group, workstream, kind, all, daemon }) => {
  if (all && (group || workstream)) throw new Error('all cannot be combined with group or workstream');
  let current;
  let groups;
  if (all) {
    current = await currentPanelLayout(daemon);
    groups = current.result.groups;
  } else {
    const selected = await selectedResourceGroup({ daemon, group, workstream });
    current = selected.current;
    groups = [selected.group];
  }
  return serviceJson(current, {
    groups: groups.map((item) => ({
      id: item.id,
      ownerId: item.ownerId,
      label: item.label,
      markdownDirectory: item.markdownDirectory,
      resources: kind ? item.resources.filter((resource) => resource.kind === kind) : item.resources,
    })),
  });
});

server.registerTool('ws_resource_read', {
  description: 'Read an associated Markdown resource by resource id.',
  inputSchema: withDaemon({ resource: z.string().min(1).describe('Resource id from ws_resource_list.') }),
}, async ({ resource, daemon }) => {
  const service = await requestDaemonService(
    `/panel-layout/resources/${encodeURIComponent(resource)}`, { daemon },
  );
  return serviceJson(service, service.result);
});

server.registerTool('ws_resource_write', {
  description: 'Replace an associated Markdown resource by resource id.',
  inputSchema: withDaemon({
    resource: z.string().min(1).describe('Resource id from ws_resource_list.'),
    content: z.string().describe('Complete Markdown content.'),
    version: z.string().optional().describe('Version from ws_resource_read; omit to force.'),
  }),
}, async ({ resource, content, version, daemon }) => {
  const service = await requestDaemonService(
    `/panel-layout/resources/${encodeURIComponent(resource)}`,
    { daemon, method: 'PUT', body: { content, ...(version ? { version } : {}) } },
  );
  return serviceJson(service, service.result);
});

server.registerTool('ws_resource_open', {
  description: 'Open or restore an associated Markdown or link resource panel and select its owning group.',
  inputSchema: withDaemon({ resource: z.string().min(1).describe('Resource id from ws_panel_layout.') }),
}, async ({ resource, daemon }) => {
  const service = await mutatePanelLayout(
    `/panel-layout/resources/${encodeURIComponent(resource)}/open`, {}, daemon,
  );
  return serviceJson(service, service.result);
});

server.registerTool('ws_resource_remove', {
  description: 'Disassociate an explicit resource. Automatically discovered session notes cannot be removed.',
  inputSchema: withDaemon({ resource: z.string().min(1).describe('Resource id from ws_panel_layout.') }),
}, async ({ resource, daemon }) => {
  const service = await mutatePanelLayout(
    `/panel-layout/resources/${encodeURIComponent(resource)}/disassociate`, {}, daemon,
  );
  return serviceJson(service, service.result);
});

server.registerTool('ws_scratch', {
  description: 'Create a scratchpad in the configured scratchpad root (not a git worktree), '
    + 'and open it as the active FritzWorks browser workspace. With no name a random one is generated.',
  inputSchema: withDaemon({
    name: z.string().optional().describe('Optional scratchpad name (sanitized; suffixed if it already exists). Random if omitted.'),
    seed: seedArg,
    agent: agentArg,
    panels: panelsArg,
    noEditor: noEditorArg,
    links: linksArg,
  }),
}, async ({ name, seed, agent, panels, noEditor, links, daemon }) => {
  const service = await requestDaemonService('/ws/scratchpad', {
    daemon,
    method: 'POST',
    body: {
      ...(name ? { name } : {}),
      ...(links ? { links } : {}),
      ...browserOpts({ seed, agent, panels, noEditor }),
    },
  });
  return serviceJson(service, {
    workstream: service.result.workstream,
    browserWorkspace: service.result.browserWorkspace,
    serviceUrl: service.daemon.url,
  });
});

server.registerTool('ws_new', {
  description: 'Create (or open) a workstream: a git worktree for a repo at a ref, recorded in the '
    + 'db and opened as the active FritzWorks browser workspace. Clones the repo if it '
    + "isn't present yet, and routes branches through your fork automatically when the canonical "
    + 'repo blocks branch creation. The result is reflected in connected browser clients and remains '
    + 'queued in shared browser state when no client is open. Idempotent on an existing branch.',
  inputSchema: withDaemon({
    repo: z.string().describe('Repository as org/repo, e.g. chainguard-dev/mono.'),
    ref: z.string().describe('A branch name (created off the default branch if new), a PR number '
      + '(123 or #123, incl. fork PRs), or owner:branch for a branch on a fork.'),
    parent: z.string().optional().describe('Stack this workstream on another one (selector: id, branch, '
      + 'or org/repo:branch). A NEW branch in the same repo is created off the parent\'s branch instead of '
      + 'the default branch, so it builds on that work; the relationship is recorded either way and shows '
      + 'up in ws_stack. Use when the new work depends on an unmerged branch.'),
    seed: seedArg,
    noVim: noVimArg,
    noEditor: noEditorArg,
    agent: agentArg,
    panels: panelsArg,
    links: linksArg,
  }),
}, async ({ repo, ref, parent, seed, noVim, noEditor, agent, panels, links, daemon }) => {
  if (!repo.includes('/')) throw new Error('repo must be org/repo');
  const service = await requestDaemonService('/ws', {
    daemon,
    method: 'POST',
    body: {
      repository: repo,
      selector: ref,
      ...(parent ? { parent } : {}),
      ...(links ? { links } : {}),
      ...browserOpts({ seed, noVim, noEditor, agent, panels }),
    },
  });
  return serviceJson(service, {
    workstream: service.result.workstream,
    branchedOffParent: service.result.branchedOffParent,
    browserWorkspace: service.result.browserWorkspace,
    serviceUrl: service.daemon.url,
  });
});

server.registerTool('ws_resume', {
  description: 'Resume (rejoin) an existing workstream by selector: reconstitute its worktree if the '
    + 'directory was removed and open it as the active FritzWorks browser workspace. '
    + 'Active status is controlled only by connected browser terminals.',
  inputSchema: withDaemon({
    workstream: workstreamArg,
    seed: seedArg,
    noVim: noVimArg,
    noEditor: noEditorArg,
    agent: agentArg,
    panels: panelsArg,
  }),
}, async ({ workstream, seed, noVim, noEditor, agent, panels, daemon }) => {
  const id = workstreamTarget(workstream, daemon, { configuredLocation: true });
  const service = await workstreamCommand(
    id,
    'resume',
    browserOpts({ seed, noVim, noEditor, agent, panels }),
    { daemon },
  );
  return serviceJson(service, {
    workstream: service.result.workstream,
    browserWorkspace: service.result.browserWorkspace,
    serviceUrl: service.daemon.url,
  });
});

server.registerTool('ws_pause', {
  description: 'Pause a workstream: close its browser terminals but keep the worktree on disk (status: paused, '
    + 'resume is instant). Use this to set work aside without discarding anything. Defaults to the '
    + 'worktree containing the current directory.',
  inputSchema: withDaemon({ workstream: workstreamArg }),
}, async ({ workstream, daemon }) => {
  const id = workstreamTarget(workstream, daemon, { configuredLocation: true });
  const service = await workstreamCommand(id, 'pause', {}, { daemon });
  return serviceJson(service, {
    workstream: service.result.workstream,
    browserWorkspace: service.result.browserWorkspace,
    paused: true,
  });
});

server.registerTool('ws_rename', {
  description: 'Rename a workstream in FritzWorks. For a scratchpad this changes its display name; for a '
    + 'git-backed workstream this sets a display label while the underlying git '
    + 'branch is left untouched (renaming a real branch is a much bigger operation). Defaults to the '
    + 'worktree containing the current directory.',
  inputSchema: withDaemon({
    name: z.string().min(1).describe('The new name/label.'),
    workstream: workstreamArg,
  }),
}, async ({ name, workstream, daemon }) => {
  const id = workstreamTarget(workstream, daemon);
  const service = await workstreamCommand(id, 'rename', { name }, { daemon });
  return serviceJson(service, { workstream: service.result.workstream, renamed: true });
});

server.registerTool('ws_close', {
  description: 'Close a workstream in one call — no skill, no manual git inspection needed. '
    + 'Marks it closed and removes its workspace from FritzWorks. '
    + 'Defaults to the worktree containing the current directory. '
    + 'DISK: a git worktree is removed by default (its commits/branch survive in the bare clone, so '
    + 'the workstream stays fully resumable); pass keep:true to leave the worktree on disk. A '
    + 'SCRATCHPAD has no git backing, so its directory is KEPT by default — the scratchpad just goes '
    + 'to status:closed and stays resumable — and is only deleted when you pass force:true (an '
    + 'irreversible discard; confirm with the user first). '
    + 'SAFETY: if a git worktree being removed has uncommitted changes this refuses and returns the '
    + 'dirty file list without touching anything — relay it and only retry with force:true once the '
    + 'user confirms discarding. This tool replaces shelling out to `ws close`.',
  inputSchema: withDaemon({
    workstream: workstreamArg,
    keep: z.boolean().optional().describe('Keep the worktree/directory on disk; just close the browser workspace and mark closed. (Scratchpad dirs are kept by default regardless.)'),
    force: z.boolean().optional().describe('For a git worktree: remove it even with uncommitted changes (discards them). For a scratchpad: delete its directory (otherwise it is kept). Irreversible either way.'),
  }),
}, async ({ workstream, keep, force, daemon }) => {
  const id = workstreamTarget(workstream, daemon);
  const detail = await requestDaemonService(`${workstreamPath(id)}?status=all`, { daemon });
  const item = detail.result.items?.[0];
  if (!item) throw new Error(`no workstream matching "${id}"`);
  const scratch = item.type === 'scratchpad' || item.scratch === true;
  const remove = scratch ? Boolean(force) : !keep;
  try {
    const service = await workstreamCommand(id, 'close', { remove, force: Boolean(force) }, { daemon });
    return serviceJson(service, {
      workstream: service.result.workstream,
      closed: true,
      browserWorkspace: service.result.browserWorkspace,
      worktreeRemoved: service.result.result.removed,
      keptWorktree: !service.result.result.removed && service.result.workstream.worktreePresent,
      noun: scratch ? 'directory' : 'worktree',
    });
  } catch (error) {
    if (error.status !== 409) throw error;
    return serviceJson(detail, {
      workstream: item,
      closed: false,
      needsForce: true,
      reason: error.message,
      dirty: error.details?.dirty || [],
    });
  }
});

server.registerTool('ws_stack', {
  description: 'Show the stack a workstream sits in: the chain of parent/child ("stacked on") '
    + 'relationships, from the bottom branch up, as a tree. Use this to find out what unmerged work a '
    + "branch depends on and what depends on it — the answer isn't in git, since a branch doesn't record "
    + 'which branch it was cut from. Also reports whether the chain is eligible to become a stack of '
    + 'GitHub PRs (ws_stack_link), and if not, why not. Defaults to the worktree containing the current '
    + 'directory.',
  inputSchema: withDaemon({ workstream: workstreamArg }),
}, async ({ workstream, daemon }) => {
  const id = workstreamTarget(workstream, daemon);
  const service = await requestDaemonService(workstreamPath(id, 'stack'), { daemon });
  return serviceJson(service, service.result);
});

server.registerTool('ws_stack_set', {
  description: 'Record that one workstream is stacked on another — i.e. its branch builds on the '
    + "other's unmerged work — or clear that relationship with clear:true. This is bookkeeping only: it "
    + 'moves no commits and rewrites no history, so it is safe to correct at any time. Cycles and '
    + 'self-parenting are rejected. Cross-repo and scratchpad parents are allowed (useful to record that '
    + 'work follows from other work), but only a same-repo chain of real branches can become GitHub '
    + 'stacked PRs — see ws_stack. To rebase the commits so the branches actually sit on each other, '
    + 'the user can run `ws stack rebase` themselves (it rewrites history).',
  inputSchema: withDaemon({
    workstream: workstreamArg,
    parent: z.string().optional().describe('The workstream to stack it on (selector: id, branch, or org/repo:branch). Required unless clear:true.'),
    clear: z.boolean().optional().describe('Detach it from its parent instead of setting one.'),
  }),
}, async ({ workstream, parent, clear, daemon }) => {
  const id = workstreamTarget(workstream, daemon);
  const service = await requestDaemonService(workstreamPath(id, 'stack-set'), {
    daemon,
    method: 'POST',
    body: { ...(parent ? { parent } : {}), clear: Boolean(clear) },
  });
  return serviceJson(service, service.result);
});

server.registerTool('ws_stack_link', {
  description: 'Turn the workstream\'s chain into a stack of pull requests on GitHub, bottom to top, by '
    + 'running `gh stack link`: it pushes each branch, opens a PR for any branch that lacks one (chaining '
    + 'each PR\'s base onto the branch below it), and creates or updates the stack shown in GitHub\'s PR UI. '
    + 'Existing PRs are reused and never removed. This PUSHES BRANCHES AND MAY OPEN PRs — confirm with '
    + 'the user first. It does not rewrite history or touch any worktree, so it cannot lose work. New PRs are '
    + 'drafts unless open:true. Requires a linear chain of at least two real branches in one repo (check '
    + 'with ws_stack first).',
  inputSchema: withDaemon({
    workstream: workstreamArg,
    open: z.boolean().optional().describe('Mark new and existing PRs ready for review (default: create new PRs as drafts).'),
  }),
}, async ({ workstream, open, daemon }) => {
  const id = workstreamTarget(workstream, daemon);
  const service = await requestDaemonService(workstreamPath(id, 'stack-link'), {
    daemon,
    method: 'POST',
    body: { open: Boolean(open) },
  });
  return serviceJson(service, service.result);
});

server.registerTool('ws_issue_list', {
  description: 'List the Linear/GitHub issues linked to a workstream.',
  inputSchema: withDaemon({ workstream: workstreamArg }),
}, async ({ workstream, daemon }) => {
  const id = workstreamTarget(workstream, daemon);
  const service = await requestDaemonService(`${workstreamPath(id)}?status=all`, { daemon });
  const item = service.result.items?.[0];
  return serviceJson(service, {
    workstream: item,
    issues: (item?.issues || []).map((issue) => ({ id: issue.id, kind: issue.kind, ref: issue.ref })),
  });
});

server.registerTool('ws_issue_add', {
  description: 'Link one or more issues (Linear keys/URLs, GitHub URLs, or any link) to a workstream.',
  inputSchema: withDaemon({
    refs: z.array(z.string()).min(1).describe('Issue links or identifiers to add.'),
    workstream: workstreamArg,
  }),
}, async ({ refs, workstream, daemon }) => {
  const id = workstreamTarget(workstream, daemon);
  const service = await workstreamCommand(id, 'issue-add', { refs }, { daemon });
  return serviceJson(service, {
    workstream: service.result.workstream,
    added: service.result.result.issues,
    issues: service.result.workstream.issues,
  });
});

server.registerTool('ws_issue_remove', {
  description: 'Unlink an issue from a workstream, by its exact link or its issue id (from ws_issue_list).',
  inputSchema: withDaemon({
    ref: z.string().describe('Exact issue link, or the numeric issue id.'),
    workstream: workstreamArg,
  }),
}, async ({ ref, workstream, daemon }) => {
  const id = workstreamTarget(workstream, daemon);
  const service = await workstreamCommand(id, 'issue-remove', { ref }, { daemon });
  return serviceJson(service, {
    workstream: service.result.workstream,
    removed: service.result.result.removed,
    ref,
    issues: service.result.workstream.issues,
  });
});

server.registerTool('ws_log', {
  description: 'Record a one-line work-log note against a workstream — what you did or figured out — '
    + 'to be folded into the daily notes digest later. Use this to capture intent/outcome that a commit '
    + 'subject would miss (e.g. a root cause you tracked down). Set done:true to mark it a completed item '
    + 'rather than an in-progress note. Defaults to the worktree containing the current directory.',
  inputSchema: withDaemon({
    body: z.string().min(1).describe('What was done / figured out — one line.'),
    done: z.boolean().optional().describe('Mark this a completed item (default: false, an in-progress note).'),
    workstream: workstreamArg,
  }),
}, async ({ body, done, workstream, daemon }) => {
  const id = workstreamTarget(workstream, daemon);
  const service = await workstreamCommand(id, 'log', { body, done: Boolean(done) }, { daemon });
  return serviceJson(service, { workstream: service.result.workstream, logged: service.result.result });
});

server.registerTool('ws_digest', {
  description: "Assemble a day's work across all workstreams into a draft under the configured notes root: git "
    + 'commits by the configured git user that day (deduped across branches) plus any ws_log notes, with each '
    + "workstream's linked issues/PRs for reference. Returns both structured activity and notes-format "
    + 'markdown bullets. Use this to draft or update the daily work note — review/polish the markdown '
    + '(or use the structured data to write a better summary) rather than pasting blindly. Set write:true '
    + "to append the markdown under the day's heading in this week's work-notes file.",
  inputSchema: withDaemon({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
      .describe('Day to digest as YYYY-MM-DD (local). Defaults to today.'),
    write: z.boolean().optional()
      .describe("Append the markdown under the day's heading in this week's configured work-notes file (default: false)."),
  }),
}, async ({ date, write, daemon }) => {
  const service = await requestDaemonService('/ws/digest', {
    daemon,
    method: 'POST',
    body: { ...(date ? { date } : {}), write: Boolean(write) },
  });
  return serviceJson(service, service.result);
});

await server.connect(new StdioServerTransport());
