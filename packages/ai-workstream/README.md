# @fritzy/ai-workstream

`ai-workstream` is an opinionated browser-based workstream manager for Git worktrees. Each workstream records a repository, branch, status, linked resources, short logs, and longer notes. FritzWorks displays each session as an ordered workspace of persistent terminals, one optional Claude Code or Codex panel, Markdown files, and associated web pages.

The package also installs `ws-mcp`, an stdio MCP server exposing the non-interactive workstream operations.

![](./fritzworks.png)

## Requirements

- macOS or Linux
- Node.js 22.13.0 or newer
- Git and Zellij
- Claude Code, Codex, or both
- An editor and shell for those panels, if enabled (defaults: `nvim` and `zsh`)
- GitHub CLI (`gh`) for PR discovery and fork routing
- The `github/gh-stack` extension for `ws stack link`

Repository clones default to SSH URLs. Set `gitProtocol` to `https` if that better matches your GitHub authentication.

## Install

```sh
npm install --global @fritzy/ai-workstream
ws --version
```

The package name is scoped, but its primary executable remains `ws`.

## Configuration

The package ships a complete [`config.ini`](./config.ini). A user file at `$XDG_CONFIG_HOME/ai-workstream/config.ini`, normally `~/.config/ai-workstream/config.ini`, is layered over those defaults. The user file can contain only the settings you want to change. Run `ws config` to print both file paths and the fully resolved configuration.

```ini
agent = claude
gitProtocol = ssh

[paths]
repositories = ~/github
scratchpads = ~/scratchpad
data = ${XDG_DATA_HOME}/ws

[locations.notes]
repo = fritzy/notes
path = /home/nathan.fritz/notes/

[locations.dotfiles]
repo = fritzy/dotfiles
path = /home/nathan.fritz/dotfiles/

[commands]
shell = zsh
editor = nvim
claude = claude
codex = codex

[models.claude]
default = opus
scratch = sonnet

[models.codex]
default =
scratch =

[server]
host = 127.0.0.1
port = 7337
pollInterval = 1000
```

Paths beginning with `~/` are expanded against the user's home directory. `${HOME}` and `${XDG_DATA_HOME}` are also supported at the start of a path. Relative user paths are resolved from the user configuration file's directory. Every `[locations.<name>]` section becomes a configured location in API list/detail responses, assumes the `main` branch unless a `branch` setting is present, and is always non-closeable (pause only). Commands may be a single executable string or a JSON-style array containing the executable and fixed arguments, such as `editor = ["nvim", "--clean"]`. Empty model values disable an explicit model selection.

The default data path intentionally remains `~/.local/share/ws` so existing databases continue to work after upgrading.

### Environment overrides

Every setting can also be overridden without editing the INI file:

| Setting | Environment variable |
| --- | --- |
| Config file | `AI_WORKSTREAM_CONFIG` |
| Repository root | `AI_WORKSTREAM_REPOSITORIES` |
| Scratchpad root | `AI_WORKSTREAM_SCRATCHPADS` |
| Notes root | `AI_WORKSTREAM_NOTES` |
| Dotfiles path | `AI_WORKSTREAM_DOTFILES` |
| Data directory | `AI_WORKSTREAM_DATA` |
| Default agent | `AI_WORKSTREAM_AGENT` |
| Shell/editor commands | `AI_WORKSTREAM_SHELL`, `AI_WORKSTREAM_EDITOR` |
| Agent commands | `AI_WORKSTREAM_CLAUDE`, `AI_WORKSTREAM_CODEX` |
| Agent models | `AI_WORKSTREAM_CLAUDE_MODEL`, `AI_WORKSTREAM_CODEX_MODEL` |
| Scratchpad models | `AI_WORKSTREAM_CLAUDE_SCRATCH_MODEL`, `AI_WORKSTREAM_CODEX_SCRATCH_MODEL` |
| GitHub URL protocol | `AI_WORKSTREAM_GIT_PROTOCOL` |
| API bind address/port | `AI_WORKSTREAM_HOST`, `AI_WORKSTREAM_PORT` |
| API state polling interval | `AI_WORKSTREAM_POLL_INTERVAL` |

Command arrays in environment variables can be JSON, for example `AI_WORKSTREAM_EDITOR='["nvim","--clean"]'`. Existing `WS_*` forms are accepted as compatibility aliases.

