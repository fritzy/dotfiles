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

## Workstation configuration

Update dotfiles and run `bash bootstrap.sh` on both the laptop and workstation.
Bootstrap delegates work-specific setup to `workstation.sh --auto`: Chainguard
hosts get the gitsign fork, credential cache, and remote browser commands; a
laptop with the `workstation` SSH alias gets the local relay and SSH tunnel.
Other hosts skip workstation configuration.
On a fresh Linux laptop, run `bash workstation.sh --local` once to opt in.
Run `bash workstation.sh --remote` to install just the remote components.

The laptop needs Python 3, OpenSSH, `xdg-open`, a graphical session with user
systemd, and authenticated gcloud. The checked-in SSH configuration targets
`nathan-fritz-work-v2` in `chainguard-workstations/us-central1-a`; edit
`home/.scripts/workstation-ssh-proxy` and `home/.ssh/config.d/workstation` to
change the destination. Setup migrates the two workstation SSH aliases into
that managed include, backs up existing files, and preserves other SSH hosts.
The existing FritzWorks forward at `127.1.1.2:7337` is retained.
Service enablement is local to each machine; remote setup disables laptop-only
units left over from older Stow installs.

On the workstation, `BROWSER`, `GH_BROWSER`, gitsign's URL opener, and a
`~/.local/bin/xdg-open` shim send HTTP(S) URLs through `/tmp/url-open.sock`.
Open a new shell after installing. Explicit gh and gitsign settings also cover
processes that haven't loaded the new shell environment. The helper installs
the required links even when stow is unavailable.
For other tools in noninteractive Bash SSH commands, use a login shell
(`ssh workstation 'bash -lc "your-command"'`) to load `BROWSER` and the user PATH.

The laptop's `url-open.socket` starts `url-open.service`, which opens URLs in
the desktop browser. `workstation-tunnel.service` maintains the SSH connection.
Loopback URLs and OAuth `redirect_uri`, `redirect_url`, or `redirectURL` query
parameters automatically get matching callback forwards to the workstation.
Forwarding is restricted to `localhost`, `127.0.0.1`, and `::1`, ports 1024–65535;
unused forwards expire 15 minutes after their last URL request. A conflicting
local port fails the request. Flows hiding the callback address elsewhere need
a manual SSH forward. URLs and OAuth parameters are not logged by the relay.

Check or restart the laptop services:

```sh
systemctl --user status url-open.socket url-open.service workstation-tunnel.service
journalctl --user -u url-open.service -u workstation-tunnel.service -n 30
systemctl --user restart workstation-tunnel.service
ssh workstation 'gh browse --repo cli/cli'
```

If the tunnel journal reports expired gcloud credentials, run `gcloud auth login`
on the laptop, then restart the tunnel. Laptop sleep or loss of connectivity
interrupts the relay; systemd reconnects it. No firewall ports are exposed.
The old FIFO reader is disabled during migration.

