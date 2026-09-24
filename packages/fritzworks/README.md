# FritzWorks

`fritzworks` is an opinionated browser-based workstream manager for Git worktrees. Each workstream records a repository, branch, status, linked resources, short logs, and longer notes. FritzWorks displays each session as an ordered workspace of persistent terminals, one optional Claude Code or Codex panel, Markdown files, and associated web pages.

Setup also links `fw-mcp`, a stdio MCP server exposing the non-interactive workstream operations.

![](./fritzworks.png)

## Requirements

- macOS or Linux
- Node.js 22.22.2+ (22.x), 24.15.0+ (24.x), or 26+
- Git and Zellij
- Claude Code or Codex for AI panels (optional for terminal and notes use)
- An editor and shell for those panels, if enabled (defaults: `vi` and `/bin/sh`; configure your preferred commands)
- Optional: authenticated GitHub CLI (`gh`) for PR discovery and fork routing
- Optional: the `github/gh-stack` extension for `fw stack link`

Repository clones default to SSH URLs. Set `gitProtocol` to `https` if that better matches your GitHub authentication.

## Install

Clone the repository, then run these commands from the directory containing
`package.json` (currently `packages/fritzworks` in the dotfiles checkout):

```sh
npm i
npm run setup
npm start
```

`npm run setup` builds the web client, creates a user config if absent, and links
`fw`, `fw-mcp`, and `fritzworks` into `~/.local/bin`. It installs hooks and skills
for detected Claude Code/Codex clients and registers the `fw` MCP server with
available client CLIs. It installs Zsh status hooks when `$SHELL` or the configured
shell selects Zsh. Keep `~/.local/bin` on your `PATH` to use the commands directly.
`npm start` opens the system browser and starts the daemon if needed.

Setup can be rerun. It preserves user configuration, unrelated hooks, customized
skills, and existing MCP registrations. If a command name in `~/.local/bin`
already belongs to something else, setup stops before changing integrations.
Hooks and MCP registrations use absolute Node/checkout paths. Keep the checkout
in place and rerun setup after changing the Node installation.

Optional setup controls:

```sh
npm run setup -- --provider codex   # claude, codex, or all; default: detected clients
npm run setup -- --shell            # explicitly install Zsh hooks
npm run setup -- --no-shell         # skip Zsh hooks
npm run setup -- --no-mcp           # leave MCP registration to you
npm run doctor
npm run fw -- config
```

Client detection uses the configured CLI executable or client home directory.
Setup respects `CLAUDE_CONFIG_DIR` and `CODEX_HOME`. Restart AI clients afterward
to load skills, MCP tools, and hooks; client hook trust/enablement still applies.