Precedence is: one-run CLI flags, environment variables, the user INI file, then the bundled `config.ini`.

## Browser workspaces and agents

Repository sessions, scratchpads, and configured locations use one daemon-owned panel model. They support any number of terminals, at most one AI terminal, and associated Markdown or iframe resources. Terminal-only groups support any number of terminals and no resources. The legacy two-panel `shell,agent` and three-panel `shell,editor,agent` choices remain creation shortcuts and migrate into the ordered model:

```sh
ws new fritzy/example feature-x --panels shell,agent
ws resume feature-x --no-editor
```

Choose an agent in configuration or per command:

```sh
ws new fritzy/example feature-x --agent codex
ws scratch investigation --claude
ws resume feature-x --codex
ws new fritzy/example feature-x --link ECO-123 --link fritzy/example#456
ws scratch investigation --link fritzy/example#456
```

`ws new` and `ws scratch` accept a repeatable `--link <ref>` option for associated Linear keys, GitHub references, or URLs. Those links are included in the new session's initial agent briefing. For an existing workstream directory, Claude uses `--continue`; Codex uses the officially documented cwd-scoped [`codex resume --last`](https://developers.openai.com/codex/cli/reference). Both fall back to a new session when no matching session exists. A `--seed file.md` is delivered to a fresh browser agent terminal as its first prompt; resuming an already-open workspace with a seed restarts only its agent terminal so the prompt is not ignored. Seed text is limited to 64 KiB. Agent models come from configuration; the old transient `--model` override no longer exists.

Install the user-level Claude Code, Codex, and Zsh lifecycle hooks once to track when an agent or shell is working or waiting for input:

```sh
ws hooks install
ws hooks status
```

The installer preserves existing hooks and is idempotent. It adds `UserPromptSubmit`, `Stop`, `PermissionRequest`, `PostToolUse`, and `SessionStart` handlers to both clients, plus Claude's idle/permission notification handler. It also installs a Zsh integration under `~/.config/ai-workstream/shell.zsh` and sources it from `.zshrc`; `preexec` reports a running command and `precmd` reports a ready prompt. Browser agent and shell terminals carry their workstream ID, with working-directory matching as a fallback.

Run the installer on every machine that hosts an ai-workstream daemon, including remote targets. Activity is recorded by the machine running the shell or agent; the browser's cross-origin event connection only relays those recorded changes. The dotfiles bootstrap runs this installation automatically.

## Main commands

Run `ws help` for the complete command reference. Common workflows include:

```sh
ws list
ws refresh
ws new org/repo feature-branch
ws join feature-branch
ws pause feature-branch
ws archive feature-branch
ws scratch experiment
ws issue add https://github.com/org/repo/issues/123 --ws feature-branch
ws log "identified the root cause" --ws feature-branch
ws stack --ws feature-branch
```

`ws refresh` starts the local daemon if needed and asks it to reconcile stored status against its connected browser terminals. The first browser terminal for a workstream makes it `active`; closing its final browser terminal makes it `paused`; and an archived workstream remains archived.

`ws list`, `refresh`, `new`, `scratch`, `join`/`resume`, `pause`, `archive`, and `rename`, plus issue and log mutations, are clients of the same REST service used by FritzWorks. They start the local daemon when necessary; lifecycle calls also update its shared panel layout. If a browser is connected, the group selection changes immediately; otherwise it is restored the next time FritzWorks opens. These commands never attach to or create an interactive Zellij tab.

Worktrees are stored under `<repositories>/<org>/<repo>/<branch>` with a bare clone at `<repositories>/<org>/<repo>/.bare`. Scratchpads are plain directories without Git backing. The SQLite database and agent seed documents live under the configured data directory.

`ws archive` refuses to remove a dirty Git worktree unless explicitly forced. Scratchpad directories are retained unless deletion is explicitly requested. (`ws close` remains an alias for compatibility.) `ws stack rebase` rewrites history, and `ws stack link` pushes branches and may create pull requests; review their output and confirmations carefully.

## REST API and web client

Start the local service in the background with:

```sh
ws daemon                 # same as: ws daemon start
ws daemon status
ws daemon stop
ws web start              # ensure it is running and open the web client
```

`restart`, `foreground`, and `log` are also available. `--host` and `--port` override the configured address for `start`, `restart`, `foreground`, or `web start`. The default is `http://127.0.0.1:7337`; opening that URL serves the React and Tailwind CSS web client, also reachable at `http://127.0.0.1:7337/v2/`. For frontend development, run `npm run dev:web:v2`; `npm run build:web:v2` writes its publishable assets only to `web/v2/`.

