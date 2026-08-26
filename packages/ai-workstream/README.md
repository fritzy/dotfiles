# @fritzy/ai-workstream

`ai-workstream` is an opinionated `ws` command for managing development work as Git worktrees and Zellij tabs. Each workstream records a repository, branch, status, linked issues, short logs, and longer notes. Tabs can combine configurable shell, editor, and AI-agent panels, using either Claude Code or Codex.

The package also installs `ws-mcp`, an stdio MCP server exposing the non-interactive workstream operations.

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
panels = shell, editor, agent
agent = claude
zellijSession = ws
gitProtocol = ssh

[paths]
repositories = ~/github
scratchpads = ~/scratchpad
notes = ~/notes
dotfiles = ~/dotfiles
data = ${XDG_DATA_HOME}/ws

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
```

Paths beginning with `~/` are expanded against the user's home directory. `${HOME}` and `${XDG_DATA_HOME}` are also supported at the start of a path. Relative user paths are resolved from the user configuration file's directory. Commands may be a single executable string or a JSON-style array containing the executable and fixed arguments, such as `editor = ["nvim", "--clean"]`. Empty model values disable an explicit model selection.

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
| Panel roles | `AI_WORKSTREAM_PANELS` |
| Default agent | `AI_WORKSTREAM_AGENT` |
| Shell/editor commands | `AI_WORKSTREAM_SHELL`, `AI_WORKSTREAM_EDITOR` |
| Agent commands | `AI_WORKSTREAM_CLAUDE`, `AI_WORKSTREAM_CODEX` |
| Agent models | `AI_WORKSTREAM_CLAUDE_MODEL`, `AI_WORKSTREAM_CODEX_MODEL` |
| Scratchpad models | `AI_WORKSTREAM_CLAUDE_SCRATCH_MODEL`, `AI_WORKSTREAM_CODEX_SCRATCH_MODEL` |
| Zellij session | `AI_WORKSTREAM_ZELLIJ_SESSION` |
| GitHub URL protocol | `AI_WORKSTREAM_GIT_PROTOCOL` |

Command arrays in environment variables can be JSON, for example `AI_WORKSTREAM_EDITOR='["nvim","--clean"]'`. Existing `WS_*` forms are accepted as compatibility aliases.

Precedence is: one-run CLI flags, environment variables, the user INI file, then the bundled `config.ini`.

## Panels and agents

The standard panel roles are `shell`, `editor`, and `agent`. Configure any non-empty subset globally, or override it for a single newly opened tab:

```sh
ws new fritzy/example feature-x --panels shell,agent
ws resume feature-x --no-editor
```

Choose an agent in configuration or per command:

```sh
ws new fritzy/example feature-x --agent codex
ws scratch investigation --claude
ws resume feature-x --codex --model gpt-5.6-sol
```

For an existing workstream directory, Claude uses `--continue`; Codex uses the officially documented cwd-scoped [`codex resume --last`](https://developers.openai.com/codex/cli/reference). Both fall back to a new session when no matching session exists. A `--seed file.md` starts a fresh session with instructions to read that document.

Panel-management commands are `ws open-shell`, `ws open-editor`, `ws open-agent`, and their `close-*` counterparts. `open-claude` and `open-codex` force a provider. The older `zsh`, `nvim`, and `claude` command aliases remain available.

## Main commands

Run `ws help` for the complete command reference. Common workflows include:

```sh
ws list
ws new org/repo feature-branch
ws join feature-branch
ws pause feature-branch
ws close feature-branch
ws scratch experiment
ws issue add https://github.com/org/repo/issues/123 --ws feature-branch
ws log "identified the root cause" --ws feature-branch
ws stack --ws feature-branch
```

Worktrees are stored under `<repositories>/<org>/<repo>/<branch>` with a bare clone at `<repositories>/<org>/<repo>/.bare`. Scratchpads are plain directories without Git backing. The SQLite database and agent seed documents live under the configured data directory.

`ws close` refuses to remove a dirty Git worktree unless explicitly forced. Scratchpad directories are retained unless deletion is explicitly requested. `ws stack rebase` rewrites history, and `ws stack link` pushes branches and may create pull requests; review their output and confirmations carefully.

## MCP server

After a global install, register the stdio server with either client:

```sh
claude mcp add --scope user ws -- ws-mcp
codex mcp add ws -- ws-mcp
```

The MCP tools share the same configuration and database as the CLI. `ws_config` reports the resolved settings.

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