The checkout includes npm 12's install-script approval for `node-pty`. If native
terminal support is unavailable, run `npm rebuild node-pty` and `npm run doctor`.
A source build requires Python 3 and C/C++ build tools (`build-essential` on
Debian/Ubuntu, Xcode Command Line Tools on macOS).
See [node-pty requirements](https://github.com/microsoft/node-pty#dependencies).

To update, pull the repository, run `npm i` and `npm run setup`, then run
`npm run fw -- daemon restart`. Config, notes, worktrees, and SQLite data live
outside the checkout and remain intact.

Before removing the checkout, run `npm run fw -- hooks uninstall --shell`,
`npm run fw -- skills uninstall`, and `npm run fw -- daemon stop`. Remove the
clients' `fw` MCP registrations with their `mcp remove fw` commands and remove
only the three `~/.local/bin` links pointing into this checkout. User data and
customized/unmanaged files remain.

## Configuration

The package ships [`config.ini`](./config.ini). A user file at
`$XDG_CONFIG_HOME/fritzworks/config.ini`, normally `~/.config/fritzworks/config.ini`,
overrides those defaults. New configurations use `configVersion = 2`:

```ini
configVersion = 2
agent = claude
gitProtocol = ssh

[paths]
data = ${XDG_DATA_HOME}/fritzworks
# These are optional; each defaults to its own subdirectory of paths.data.
repositories = ~/projects/repository-cache
worktrees = ~/projects/worktrees
scratchpads = ~/projects/scratchpads
sessionNotes = ~/writing/sessions

[notes.weekly]
enabled = false
# When enabled, an explicit root is required:
# root = ~/writing/weekly

[commands]
shell = /bin/sh
editor = vi
claude = claude
codex = codex

[server]
host = 127.0.0.1
port = 7337
pollInterval = 1000
```

With no overrides, managed roots are `<data>/repositories`, `<data>/worktrees`,
`<data>/scratchpads`, and `<data>/session-notes`. There is no general `notes` root.
Paths support `~/`, `${HOME}`, and `${XDG_DATA_HOME}` prefixes; relative paths use
the selected config file's directory. Managed roots must not overlap each other
(including through existing symlinks) or contain the data directory. They may be
separate children of that directory. Enabled weekly storage follows the same rule.
Existing ancestors and symlink targets must be directories; missing directory
trees are accepted, while file ancestors and dangling symlinks are rejected.

`fw config validate` validates without creating state or starting a daemon.
`fw config` queries the selected daemon (starting local on demand) and prints
effective values, `sources` keyed by setting, compatibility
`diagnostics`, and storage availability. `fw config active` queries the already
running daemon and reports its active values plus active/disk revisions. This CLI
view still needs valid local connection configuration; use the running daemon's
`GET /config/status` to inspect a broken on-disk file. Unknown
keys, invalid sections/IDs/URLs, duplicate keys, and conflicting roots fail before
daemon startup. A missing explicitly selected non-default config file is an error.

Session notes now allocate a persisted UUID directory under `paths.sessionNotes`,
created on the first write. Configured locations get independent persisted UUIDs.
Group responses include `markdownDirectory` and `noteStorage`; sessions include
`notesPath` and `noteStorage`. Renames, year changes, root edits, and archive keep
existing note paths. Unavailable volumes preserve resource associations and return
storage errors. Weekly notes remain separately opt-in.

Repository creation accepts an existing local repository path, an explicit clone
URL, or GitHub `owner/repo`. Local branch creation needs neither a remote nor `gh`.
Repository identity/common Git directory and each worktree allocation are persisted;
new checkouts use `<worktrees>/<branch-slug>-<session-uuid>`. Root edits affect new
allocations. Resume verifies the recorded Git ownership, and archive removal has
no recursive-delete fallback after a Git failure. Interrupted clones retain their
partial directories and retry through their instance-owned cache reservation.

Existing unversioned files use version 1 compatibility, preserving the old
`~/github`, `~/scratchpad`, and `~/notes` defaults and any effective legacy aliases.
The old `ai-workstream/config.ini` and `ws/workstreams.db` fallbacks remain. No
files move. `locations.notes` can determine the old note root only in this
compatibility adapter; diagnostics and sources identify that coupling. Other
location IDs are no longer inserted into the storage map. New setup writes the
selected schema version explicitly. A small `config-format.json` marker in the
data directory preserves v2 selection for configless and CLI-first starts.

The migration implementation is available for isolated validation. The existing-install
upgrade gate remains open: real Git moves and real legacy shell PID/environment
continuity have not been tested under the current restrictions. Do not deploy this
working tree or migrate a live installation on the strength of mocked tests.

Commands accept an executable string or an argument array, for example
`editor = ["nvim", "--clean"]`. Empty model values disable explicit model selection.

### Optional locations and work suggestions

Locations are ordinary external directories: only `path` is required. `name`
controls the display label, `enabled = false` hides an entry, and optional `repo`
(`owner/repository`) and `branch` describe GitHub metadata. A supplied repository
without a branch defaults to `main`; plain directories have neither. The daemon
recognizes a local `.git` marker for Git status without requiring repository
metadata. Existing locations are never removed by archive/close, and missing
paths are reported instead of created. IDs `notes` and `dotfiles` have no special
meaning in version 2. Removing or disabling entries does not delete their files.
Locations and remotes are both empty by default; zero or multiple entries work.

```ini
[locations.notes]
name = Reference material
path = ~/reference

[locations.dotfiles]
name = Settings
path = ~/configuration

[locations.project]
repo = example/project
path = ~/projects/project

[suggestions.linear]
enabled = true
team = TEAM

[suggestions.github]
enabled = true
issueRepository = example/issues
issueLabel = needs-help
reviewRepositories = ["example/project"]
teammates = ["colleague"]
```

Restart with `fw daemon restart` after editing configuration. Browser theme,
font size, sidebar width, and omitted branch prefixes are browser-local preferences.
Branch prefixes are displayed in full by default.

Daemon settings remain fixed until restart. `GET /config` returns the active
configuration; `GET /config/status` reports `activeRevision`, `diskRevision`,
`restartRequired`, and validation errors from the selected config file. `/health`
also reports that status and a persistent `instanceId`. Foreground and detached
startup share the selected configuration, process metadata, and one owner lock
per data directory. Terminal namespaces belong to the instance, including when
CLI commands initialize its database before daemon startup. Persisted legacy
terminal records without verified instance ownership remain intact and report
`terminalOwnership.status = migration_required` in `/health`. Their terminal
attachments and terminal-changing actions return 409 until explicit ownership
migration succeeds; existing processes are left running. Global `fw`/`ws` sessions
are never automatically claimed by a new instance.

### Storage adoption and recovery

These commands contact an already-running selected local daemon and do not start
or restart it:

```sh
fw storage inventory --legacy-config /absolute/path/to/legacy-config.ini
fw storage apply --revision <inventory-revision> --write-config
fw storage ledger
fw storage recover --migration <migration-id>
fw storage terminals preview
fw storage terminals apply --revision <terminal-inventory-revision>
fw storage terminals apply --revision <terminal-inventory-revision> --legacy-approvals /absolute/path/to/reviewed-terminals.json
fw storage terminals recover --migration <migration-id>
```

Older terminals may lack installation identity variables. On Linux, the preview
can mark these as `reviewRequired` when their user-owned listening socket, process,
FritzWorks launch marker, and recorded working directory agree. This requires
`ss` from iproute2; a missing tool leaves the session blocked. Inspect those exact
processes before approving them. The JSON file is an array of
`{ "panelId": "...", "name": "...", "fingerprint": "..." }` records copied from
the reviewed preview. A revision alone does not approve these candidates. The
daemon rechecks the process/socket fingerprint, records the acknowledgement, and
reuses that existing session; it never kills or recreates it during adoption.
When two server processes share a name, only the server bound to the socket inode
currently on disk is eligible. Other server processes are left untouched.

Omit `--legacy-config` when the daemon already uses the legacy effective config.
Inventory resolves that configuration, inventories recorded worktrees, legacy bare
caches, UUID/numeric-slug notes across years, configured owners, resources and tabs.
Apply keeps all note directories, pins one write directory, and retains the others
for reads. It moves no storage. The preview includes exact configuration before/after
text; `--write-config` writes the translation atomically, preserving effective settings
and disabled entries. Environment overrides are listed and still take precedence;
remove obsolete legacy overrides before restarting with version 2. An explicit restart
loads the translated configuration.

Migration records and consistent SQLite/config/tab backups live under the existing
data root. Recovery replays the original ledger plan and accepts already-written tab
or config contents; unrelated edits cause a conflict. An interrupted relocation blocks
writes/scans for its owner. Keep both paths and the backup while recovering.

| Operation | HTTP contract |
| --- | --- |
| Inventory/adopt notes and Git storage | `GET /migrations/storage`, `POST /migrations/storage/apply` with `revision`, optional `legacyConfigPath` and `applyConfiguration` |
| Recover adoption / inspect ledger | `POST /migrations/storage/recover` with `migrationId`; `GET /migrations` |
| Verify/adopt legacy terminals | `GET /migrations/terminals`; `POST /migrations/terminals/apply` with `revision`; `/recover` with `migrationId` |
| Relocate notes or a worktree | `POST /storage/relocate/preview` with `target`, `kind` (`notes` or `worktree`), absolute `destination`, optional `copy:true`; `/apply` also requires `revision`; `/recover` takes `migrationId` |
| Rename a configured location identity | `POST /storage/location/preview` with `from`, `to`; `/apply` also requires `revision`; `/recover` takes `migrationId` |

Terminal adoption verifies a live server's process generation, descendant installation
identity and owner ID, then persists a per-terminal name/evidence mapping and exclusive
claim. Contradictory config/data/instance evidence is rejected. Verified adoption does
not rename, kill, reset or recreate shells. Proven-inactive panels can migrate without
claiming a process. Ambiguous ownership stays blocked. The default process inspector
currently supports Linux only; macOS legacy adoption needs an additional inspector and
real continuity validation. An adopted process that exits requires explicit recovery
before a fresh namespaced terminal can replace it.

Relocation requires affected terminals to be stopped and rechecks their absence.
Same-filesystem worktree movement uses Git; `copy:true` supports a retained-source
cross-filesystem copy followed by Git repair and verification. A partial owned copy can
resume. Symlinks are preserved without following them; other non-regular entries require manual handling. Resources, saved tabs,
browser paths, and allocations change only after destination verification. Markdown
watchers are invalidated so clients reopen the updated resource path. Retained source
copies are never deleted automatically. Location-ID migration retains notes/resources,
requires stopped terminals, and blocks terminal/note actions until explicit restart.

Changing only `paths.data` is rejected using the configuration's adjacent
`.instance.json` binding. Use the offline command after stopping the owning daemon:

```sh
fw storage rebind preview --destination /absolute/new-data
fw storage rebind apply --destination /absolute/new-data --revision <preview-revision>
fw storage rebind recover --source /absolute/old-data --migration <migration-id>
```

Rebind locks both data roots, snapshots SQLite, copies tabs/config marker/seeds, preserves
instance and terminal identity, updates config/binding, and retires the old database.
Existing repository, worktree, scratchpad and note paths stay pinned, including paths
inside the old data directory. Keep that directory; rebind does not relocate those files.
A pending destination cannot start a daemon. Recovery uses the source ledger and works
even if config replacement already occurred. Environment data overrides must be updated
or removed before the next daemon start.

Current binaries reject a newer storage schema and a retired source database. Binaries
predating this guard cannot honor it: in-place downgrade is unsupported. To roll back,
stop the daemon, retain the failed directories and ledger, and restore the recorded
pre-migration SQLite/config/tab backup together with the previous config binding into
an isolated recovery location. Do not run old and new binaries against the same state.

### Environment overrides

These settings can also be overridden without editing the INI file:

| Setting | Environment variable |
| --- | --- |
| Config file | `FRITZWORKS_CONFIG` |
| Repository root | `FRITZWORKS_REPOSITORIES` |
| Scratchpad root | `FRITZWORKS_SCRATCHPADS` |
| Worktree root | `FRITZWORKS_WORKTREES` |
| Session-note root | `FRITZWORKS_SESSION_NOTES` |
| Data directory | `FRITZWORKS_DATA` |
| Default agent | `FRITZWORKS_AGENT` |
| Shell/editor commands | `FRITZWORKS_SHELL`, `FRITZWORKS_EDITOR` |
| Agent commands | `FRITZWORKS_CLAUDE`, `FRITZWORKS_CODEX` |
| Agent models | `FRITZWORKS_CLAUDE_MODEL`, `FRITZWORKS_CODEX_MODEL` |
| Scratchpad models | `FRITZWORKS_CLAUDE_SCRATCH_MODEL`, `FRITZWORKS_CODEX_SCRATCH_MODEL` |
| GitHub URL protocol | `FRITZWORKS_GIT_PROTOCOL` |
| API bind address/port | `FRITZWORKS_HOST`, `FRITZWORKS_PORT` |
| API state polling interval | `FRITZWORKS_POLL_INTERVAL` |

Legacy `FRITZWORKS_NOTES`/`FW_NOTES` and `FRITZWORKS_DOTFILES`/`FW_DOTFILES` are accepted only in version 1; version 2 rejects them with migration guidance. Configure ordinary location paths in INI.

Command arrays in environment variables can be JSON, for example `FRITZWORKS_EDITOR='["nvim","--clean"]'`. Short `FW_*` forms are also accepted (`FW_DATA_DIR` selects the data directory).

Precedence is: one-run CLI flags, environment variables, the user INI file, then the bundled `config.ini`.

## Browser workspaces and agents

Repository sessions, scratchpads, and configured locations use one daemon-owned panel model. They support any number of terminals, at most one AI terminal, and associated Markdown or iframe resources. Terminal-only groups support any number of terminals and no resources. The legacy two-panel `shell,agent` and three-panel `shell,editor,agent` choices remain creation shortcuts and migrate into the ordered model:

```sh
fw new example/project feature-x --panels shell,agent
fw resume feature-x --no-editor
```

Choose an agent in configuration or per command:

```sh
fw new example/project feature-x --agent codex
fw scratch investigation --claude
fw resume feature-x --codex
fw new example/project feature-x --link TEAM-123 --link example/project#456
fw scratch investigation --link example/project#456
```

`fw new` and `fw scratch` accept a repeatable `--link <ref>` option for associated Linear keys, GitHub references, or URLs. Those links are included in the new session's initial agent briefing. For an existing workstream directory, Claude uses `--continue`; Codex uses the officially documented cwd-scoped [`codex resume --last`](https://developers.openai.com/codex/cli/reference). Both fall back to a new session when no matching session exists. A `--seed file.md` is delivered to a fresh browser agent terminal as its first prompt; resuming an already-open workspace with a seed restarts only its agent terminal so the prompt is not ignored. Seed text is limited to 64 KiB. Agent models come from configuration; the old transient `--model` override no longer exists.

Install the user-level Claude Code, Codex, and Zsh lifecycle hooks once to track when an agent or shell is working or waiting for input:

```sh
fw hooks install --shell
fw hooks status
```

The installer preserves existing hooks and is idempotent. It respects `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, and saves existing JSON settings to a `.fritzworks-backup` file before the first change. Presence in the file does not verify execution: enable/trust hooks in your client and restart it. Agent and shell hooks send status to the owning daemon with a 500 ms deadline. They never start a daemon or open SQLite; unavailable daemons and rejected events leave the command or prompt running normally. It adds `UserPromptSubmit`, `Stop`, `PermissionRequest`, `PostToolUse`, and `SessionStart` handlers to both clients, plus Claude's idle/permission notification handler. With `--shell`, it installs a Zsh integration under `~/.config/fritzworks/shell.zsh` and sources it from `.zshrc`; `preexec` reports a running command and `precmd` reports a ready prompt. Browser agent and shell terminals carry their instance, session, terminal and generation identities. The daemon rejects stale generations, duplicate events and out-of-order status. Existing terminals without generation evidence stop reporting status until a verified migration or explicit terminal restart supplies it; hooks do not infer ownership from the working directory. To inspect a hook result, use its internal command with `--json` or `--verbose`, or set `FRITZWORKS_HOOK_DEBUG=1` for stderr diagnostics. `GET /hooks/status` reports daemon acceptance/drop counters and reasons.

Run the installer on every machine that hosts an fritzworks daemon, including remote targets. Activity is recorded by the machine running the shell or agent; the browser's cross-origin event connection only relays those recorded changes. The dotfiles bootstrap runs this installation automatically.

## Main commands

Run `fw help` for the complete command reference. Common workflows include:

```sh
fw list
fw refresh
fw new org/repo feature-branch
fw join feature-branch
fw pause feature-branch
fw archive feature-branch
fw scratch experiment
fw issue add https://github.com/org/repo/issues/123 --fw feature-branch
fw log "identified the root cause" --fw feature-branch
fw stack --fw feature-branch
```

`fw refresh` starts the local daemon if needed and asks it to reconcile stored status against its connected browser terminals. The first browser terminal for a workstream makes it `active`; closing its final browser terminal makes it `paused`; and an archived workstream remains archived.

`fw list`, context selection, lifecycle commands, stacks, issues, logs, session notes and digests use the same daemon service as MCP and the browser. Clients do not open SQLite, inspect Git worktrees, or read and write daemon-owned notes. They start the local daemon when necessary; lifecycle calls also update its shared panel layout. If a browser is connected, the group selection changes immediately; otherwise it is restored the next time FritzWorks opens. These commands never attach to or create an interactive Zellij tab.

Adopted legacy worktrees retain their original `<repositories>/<org>/<repo>/<branch>` paths and `.bare` common directory. New allocations use the independent worktree root and persisted repository identity. Scratchpads are plain directories without Git backing. The SQLite database and agent seed documents live under the configured data directory.

`fw archive` refuses to remove a dirty Git worktree unless explicitly forced. Scratchpad directories are retained unless deletion is explicitly requested. (`fw close` remains an alias for compatibility.) `fw stack rebase` rewrites history, and `fw stack link` pushes branches and may create pull requests; review their output and confirmations carefully.

### Previews and background jobs

The daemon resolves selectors, configured locations, available actions and panel defaults.
Version 2 installations without an available configured AI client default to a shell-only
workspace; `--panels shell` requests one explicitly. CLI and MCP listing follows every
page, including installations with more than 100 sessions.

Archive removal, terminal reset, stack linking and stack rebasing use revision-bound
previews. Interactive CLI commands display consequences and ask before destructive
execution. Noninteractive commands require an explicit selector and reviewed revision:

```sh
fw archive feature-branch --preview
fw archive feature-branch --preview-revision <revision> --confirm
fw stack rebase --fw feature-branch --preview
fw stack rebase --fw feature-branch --preview-revision <revision> --confirm
```

Use the same options in preview and execution, including `--delete`, `--keep`, `--force`
or `--trunk`. A changed session, filesystem or configuration invalidates the preview;
clients do not silently refresh approval. Dirty removal requires `--force` during both
preview and execution. `--keep` retains repository worktrees; scratchpads are retained
unless explicitly discarded.

Repository creation, resume and removal can return a background job. Stack linking and
rebasing also run as daemon jobs. Inspect progress and results or request cancellation:

```sh
fw job list
fw job show <job-id>
fw job cancel <job-id>
```

MCP exposes `fw_capabilities`, `fw_preview`, `fw_jobs`, `fw_job`, and `fw_job_cancel`.
Destructive tools return their preview without executing; pass the reviewed
`previewRevision` and `confirm:true` with the same requested operation after approval.
Job responses retain their ID for later inspection. CLI creation, resume, archive and stack commands accept `--idempotency-key <key>`; MCP accepts `idempotencyKey`. Reuse the key with the exact same payload and reviewed revision to retrieve the original queued, running or completed job. Changing options requires a new key and a new preview where applicable. A cancellation request does not
undo completed Git steps; inspect the job's partial result before resuming work.

Bootstrap commands such as setup, config validation and daemon management still run
locally. The explicit offline `fw storage rebind` command is the storage-maintenance
exception. Local seed-file input remains supported. CLI remote selection and dynamic
remote catalogue refresh remain phase-5 work.

## REST API and web client

Start the local service in the background with:

```sh
fw daemon                 # same as: fw daemon start
fw daemon status
fw daemon stop
fw web start              # ensure it is running and open the web client
```

`restart`, `foreground`, and `log` are also available. `--host` and `--port` override the configured address for `start`, `restart`, `foreground`, or `web start`. The default is `http://127.0.0.1:7337`; opening that URL serves the React and Tailwind CSS web client, also reachable at `http://127.0.0.1:7337/v2/`. For frontend development, run `npm run dev:web:v2`; `npm run build:web:v2` writes its publishable assets only to `web/v2/`.

`fritzworks` starts the daemon and opens the default browser on Linux/macOS. Set `FRITZWORKS_FIREFOX_PROFILE=appmode` to opt into a dedicated, pre-existing Firefox profile. It keeps a native KDE/GTK title bar for moving, resizing, minimizing, maximizing, and closing the window while profile CSS hides the tab and navigation bars. Linux launcher and icon files are available under `desktop/` for optional manual installation. Set `FRITZWORKS_FIREFOX_PROFILE` or `FIREFOX` to override the profile name or browser executable.

Browser terminals retain Zellij's mouse mode. A regular drag uses Zellij selection, whose OSC 52 text FritzWorks makes available to `Ctrl-Shift-C` and the browser's Copy command; Shift-drag bypasses Zellij and creates a native xterm selection.

Local and configured remote machines share one sidebar as independently collapsible sections. Within each machine, session nodes are organized by repository, Scratchpads, Directories, and Terminals. The browser keeps each section's expanded or collapsed state in local storage across client refreshes; newly discovered nodes start collapsed. Associated links and Markdown files are children of their owning session; generated session notes are discovered across every year and marked as automatic. Terminal groups have a drag grip and can be merged by dropping one onto another. Machine content hosts remain isolated, so terminal processes, resources, and state never mix across daemons.

Settings → **Omitted branch prefixes** accepts a comma-separated list, empty by default. The sidebar replaces the longest matching leading prefix with an ellipsis: `username/fix-header` with `username/` configured becomes `…fix-header`. Labels that still exceed the available width also end with an ellipsis; hover to see the full name. This browser-local setting applies across machines and survives reloads. Clear it to disable prefix omission. Custom session names and scratchpad names are preserved; actual branch names are never changed.

The shared workspace has a group header, a minimized/resource pill shelf, one compact `+` icon button per panel type, and an ordered draggable and resizable panel strip. Drag anywhere on a panel header except its buttons to preview a live reorder, then drop to persist it. Click a terminal group's name in the group header, or any panel title, to rename it inline. The practical minimum panel width is 320 pixels. Shrinking a window minimizes visible panels from right to left while retaining at least one; growing it never restores them. A manual restore that cannot fit reports “Minimize another panel to open this.” The `^` action minimizes any panel. Terminal and AI panels keep their Zellij processes and also expose an explicit Close/Kill action. Markdown and iframe panels have no close action: minimizing unmounts them while preserving their association pill. Explicit associations can be disassociated separately, with dirty Markdown protection; discovered session notes cannot be disassociated.

Every terminal is rooted in its owning session directory (or the daemon home for a terminal group). Each additional terminal has its own stable panel-based Zellij identity. Migrated shell, editor, AI, and standalone terminal identities retain their old names. Switching groups or minimizing detaches the browser view without killing the process; Pause, Archive, Reset, provider changes, and Close/Kill discover and operate on the terminal panels actually present. The selected AI provider remains session-wide, including after its panel is closed and re-added.

Associated links render in sandboxed iframe panels and always include an external-open action. FritzWorks does not proxy or bypass `X-Frame-Options` or `frame-ancestors`; sites that refuse embedding must be opened externally. Markdown associations accept paths relative to the owning session directory, absolute paths, and `~/` paths, normalize them to existing regular `.md` files, and retain content-hash conflict protection. New Markdown panels open in Preview; restoring an existing panel retains its selected mode. Associating Markdown leaves it closed by default. Check “Open after associating” in the association dialog to open it immediately.

HTML associations accept existing `.html` and `.htm` files using the same relative, absolute, or `~/` paths. Use **Associate HTML panel**, `fw resource add <group> html <path> --open`, or `fw_resource_add` with `kind: "html"`. HTML opens only as a sandboxed iframe preview, with **Reload** and **Open externally**; there is no editor or write API. The owning daemon serves the file and supported images, styles, scripts, fonts, and media from its directory and subdirectories at `/resource-files/{resource}/{filename}`. Parent-directory traversal and symlinks outside that directory are rejected. Scripts can render the document but cannot access the parent session or fetch APIs. No separate HTTP server is needed.

Markdown previews enable **Follow changes** by default. When an external edit arrives, the preview scrolls to the first changed block, or the nearest surviving block for a deletion. Changes already visible leave the scroll position alone, and rapid updates settle before scrolling. Turn off **Follow changes** to read elsewhere while the document updates. Following does not move keyboard focus or scroll the source editor, and the initial document load does not trigger a jump.

The open detail modal remains stored as `session=<id>` in the URL, so it participates in Back/Forward history and survives reloads and bookmarks. A scratchpad's Name field changes its display name without renaming its original directory or branch identifier. The detail and creation modals retain their Custom, Linear, and GitHub link controls and shorthand expansion. Every terminal font falls back to [Symbols Nerd Font Mono](https://github.com/ryanoasis/nerd-fonts) v3.5.1, bundled at `/v2/fonts/symbols-nerd-font-mono.woff2`; its license and icon-set attributions are in `/v2/fonts/Symbols-Nerd-Font-LICENSE.txt`. The theme and terminal-font selectors remain browser-local settings. `fw web start` reuses a healthy daemon whose server-source revision is current, replaces an outdated daemon after a package update or local server edit, and opens its actual URL.

The daemon checks each non-archived repository session for a pull request matching its branch when it starts and every three minutes afterward. Finding a PR adds its canonical GitHub URL to the session's existing associated links and broadcasts an update to connected clients. A session that already has any `github.com/<owner>/<repo>/pull/<number>` link is excluded from discovery, whether that link was added automatically or by the user, so GitHub is not polled again for it.

The collection/detail endpoint is:

```text
GET /fw/{id}/?type={repo,scratchpad,misc}&page=0&perpage=25&status={active,paused,closed,all,active_paused}
```

Use `all` as the ID for a collection, or a numeric/configured-location ID for one item. `type` is optional; `status` defaults to `active_paused`, and `perpage` defaults to 25 and is capped at 100. The web client keeps type, status, page, and per-page settings in the URL without reloading the page, and shows numbered pagination below the list. The `misc` type contains every configured `[locations.<name>]` entry.

### Panel and resource API

`GET /panel-layout` returns the complete daemon-owned model:

```json
{
  "version": 1,
  "revision": 12,
  "activeGroupId": "session-…",
  "groups": [{ "id": "session-…", "type": "repository", "ownerId": "42", "panels": [], "resources": [] }]
}
```

Every mutation body must include the last-read integer `revision` and may include a browser `client` ID. A stale mutation returns HTTP 409 with the current revision in `details.revision`; clients must reload and reapply the user's intent. Successful mutations return the new revision and broadcast `{"type":"panel_layout","revision":13}` on `/fw/events`.

On first startup, the daemon migrates the old `workspaces` and `bottom-terminals` JSON records and `editor-tabs.json` into these tables in one idempotent transaction. Fixed session roles and standalone terminal IDs keep their existing Zellij names. Former standalone Markdown tabs become minimized resources in a generated **Unassigned Markdown** scratchpad. The old records and file are not deleted.

| Operation | Endpoint |
| --- | --- |
| Create a terminal group | `POST /panel-layout/groups` with `{"type":"terminal","revision":12}` |
| Rename a terminal group | `PUT /panel-layout/groups/{group}` with `{"label":"Build logs"}` |
| Select a group | `POST /panel-layout/groups/{group}/activate` |
| Add a terminal or AI panel | `POST /panel-layout/groups/{group}/panels` with `kind` set to `terminal` or `ai` |
| Merge terminal groups | `POST /panel-layout/groups/{destination}/merge` with `sourceGroupId` |
| Minimize, restore, rename, resize, or change Markdown mode | `PUT /panel-layout/panels/{panel}` |
| Close/Kill a terminal or AI panel | `POST /panel-layout/panels/{panel}/close` |
| Persist ordering and widths | `PUT /panel-layout/groups/{group}/order` with `panelIds` and `widths` |
| Add a resource | `POST /panel-layout/groups/{group}/resources`; associate `kind` + `value`, or create Markdown with `content`, optional `title`/`value`, and optional `open` |
| Read a Markdown resource | `GET /panel-layout/resources/{resource}` |
| Write a Markdown resource | `PUT /panel-layout/resources/{resource}` with `content` and optional `version` |
| Open or restore a resource panel | `POST /panel-layout/resources/{resource}/open` |
| Disassociate an explicit resource | `POST /panel-layout/resources/{resource}/disassociate` |

Each workstream has an immutable UUID. Its session group reports the persisted `markdownDirectory` and storage availability. New directories use `<sessionNotes>/<uuid>`; adopted legacy directories remain pinned across years. Creating Markdown with `content` and no `value` uses that allocation; an explicit `value` writes relative to the owning session unless absolute or `~/`. Resource panels are created from associations, not arbitrary client URLs or paths. Markdown paths are resolved and validated on the owning daemon. A disassociation request may pass `{"dirty":true}` to receive an HTTP 409; after user confirmation it can retry with `{"dirty":true,"force":true}`. Automatically discovered resources always reject disassociation.

The CLI exposes the same model through `fw panels`, `fw panel …`, and `fw resource …`. MCP clients use `fw_resource_list`, `fw_resource_add`, `fw_resource_read`, `fw_resource_write`, `fw_resource_open`, and `fw_resource_remove`; each accepts the standard optional `daemon` selector. Resource association does not open a panel by default. `fw_resource_add` accepts `content` to create Markdown and `open:true` (CLI: `fw resource add … --open`) to immediately create or restore its panel when the owning session is active, without changing the currently focused group.

The New Repo button opens a creation modal with repository and branch/ref inputs, associated links, source and path previews, agent selection, and the initial panel layout. Its links section has a free-form field and optional Linear/GitHub suggestions. Suggestions are disabled until configured; no integration commands run for disabled sources. Press Enter or use Add to stage a link. Linear searches the configured team's active issues; GitHub combines configured issue filters and repositories needing PR reviews. The same three link inputs appear when creating a scratchpad. When a newly created repo or scratchpad has associated links, its seed briefing lists the canonical links and directs the agent to retrieve authenticated details with the Linear skill/CLI or `gh`; this also applies to CLI and MCP creation, and is appended to an explicit seed when one is supplied. It submits the following collection request, creates or restores the worktree, activates its browser terminal workspace, and then shows the new session details:

```text
POST /fw
{"repository":"org/repo","selector":"feature-branch","agent":"claude","panels":["shell","editor","agent"],"links":["#123"]}
```

`GET /fw/new` returns repository-creation availability and its reason, the configured worktree and scratchpad roots (plus the legacy repository root when applicable), repositories used in the last three months, default agent, and default panels used to initialize the creation modals. `GET /fw/link-suggestions/linear` queries `linear api`; `GET /fw/link-suggestions/github` queries `gh` and groups the configured work sources. Both accept an optional `q` filter and cache their CLI results briefly.

The New Scratchpad button opens a parallel modal with an optional name, scratch path preview, agent, links, and initial panels. Leaving the name empty generates a readable random name. GitHub shorthand must include its repository because scratchpads have no associated repository of their own.

```text
POST /fw/scratchpad
{"name":"investigation","agent":"codex","panels":["shell","agent"],"links":["org/repo#123"]}
```

Commands accept a JSON object:

```text
POST /fw/{id}/{cmd}
```

| Command | JSON body |
| --- | --- |
| `pause` | `{}` |
| `resume` | Optional `{"panels":["shell","agent"],"agent":"codex","seed":"markdown prompt"}` fields |
| `archive` | `{}` archives state only; `{"remove":true}` also removes the directory; dirty Git worktrees require `"force":true` (`close` is a compatibility alias) |
| `rename` | `{"name":"New label"}` |
| `log` | `{"body":"What changed","done":true}` |
| `issue-add` | `{"refs":["ABC-123"]}` or `{"ref":"ABC-123"}` |
| `issue-remove` | `{"ref":"ABC-123"}` |
| `agent-set` | `{"agent":"claude"}` or `{"agent":"codex"}` persists the provider and replaces an open agent panel |
| `terminal-reset` | `{}` stops and deletes every persistent terminal panel currently associated with the session so open views reconnect from the current layout |
| `open-path` | `{}` launches the workstream directory with `xdg-open` |
| `open-notes` | `{}` launches the newest existing notes directory for the workstream with `xdg-open` |

Daemon-executed MCP support also uses `GET /config`, the panel/resource routes above, `GET /fw/{id}/stack`, `POST /fw/{id}/stack-set`, `POST /fw/{id}/stack-link`, and `POST /fw/digest`. Keeping these operations behind HTTP ensures a remote MCP request reads and mutates the remote daemon's database, worktrees, and Markdown rather than local state. The older note routes remain for compatibility but are not exposed as MCP tools.

`POST /fw/refresh` performs synchronous status reconciliation through the daemon. It is the endpoint used by `fw refresh`.

`POST /fw/{id}/sync` explicitly discovers that session's Markdown resources across all years. For a repository session with no associated pull request, it performs one `gh pr list` lookup for the current branch and associates the result when found. `fw sync` and the MCP `fw_sync` tool call this endpoint. GitHub PR discovery has no startup scan, timer, lifecycle hook, or terminal-activity polling.

Repository and scratchpad workspace headers expose a refresh button for this explicit sync. The daemon emits its normal WebSocket invalidations when resources or session data change; the client does no extra refresh work.

The REST `resume` command reconstitutes a missing worktree, selects its daemon-owned panel group, and broadcasts layout and session invalidations. The first attached browser terminal marks it active. `pause` clears it as the active group, disconnects its browser attaches, and stops each persistent terminal panel belonging to it. `terminal-reset` is the recovery path for a corrupt or incorrectly resurrected terminal: it disconnects the session's browser clients, force-deletes the actual panel-backed Zellij sessions and saved snapshots, and lets visible views reconnect into fresh processes. Settings also offers **Reset all terminal sessions**, backed by `POST /fw/terminal-reset`, for every `fw-browser-*` session on the selected daemon. Every configured location supports pause/resume, terminal reset, provider selection, and path opening; the API always rejects `close` for it.

Web clients connect to `ws://127.0.0.1:7337/fw/events`. Adding a workstream emits `{"id":123,"type":"new_session"}`; changing its session status or associated links emits `{"id":123,"type":"update_session"}`; layout mutations emit `{"type":"panel_layout","revision":13}`; lifecycle compatibility updates may also emit a `browser_state` invalidation; and activity hooks emit `{"id":123,"type":"agent_status","status":"working"}` or `{"id":123,"type":"shell_status","status":"ready"}`. These messages are invalidations, so clients reload the affected model. CLI and MCP mutations go through REST and emit immediately; direct bookkeeping changes such as stack relationships remain visible through the durable event journal poll. The event socket is bidirectional for focused Markdown panels: the client sends `markdown_watch`/`markdown_unwatch`, and the daemon uses Chokidar's native-first watcher for that one file and emits `markdown_changed` after an external save. A clean panel reloads immediately; a dirty panel retains its edits and enters the existing conflict flow.

`POST /browser/refresh` broadcasts `{"type":"full_page_refresh"}` to every event client on that daemon. Each client performs `location.reload()`, re-requesting the no-store HTML and built assets. The MCP `fw_browser_refresh` tool invokes this endpoint and accepts the standard optional `daemon` selector.

Terminal groups replace the former global standalone-terminal bucket. Each is an ordinary sidebar node backed by ordered, resizable panel records and borderless Zellij sessions rooted at the daemon user's home directory. Terminals use the separate `/fw/terminal` WebSocket for input, output, resize, suspension, and ownership messages. Upgrades are accepted only from loopback clients with an allowed origin. Switching targets or groups, minimizing a panel, or hiding the document suspends only its Zellij attachment; the browser registration and backing shell remain alive. Returning to the view resumes the attachment at its last size. Ordinary window blur does not suspend it. Terminal and event sockets reconnect automatically after a daemon restart or network interruption with exponential backoff capped at ten seconds, except that an intentionally suspended terminal waits until it becomes active. Exactly one browser client owns each attach; another client waits, can take over explicitly, and automatically claims it when the owner detaches.

Opt-in terminal diagnostics are available by loading the client with `?terminalDebug=1` or setting the browser-local `fritzworks-terminal-debug` key to `1`. Once per second, the console reports per-terminal WebSocket/output/write counters, pending batch size, lifecycle state, and the browser terminal-socket count. `GET /fw/terminal-sessions?diagnostics=1` reports daemon-side socket, attachment, and client-state counts; the default endpoint response remains unchanged.

Markdown editors now open from resources below their owning session instead of a global Markdown bucket. Each panel persists its Edit/Preview mode, size, order, and minimized state in SQLite. Editing still supports Tab/Shift-Tab indentation, list continuation, Ctrl-E, autosave, explicit Ctrl/Cmd-S, and content-hash conflict handling. Canonical session Markdown under `work/<YYYY>/workstream/<uuid>/` is dynamically included across all years. Legacy `<id>-<repo>-<branch>` and scratchpad directories remain discoverable after branch changes, but new files are written only to the UUID directory.

```text
GET  /notes/files                      # this week's work-note path, plus every markdown file under work/
GET  /notes/file?path=<relative path>  # { path, name, content, version, mtime, todayHeading, todayLine }
PUT  /notes/file                       # {"path":"work/2026/2026-06-22-week.md","content":"…","version":"<hash>"}
POST /notes/weekly                     # {"kind":"work"}; creates and scaffolds the week's file when missing
GET  /notes/tabs?scope=global          # which files the editor had open
PUT  /notes/tabs                       # tabs include source "notes" or "file"
GET  /markdown/file?path=<path>         # read any existing .md file; returns its normalized absolute path
PUT  /markdown/file                    # save it with the same content-version conflict check
```

The preview renders headings, task and nested lists, quotes, fenced code, links, and `![alt](url)` images. `img-src` on the served pages is widened to `'self' data: blob: https:` so a note can show an image it links to; every other directive stays same-origin. Relative image paths are not resolved against the notes tree, so images need an absolute URL.

Optional weekly work-note paths remain confined to `notes.weekly.root` (the legacy notes root in version 1) — `..`, absolute paths, symlinks pointing outside it, and non-`.md` files are rejected by the `/notes/file` routes. The explicit `/markdown/file` routes accept Markdown paths elsewhere on the selected daemon but only open existing regular files. Both kinds are capped at 1 MiB. Associations and panels are stored in SQLite; `editor-tabs.json` is retained and its paths are rewritten explicitly during storage adoption or relocation.

Associated `https://github.com/<owner>/<repo>/pull/<number>` links open a rendered PR panel with the title, state, author, Markdown description, and conversation comments. The selected daemon runs `gh pr view --json` using its existing GitHub authentication through `GET /panel-layout/resources/{id}/pull-request`. Opening or restoring the view fetches current content; **Reload** fetches it again. **Open on GitHub** opens the original link. Inline code-review threads and diffs remain on GitHub. Other links continue to use iframe panels.

Keyboard navigation follows the visible layout. Ctrl-H/Ctrl-L move horizontally between panels, and Ctrl-H from the first panel returns to the sidebar. In the sidebar, Ctrl-J/Ctrl-K move between Sessions and Settings, Ctrl-L enters the highlighted group or resource, plain J/K move through rows, and plain H/L collapse or expand machine and group nodes.

Git cleanliness is cached in SQLite. List and detail GETs return the cached value immediately, then queue an asynchronous `git status` for each loaded repository or configured location. A changed result records an `update_session` event and is pushed over the WebSocket, causing clients to reload the new cached state without making the original GET wait on Git.

The API has no authentication and therefore binds to loopback by default. Do not expose it on a public interface without putting an authenticated proxy in front of it.

## Remote access

The daemon is an unauthenticated, single-user local service. Keep it bound to
loopback. Access another machine through an authenticated SSH tunnel terminating
on a local loopback address, and explicitly configure that endpoint:

```ini
[daemons.remote]
url = http://127.0.0.1:7441
```

HTTP and WebSocket requests require loopback Host/Origin headers; request bodies
require `Content-Type: application/json`. Endpoints must be HTTP(S) origin URLs
without credentials, path prefixes, query strings, or fragments. Direct public
network exposure and reverse-proxy subpaths are unsupported. Enabled remote URLs
must use `localhost`, `127.x.x.x`, or `[::1]`; tunnel and credential setup remain
external. A second remote can use another local port, for example `7442`.

Select a daemon globally in the CLI, before or after the command:

```sh
fw daemons
fw --daemon remote list
fw rename "New label" --fw 17 --daemon remote
fw --daemon remote config
```

CLI and MCP both fetch the running local daemon's `/daemons` directory before
remote requests. `fw_daemons` refreshes that same directory even when a remote is
selected; remote directories are never recursively imported. Remote requests do
not start or restart the local daemon, substitute another endpoint, or open remote
paths with a local application. The local directory must already be reachable.
Local setup, doctor, config validation, daemon/web control, hooks/skills installation,
and offline storage rebind reject remote selection. Domain operations support the
same selector in CLI, MCP, and browser. Remote session operations require an
explicit selector; relative repository paths remain relative to the remote daemon.

Every domain request negotiates protocol version 1 plus `instance-bound-v1` and the
capabilities needed by its operation. Each HTTP exchange, including response body
reading, has a ten-second deadline and supports cancellation. Redirects are
rejected. Unknown, disabled, unreachable, incompatible, and replaced targets return
structured codes; MCP includes these in error results. HTTP requests carry the
observed instance UUID, and WebSockets bind it in their URL. HTML previews use
`/resource-files/<instance>/<resource>/<path>` so relative assets and nested pages
inherit the same binding. The server rejects old unbound resource URLs and an
instance mismatch before reading a file. Files remain confined to the associated
HTML directory, including symlink checks.

CLI/MCP remember accepted target identities separately from daemon data under
`$XDG_STATE_HOME/fritzworks/clients/` (default `~/.local/state/fritzworks/clients/`),
scoped to the selected configuration. First contact records the identity. A later
replacement remains readable but mutations require explicit acknowledgement:

```sh
fw --daemon remote capabilities
fw --daemon remote --acknowledge-instance <observed-uuid> config
fw --daemon remote --expect-instance <observed-uuid> rename "New label" --fw 17
```

MCP provides `fw_daemon_acknowledge` with `daemon` and the observed `instanceId`.
Acknowledgement never retries an action automatically. A multi-request CLI command
or MCP tool retains its first endpoint/instance binding even if another command
acknowledges a replacement concurrently. The browser has a separate
acknowledgement button and stores its accepted identities in browser storage.
It refreshes the local directory on focus and every ten seconds, negotiates targets
independently, and drops panes/caches when an identity changes or a target is
removed/disabled. Pending actions retain their original endpoint/instance and never
fall back to local. One offline remote does not delay other panes. Sidebar tree
preferences are scoped by instance; session font/split preferences include instance
and session UUID. Global visual settings remain browser-wide.

A temporary outage hides and disables the affected pane while preserving its
mounted state. Autosave resumes only after that same instance reconnects. Unsaved
Markdown is also retained by instance, file, and editor in tab-local session
storage (in memory when storage is unavailable). Removal or replacement quarantines
these drafts: an overlay above the workspace shows read-only text to copy, and
acknowledging a new daemon never writes old drafts to it. The overlay can collapse
to a compact recovery button without deleting drafts. Returning to the original
instance restores its draft; saving or reverting to the saved content clears that
editor's recovery entry. Confirming an editor's close discards its unsaved draft.
Disassociating a resource clears its panel drafts only after daemon success;
cancellation or failure preserves them. Recovery storage lasts for the browser tab session.

Native path opening is a distinct capability of the owning daemon. Linux daemons without a desktop display and daemons missing an opener
report it unavailable; remote Markdown opens through the browser's daemon-backed
resource editor. Real SSH tunnels, browser private-network restrictions, and
multi-machine terminal continuity still require separately authorized validation.

## MCP server

Setup registers the stdio server with detected clients. To register it manually from the checkout:

```sh
claude mcp add --scope user fw -- "$(command -v node)" --no-warnings "$PWD/mcp.js"
codex mcp add fw -- "$(command -v node)" --no-warnings "$PWD/mcp.js"
```

The MCP tools share the same configuration and service as the CLI. `fw_daemons` reads the running local daemon’s live directory, including disabled targets. Every tool accepts an optional `daemon` id (default: `local`) and relays its operation to that daemon, so filesystem, Git, GitHub, notes, and lifecycle work happens on the selected machine. Pass `workstream` explicitly for remote workstream operations because the MCP process's current directory can only identify a local workstream.

Lifecycle, stack, issue, log, resource, digest, and browser-refresh tools all execute through the selected daemon's REST API. Consequently, `fw_new`, `fw_scratch`, `fw_resume`, `fw_pause`, and `fw_close` update that daemon's FritzWorks browser state rather than manipulating the MCP host terminal. `fw_new` and `fw_scratch` accept an optional `links` array; as in the web client and CLI, those links are included in the initial agent briefing. `fw_config` reports the selected daemon's resolved settings, and `fw_browser_refresh` asks its connected browser clients to reload the whole page.

## Development

```sh
npm i
npm run check
npm run test:checkout
```

`check` builds the UI and runs the test suite. `test:checkout` copies the source
to a temporary directory with no dependencies or built UI, runs `npm i` and
`npm run setup` with an isolated home, and checks command links, hooks, skills,
CLI/MCP, the native PTY, web assets, scratchpads, a Git worktree, and restart
persistence. It requires network access to install dependencies. It runs setup
repeatedly to check idempotence. MCP registration is covered using fake client
runners; the smoke test does not modify real AI clients.

With Zellij installed, `FW_SMOKE_TERMINAL=1 npm run test:checkout` also checks
that an isolated shell retains its PID and environment through repeated setup
and daemon restart. The test cleans up its own sessions and files.

CI covers Linux/macOS and Node 22/24/26. No npm publication is needed.
