#!/usr/bin/env -S node --no-warnings
// fritzworks MCP server — exposes FritzWorks operations to AI agents. Session
// lifecycle calls use the daemon's HTTP API and shared browser workspace state;
// this stdio process never creates or manipulates terminal tabs.
import { AsyncLocalStorage } from 'node:async_hooks';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { readFileSync, realpathSync } from 'node:fs';

import { fileURLToPath } from 'node:url';
import { CONFIG } from './lib/config.js';
import { requestDaemonService as defaultRequest, resolveContext, listWorkstreams, repositorySelector } from './lib/client.js';

const PACKAGE = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export function createMcpServer({ request = defaultRequest, config = CONFIG, cwd = process.cwd(), env = process.env,
  server = new McpServer({ name: 'fritzworks', version: PACKAGE.version }),
} = {}) {
const requestScopes = new AsyncLocalStorage();
const registerTool = (name, definition, call) => server.registerTool(name, definition, (...args) => requestScopes.run(new Map(), async () => {
  try { return await call(...args); }
  catch (error) {
    if (!error.code) throw error;
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: error.code, message: error.message, details: error.details }) }] };
  }
}));
const requestDaemonService = async (path, options = {}) => {
  const scope = requestScopes.getStore();
  const id = options.daemon || 'local';
  const binding = scope?.get(id);
  const service = await request(path, { config, ...options, ...binding });
  if (!binding && service.daemon.instanceId) scope?.set(id, { expectedInstance: service.daemon.instanceId, expectedEndpoint: service.daemon.url });
  return service;
};
const workstreamCommand = (id, command, body = {}, options = {}) => requestDaemonService(`/fw/${encodeURIComponent(id)}/${command}`, { ...options, method: 'POST', body });
const json = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });

const daemonView = (daemon) => ({
  id: daemon.id, name: daemon.name, url: daemon.url, local: daemon.local, instanceId: daemon.instanceId, identityChanged: daemon.identityChanged,
});

const serviceJson = (service, data) => json({ daemon: daemonView(service.daemon), ...data });

async function workstreamTarget(selector, daemon) {
  const service = await resolveContext({ selector, cwd, sessionId: env.FRITZWORKS_ID }, { daemon, config, request: requestDaemonService });
  if (!service.result.target) throw new Error('no workstream in context — pass "workstream"');
  return String(service.result.target.id);
}

