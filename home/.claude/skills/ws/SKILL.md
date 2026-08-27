# ws

Manage **workstreams**: a git branch + worktree + a Zellij tab with configurable
shell, editor, and AI-agent panels. One command to create, list, rejoin, and close them.

`ws` is the `@fritzy/ai-workstream` Node package at
`~/dotfiles/packages/ai-workstream/` (data in `node:sqlite`); the `ws` command on PATH
is a symlink to its `cli.js`. The same logic is also served as an **MCP server** (see
[MCP](#mcp-server) below), so basic housekeeping is available to Claude Code and Codex
sessions without loading this skill.

Package layout: `cli.js` (the command), `mcp.js` (the MCP server), `lib/core.js`
(shared db/git/worktree logic), and `lib/config.js` (configuration). On a fresh machine
run the dotfiles bootstrap or `npm install` in `~/dotfiles/packages/ai-workstream/`.

## How it's organized

By default, repos are cloned **bare** and worktrees nest as sibling directories:

```
~/github/<org>/<repo>/
  .bare/                 # bare clone of git@github.com:<org>/<repo>.git
  <branch>/              # one worktree directory per workstream
  <other-branch>/
```

Branch names with `/` are sanitized to `-` for directory and tab names; the real
branch name is stored in the database.

Each active workstream is a Zellij tab named `<id>:<repo>:<branch>` (scratchpads:
`<id>:scratchpad:<name>`) with the configured panel roles. Defaults are
**shell (`zsh`) | editor (`nvim`) | agent (`claude`)**.
The id prefix keeps the tab identifiable even when two branches share a name, and
survives a `ws rename` (see below), which only ever changes what comes after it.

Workstream metadata lives in a SQLite db at
`${XDG_DATA_HOME:-~/.local/share}/ws/workstreams.db`.

The package's default `config.ini` is overridden by
`${XDG_CONFIG_HOME:-~/.config}/ai-workstream/config.ini`. Run `ws config` to inspect
both config paths plus the resolved paths, panels, commands, agent, and models. Use
`--agent claude|codex` (`--claude` / `--codex`), `--model`, `--panels`, and
`--no-editor` as one-run overrides when opening a tab.

`ws daemon` starts the configured localhost REST/WebSocket service in the background;
use `ws daemon status|stop|restart|foreground|log` to manage it. Its workstream API is
`GET /ws/{id}/` (use `id=all` for a collection), commands are
`POST /ws/{id}/{cmd}`, and invalidations stream from `/ws/events` as
`{"id":123,"change":"new"}` or `{"id":123,"change":"changed"}`. Fetch the
workstream again after an event. `ws web start` starts the daemon if needed and
opens its local web client.

## Commands

### List

```bash
ws list          # active workstreams
ws list --all    # include closed ones
```
`●` = worktree present on disk, `○` = worktree removed (rejoin to reconstitute).

### Refresh

```bash
ws refresh
```

Scans every running Zellij session. A workstream with an open expected tab becomes
`active`; an `active` workstream with no tab becomes `paused`; and an absent closed
workstream remains closed. It aborts without changing statuses if Zellij cannot be
queried reliably.

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
branch.

#### Seeding the agent panel

```bash
ws new <org/repo> <ref> --seed <file>     # also works on: ws scratch [name] --seed <file>
```
`--seed <file>` hands the new tab's selected agent a **seed document**: the file is
copied to `${XDG_DATA_HOME:-~/.local/share}/ws/seeds/<id>.md` (never into the
worktree, so git status stays clean) and the agent starts with an instruction to read
that file instead of resuming. Use it to hand off context + a task to a fresh
session (e.g. a findings writeup and plan composed elsewhere). Re-seeding a
workstream overwrites its previous seed. The MCP `ws_new` / `ws_scratch` /
`ws_resume` tools take the same thing as a `seed` parameter carrying the markdown
content inline (the calling agent composes it directly rather than pointing at a
file); on `ws_resume` the seed only takes effect if the tab isn't already open.

#### Fork routing (when you can't push to the canonical repo)

For a plain `branch`, before creating it `ws` asks GitHub's rulesets API
(`/repos/<org>/<repo>/rules/branches/<branch>`) whether a `creation` rule blocks
pushing new refs to the canonical repo. If it does — e.g. you're an outside
contributor to `chainguard-dev/mono` — `ws` routes the repo through **your fork**:

- `origin` is repointed to `git@github.com:<you>/<repo>.git` (your fork; push target)
- `upstream` is the canonical repo, fetch-only (`pushurl` disabled), and new branches
  are based off `upstream/<default-branch>`
- the fork is created with `gh repo fork` if it doesn't exist yet

This mirrors a hand-set-up fork checkout, so `git push` / `git pull` from the worktree
go to your fork. A branch that already exists on your fork is checked out from there
(`origin/<branch>`); otherwise an existing canonical branch (`upstream/<branch>`) is
used; otherwise a new branch is started off the canonical default branch.

The decision is detected with `gh` and remembered per clone in the bare repo's
`ws.useFork` config (`git -C <bare> config --unset ws.useFork` to re-evaluate). Repos
where you *can* push directly keep `origin` pointed at the canonical repo as before.

### Scratchpad

```bash
ws scratch [name]      # alias: sp
```
A **scratchpad** is a throwaway workstream that lives under the configured scratchpad root
instead of a git worktree — no repo, no branch, just a fresh directory opened with the
same configured tab. It lives in a persistent directory rather than a temp dir,
so it survives reboots. Give it a name or omit it for a random one (e.g. `calm-otter`).
Names are slugged for the dir/tab and suffixed if they collide. Its tab is
`scratchpad:<name>`.

Scratchpads are otherwise normal workstreams: they show in `ws list`, can be
`pause`d / `resume`d / `join`ed (reconstituting just recreates the directory), and
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

### Rename

```bash
ws rename <id|branch> <name>   # rename its tab (renamed in place if open)
ws rename <name>                # rename the current workstream (context-resolved)
```
For a **scratchpad**, this renames its directory and its name field — a scratchpad's
name is made up, so there's nothing else to preserve. For a **git-backed workstream**,
it only sets a display **label** used in place of `repo:branch` in the tab name; the
underlying git branch is left alone (renaming a real branch is a much bigger, riskier
operation). Either way the id prefix stays put and an open tab is renamed live.

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

On `ws new` and `ws join`/`resume`, `ws` also looks up (via `gh`) whether the branch
has an open/closed PR on its repo — including fork PRs — and links it automatically
(prefers an open PR). This is best-effort and idempotent: no `gh` or no PR links
nothing, and an already-linked PR isn't duplicated.

### Stacks (parent → child)

A workstream can be **stacked on** another: "this branch builds on that one's unmerged
work." Git doesn't record which branch a branch was cut from, so ws does.

```bash
ws new <org/repo> <branch> --parent <id|branch>   # create it branched off that workstream
ws stack [--ws X]                                # show the chain (a tree, bottom first)
ws stack on <id|branch> [--ws X]                 # record a parent for an existing workstream
ws stack off [--ws X]                            # detach from its parent
```
`ws stack on` is **bookkeeping only** — it moves no commits, so it's safe to correct at
any time. `--parent` on `ws new` is the one that affects git: the new branch is created
off the parent's branch instead of the default branch.

The relationship is deliberately loose: any workstream can parent any other, including
across repos and scratchpads, so it also serves as "this work follows from that work."
Cycles and self-parenting are rejected. A parent in a *different* repo is recorded but
can't be branched off (it isn't a ref in this clone). `ws list` shows
`↳ stacked on #N (branch)` under each stacked workstream.

One branch may have several children — that's a valid tree, it just isn't a single
linear stack, so the GitHub-stack commands below ask you to target one child.

#### Stacked PRs on GitHub (`gh stack link`)

When a chain is **two or more branches of the same repo on the canonical remote**, it
can become a stack of PRs in GitHub's PR UI:

```bash
ws stack link [--ws X]           # push the branches, open/chain PRs, create the stack
ws stack link --open [--ws X]    # and mark them ready for review (default: new PRs are drafts)
```
This shells out to `gh stack link <bottom> … <top>` with the chain in ws's order. It
pushes each branch, opens a PR for any branch lacking one (basing each on the branch
below), reuses existing PRs, and creates or updates the server-side stack object.
It never rewrites history or touches a worktree.

`ws stack` reports eligibility and, when a chain can't be a GitHub stack, why:

| Not eligible when | Because |
|---|---|
| fewer than two workstreams | nothing to stack |
| a scratchpad is in the chain | no branch, so no PR |
| the chain mixes repos | a GitHub stack is one repo |
| a member is `owner:branch` (someone's fork) | not our branch to stack |
| the repo is fork-routed (`ws.useFork`) | our branches aren't on the repo the PRs target — stack those by hand in the PR descriptions |
| one branch has two children | a GitHub stack is linear; target one child |

#### Why only `gh stack link`, and not the rest of `gh stack`

**`gh stack`'s local half is incompatible with the worktree layout, and ws replaces it.**
`gh stack init`, `checkout`, `up`/`down`/`switch`/`top`/`bottom`/`trunk`, `rebase`, and
`sync` all work by `git checkout`-ing each stack branch in **one** working tree. Under ws
every branch is its own worktree, so checking out a stack branch fails — it's already
checked out elsewhere. Use the ws equivalents:

| Instead of | Use |
|---|---|
| `gh stack init` | `ws new … --parent X` / `ws stack on X` |
| `gh stack checkout` / `up` / `down` / `switch` | `ws join <id\|branch>` (each branch is its own tab) |
| `gh stack rebase` / `sync` (rebase half) | `ws stack rebase` |
| `gh stack submit` / `sync` (link half) | `ws stack link` |
| `gh stack view` | `ws stack` |

`gh stack link` is the exception: it's documented for exactly this situation — people who
manage branches with external tools (jj, Sapling, git-town, ws) and want GitHub's stacked
PRs without adopting gh's local tracking. It addresses branches by name and checks nothing
out. ws runs it from the bottom branch's worktree.

Note that chained PR base branches alone don't make a stack in the UI; the stack is its
own server-side object, which is what `link` creates.

#### Cascading rebase

```bash
ws stack rebase [--ws X]            # rebase each branch onto its parent, bottom to top
ws stack rebase --trunk [--ws X]    # first rebase the bottom branch onto origin/<default>
```
Each branch is rebased **in its own worktree** (`git -C <worktree> rebase <parent-branch>`),
which is the whole reason this isn't `gh stack rebase`. It refuses a worktree with
uncommitted changes, and stops at the first conflict, telling you which worktree to
resolve it in — branches below that point are already rebased, so re-run it afterwards to
finish the ones above.

Two things it deliberately leaves to you: it does **not** push (the rewritten branches
each need `--force-with-lease`), and it will trigger gitsign per rewritten commit, since
rebasing re-signs them.

### Work log

Jot a one-line note of what you did or figured out against a workstream, as you go.
These are the feed for the daily notes digest — capture the intent/outcome that a
commit subject would miss (a root cause tracked down, a decision made). The workstream
is taken from the current directory (or `--ws <id|branch>`).

```bash
ws log <msg...>            # an in-progress note
ws log <msg...> --done     # mark it a completed item
```
Examples (run from inside the worktree):
```bash
ws log "root-caused the SIGKILL to Falcon killing the socket listener"
ws log "shipped the retry-backoff fix" --done
```
Entries are stored per workstream with a timestamp (`done` flags completed items) so a
day can later be reconstructed for `~/notes` — see the **notes** skill.

### Notes

Longer-form notes — a design decision, a debugging writeup, a plan — that outgrow a
one-line `ws log` entry. Each is its own file under
`~/notes/work/<YYYY>/workstream/<id>-<repo>-<branch>/<timestamp>[-<title>].md`
(scratchpads: `<id>-<name>/`). They're written **only** via the MCP `ws_note` tool
(an agent session filing a note for you) — there's no CLI write command — but you can
list and read them from the terminal:

```bash
ws note list [--ws X]          # filenames, oldest first
ws note show <file> [--ws X]   # print a note's contents
```

### Digest

Draft a day's `~/notes` work entry from what actually happened, across all workstreams:
the git commits you authored that day (deduped across branches) plus your `ws log`
notes, with each workstream's linked issues/PRs nested for reference.

```bash
ws digest                    # today's activity as notes-format bullets (prints)
ws digest 2026-06-25         # a specific day (YYYY-MM-DD, local)
ws digest --write            # also append under today's heading in this week's note
```
`--write` locates (or creates) this week's `~/notes/work/<YYYY>/<Monday>-week.md`,
finds the day's `## <Weekday>, …` heading, and appends the bullets after any existing
entries — review and trim rather than treating it as final. Without `--write` it just
prints, so you can pipe or edit before committing anything.

## Status model

`active` (working on it) → `paused` (set aside, worktree kept) → `closed` (done; worktree
usually removed). `ws list` shows active + paused; `--all` adds closed. `ws close --keep`
is like `pause` but final — the difference is purely the recorded status.

## Work notes

Work done in a workstream is logged to weekly notes under `~/notes/work/` — see the
**notes** skill for the layout. The fast path: `ws log` (above) captures notes as you
go, and `ws digest [--write]` drafts a day's entry from your commits + those logs, with
each workstream's linked issues nested in. When drafting by hand instead, reference a
workstream's issues with `ws issue list` (from inside the worktree).

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
Claude Code and Codex, so every session can do workstream housekeeping via tools
without invoking this skill:

| Tool | Does |
|------|------|
| `ws_list` | List workstreams (+ status, worktree presence, linked issues, which one is current). Arg: `all`. |
| `ws_config` | Show the resolved paths, panels, commands, and agent defaults. |
| `ws_new` | Create/open a workstream (clones if needed, fork-routes, links PR). Args: `repo`, `ref`, `parent` (stack it on another workstream — a new same-repo branch is cut from the parent's branch), `seed`, `agent`, `model`, `panels`, `noEditor`. |
| `ws_resume` | Rejoin a workstream, reconstituting the worktree if removed. Args: `workstream`, `seed`, `agent`, `model`, `panels`, `noEditor` (layout options only apply if the tab isn't already open). |
| `ws_pause` | Close the tab, keep the worktree (status: paused). Arg: `workstream`. |
| `ws_rename` | Rename a workstream (and its open tab, if any). Scratchpad: renames its dir/name; git-backed: sets a display label only, branch untouched. Args: `name`, `workstream`. |
| `ws_close` | Close a workstream in one call: mark closed, close the tab, and (for a git worktree) remove it. Args: `workstream`, `keep`, `force`. A git worktree is removed by default (commits survive in the bare clone) — refuses a dirty one (returns the dirty file list) unless `force:true`, `keep:true` leaves it on disk. A **scratchpad keeps its directory by default** (no git backing, so it stays resumable) and is only deleted with `force:true`. |
| `ws_stack` | Show the chain a workstream sits in (tree, bottom first) plus whether it can become a GitHub PR stack and why not. Arg: `workstream`. |
| `ws_stack_set` | Record that a workstream is stacked on another, or `clear:true` to detach. Bookkeeping only — moves no commits. Args: `workstream`, `parent`, `clear`. |
| `ws_stack_link` | Push the chain's branches and create/update its stack of PRs on GitHub (`gh stack link`). Args: `workstream`, `open`. **Pushes branches and may open PRs — confirm first.** |
| `ws_issue_list` | List issues linked to a workstream. Arg: `workstream`. |
| `ws_issue_add` | Link issues. Args: `refs` (array), `workstream`. |
| `ws_issue_remove` | Unlink an issue by link or id. Args: `ref`, `workstream`. |
| `ws_log` | Record a one-line work-log note against a workstream (feeds the daily notes digest). Args: `body`, `done` (mark completed), `workstream`. |
| `ws_note` | Write a longer-form note file under the configured notes root — the only way notes get written. Args: `body`, `title` (optional), `workstream`. |
| `ws_note_list` | List note files written for a workstream via `ws_note`. Arg: `workstream`. |
| `ws_digest` | Assemble a day's commits + work logs (with linked issues) across all workstreams into structured activity **and** notes-format markdown. Args: `date` (YYYY-MM-DD, default today), `write` (append under the day's heading in the configured weekly notes file). |
| `ws_scratch` | Create a DB-tracked, resumable scratchpad with no git repo or branch. Args: `name`, `seed`, `agent`, `model`, `panels`, `noEditor`. Opens the configured tab when the server runs inside Zellij; otherwise just creates the dir and returns its path. |

`workstream` accepts the usual selector (id / branch / `org/repo:branch`); when omitted
the tool uses the worktree containing the session's working directory.

**Prefer `ws_close` / `ws_pause` over shelling out to `ws close` / `ws pause`** — the
tools are non-interactive and need no skill load or manual `git status` poking: a close
is a single call, and a dirty worktree comes back as a structured `needsForce` result
(with the file list) for you to relay before retrying with `force:true`. The CLI's
interactive prompts only matter when a human runs `ws` in a terminal. Tab handling
mirrors the CLI: inside Zellij the tab is opened/closed in place; from outside, tab
operations are skipped (attaching would be interactive) and the worktree path is still
returned. Closing the workstream you're currently in also closes that tab, which ends
the session — that's the confirmation.

**There is deliberately no `ws_stack_rebase` tool.** A cascading rebase rewrites history
and re-signs commits through gitsign (interactive), so `ws stack rebase` is CLI-only —
Nathan runs it. Suggest it as `! ws stack rebase --ws <id>` so its output lands in the
session. `ws_stack_link` *is* exposed because it only pushes and opens PRs (no history
rewriting, nothing lost), but confirm before calling it: it's outward-facing.

Manage registration with `claude mcp get ws` / `claude mcp remove ws -s user` and
`codex mcp get ws` / `codex mcp remove ws`. Both run
`node --no-warnings ~/dotfiles/packages/ai-workstream/mcp.js`.

## Notes

- Distinct from the Rust `wt`/worktrunk tool — they don't share state.
