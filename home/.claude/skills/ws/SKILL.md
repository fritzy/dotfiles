# ws

Manage **workstreams**: a git branch + worktree + a Zellij tab pre-wired with three
panes (zsh, nvim, claude). One command to create, list, rejoin, and close them.

`ws` is a Node package at `~/.scripts/ws/` (data in `node:sqlite`); the `ws` command on
PATH is a symlink to its `cli.js`. The same logic is also served as an **MCP server**
(see [MCP](#mcp-server) below), so basic housekeeping is available to Claude sessions
without loading this skill.

Package layout: `cli.js` (the command), `mcp.js` (the MCP server), `lib/core.js`
(shared db/git/worktree logic). On a fresh machine run `npm install` in `~/.scripts/ws/`.

## How it's organized

Repos are cloned **bare** and worktrees nest as sibling directories:

```
~/github/<org>/<repo>/
  .bare/                 # bare clone of git@github.com:<org>/<repo>.git
  <branch>/              # one worktree directory per workstream
  <other-branch>/
```

Branch names with `/` are sanitized to `-` for directory and tab names; the real
branch name is stored in the database.

Each active workstream is a Zellij tab named `<repo>:<branch>` with three equal
vertical panes: **zsh | nvim | claude**.

Workstream metadata lives in a SQLite db at
`${XDG_DATA_HOME:-~/.local/share}/ws/workstreams.db`.

## Commands

### List

```bash
ws list          # active workstreams
ws list --all    # include closed ones
```
`●` = worktree present on disk, `○` = worktree removed (rejoin to reconstitute).

### Create / open

```bash
ws new <org/repo> <ref>
```
Prompts for any missing argument. Clones the bare repo if absent (asks first),
creates the worktree, records it, and opens the Zellij tab. `create` is an alias.

`<ref>` can be any of:

| Form | Meaning | Example |
|------|---------|---------|
| `branch` | A branch on `origin`. Created off the default branch if it doesn't exist yet. | `ws new chainguard-dev/ecosystems-rebuilder.js fix-foo` |
| `123` or `#123` | A pull request by **number** — works whether the PR comes from `origin` or a **fork**. Uses `gh` to resolve the head branch (falls back to GitHub's `refs/pull/N/head` pull ref if `gh` is unavailable). | `ws new chainguard-dev/mono 4567` |
| `owner:branch` | A branch on someone's **fork** of this repo. | `ws new chainguard-dev/mono alice:feature-x` |

For fork PRs and `owner:branch`, `ws` adds the fork as a named remote and sets the
local branch's upstream to it, so `git push` from the worktree goes back to the PR
branch. (The bare clone's `origin` always stays the canonical `chainguard-dev` repo.)

### Scratchpad

```bash
ws scratch [name]      # alias: sp
```
A **scratchpad** is a throwaway workstream that lives in a temp directory
(`$TMPDIR/ws-scratch/<name>`) instead of a git worktree — no repo, no branch, just a
fresh directory opened with the same three-pane tab (zsh, nvim, claude). Give it a name
or omit it for a random one (e.g. `calm-otter`). Names are slugged for the dir/tab and
suffixed if they collide. Its tab is `scratchpad:<name>`.

Scratchpads are otherwise normal workstreams: they show in `ws list`, can be
`pause`d / `resume`d / `join`ed (reconstituting just recreates the temp dir), and
`ws close` removes the directory.

### Rejoin

```bash
ws join <id|branch>       # alias: rejoin
```
Focuses the tab if it exists; recreates the worktree first if it was removed.

### Pause / resume

```bash
ws pause <id|branch>      # close the tab, keep the worktree (status: paused)
ws resume <id|branch>     # reopen the tab (focuses it if already open; reconstitutes if needed)
```
Pausing is the "set this aside for now" state: the worktree stays on disk so resuming
is instant. Paused workstreams still show in `ws list`.

### Close

```bash
ws close <id|branch>          # closes the tab, prompts to remove the worktree
ws close <id|branch> --keep   # closes the tab, keeps the worktree on disk
```
Marks the workstream closed; it drops out of `ws list` (still visible under `ws list --all`).

### Issues

Link Linear or GitHub issues (or any URL/identifier) to a workstream — a workstream
can have many. The workstream is taken from the current directory (see
[Context](#context)); use `--ws <id|branch>` to target a different one.

```bash
ws issue add <link...> [--ws X]    # link one or more issues
ws issue remove <link> [--ws X]    # unlink, by exact link or by the issue's own id
ws issue list [--ws X]             # show linked issues (with their ids)
```
Examples (run from inside the workstream's worktree):
```bash
ws issue add ENG-1234 https://github.com/chainguard-dev/mono/issues/42
ws issue remove ENG-1234
ws issue list --ws fix-foo          # a different workstream, from anywhere
```
Each reference is classified for display (`linear` / `github` / `link`) — Linear keys
like `ENG-1234` and `linear.app` URLs show as `linear`, `github.com` URLs as `github`.
Linked issues also appear indented under their workstream in `ws list`.

## Status model

`active` (working on it) → `paused` (set aside, worktree kept) → `closed` (done; worktree
usually removed). `ws list` shows active + paused; `--all` adds closed. `ws close --keep`
is like `pause` but final — the difference is purely the recorded status.

## Work notes

Work done in a workstream is logged to weekly notes under `~/notes/work/` — see the
**notes** skill for the layout and logging steps. When logging work for a workstream,
reference its linked issues: `ws issue list` (from inside the worktree) gives the
Linear/GitHub links to drop under the day's entry.

## Context

`ws` notices where it's run and uses that as the default context:

- **Current worktree** — if the current directory is inside a workstream's worktree,
  commands that act on a workstream default to *that* one when you don't pass a
  selector (e.g. `ws pause`, `ws issue add ENG-1`, `ws close`). `ws list` marks it
  with `▸`. Override with an explicit selector or `--ws <id|branch>`.
- **Zellij session** — if `ws` is run inside a Zellij session, tabs are added to /
  focused in it. If run from outside any session, `ws new`/`join`/`resume` attach to
  (or create) a session named `ws` (override with `$WS_SESSION`) and open the tab there.

If no context and no selector are available, the workstream commands fall back to an
interactive pick from the list.

## Selectors

`<id|branch>` accepts a numeric id, a branch name, or `org/repo:branch` to
disambiguate when the same branch name exists in multiple repos. When omitted,
the current worktree is used (see [Context](#context)).

## MCP server

`mcp.js` is a stdio MCP server (built on `@modelcontextprotocol/sdk`) registered with
Claude Code at user scope, so every session can do workstream housekeeping via tools
without invoking this skill:

| Tool | Does |
|------|------|
| `ws_list` | List workstreams (+ status, worktree presence, linked issues, which one is current). Arg: `all`. |
| `ws_issue_list` | List issues linked to a workstream. Arg: `workstream`. |
| `ws_issue_add` | Link issues. Args: `refs` (array), `workstream`. |
| `ws_issue_remove` | Unlink an issue by link or id. Args: `ref`, `workstream`. |
| `ws_scratch` | Create a scratchpad (temp-dir workstream). Arg: `name` (optional). Opens the three-pane tab when the server runs inside Zellij; otherwise just creates the dir and returns its path. |

`workstream` accepts the usual selector (id / branch / `org/repo:branch`); when omitted
the tool uses the worktree containing the session's working directory. Creating/joining/
closing **git** worktrees and their tabs stay in the CLI, since they're interactive and
have nowhere to attach from a tool call — `ws_scratch` is the exception, since a
scratchpad is just a temp dir and the tab can be opened in place from within Zellij.

Manage the registration with `claude mcp get ws` / `claude mcp remove ws -s user`; the
command it runs is `node --no-warnings ~/.scripts/ws/mcp.js`.

## Notes

- Distinct from the Rust `wt`/worktrunk tool — they don't share state.
