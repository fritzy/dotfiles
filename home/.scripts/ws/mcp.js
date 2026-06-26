#!/usr/bin/env -S node --no-warnings
// ws MCP server — exposes the safe, non-interactive workstream operations
// (listing + issue management + scratchpad creation) to Claude sessions, so basic
// housekeeping doesn't require loading the ws skill. Git-worktree mutations stay
// CLI-only: they're interactive and would have nowhere to attach from a tool call.
// Scratchpad creation is the exception — it's just a temp dir, and when the server
// runs inside Zellij (the Claude pane does) it can open the three-pane tab in place.
//
// Transport is stdio (JSON-RPC over stdin/stdout) — no sockets, which also keeps
// it clear of the Falcon socket-exec issue noted in memory. core.js writes its
// diagnostics to stderr only, so stdout stays a clean protocol stream.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import {
  openDb, resolveRow, currentWorkstream,
  listWorkstreams, listIssues, addIssue, removeIssue, workstreamView,
  createScratchpad,
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
  description: 'Create a scratchpad: a throwaway workstream in a temp directory (not a git '
    + 'worktree), opened with the same three-pane Zellij tab (zsh, nvim, claude). '
    + 'With no name a random one is generated. When the server runs inside Zellij the tab '
    + 'is opened in place; otherwise the directory is created and its path is returned.',
  inputSchema: {
    name: z.string().optional().describe('Optional scratchpad name (sanitized; suffixed if it already exists). Random if omitted.'),
  },
}, async ({ name }) => {
  const db = openDb();
  const row = createScratchpad(db, name);
  let tabOpened = false;
  if (inZellij()) {
    try { openTab(row); tabOpened = true; } catch { tabOpened = false; }
  }
  return json({ workstream: workstreamView(db, row, process.cwd()), tabOpened });
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