const workstreamPath = (id, suffix = '') => (
  `/fw/${encodeURIComponent(id)}${suffix ? `/${suffix}` : ''}`
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
const idempotencyArg = z.string().min(1).max(200).optional().describe('Stable key for retrying the exact same daemon job request.');
const linksArg = z.array(z.string().min(1)).min(1).optional()
  .describe('Associated Linear/GitHub references or URLs. They are included in the new session\'s initial agent briefing.');
const daemonArg = z.string().optional()
  .describe('Daemon id from fw_daemons. Defaults to local. Remote workstream actions require an explicit workstream selector.');
const workstreamArg = z.string().optional()
  .describe('Workstream selector: numeric id, branch name, or org/repo:branch. On local, defaults to the worktree containing the current directory; required for a remote daemon.');
const withDaemon = (schema = {}) => ({ ...schema, daemon: daemonArg });


registerTool('fw_config', {
  description: 'Show the resolved FritzWorks configuration, including paths, commands, service, and agent defaults.',
  inputSchema: withDaemon(),
}, async ({ daemon }) => {
  const service = await requestDaemonService('/config', { daemon });
  return serviceJson(service, { config: service.result });
});

registerTool('fw_browser_refresh', {
  description: 'Ask every browser connected to the selected daemon to reload the full page and re-request its HTML, JavaScript, styles, images, and SVG assets.',
  inputSchema: withDaemon(),
}, async ({ daemon }) => {
  const service = await requestDaemonService('/browser/refresh', {
    daemon, method: 'POST', body: {},
  });
  return serviceJson(service, service.result);
});

registerTool('fw_daemons', {
  description: 'List daemon ids available to this MCP server. Pass one of these ids as daemon to any other fw tool.',
  inputSchema: withDaemon(),
}, async ({ daemon }) => {
  const directory = await requestDaemonService('/daemons', { daemon: 'local' });
  const targets = [{ id: 'local', name: 'Local', local: true }, ...directory.result.daemons];
  return json({ selected: daemon || 'local', daemons: targets, instanceId: directory.result.instanceId });
});

registerTool('fw_daemon_acknowledge', {
  description: 'Explicitly acknowledge a changed daemon identity after reviewing its new instance UUID. Does not retry any pending action.',
  inputSchema: withDaemon({ instanceId: z.string().min(1) }),
}, async ({ daemon, instanceId }) => {
  const service = await requestDaemonService('/capabilities', { daemon, acknowledgeInstance: instanceId, expectedInstance: instanceId });
  return serviceJson(service, { capabilities: service.result, acknowledged: instanceId });
});

registerTool('fw_list', {
  description: 'List fw-managed workstreams (git worktrees + their linked issues). '
    + 'Each has a status (active/paused/closed), whether its worktree is present on disk, '
    + 'and which one contains the current directory.',
  inputSchema: withDaemon({
    all: z.boolean().optional().describe('Include closed workstreams (default: only active + paused).'),
  }),
}, async ({ all, daemon }) => {
  const service = await listWorkstreams(all ? 'all' : 'active_paused', { daemon, config, request: requestDaemonService });
  const current = (!daemon || daemon === 'local')
    ? (await resolveContext({ cwd, sessionId: env.FRITZWORKS_ID }, { daemon, config, request: requestDaemonService })).result.workstream?.id || null
    : null;
  return serviceJson(service, {
    current,
    workstreams: service.result.items,
  });
});

registerTool('fw_sync', {
  description: 'Explicitly sync a session’s Markdown resources and, when needed, look up its current branch PR.',
  inputSchema: withDaemon({ workstream: workstreamArg }),
}, async ({ workstream, daemon }) => {
  const id = await workstreamTarget(workstream, daemon);
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
  const target = await workstreamTarget(workstream, daemon, { configuredLocation: true });
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

registerTool('fw_panel_layout', {
  description: 'List this daemon’s panel groups, ordered panels, associated resources, active group, and optimistic revision.',
  inputSchema: withDaemon(),
}, async ({ daemon }) => {
  const service = await currentPanelLayout(daemon);
  return serviceJson(service, { layout: service.result });
});

registerTool('fw_panel_add', {
  description: 'Add a persistent terminal or the single allowed AI panel to an existing panel group.',
  inputSchema: withDaemon({
    group: z.string().min(1).describe('Panel group id from fw_panel_layout.'),
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

registerTool('fw_panel_update', {
  description: 'Minimize, restore, rename, resize, or change the Edit/Preview mode of a panel.',
  inputSchema: withDaemon({
    panel: z.string().min(1).describe('Panel id from fw_panel_layout.'),
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

registerTool('fw_panel_close', {
  description: 'Close a terminal or AI panel and kill its persistent process. Minimize it instead to keep the process running.',
  inputSchema: withDaemon({ panel: z.string().min(1).describe('Panel id from fw_panel_layout.') }),
}, async ({ panel, daemon }) => {
  const service = await mutatePanelLayout(
    `/panel-layout/panels/${encodeURIComponent(panel)}/close`, {}, daemon,
  );
  return serviceJson(service, service.result);
});

registerTool('fw_resource_add', {
  description: 'Add a link, Markdown, or HTML file resource. HTML opens as a preview without an editor. With content and no value, creates Markdown in the workstream’s configured session-notes directory.',
  inputSchema: withDaemon({
    group: z.string().min(1).optional().describe('Panel group id. Otherwise resolve workstream.'),
    workstream: workstreamArg,
    kind: z.enum(['link', 'markdown', 'html']).optional().describe('Defaults to markdown when content is supplied.'),
    value: z.string().min(1).optional().describe('URL, Markdown path, or HTML path. Omit when creating a session note.'),
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

registerTool('fw_resource_list', {
  description: 'List resources for a workstream or group. Defaults to the current local workstream.',
  inputSchema: withDaemon({
    group: z.string().min(1).optional().describe('Panel group id. Otherwise resolve workstream.'),
    workstream: workstreamArg,
    kind: z.enum(['link', 'markdown', 'html']).optional(),
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

registerTool('fw_resource_read', {
  description: 'Read an associated Markdown resource by resource id.',
  inputSchema: withDaemon({ resource: z.string().min(1).describe('Resource id from fw_resource_list.') }),
}, async ({ resource, daemon }) => {
  const service = await requestDaemonService(
    `/panel-layout/resources/${encodeURIComponent(resource)}`, { daemon },
  );
  return serviceJson(service, service.result);
});

registerTool('fw_resource_write', {
  description: 'Replace an associated Markdown resource by resource id.',
  inputSchema: withDaemon({
    resource: z.string().min(1).describe('Resource id from fw_resource_list.'),
    content: z.string().describe('Complete Markdown content.'),
    version: z.string().optional().describe('Version from fw_resource_read; omit to force.'),
  }),
}, async ({ resource, content, version, daemon }) => {
  const service = await requestDaemonService(
    `/panel-layout/resources/${encodeURIComponent(resource)}`,
    { daemon, method: 'PUT', body: { content, ...(version ? { version } : {}) } },
  );
  return serviceJson(service, service.result);
});

registerTool('fw_resource_open', {
  description: 'Open or restore an associated Markdown or link resource panel and select its owning group.',
  inputSchema: withDaemon({ resource: z.string().min(1).describe('Resource id from fw_panel_layout.') }),
}, async ({ resource, daemon }) => {
  const service = await mutatePanelLayout(
    `/panel-layout/resources/${encodeURIComponent(resource)}/open`, {}, daemon,
  );
  return serviceJson(service, service.result);
});

registerTool('fw_resource_remove', {
  description: 'Disassociate an explicit resource. Automatically discovered session notes cannot be removed.',
  inputSchema: withDaemon({ resource: z.string().min(1).describe('Resource id from fw_panel_layout.') }),
}, async ({ resource, daemon }) => {
  const service = await mutatePanelLayout(
    `/panel-layout/resources/${encodeURIComponent(resource)}/disassociate`, {}, daemon,
  );
  return serviceJson(service, service.result);
});

registerTool('fw_scratch', {
  description: 'Create a scratchpad in the configured scratchpad root (not a git worktree), '
    + 'and open it as the active FritzWorks browser workspace. With no name a random one is generated.',
  inputSchema: withDaemon({
    idempotencyKey: idempotencyArg,
    name: z.string().optional().describe('Optional scratchpad name (sanitized; suffixed if it already exists). Random if omitted.'),
    seed: seedArg,
    agent: agentArg,
    panels: panelsArg,
    noEditor: noEditorArg,
    links: linksArg,
  }),
}, async ({ idempotencyKey, name, seed, agent, panels, noEditor, links, daemon }) => {
  const service = await requestDaemonService('/fw/scratchpad', {
    daemon,
    method: 'POST',
    body: {
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(name ? { name } : {}),
      ...(links ? { links } : {}),
      ...browserOpts({ seed, agent, panels, noEditor }),
    },
  });
  if (service.result.job) return serviceJson(service, { job: service.result.job });
  return serviceJson(service, {
    workstream: service.result.workstream,
    browserWorkspace: service.result.browserWorkspace,
    serviceUrl: service.daemon.url,
  });
});

registerTool('fw_new', {
  description: 'Create (or open) a workstream: a git worktree for a repo at a ref, recorded in the '
    + 'db and opened as the active FritzWorks browser workspace. Clones the repo if it '
    + "isn't present yet, and routes branches through your fork automatically when the canonical "
    + 'repo blocks branch creation. The result is reflected in connected browser clients and remains '
    + 'queued in shared browser state when no client is open. Idempotent on an existing branch.',
  inputSchema: withDaemon({
    idempotencyKey: idempotencyArg,
    repo: z.string().describe('Local repository path, explicit clone URL, or GitHub owner/repo.'),
    ref: z.string().describe('A branch name (created off the default branch if new), a PR number '
      + '(123 or #123, incl. fork PRs), or owner:branch for a branch on a fork.'),
    parent: z.string().optional().describe('Stack this workstream on another one (selector: id, branch, '
      + 'or org/repo:branch). A NEW branch in the same repo is created off the parent\'s branch instead of '
      + 'the default branch, so it builds on that work; the relationship is recorded either way and shows '
      + 'up in fw_stack. Use when the new work depends on an unmerged branch.'),
    seed: seedArg,
    noVim: noVimArg,
    noEditor: noEditorArg,
    agent: agentArg,
    panels: panelsArg,
    links: linksArg,
  }),
}, async ({ idempotencyKey, repo, ref, parent, seed, noVim, noEditor, agent, panels, links, daemon }) => {
  const service = await requestDaemonService('/fw', {
    daemon,
    method: 'POST',
    body: {
      ...(idempotencyKey ? { idempotencyKey } : {}),
      repository: repositorySelector(repo, { cwd, local: (!daemon || daemon === 'local') }),
      async: true,
      selector: ref,
      ...(parent ? { parent } : {}),
      ...(links ? { links } : {}),
      ...browserOpts({ seed, noVim, noEditor, agent, panels }),
    },
  });
  if (service.result.job) return serviceJson(service, { job: service.result.job });
  return serviceJson(service, {
    workstream: service.result.workstream,
    branchedOffParent: service.result.branchedOffParent,
    browserWorkspace: service.result.browserWorkspace,
    serviceUrl: service.daemon.url,
  });
});

registerTool('fw_resume', {
  description: 'Resume (rejoin) an existing workstream by selector: reconstitute its worktree if the '
    + 'directory was removed and open it as the active FritzWorks browser workspace. '
    + 'Active status is controlled only by connected browser terminals.',
  inputSchema: withDaemon({
    idempotencyKey: idempotencyArg,
    workstream: workstreamArg,
    seed: seedArg,
    noVim: noVimArg,
    noEditor: noEditorArg,
    agent: agentArg,
    panels: panelsArg,
  }),
}, async ({ idempotencyKey, workstream, seed, noVim, noEditor, agent, panels, daemon }) => {
  const id = await workstreamTarget(workstream, daemon, { configuredLocation: true });
  const service = await workstreamCommand(
    id,
    'resume',
    { ...browserOpts({ seed, noVim, noEditor, agent, panels }), async: true, ...(idempotencyKey ? { idempotencyKey } : {}) },
    { daemon },
  );
  if (service.result.job) return serviceJson(service, { job: service.result.job });
  return serviceJson(service, {
    workstream: service.result.workstream,
    browserWorkspace: service.result.browserWorkspace,
    serviceUrl: service.daemon.url,
  });
});

registerTool('fw_pause', {
  description: 'Pause a workstream: close its browser terminals but keep the worktree on disk (status: paused, '
    + 'resume is instant). Use this to set work aside without discarding anything. Defaults to the '
    + 'worktree containing the current directory.',
  inputSchema: withDaemon({ workstream: workstreamArg, idempotencyKey: idempotencyArg }),
}, async ({ workstream, daemon, idempotencyKey }) => {
  const id = await workstreamTarget(workstream, daemon, { configuredLocation: true });
  const service = await workstreamCommand(id, 'pause', idempotencyKey ? { idempotencyKey, async: true } : {}, { daemon });
  if (service.result.job) return serviceJson(service, { job: service.result.job });
  return serviceJson(service, {
    workstream: service.result.workstream,
    browserWorkspace: service.result.browserWorkspace,
    paused: true,
  });
});

registerTool('fw_rename', {
  description: 'Rename a workstream in FritzWorks. For a scratchpad this changes its display name; for a '
    + 'git-backed workstream this sets a display label while the underlying git '
    + 'branch is left untouched (renaming a real branch is a much bigger operation). Defaults to the '
    + 'worktree containing the current directory.',
  inputSchema: withDaemon({
    name: z.string().min(1).describe('The new name/label.'),
    workstream: workstreamArg,
  }),
}, async ({ name, workstream, daemon }) => {
  const id = await workstreamTarget(workstream, daemon);
  const service = await workstreamCommand(id, 'rename', { name }, { daemon });
  return serviceJson(service, { workstream: service.result.workstream, renamed: true });
});

const confirmationArgs = {
  idempotencyKey: idempotencyArg,
  previewRevision: z.string().optional().describe('Revision from the reviewed daemon preview. Required for destructive execution.'),
  confirm: z.boolean().optional().describe('Execute the supplied reviewed preview after user authorization.'),
};

async function confirmedAction(intent, daemon, previewRevision, confirm) {
  if (!previewRevision || !confirm) {
    const service = await requestDaemonService('/intents/preview', { daemon, method: 'POST', body: intent });
    if (service.result.confirmationRequired) return serviceJson(service, { executed: false, preview: service.result });
    const executed = await workstreamCommand(intent.target, intent.command || intent.kind, {
      ...service.result.intent.body, ...(intent.body.idempotencyKey ? { idempotencyKey: intent.body.idempotencyKey } : {}), async: true, previewRevision: service.result.revision,
    }, { daemon });
    return serviceJson(executed, { ...executed.result, executed: true });
  }
  const service = await workstreamCommand(intent.target, intent.command || intent.kind, {
    ...intent.body, async: true, previewRevision, confirm: true,
  }, { daemon });
  return serviceJson(service, { ...service.result, executed: true });
}

registerTool('fw_capabilities', {
  description: 'Read live daemon defaults, configured locations, providers and supported operations.', inputSchema: withDaemon(),
}, async ({ daemon }) => {
  const service = await requestDaemonService('/capabilities', { daemon });
  return serviceJson(service, service.result);
});

registerTool('fw_preview', {
  description: 'Preview a daemon action and its current consequences before execution.',
  inputSchema: withDaemon({ kind: z.enum(['create-repo', 'create-scratchpad', 'action', 'stack-link', 'stack-rebase']),
    target: z.string().optional(), command: z.string().optional(), body: z.record(z.string(), z.unknown()).optional() }),
}, async ({ daemon, ...intent }) => {
  const service = await requestDaemonService('/intents/preview', { daemon, method: 'POST', body: intent });
  return serviceJson(service, { preview: service.result });
});

registerTool('fw_close', {
  description: 'Archive a session using daemon policy. Returns a preview when confirmation is required; submit its revision and confirm:true after authorization. Repository worktrees default to removal; scratchpads retain files. Keep retains files; discard explicitly selects removal.',
  inputSchema: withDaemon({ workstream: workstreamArg, keep: z.boolean().optional(), discard: z.boolean().optional(),
    remove: z.boolean().optional(), force: z.boolean().optional(), ...confirmationArgs }),
}, async ({ workstream, daemon, previewRevision, confirm, ...body }) => {
  const target = await workstreamTarget(workstream, daemon);
  return confirmedAction({ kind: 'action', target, command: 'close', body: { retention: 'automatic', ...body } }, daemon, previewRevision, confirm);
});

registerTool('fw_stack', {
  description: 'Show the stack a workstream sits in: the chain of parent/child ("stacked on") '
    + 'relationships, from the bottom branch up, as a tree. Use this to find out what unmerged work a '
    + "branch depends on and what depends on it — the answer isn't in git, since a branch doesn't record "
    + 'which branch it was cut from. Also reports whether the chain is eligible to become a stack of '
    + 'GitHub PRs (fw_stack_link), and if not, why not. Defaults to the worktree containing the current '
    + 'directory.',
  inputSchema: withDaemon({ workstream: workstreamArg }),
}, async ({ workstream, daemon }) => {
  const id = await workstreamTarget(workstream, daemon);
  const service = await requestDaemonService(workstreamPath(id, 'stack'), { daemon });
  return serviceJson(service, service.result);
});

registerTool('fw_stack_set', {
  description: 'Record that one workstream is stacked on another — i.e. its branch builds on the '
    + "other's unmerged work — or clear that relationship with clear:true. This is bookkeeping only: it "
    + 'moves no commits and rewrites no history, so it is safe to correct at any time. Cycles and '
    + 'self-parenting are rejected. Cross-repo and scratchpad parents are allowed (useful to record that '
    + 'work follows from other work), but only a same-repo chain of real branches can become GitHub '
    + 'stacked PRs — see fw_stack. To rebase the commits so the branches actually sit on each other, '
    + 'the user can run `fw stack rebase` themselves (it rewrites history).',
  inputSchema: withDaemon({
    workstream: workstreamArg,
    parent: z.string().optional().describe('The workstream to stack it on (selector: id, branch, or org/repo:branch). Required unless clear:true.'),
    clear: z.boolean().optional().describe('Detach it from its parent instead of setting one.'),
  }),
}, async ({ workstream, parent, clear, daemon }) => {
  const id = await workstreamTarget(workstream, daemon);
  const service = await requestDaemonService(workstreamPath(id, 'stack-set'), {
    daemon,
    method: 'POST',
    body: { ...(parent ? { parent } : {}), clear: Boolean(clear) },
  });
  return serviceJson(service, service.result);
});

for (const command of ['stack-link', 'stack-rebase']) {
  registerTool(`fw_${command.replace('-', '_')}`, {
    description: `Preview ${command}, then submit its revision with confirm:true to start a daemon job. Linking pushes branches and may open PRs; rebasing rewrites history.`,
    inputSchema: withDaemon({ workstream: workstreamArg, open: z.boolean().optional(), trunk: z.boolean().optional(), ...confirmationArgs }),
  }, async ({ workstream, daemon, previewRevision, confirm, ...body }) => {
    const target = await workstreamTarget(workstream, daemon);
    return confirmedAction({ kind: command, target, body }, daemon, previewRevision, confirm);
  });
}
for (const action of ['list', 'show', 'cancel']) {
  registerTool(action === 'list' ? 'fw_jobs' : action === 'show' ? 'fw_job' : 'fw_job_cancel', {
    description: `${action} daemon background jobs.`,
    inputSchema: withDaemon(action === 'list' ? {} : { id: z.string() }),
  }, async ({ daemon, id }) => {
    const path = action === 'list' ? '/jobs' : `/jobs/${encodeURIComponent(id)}${action === 'cancel' ? '/cancel' : ''}`;
    const service = await requestDaemonService(path, { daemon, ...(action === 'cancel' ? { method: 'POST', body: {} } : {}) });
    return serviceJson(service, service.result);
  });
}

registerTool('fw_issue_list', {
  description: 'List the Linear/GitHub issues linked to a workstream.',
  inputSchema: withDaemon({ workstream: workstreamArg }),
}, async ({ workstream, daemon }) => {
  const id = await workstreamTarget(workstream, daemon);
  const service = await requestDaemonService(`${workstreamPath(id)}?status=all`, { daemon });
  const item = service.result.items?.[0];
  return serviceJson(service, {
    workstream: item,
    issues: (item?.issues || []).map((issue) => ({ id: issue.id, kind: issue.kind, ref: issue.ref })),
  });
});

registerTool('fw_issue_add', {
  description: 'Link one or more issues (Linear keys/URLs, GitHub URLs, or any link) to a workstream.',
  inputSchema: withDaemon({
    refs: z.array(z.string()).min(1).describe('Issue links or identifiers to add.'),
    workstream: workstreamArg,
  }),
}, async ({ refs, workstream, daemon }) => {
  const id = await workstreamTarget(workstream, daemon);
  const service = await workstreamCommand(id, 'issue-add', { refs }, { daemon });
  if (service.result.job) return serviceJson(service, { job: service.result.job });
  return serviceJson(service, {
    workstream: service.result.workstream,
    added: service.result.result.issues,
    issues: service.result.workstream.issues,
  });
});

registerTool('fw_issue_remove', {
  description: 'Unlink an issue from a workstream, by its exact link or its issue id (from fw_issue_list).',
  inputSchema: withDaemon({
    ref: z.string().describe('Exact issue link, or the numeric issue id.'),
    workstream: workstreamArg,
  }),
}, async ({ ref, workstream, daemon }) => {
  const id = await workstreamTarget(workstream, daemon);
  const service = await workstreamCommand(id, 'issue-remove', { ref }, { daemon });
  if (service.result.job) return serviceJson(service, { job: service.result.job });
  return serviceJson(service, {
    workstream: service.result.workstream,
    removed: service.result.result.removed,
    ref,
    issues: service.result.workstream.issues,
  });
});

registerTool('fw_log', {
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
  const id = await workstreamTarget(workstream, daemon);
  const service = await workstreamCommand(id, 'log', { body, done: Boolean(done) }, { daemon });
  return serviceJson(service, { workstream: service.result.workstream, logged: service.result.result });
});

registerTool('fw_digest', {
  description: "Assemble a day's work across all workstreams into a draft under the configured notes root: git "
    + 'commits by the configured git user that day (deduped across branches) plus any fw_log notes, with each '
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
  const service = await requestDaemonService('/fw/digest', {
    daemon,
    method: 'POST',
    body: { ...(date ? { date } : {}), write: Boolean(write) },
  });
  return serviceJson(service, service.result);
});

return server;
}

const isMain = process.argv[1] && (() => {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) await createMcpServer().connect(new StdioServerTransport());