Relay tests: `python3 -m unittest discover -s tests -p 'test_url_relay.py'`.
Protocol references: [gh browser selection](https://cli.github.com/manual/gh_help_environment),
[gitsign URL opener](https://github.com/sigstore/gitsign#configuration), and
[SSH forwarding control](https://man.openbsd.org/ssh#O).

## Gitsign fork

`bash bootstrap.sh` on a Chainguard workstation, or `bash workstation.sh --remote`
explicitly, runs `bin/install-gitsign-fork --system`. Git, Go 1.21+ and sudo must
be available. No existing fork checkout or manual build is needed.

The installer clones the [fork](https://github.com/fritzy/gitsign) at commit
`48435a8f7995eabe5d1f7dde9a74ae7905c985e1` and builds both binaries with Go 1.27.1
(downloaded by Go if needed). Source lives in `~/github/fritzy/gitsign`;
installed binaries live in `~/.local/lib/gitsign`, with links in `~/.local/bin`.
Local checkout edits or a different origin stop installation without replacing
the installed binaries. Repeat runs preserve an unchanged running cache.

Setup enables X.509 commit/tag signing, selects Google with the default login
hint `nathan.fritz@chainguard.dev`, enables automatic cache discovery, and sets
`gitsign.rekorMode=offline` to embed Rekor proofs. Signing still publishes to
Rekor; verification doesn't depend on its delayed search index. Existing
connector, login-hint, and browser-opener settings are preserved.

On Linux, setup installs and enables `gitsign-credential-cache.service`. If no
user systemd bus is available, it installs the unit and prints the activation
command. Installation doesn't initiate a browser login; the first signing
request fills the cache. A changed daemon binary or unit restarts the service.

`--system` backs up and replaces `/usr/bin/gitsign` and installs the passthrough
wrapper at `/usr/local/bin/gitsign`, covering old sessions and explicit signer
paths. Rerunning workstation setup repairs those paths after a host update.
For a user-only install, run `bash bin/install-gitsign-fork` without sudo.

Override `GITSIGN_CHECKOUT`, `GITSIGN_REPOSITORY`, `GITSIGN_REVISION` (a full
commit SHA), or `GITSIGN_TOOLCHAIN` to change the source/build inputs.
`GITSIGN_LOGIN_HINT` explicitly overrides the saved hint, including an empty
value to disable it. Update the pinned revision in the installer when adopting
new fork changes.

An older online signature can report `could not find matching tlog entry`
until Rekor indexes it. Retry verification of the same commit; re-signing
creates another entry and restarts that wait. The cache only reuses credentials
while their short-lived Fulcio certificate remains valid.

Installer and wrapper tests: `python3 -m unittest discover -s tests -p 'test_gitsign*.py'`.

## FritzWorks

Bootstrap installs or upgrades [FritzWorks](https://github.com/chainguard-sandbox/fritzworks)
in `~/fritzworks` using `bin/install-fritzworks`. The repository currently requires
GitHub access; the default clone uses SSH. Node.js and npm must already be installed.
The installer runs `npm ci` and package setup, preserving configuration and local
checkout edits. It never restarts the daemon automatically.

Override `FRITZWORKS_CHECKOUT`, `FRITZWORKS_REPOSITORY`, or `FRITZWORKS_BRANCH` to use
another directory, clone URL, or branch. `packages/fritzworks` remains a compatibility
link for existing installations. Run `fw doctor` for dependency, hook, and web-build
status, or `fw doctor --fix` to repair the installation.

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

## Libraries Build work report

[`home/.scripts/libraries-build-work.sh`](home/.scripts/libraries-build-work.sh)
gathers review work in `chainguard-dev/mono`, your unfinished Linear assignments
across all teams, and unfinished ECO issues related to mentat, judge, and axlotl.
Requires authenticated [`gh`](https://cli.github.com/manual/gh_api),
[`linear`](https://github.com/schpet/linear-cli) with `linear api`, and `jq` 1.6+.

```bash
~/.scripts/libraries-build-work.sh --tty
~/.scripts/libraries-build-work.sh --markdown > work.md
~/.scripts/libraries-build-work.sh --workspace chainguard --markdown
```

Without a mode flag, terminals get the terminal layout and redirected output gets
Markdown. `NO_COLOR=1` disables terminal color. Progress goes to stderr. Queries
are read-only, results are fully paginated, and API failures exit nonzero without
printing a partial report.

PR matching checks titles, descriptions, branch names, and changed paths for the
three component names, case-insensitively. Non-draft PRs qualify when GitHub says
review is required, a review request is outstanding, or there is no review
decision and no approval/change-request review. This includes all authors and
reviewers, including your own PRs. PRs appear most recently updated first.

ECO matching uses titles, descriptions, labels, and project names through
[Linear issue filters](https://linear.app/developers/filtering). Both Linear
sections exclude completed, canceled, and archived issues and sort by priority,
then due date. An issue matching both sections appears in both.

## About

I use this primarily to keep my dev environment current on my local MacOS and my GitHub Codespaces VMs.

## Notes

- If neovim or kitty reformats their release file structure, it'll need fixing
- You'll need to enable dotfiles for GH Codespaces
- The GH Codespaces path is an implementation detail
  - Currently something like `/workspaces/.codespaces/.persistedshare/dotfiles`
