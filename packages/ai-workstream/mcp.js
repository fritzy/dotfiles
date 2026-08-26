#!/usr/bin/env -S node --no-warnings
// ai-workstream MCP server — exposes non-interactive workstream operations
// (listing + issue management + create/resume + scratchpad creation) to AI-agent
// sessions, so basic housekeeping does not require a separate skill.
//
// Tab handling mirrors the CLI but only the in-place path: when the server runs
// inside Zellij (an agent panel usually does) `openTab` adds/focuses the tab with a plain
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

import { existsSync, readFileSync } from 'node:fs';

import { CONFIG } from './lib/config.js';
import {
  openDb, resolveRow, currentWorkstream, now,
  listWorkstreams, listIssues, addIssue, removeIssue, addLog, workstreamView,
  createScratchpad, parseSelector, materializeWorktree, upsertWorkstream,
  setStatus, setPath, linkPr, renameWorkstream, writeSeed,
  worktreeDirty, removeWorktree, isScratch, computeTabName,
  collectDayActivity, renderDigest, appendDayEntry, NOTES_ROOT,
  addNote, listNotes,
  parentOf, setParent, stackTree, stackLine, stackCheck, ghStackLink, briefStackRow,
} from './lib/core.js';
import { openTab, closeTab, inZellij, renameTab } from './lib/zellij.js';

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

const briefRow = (r) => ({ id: r.id, repo: `${r.org}/${r.repo}`, branch: r.branch });

// Open the workstream's tab in place when running inside Zellij. Returns whether a
// tab was opened. Never attaches from outside (that would be interactive and hang
// the tool call), so callers get the worktree either way and a tab only when in-session.
function maybeOpenTab(row, opts = {}) {
  if (!inZellij()) return false;
  try { openTab(row, opts); return true; } catch { return false; }
}

// Persist seed content (if any) for the row and return openTab opts. The MCP
// side takes the seed as inline markdown (the calling agent session usually
// composes it) rather than a file path like the CLI's --seed.
function tabOpts(row, { seed, noVim, noEditor, agent, model, panels } = {}) {
  return {
    ...(noVim || noEditor ? { noEditor: true } : {}),
    ...(seed ? { seed: writeSeed(row, seed) } : {}),
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(panels ? { panels } : {}),
  };
}
const noVimArg = z.boolean().optional()
  .describe('Deprecated alias for noEditor.');
const noEditorArg = z.boolean().optional()
  .describe('Omit the configured editor panel for this open. This one-off choice is not persisted.');
const agentArg = z.enum(['claude', 'codex']).optional()
  .describe('Use Claude Code or Codex for this tab, overriding the configured default for this open.');
const modelArg = z.string().optional()
  .describe('Override the configured model for the selected agent for this open.');
const panelsArg = z.array(z.enum(['shell', 'editor', 'agent'])).min(1).optional()
  .describe('Panel roles to open, overriding the configured panel list for this tab.');
const seedArg = z.string().optional()
  .describe('Markdown seed document for the new agent session: context, findings, and the task. '
    + 'Saved under the ws data dir and opened as the agent panel\'s first prompt ("read this and '
    + 'do what it says"), instead of resuming a prior session. Make it self-contained — the new '
    + 'session starts with no other context.');
const workstreamArg = z.string().optional()
  .describe('Workstream selector: numeric id, branch name, or org/repo:branch. Defaults to the worktree containing the current directory.');

const server = new McpServer({ name: 'ai-workstream', version: PACKAGE.version });

server.registerTool('ws_config', {
  description: 'Show the resolved ai-workstream configuration, including paths, panels, commands, and agent defaults.',
  inputSchema: {},
}, async () => json(CONFIG));

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
  description: 'Create a scratchpad in the configured scratchpad root (not a git worktree), '
    + 'opened with the configured Zellij panels and AI agent. '
    + 'With no name a random one is generated. When the server runs inside Zellij the tab '
    + 'is opened in place; otherwise the directory is created and its path is returned.',
  inputSchema: {
    name: z.string().optional().describe('Optional scratchpad name (sanitized; suffixed if it already exists). Random if omitted.'),
    seed: seedArg,
    agent: agentArg,
    model: modelArg,
    panels: panelsArg,
    noEditor: noEditorArg,
  },
}, async ({ name, seed, agent, model, panels, noEditor }) => {
  const db = openDb();
  const row = createScratchpad(db, name);
  return json({
    workstream: workstreamView(db, row, process.cwd()),
    tabOpened: maybeOpenTab(row, tabOpts(row, { seed, agent, model, panels, noEditor })),
  });
});

