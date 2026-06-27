#!/usr/bin/env -S node --no-warnings
// ws MCP server — exposes the workstream operations that work non-interactively
// (listing + issue management + create/resume + scratchpad creation) to Claude
// sessions, so basic housekeeping doesn't require loading the ws skill.
//
// Tab handling mirrors the CLI but only the in-place path: when the server runs
// inside Zellij (the Claude pane does) `openTab` adds/focuses the tab with a plain
// `zellij action new-tab` — no attach. From *outside* Zellij the CLI's openTab would
// `zellij attach`, which is interactive and would hang a tool call, so these tools
// skip the tab there and just create/reconstitute the worktree, returning its path.
//
// Transport is stdio (JSON-RPC over stdin/stdout) — no sockets, which also keeps
// it clear of the Falcon socket-exec issue noted in memory. core.js writes its
// diagnostics to stderr only, so stdout stays a clean protocol stream.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { existsSync } from 'node:fs';

import {
  openDb, resolveRow, currentWorkstream, now, sanitize,
  listWorkstreams, listIssues, addIssue, removeIssue, workstreamView,
  createScratchpad, parseSelector, materializeWorktree, upsertWorkstream,
  setStatus, setPath, linkPr,
} from './lib/core.js';
import { openTab, inZellij } from './lib/zellij.js';

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

const briefRow = (r) => ({ id: r.id, repo: `${r.org}/${r.repo}`, branch: r.branch });

// Open the workstream's tab in place when running inside Zellij. Returns whether a
// tab was opened. Never attaches from outside (that would be interactive and hang
// the tool call), so callers get the worktree either way and a tab only when in-session.
function maybeOpenTab(row) {
  if (!inZellij()) return false;
  try { openTab(row); return true; } catch { return false; }
}
const workstreamArg = z.string().optional()
  .describe('Workstream selector: numeric id, branch name, or org/repo:branch. Defaults to the worktree containing the current directory.');

const server = new McpServer({ name: 'ws', version: '1.0.0' });

server.registerTool('ws_list', {
  description: 'List ws-managed workstreams (git worktrees + their linked issues). '
    + 'Each has a status (active/paused/closed), whether its worktree is present on disk, '
    + 'and which one contains the current directory.',
  inputSchema: { all: z.boolean().optional().describe('Include closed workstreams (default: only active + paused).') },
}, async ({ all }) => {
  const db = openDb();
  const cwd = process.cwd();
  const cur = currentWorkstream(db, cwd);
  return json({
    current: cur ? cur.id : null,
    workstreams: listWorkstreams(db, { all: !!all }).map((r) => workstreamView(db, r, cwd)),
  });
});

server.registerTool('ws_scratch', {
  description: 'Create a scratchpad: a throwaway workstream under ~/scratchpad (not a git '
    + 'worktree), opened with the same three-pane Zellij tab (zsh, nvim, claude). '
    + 'With no name a random one is generated. When the server runs inside Zellij the tab '
    + 'is opened in place; otherwise the directory is created and its path is returned.',
  inputSchema: {
    name: z.string().optional().describe('Optional scratchpad name (sanitized; suffixed if it already exists). Random if omitted.'),
  },
}, async ({ name }) => {
  const db = openDb();
  const row = createScratchpad(db, name);
  return json({ workstream: workstreamView(db, row, process.cwd()), tabOpened: maybeOpenTab(row) });
});

server.registerTool('ws_new', {
  description: 'Create (or open) a workstream: a git worktree for a repo at a ref, recorded in the '
    + 'db and opened with the three-pane Zellij tab (zsh, nvim, claude). Clones the repo if it '
    + "isn't present yet, and routes branches through your fork automatically when the canonical "
    + 'repo blocks branch creation. Any associated PR is linked. When the server runs inside '
    + 'Zellij the tab opens in place; otherwise the worktree is created and its path returned '
    + '(no tab — attaching would be interactive). Idempotent on an existing branch.',
  inputSchema: {
    repo: z.string().describe('Repository as org/repo, e.g. chainguard-dev/mono.'),
    ref: z.string().describe('A branch name (created off the default branch if new), a PR number '
      + '(123 or #123, incl. fork PRs), or owner:branch for a branch on a fork.'),
  },
}, async ({ repo, ref }) => {
  if (!repo.includes('/')) throw new Error('repo must be org/repo');
  const [org, name] = repo.split('/');
  const { branch, source } = parseSelector(org, name, ref);
  const path = materializeWorktree(org, name, branch, source);
  const db = openDb();
  const row = upsertWorkstream(db, {
    org, repo: name, branch, source, path,
    tab_name: `${name}:${sanitize(branch)}`,
    created_at: now(), last_joined_at: now(),
  });
  const linked = linkPr(db, row);
  return json({
    workstream: workstreamView(db, row, process.cwd()),
    linkedPr: linked ? linked.pr : null,
    tabOpened: maybeOpenTab(row),
  });
});

server.registerTool('ws_resume', {
  description: 'Resume (rejoin) an existing workstream by selector: reconstitute its worktree if the '
    + 'directory was removed, mark it active, link its PR if any, and — inside Zellij — (re)open or '
    + 'focus its three-pane tab in place. Outside Zellij it just reconstitutes the worktree and '
    + 'returns its path.',
  inputSchema: { workstream: workstreamArg },
}, async ({ workstream }) => {
  const db = openDb();
  const row = targetRow(db, workstream);
  if (!existsSync(row.path)) {
    const path = materializeWorktree(row.org, row.repo, row.branch, row.source);
    if (path && path !== row.path) { setPath(db, row.id, path); row.path = path; }
  }
  setStatus(db, row.id, 'active', true);
  const linked = linkPr(db, row);
  return json({
    workstream: workstreamView(db, row, process.cwd()),
    linkedPr: linked ? linked.pr : null,
    tabOpened: maybeOpenTab(row),
  });
});

server.registerTool('ws_issue_list', {
  description: 'List the Linear/GitHub issues linked to a workstream.',
  inputSchema: { workstream: workstreamArg },
}, async ({ workstream }) => {
  const db = openDb();
  const row = targetRow(db, workstream);
  return json({
    workstream: briefRow(row),
    issues: listIssues(db, row.id).map((i) => ({ id: i.id, kind: i.kind, ref: i.ref })),
  });
});

server.registerTool('ws_issue_add', {
  description: 'Link one or more issues (Linear keys/URLs, GitHub URLs, or any link) to a workstream.',
  inputSchema: {
    refs: z.array(z.string()).min(1).describe('Issue links or identifiers to add.'),
    workstream: workstreamArg,
  },
}, async ({ refs, workstream }) => {
  const db = openDb();
  const row = targetRow(db, workstream);
  const added = refs.map((ref) => addIssue(db, row.id, ref));
  return json({
    workstream: briefRow(row),
    added,
    issues: listIssues(db, row.id).map((i) => ({ id: i.id, kind: i.kind, ref: i.ref })),
  });
});

server.registerTool('ws_issue_remove', {
  description: 'Unlink an issue from a workstream, by its exact link or its issue id (from ws_issue_list).',
  inputSchema: {
    ref: z.string().describe('Exact issue link, or the numeric issue id.'),
    workstream: workstreamArg,
  },
}, async ({ ref, workstream }) => {
  const db = openDb();
  const row = targetRow(db, workstream);
  const { removed } = removeIssue(db, row.id, ref);
  return json({
    workstream: briefRow(row),
    removed,
    ref,
    issues: listIssues(db, row.id).map((i) => ({ id: i.id, kind: i.kind, ref: i.ref })),
  });
});

await server.connect(new StdioServerTransport());
