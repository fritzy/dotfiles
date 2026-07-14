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
  openDb, resolveRow, currentWorkstream, now,
  listWorkstreams, listIssues, addIssue, removeIssue, addLog, workstreamView,
  createScratchpad, parseSelector, materializeWorktree, upsertWorkstream,
  setStatus, setPath, linkPr, renameWorkstream,
  worktreeDirty, removeWorktree, isScratch,
  collectDayActivity, renderDigest, appendDayEntry, NOTES_ROOT,
  addNote, listNotes,
} from './lib/core.js';
import { openTab, closeTab, inZellij, renameTab } from './lib/zellij.js';

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

server.registerTool('ws_pause', {
  description: 'Pause a workstream: close its Zellij tab but keep the worktree on disk (status: paused, '
    + 'resume is instant). Use this to set work aside without discarding anything. Defaults to the '
    + 'worktree containing the current directory.',
  inputSchema: { workstream: workstreamArg },
}, async ({ workstream }) => {
  const db = openDb();
  const row = targetRow(db, workstream);
  if (inZellij()) closeTab(row);
  setStatus(db, row.id, 'paused');
  return json({ workstream: workstreamView(db, row, process.cwd()), paused: true });
});

server.registerTool('ws_rename', {
  description: 'Rename a workstream and (if open) its Zellij tab in place. For a SCRATCHPAD this renames '
    + "its directory and name — scratchpads are just a made-up name, so this is a full rename. For a "
    + "git-backed workstream this only sets a display label used for the tab name; the underlying git "
    + 'branch is left untouched (renaming a real branch is a much bigger operation). Defaults to the '
    + 'worktree containing the current directory.',
  inputSchema: {
    name: z.string().min(1).describe('The new name/label.'),
    workstream: workstreamArg,
  },
}, async ({ name, workstream }) => {
  const db = openDb();
  const row = targetRow(db, workstream);
  const oldTabName = row.tab_name;
  const updated = renameWorkstream(db, row, name);
  const tabRenamed = inZellij() ? renameTab(oldTabName, updated.tab_name) : false;
  return json({ workstream: workstreamView(db, updated, process.cwd()), tabRenamed });
});