server.registerTool('ws_new', {
  description: 'Create (or open) a workstream: a git worktree for a repo at a ref, recorded in the '
    + 'db and opened with the configured Zellij panels and AI agent. Clones the repo if it '
    + "isn't present yet, and routes branches through your fork automatically when the canonical "
    + 'repo blocks branch creation. Any associated PR is linked. When the server runs inside '
    + 'Zellij the tab opens in place; otherwise the worktree is created and its path returned '
    + '(no tab — attaching would be interactive). Idempotent on an existing branch.',
  inputSchema: {
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
    model: modelArg,
    panels: panelsArg,
  },
}, async ({ repo, ref, parent, seed, noVim, noEditor, agent, model, panels }) => {
  if (!repo.includes('/')) throw new Error('repo must be org/repo');
  const [org, name] = repo.split('/');
  const db = openDb();
  let parentRow = null;
  if (parent) {
    parentRow = resolveRow(db, parent);
    if (!parentRow) throw new Error(`no workstream matching parent "${parent}"`);
    if (isScratch(parentRow)) throw new Error(`parent #${parentRow.id} is a scratchpad, so it has no branch to build on`);
  }
  const { branch, source } = parseSelector(org, name, ref);
  // A parent in another repo isn't a ref in this clone, so only branch off a same-repo one.
  const sameRepo = parentRow && parentRow.org === org && parentRow.repo === name;
  const path = materializeWorktree(org, name, branch, source, sameRepo ? { base: parentRow.branch } : {});
  let row = upsertWorkstream(db, {
    org, repo: name, branch, source, path,
    created_at: now(), last_joined_at: now(),
  });
  if (parentRow) row = setParent(db, row, parentRow);
  const linked = linkPr(db, row);
  return json({
    workstream: workstreamView(db, row, process.cwd()),
    linkedPr: linked ? linked.pr : null,
    branchedOffParent: !!sameRepo,
    tabOpened: maybeOpenTab(row, tabOpts(row, { seed, noVim, noEditor, agent, model, panels })),
  });
});