On Linux, `fritzworks` starts the daemon and opens the client with Firefox's `appmode` profile. It keeps a native KDE/GTK title bar for moving, resizing, minimizing, maximizing, and closing the window while profile CSS hides the tab and navigation bars. The dotfiles bootstrap installs a branded `FritzWorks.desktop` launcher in KDE's application menu and Desktop folder. Set `AI_WORKSTREAM_FIREFOX_PROFILE` or `FIREFOX` to override the profile name or browser executable.

Browser terminals retain Zellij's mouse mode. A regular drag uses Zellij selection, whose OSC 52 text FritzWorks makes available to `Ctrl-Shift-C` and the browser's Copy command; Shift-drag bypasses Zellij and creates a native xterm selection.

Local and configured remote machines share one sidebar as independently collapsible sections. Within each machine, session nodes are organized by repository, Scratchpads, Directories, and Terminals. The browser keeps each section's expanded or collapsed state in local storage across client refreshes; newly discovered nodes start collapsed. Associated links and Markdown files are children of their owning session; generated session notes are discovered across every year and marked as automatic. Terminal groups have a drag grip and can be merged by dropping one onto another. Machine content hosts remain isolated, so terminal processes, resources, and state never mix across daemons.

The shared workspace has a group header, a minimized/resource pill shelf, one compact `+` icon button per panel type, and an ordered draggable and resizable panel strip. Drag anywhere on a panel header except its buttons to preview a live reorder, then drop to persist it. Click a terminal group's name in the group header, or any panel title, to rename it inline. The practical minimum panel width is 320 pixels. Shrinking a window minimizes visible panels from right to left while retaining at least one; growing it never restores them. A manual restore that cannot fit reports “Minimize another panel to open this.” The `^` action minimizes any panel. Terminal and AI panels keep their Zellij processes and also expose an explicit Close/Kill action. Markdown and iframe panels have no close action: minimizing unmounts them while preserving their association pill. Explicit associations can be disassociated separately, with dirty Markdown protection; discovered session notes cannot be disassociated.

Every terminal is rooted in its owning session directory (or the daemon home for a terminal group). Each additional terminal has its own stable panel-based Zellij identity. Migrated shell, editor, AI, and standalone terminal identities retain their old names. Switching groups or minimizing detaches the browser view without killing the process; Pause, Archive, Reset, provider changes, and Close/Kill discover and operate on the terminal panels actually present. The selected AI provider remains session-wide, including after its panel is closed and re-added.

Associated links render in sandboxed iframe panels and always include an external-open action. FritzWorks does not proxy or bypass `X-Frame-Options` or `frame-ancestors`; sites that refuse embedding must be opened externally. Markdown associations accept paths relative to the owning session directory, absolute paths, and `~/` paths, normalize them to existing regular `.md` files, and retain content-hash conflict protection.

The open detail modal remains stored as `session=<id>` in the URL, so it participates in Back/Forward history and survives reloads and bookmarks. A scratchpad's Name field changes its display name without renaming its original directory or branch identifier. The detail and creation modals retain their Custom, Linear, and GitHub link controls and shorthand expansion. Every terminal font falls back to [Symbols Nerd Font Mono](https://github.com/ryanoasis/nerd-fonts) v3.5.1, bundled at `/v2/fonts/symbols-nerd-font-mono.woff2`; its license and icon-set attributions are in `/v2/fonts/Symbols-Nerd-Font-LICENSE.txt`. The theme and terminal-font selectors remain browser-local settings. `ws web start` reuses a healthy daemon whose server-source revision is current, replaces an outdated daemon after a package update or local server edit, and opens its actual URL.

The daemon checks each non-archived repository session for a pull request matching its branch when it starts and every three minutes afterward. Finding a PR adds its canonical GitHub URL to the session's existing associated links and broadcasts an update to connected clients. A session that already has any `github.com/<owner>/<repo>/pull/<number>` link is excluded from discovery, whether that link was added automatically or by the user, so GitHub is not polled again for it.

The collection/detail endpoint is:

