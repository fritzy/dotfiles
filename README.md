# @fritzy dotfiles

This is a [stow](https://www.gnu.org/software/stow/) based dotfiles repo with bootstrap script with multiple OSes and Architectures supported.

## Features:

- Installs the latest `neovim` in `~/.local`
- Installs `stow` via `apt` or `brew`
- Installs the latest `kitty.app` on macos
- Supports Linux & MacOS on Arm and x86
- Adds aliases/env to `.bashrc` or `.zshrc`
- Uses a guarded interactive Bash-to-Zsh handoff, so a persistent home can keep
  Zsh as the user shell when an ephemeral host resets its passwd entry to Bash
- Syncs dotfiles with `stow` (primarily `~/.config/nvim/...`)
- Copies allowlisted Claude and Codex settings, global instructions (`CLAUDE.md` / `AGENTS.md`), and skills without linking their runtime directories into this repo
- Links the shell startup files directly when `stow` is temporarily unavailable
- Bootstraps NeoVim Lazy plugins

## Google Sheets MCP

Bootstrap installs a pinned `mcp-remote` adapter and registers `sheets` with both
Claude Code (user scope) and Codex. Both use the same private OAuth credentials
and token cache. Registration does not open a browser or require sign-in.

1. In your Google Cloud project, enable the Sheets API and Sheets MCP API and
   configure the OAuth consent screen. The server currently requires Workspace
   Developer Preview access; see [Google's setup guide](https://developers.google.com/workspace/sheets/api/guides/configure-mcp-server).
2. Create a **Web application** OAuth client with the authorized redirect URI
   `http://localhost:8765/callback`, then download its client JSON.
3. Run `bash packages/google-sheets-mcp/setup.sh --credentials /path/to/client.json`.
4. Run `node packages/google-sheets-mcp/sheets.js --login '<spreadsheet URL>'` and
   sign in with your work account. If no browser opens, use the authorization URL
   printed in the terminal. Success means the command read the spreadsheet's
   metadata; listing MCP tools alone does not verify authentication. Restart
   Claude Code and Codex to load the server.

Requires Node.js 20.18.1+ and npm. Run setup again after installing either CLI or
moving the checkout. It updates only the `sheets` registration and preserves
other MCP servers. Bootstrap runs the same setup after copying client settings.

Credentials live in `~/.config/google-sheets-mcp/oauth-client.json` (mode `600`);
tokens live in `~/.local/state/google-sheets-mcp/` (mode `700`). The corresponding
`XDG_CONFIG_HOME` and `XDG_STATE_HOME` overrides are honored; keep them consistent
between setup and client launches. Back up these private files separately from
git. On a new machine, import the OAuth client JSON and sign in again. Run the
login command before starting both clients for the first time. For an SSH host,
forward local port 8765 to the host's port 8765 during sign-in.

The adapter supports Google's client secret and refresh tokens for both clients.
Codex's native MCP OAuth configuration currently exposes a client ID but no client
secret setting. See [Codex MCP documentation](https://developers.openai.com/codex/mcp/)
and [mcp-remote](https://github.com/punkpeye/mcp-remote).

## About

I use this primarily to keep my dev environment current on my local MacOS and my GitHub Codespaces VMs.

## Notes

- If neovim or kitty reformats their release file structure, it'll need fixing
- You'll need to enable dotfiles for GH Codespaces
- The GH Codespaces path is an implementation detail
  - Currently something like `/workspaces/.codespaces/.persistedshare/dotfiles`