server.registerTool('ws_close', {
  description: 'Close a workstream in one call — no skill, no manual git inspection needed. '
    + 'Marks it closed and closes its Zellij tab. '
    + 'Defaults to the worktree containing the current directory; closing the current one also closes '
    + 'this tab (ending the session — that is the confirmation). '
    + 'DISK: a git worktree is removed by default (its commits/branch survive in the bare clone, so '
    + 'the workstream stays fully resumable); pass keep:true to leave the worktree on disk. A '
    + 'SCRATCHPAD has no git backing, so its directory is KEPT by default — the scratchpad just goes '
    + 'to status:closed and stays resumable — and is only deleted when you pass force:true (an '
    + 'irreversible discard; confirm with the user first). '
    + 'SAFETY: if a git worktree being removed has uncommitted changes this refuses and returns the '
    + 'dirty file list without touching anything — relay it and only retry with force:true once the '
    + 'user confirms discarding. This tool replaces shelling out to `ws close`.',
  inputSchema: {
    workstream: workstreamArg,
    keep: z.boolean().optional().describe('Keep the worktree/directory on disk; just close the tab and mark closed. (Scratchpad dirs are kept by default regardless.)'),
    force: z.boolean().optional().describe('For a git worktree: remove it even with uncommitted changes (discards them). For a scratchpad: delete its directory (otherwise it is kept). Irreversible either way.'),
  },
}, async ({ workstream, keep, force }) => {
  const db = openDb();
  const row = targetRow(db, workstream);
  const scratch = isScratch(row);
  // Git worktrees are safe to remove by default (work survives in the bare clone),
  // so remove unless keep:true. Scratchpads have no such backing, so keep the dir
  // by default and only discard it on an explicit force:true.
  const removing = (scratch ? !!force : !keep) && existsSync(row.path);

  // Refuse to discard uncommitted work in a git worktree unless explicitly forced.
  // (Scratchpad removal is already force-gated above, and has no git status.)
  if (removing && !scratch && !force) {
    const dirty = worktreeDirty(row.path);
    if (dirty) {
      return json({
        workstream: workstreamView(db, row, process.cwd()),
        closed: false,
        needsForce: true,
        reason: 'worktree has uncommitted changes; confirm with the user, then retry with force:true',
        dirty: dirty.split('\n'),
      });
    }
  }

  const noun = scratch ? 'directory' : 'worktree';
  if (removing) removeWorktree(row.org, row.repo, row.path);
  setStatus(db, row.id, 'closed');
  const view = workstreamView(db, row, process.cwd());
  const kept = !removing && existsSync(row.path);
  // Close the tab last: if this is the current workstream, closing its tab ends
  // the session, so the db/worktree state is already settled before that happens.
  if (inZellij()) closeTab(row);
  return json({ workstream: view, closed: true, worktreeRemoved: removing, keptWorktree: kept, noun });
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

server.registerTool('ws_log', {
  description: 'Record a one-line work-log note against a workstream — what you did or figured out — '
    + 'to be folded into the daily notes digest later. Use this to capture intent/outcome that a commit '
    + 'subject would miss (e.g. a root cause you tracked down). Set done:true to mark it a completed item '
    + 'rather than an in-progress note. Defaults to the worktree containing the current directory.',
  inputSchema: {
    body: z.string().min(1).describe('What was done / figured out — one line.'),
    done: z.boolean().optional().describe('Mark this a completed item (default: false, an in-progress note).'),
    workstream: workstreamArg,
  },
}, async ({ body, done, workstream }) => {
  const db = openDb();
  const row = targetRow(db, workstream);
  const logged = addLog(db, row.id, body, !!done);
  return json({ workstream: briefRow(row), logged });
});

server.registerTool('ws_note', {
  description: 'Write a longer-form note file for a workstream, filed under '
    + '~/notes/work/<year>/workstream/<id-name>/<timestamp>[-<title>].md — for writeups that outgrow a '
    + "one-line ws_log entry (a design decision, a debugging writeup, a plan). This is the only way notes "
    + 'get written for a workstream; use ws_log instead for short digest-feeding one-liners. Defaults to '
    + 'the worktree containing the current directory.',
  inputSchema: {
    body: z.string().min(1).describe('The note content (markdown).'),
    title: z.string().optional().describe('Optional short title; becomes an H1 and part of the filename.'),
    workstream: workstreamArg,
  },
}, async ({ body, title, workstream }) => {
  const db = openDb();
  const row = targetRow(db, workstream);
  const { file, path } = addNote(row, body, { title });
  return json({ workstream: briefRow(row), file, path });
});

server.registerTool('ws_note_list', {
  description: 'List the longer-form note files written for a workstream via ws_note.',
  inputSchema: { workstream: workstreamArg },
}, async ({ workstream }) => {
  const db = openDb();
  const row = targetRow(db, workstream);
  return json({ workstream: briefRow(row), notes: listNotes(row) });
});

server.registerTool('ws_digest', {
  description: "Assemble a day's work across all workstreams into a draft for Nathan's ~/notes: git "
    + 'commits he authored that day (deduped across branches) plus any ws_log notes, with each '
    + "workstream's linked issues/PRs for reference. Returns both structured activity and notes-format "
    + 'markdown bullets. Use this to draft or update the daily work note — review/polish the markdown '
    + '(or use the structured data to write a better summary) rather than pasting blindly. Set write:true '
    + "to append the markdown under the day's heading in this week's ~/notes work file.",
  inputSchema: {
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
      .describe('Day to digest as YYYY-MM-DD (local). Defaults to today.'),
    write: z.boolean().optional()
      .describe("Append the markdown under the day's heading in this week's ~/notes work file (default: false)."),
  },
}, async ({ date, write }) => {
  const db = openDb();
  const activity = collectDayActivity(db, { date });
  const markdown = renderDigest(activity);
  const result = { date: activity.dateIso, markdown, workstreams: activity.workstreams };
  if (write && markdown) {
    const { file, heading } = appendDayEntry(markdown, activity.date, NOTES_ROOT);
    result.written = { file, heading };
  }
  return json(result);
});

await server.connect(new StdioServerTransport());