```text
GET /ws/{id}/?type={repo,scratchpad,misc}&page=0&perpage=25&status={active,paused,closed,all,active_paused}
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

Every mutation body must include the last-read integer `revision` and may include a browser `client` ID. A stale mutation returns HTTP 409 with the current revision in `details.revision`; clients must reload and reapply the user's intent. Successful mutations return the new revision and broadcast `{"type":"panel_layout","revision":13}` on `/ws/events`.

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
| Associate a resource | `POST /panel-layout/groups/{group}/resources` with `kind` (`link` or `markdown`) and `value` |
| Open or restore a resource panel | `POST /panel-layout/resources/{resource}/open` |
| Disassociate an explicit resource | `POST /panel-layout/resources/{resource}/disassociate` |

Resource panels are created from associations, not arbitrary client URLs or paths. Markdown paths are resolved and validated on the owning daemon. A disassociation request may pass `{"dirty":true}` to receive an HTTP 409; after user confirmation it can retry with `{"dirty":true,"force":true}`. Automatically discovered resources always reject disassociation.

The CLI exposes the same model through `ws panels`, `ws panel …`, and `ws resource …`. MCP clients can use `ws_panel_layout`, `ws_panel_add`, `ws_panel_update`, `ws_panel_close`, `ws_resource_add`, `ws_resource_open`, and `ws_resource_remove`; each tool accepts the standard optional `daemon` selector.

The New Repo button opens a creation modal with repository and branch/ref inputs, associated links, source and path previews, agent selection, and the initial panel layout. Its links section has a free-form field, a Linear autocomplete, and a GitHub autocomplete covering JavaScript customer escalations plus review-required PRs in `chainguard-dev/mono` and `chainguard-dev/ecosystems-rebuilder.js`. Press Enter or use the Add button to stage a link; each field accepts multiple links, shown together beneath the inputs as removable list-view pills with provider icons. Custom HTTP links use the site's favicon and hostname, with the complete URL in the hover tooltip. Opening the empty Linear control shows incomplete work assigned to the viewer or unassigned in the current ECO cycle; typing runs a debounced full-text search across active ECO issues, including issues outside the current cycle. The same three link inputs appear when creating a scratchpad. When a newly created repo or scratchpad has associated links, its seed briefing lists the canonical links and directs the agent to retrieve authenticated details with the Linear skill/CLI or `gh`; this also applies to CLI and MCP creation, and is appended to an explicit seed when one is supplied. It submits the following collection request, creates or restores the worktree, activates its browser terminal workspace, and then shows the new session details:

```text
POST /ws
{"repository":"org/repo","selector":"feature-branch","agent":"claude","panels":["shell","editor","agent"],"links":["#123"]}
```

`GET /ws/new` returns the configured repository and scratchpad roots, repositories used in the last three months, default agent, and default panels used to initialize the creation modals. `GET /ws/link-suggestions/linear` queries `linear api`; `GET /ws/link-suggestions/github` queries `gh` and groups the configured work sources. Both accept an optional `q` filter and cache their CLI results briefly.

The New Scratchpad button opens a parallel modal with an optional name, scratch path preview, agent, links, and initial panels. Leaving the name empty generates a readable random name. GitHub shorthand must include its repository because scratchpads have no associated repository of their own.

```text
POST /ws/scratchpad
{"name":"investigation","agent":"codex","panels":["shell","agent"],"links":["org/repo#123"]}
```

Commands accept a JSON object:

```text
POST /ws/{id}/{cmd}
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

Daemon-executed MCP support also uses `GET /config`, `GET /ws/{id}/stack`, `POST /ws/{id}/stack-set`, `POST /ws/{id}/stack-link`, `POST /ws/{id}/note`, `GET /ws/{id}/notes`, and `POST /ws/digest`. Keeping these operations behind HTTP ensures a remote MCP request reads and mutates the remote daemon's database, worktrees, and notes rather than local state.

`POST /ws/refresh` performs synchronous status reconciliation through the daemon. It is the endpoint used by `ws refresh`.

The REST `resume` command reconstitutes a missing worktree, selects its daemon-owned panel group, and broadcasts layout and session invalidations. The first attached browser terminal marks it active. `pause` clears it as the active group, disconnects its browser attaches, and stops each persistent terminal panel belonging to it. `terminal-reset` is the recovery path for a corrupt or incorrectly resurrected terminal: it disconnects the session's browser clients, force-deletes the actual panel-backed Zellij sessions and saved snapshots, and lets visible views reconnect into fresh processes. Settings also offers **Reset all terminal sessions**, backed by `POST /ws/terminal-reset`, for every `ws-browser-*` session on the selected daemon. Every configured location supports pause/resume, terminal reset, provider selection, and path opening; the API always rejects `close` for it.