server.registerTool('ws_resume', {
  description: 'Resume (rejoin) an existing workstream by selector: reconstitute its worktree if the '
    + 'directory was removed, mark it active, link its PR if any, and — inside Zellij — (re)open or '
    + 'focus its configured tab in place. Outside Zellij it just reconstitutes the worktree and '
    + 'returns its path.',
  inputSchema: {
    workstream: workstreamArg,
    seed: seedArg,
    noVim: noVimArg,
    noEditor: noEditorArg,
    agent: agentArg,
    model: modelArg,
    panels: panelsArg,
  },
}, async ({ workstream, seed, noVim, noEditor, agent, model, panels }) => {
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
    tabOpened: maybeOpenTab(row, tabOpts(row, { seed, noVim, noEditor, agent, model, panels })),
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
  const oldTabName = computeTabName(row);
  const updated = renameWorkstream(db, row, name);
  const tabRenamed = inZellij() ? renameTab(oldTabName, computeTabName(updated)) : false;
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

// A stack tree as plain JSON: { id, branch, status, repo, stackedBy: [...] }.
const stackNode = (node) => ({
  ...briefStackRow(node.row),
  repo: isScratch(node.row) ? 'scratch' : `${node.row.org}/${node.row.repo}`,
  stackedBy: node.children.map(stackNode),
});

// The GitHub-stack eligibility of the chain through `row`, tolerating a branch
// point (a legitimate shape that just can't be a single linear GitHub stack).
function linearity(db, row) {
  try {
    const chain = stackLine(db, row);
    const check = stackCheck(chain);
    return { chain, order: chain.map((r) => r.branch), ...check };
  } catch (e) {
    return { chain: null, ok: false, reason: e.message };
  }
}

server.registerTool('ws_stack', {
  description: 'Show the stack a workstream sits in: the chain of parent/child ("stacked on") '
    + 'relationships, from the bottom branch up, as a tree. Use this to find out what unmerged work a '
    + "branch depends on and what depends on it — the answer isn't in git, since a branch doesn't record "
    + 'which branch it was cut from. Also reports whether the chain is eligible to become a stack of '
    + 'GitHub PRs (ws_stack_link), and if not, why not. Defaults to the worktree containing the current '
    + 'directory.',
  inputSchema: { workstream: workstreamArg },
}, async ({ workstream }) => {
  const db = openDb();
  const row = targetRow(db, workstream);
  const { chain, ok, reason, repo } = linearity(db, row);
  return json({
    workstream: briefRow(row),
    stackedOn: parentOf(db, row) ? briefStackRow(parentOf(db, row)) : null,
    stack: stackNode(stackTree(db, row)),
    linear: !!chain,
    bottomToTop: chain ? chain.map((r) => ({ ...briefStackRow(r), path: r.path })) : null,
    canLinkOnGitHub: ok,
    reason: ok ? undefined : reason,
    githubRepo: ok ? repo : undefined,
  });
});

server.registerTool('ws_stack_set', {
  description: 'Record that one workstream is stacked on another — i.e. its branch builds on the '
    + "other's unmerged work — or clear that relationship with clear:true. This is bookkeeping only: it "
    + 'moves no commits and rewrites no history, so it is safe to correct at any time. Cycles and '
    + 'self-parenting are rejected. Cross-repo and scratchpad parents are allowed (useful to record that '
    + 'work follows from other work), but only a same-repo chain of real branches can become GitHub '
    + 'stacked PRs — see ws_stack. To rebase the commits so the branches actually sit on each other, '
    + 'the user can run `ws stack rebase` themselves (it rewrites history).',
  inputSchema: {
    workstream: workstreamArg,
    parent: z.string().optional().describe('The workstream to stack it on (selector: id, branch, or org/repo:branch). Required unless clear:true.'),
    clear: z.boolean().optional().describe('Detach it from its parent instead of setting one.'),
  },
}, async ({ workstream, parent, clear }) => {
  const db = openDb();
  const row = targetRow(db, workstream);
  if (clear) {
    const had = parentOf(db, row);
    const updated = setParent(db, row, null);
    return json({ workstream: briefRow(updated), cleared: true, wasStackedOn: had ? briefStackRow(had) : null });
  }
  if (!parent) throw new Error('pass "parent" to stack this workstream on another, or clear:true to detach');
  const parentRow = resolveRow(db, parent);
  if (!parentRow) throw new Error(`no workstream matching parent "${parent}"`);
  const updated = setParent(db, row, parentRow);
  return json({
    workstream: briefRow(updated),
    stackedOn: briefStackRow(parentRow),
    stack: stackNode(stackTree(db, updated)),
  });
});

server.registerTool('ws_stack_link', {
  description: 'Turn the workstream\'s chain into a stack of pull requests on GitHub, bottom to top, by '
    + 'running `gh stack link`: it pushes each branch, opens a PR for any branch that lacks one (chaining '
    + 'each PR\'s base onto the branch below it), and creates or updates the stack shown in GitHub\'s PR UI. '
    + 'Existing PRs are reused and never removed. This PUSHES BRANCHES AND MAY OPEN PRs — confirm with '
    + 'the user first. It does not rewrite history or touch any worktree, so it cannot lose work. New PRs are '
    + 'drafts unless open:true. Requires a linear chain of at least two real branches in one repo (check '
    + 'with ws_stack first).',
  inputSchema: {
    workstream: workstreamArg,
    open: z.boolean().optional().describe('Mark new and existing PRs ready for review (default: create new PRs as drafts).'),
  },
}, async ({ workstream, open }) => {
  const db = openDb();
  const row = targetRow(db, workstream);
  const chain = stackLine(db, row); // throws on a branch point, with which children to pick between
  const check = stackCheck(chain);
  if (!check.ok) throw new Error(check.reason);
  const res = ghStackLink(chain, { open: !!open });
  return json({
    workstream: briefRow(row),
    repo: check.repo,
    bottomToTop: chain.map((r) => r.branch),
    command: res.command,
    ok: res.ok,
    output: res.output,
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
  description: 'Write a longer-form note file for a workstream under the configured notes root, filed as '
    + 'work/<year>/workstream/<id-name>/<timestamp>[-<title>].md — for writeups that outgrow a '
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
  description: "Assemble a day's work across all workstreams into a draft under the configured notes root: git "
    + 'commits by the configured git user that day (deduped across branches) plus any ws_log notes, with each '
    + "workstream's linked issues/PRs for reference. Returns both structured activity and notes-format "
    + 'markdown bullets. Use this to draft or update the daily work note — review/polish the markdown '
    + '(or use the structured data to write a better summary) rather than pasting blindly. Set write:true '
    + "to append the markdown under the day's heading in this week's work-notes file.",
  inputSchema: {
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
      .describe('Day to digest as YYYY-MM-DD (local). Defaults to today.'),
    write: z.boolean().optional()
      .describe("Append the markdown under the day's heading in this week's configured work-notes file (default: false)."),
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