Web clients connect to `ws://127.0.0.1:7337/ws/events`. Adding a workstream emits `{"id":123,"type":"new_session"}`; changing its session status or associated links emits `{"id":123,"type":"update_session"}`; layout mutations emit `{"type":"panel_layout","revision":13}`; lifecycle compatibility updates may also emit a `browser_state` invalidation; and activity hooks emit `{"id":123,"type":"agent_status","status":"working"}` or `{"id":123,"type":"shell_status","status":"ready"}`. These messages are invalidations, so clients reload the affected model. CLI and MCP mutations go through REST and emit immediately; direct bookkeeping changes such as stack relationships remain visible through the durable event journal poll.

Terminal groups replace the former global standalone-terminal bucket. Each is an ordinary sidebar node backed by ordered, resizable panel records and borderless Zellij sessions rooted at the daemon user's home directory. Terminals use the separate `/ws/terminal` WebSocket for input, output, resize, and ownership messages. Upgrades are accepted only from loopback clients with an allowed origin. A disconnect kills only its Zellij attach, leaving the shell alive. Terminal and event sockets reconnect automatically after a daemon restart or network interruption with exponential backoff capped at ten seconds. Exactly one browser client owns each attach; another client waits, can take over explicitly, and automatically claims it when the owner detaches.

Markdown editors now open from resources below their owning session instead of a global Markdown bucket. Each panel persists its Edit/Preview mode, size, order, and minimized state in SQLite. Editing still supports Tab/Shift-Tab indentation, list continuation, Ctrl-E, autosave, explicit Ctrl/Cmd-S, and content-hash conflict handling. Generated `ws note` files under `work/<YYYY>/workstream/<session>/` are dynamically included for repository sessions and scratchpads across all years.

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

Work-note paths remain confined to the notes root — `..`, absolute paths, symlinks pointing outside it, and non-`.md` files are rejected by the `/notes/file` routes. The explicit `/markdown/file` routes accept Markdown paths elsewhere on the selected daemon but only open existing regular files. Both kinds are capped at 1 MiB. Associations and panels are stored in SQLite; `editor-tabs.json` is read only by the idempotent legacy migration and is left untouched after a successful commit.

Keyboard navigation follows the visible layout. Ctrl-H/Ctrl-L move horizontally between panels, and Ctrl-H from the first panel returns to the sidebar. In the sidebar, Ctrl-J/Ctrl-K move between Sessions and Settings, Ctrl-L enters the highlighted group or resource, plain J/K move through rows, and plain H/L collapse or expand machine and group nodes.

Git cleanliness is cached in SQLite. List and detail GETs return the cached value immediately, then queue an asynchronous `git status` for each loaded repository or configured location. A changed result records an `update_session` event and is pushed over the WebSocket, causing clients to reload the new cached state without making the original GET wait on Git.

The API has no authentication and therefore binds to loopback by default. Do not expose it on a public interface without putting an authenticated proxy in front of it.

## MCP server

After a global install, register the stdio server with either client:

```sh
claude mcp add --scope user ws -- ws-mcp
codex mcp add ws -- ws-mcp
```

The MCP tools share the same configuration and service as the CLI. `ws_daemons` exposes the local daemon and every configured `[daemons.<id>]` endpoint. Every tool accepts an optional `daemon` id (default: `local`) and relays its operation to that daemon, so filesystem, Git, GitHub, notes, and lifecycle work happens on the selected machine. Pass `workstream` explicitly for remote workstream operations because the MCP process's current directory can only identify a local workstream.

Lifecycle, stack, issue, log, note, and digest tools all execute through the selected daemon's REST API. Consequently, `ws_new`, `ws_scratch`, `ws_resume`, `ws_pause`, and `ws_close` update that daemon's FritzWorks browser state rather than manipulating the MCP host terminal. `ws_new` and `ws_scratch` accept an optional `links` array; as in the web client and CLI, those links are included in the initial agent briefing. `ws_config` reports the selected daemon's resolved settings.

## Development and publishing

```sh
npm install
npm test
npm run check
npm pack --dry-run
```

`prepack` and `prepublishOnly` both run the complete check suite. Scoped public publication uses:

```sh
npm publish --access public
```
