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
- Seeds missing Claude/Codex settings, updates repository-managed skills with backups, and syncs global instructions (`CLAUDE.md` / `AGENTS.md`)
- Uses relative fallback links when `stow` is temporarily unavailable; later Stow runs accept them
- Bootstraps NeoVim Lazy plugins

## Bootstrap entry points

Run `bash bootstrap.sh` on every machine, including non-work machines. It installs
shared shell/editor tools, syncs the `home` Stow package, and sets up Claude/Codex
and FritzWorks. It does not select a work role from the OS or SSH configuration.

After general bootstrap, run the appropriate work script:

| Machine | Command | Additional setup |
| --- | --- | --- |
| Work laptop | `bash bootstrap-worklaptop.sh` | `ssh workstation`, local browser relay/socket, persistent SSH tunnel |
| Cloud workstation | `bash bootstrap-workstation.sh` | Remote browser commands, gitsign fork and credential cache |

Both work scripts also install Linear and configure Sheets MCP when credentials
are available. They assume general bootstrap has already run and do not invoke it.
Run shared setup first, then exactly one role. Both sequences are additive:
rerunning shared setup preserves the selected role's files.
Rerun the relevant scripts after pulling changes. Existing MCP registrations,
client settings, unrelated skills, and FritzWorks configuration are preserved.
Bootstrap does not start OAuth login, clear tokens, or upgrade an existing
Codex/FritzWorks installation. Repository-managed skills and global instructions
sync from this repo; FritzWorks refreshes its hooks and adds missing MCP registrations.

The `home`, `worklaptop`, and `workstation` directories are separate Stow packages.
`bin/sync-dotfiles` migrates old absolute links, unfolds managed directory links,
and backs up conflicting files as `.bak`, `.bak.1`, etc. It installs relative file
links and validates their ownership with Stow when available. Failed syncs roll
back their changes. Unfolding copies only the linked directory, preserving its
ignored configuration and runtime files without importing other machine roles.
Python 3 is required and installed by general bootstrap. Generated
Python bytecode is ignored by both Git and Stow. The old `workstation.sh --local`
and `--remote` commands forward to the new scripts; automatic role detection is
removed.

## Workstation browser relay

The laptop needs Python 3, OpenSSH, `xdg-open`, a graphical session with user
systemd, and authenticated gcloud. The checked-in SSH configuration targets
`nathan-fritz-work-v2` in `chainguard-workstations/us-central1-a`; edit
`worklaptop/.scripts/workstation-ssh-proxy` and `worklaptop/.ssh/config.d/workstation` to
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

`bash bootstrap-workstation.sh` runs `bin/install-gitsign-fork --system`.
Git, Go 1.21+ and sudo must be available. No existing fork checkout or manual build
is needed.

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

## Codex and npm

General bootstrap installs Codex only when it is missing from PATH. An existing
command is checked with `--version`; its npm prefix is left unchanged. For a new
installation, if npm's global directories are not writable, setup sets the user
npm prefix to `~/.local` and installs Codex there. Existing writable prefixes,
including active Node version managers, are preserved. Bash and Zsh put `~/.local/bin` ahead of
system executables. Node.js and npm must already be installed.

Run `bash bin/setup-codex` to install a missing Codex command, then open a new
shell. An existing command that fails `--version` is reported for manual repair.
Updates use `npm install --global @openai/codex@latest` without sudo.
The system copy remains installed. This follows
[npm's user-prefix setup](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally/).

Bootstrap seeds settings only when absent: `$CODEX_HOME/config.toml` (default
`~/.codex`), Claude's `settings.json`, and its plugin marketplace registry
(`CLAUDE_CONFIG_DIR` is honored). Repository-managed skills are refreshed when their
contents change; previous copies are saved under each client's `skill-backups`
directory. Unrelated skills stay intact. Symlinked skill roots are materialized
before updating them, and unchanged skills are not rewritten.
Keep repository seeds free of credentials and machine-specific MCP paths. FritzWorks and Sheets setup
generate their own local paths. Bootstrap does not copy auth files, keyrings,
OAuth tokens, or credentials from another machine.

Sign in separately on each machine with `codex login`. Slack and Sheets setup
are described below.
The SessionEnd timeout is generated by FritzWorks; fix its installer if it
reintroduces a timeout above Codex's 3-second limit. Enterprise-managed feature
warnings require a compatible Codex release or a managed-policy correction.

## Slack MCP

Register Slack separately in each client, then sign in on that machine:

```sh
codex mcp add slack --url https://mcp.slack.com/mcp
codex mcp login slack
claude mcp add --transport http --scope user \
  --client-id 1601185624273.8899143856786 --callback-port 3118 \
  slack https://mcp.slack.com/mcp
claude mcp login slack
```

Skip registration when the server already exists. Claude requires the client ID
and callback port from [Slack's Claude configuration](https://docs.slack.dev/ai/slack-mcp-server/connect-to-claude/);
without them, login fails because Slack does not support dynamic client registration.
See also [Codex MCP authentication](https://developers.openai.com/codex/mcp/).

On the workstation, keep the laptop's `workstation-tunnel.service` running for
browser sign-in and callback forwarding. For a noninteractive SSH shell, export
`PATH="$HOME/.local/bin:$PATH"` and `BROWSER="$HOME/.scripts/url-open"` first;
Claude login also requires `ssh -t`. Restart existing agent sessions after login.

## FritzWorks

Bootstrap installs [FritzWorks](https://github.com/chainguard-sandbox/fritzworks)
only when `fw` is missing. Existing installations keep their checkout and
dependencies. `bin/setup-fritzworks` validates the configuration, refreshes
FritzWorks hooks, and registers MCP only for clients without an existing `fw`
entry. Custom registrations are preserved. Its config file is seeded only when
absent, using explicit paths, rather than replaced by Stow. Invalid configuration
or a broken configuration symlink stops setup.

For an intentional upgrade or repair, run `bash bin/install-fritzworks --desktop`.
That command updates `~/fritzworks` and runs `npm ci` and package setup. It requires
GitHub SSH access, Node.js, and npm, preserves local checkout edits, and never
restarts the daemon automatically.

Override `FRITZWORKS_CHECKOUT`, `FRITZWORKS_REPOSITORY`, or `FRITZWORKS_BRANCH` to use
another directory, clone URL, or branch. `packages/fritzworks` remains a compatibility
link for existing installations. Run `fw doctor` for dependency, hook, and web-build
status, or `fw doctor --fix` to repair the installation.

## Google Sheets MCP

The work bootstraps install a pinned `mcp-remote` adapter and register `sheets` with both
Claude Code (user scope) and Codex when a local OAuth client file is present.
Dependency setup reruns `npm ci` when the package manifest or lockfile changes,
or an installed package is missing or has the wrong version.
Existing `sheets` registrations are always preserved, including custom commands,
environment variables, and disabled servers. Without credentials, missing
registrations are deferred; existing entries are never removed. The adapter is
installed only if needed and absent. Both clients use the same private OAuth
credentials and token cache on that machine. Setup does not start sign-in or
rewrite existing credentials unless `--credentials` is supplied explicitly.

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

Requires Node.js 20.18.1+ and npm. Run setup again after installing either CLI to
add a missing `sheets` registration. To repair an old registration after moving
the checkout, remove that entry explicitly in the affected client, then rerun
setup. Adapter upgrades are explicit: run `npm ci --ignore-scripts --no-audit
--no-fund` in `packages/google-sheets-mcp`. Both work bootstraps run setup after
general bootstrap.

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

## ASK_FRIEND dashboard

Run `bash bin/install-ask-friend` to install the
[Mentat ASK_FRIEND dashboard](https://github.com/chainguard-sandbox/sandbox-of-power/tree/main/bdmurray/ask-friend)
and its audit scripts in `~/sandbox-of-power`, with an `ask-friend` command in
`~/.local/bin`. Requires Python 3.9+, authenticated GitHub SSH access, gcloud
application-default credentials, and a current `cg` with `questions list --json`.
Build `cg` from current mono main with `bash cg/hack/build.sh -o ~/go/bin/cg`.
Audits also use `gsutil` and authenticated `gh`.

```sh
ask-friend refresh                 # live pull; takes a few minutes
ask-friend serve                   # http://127.0.0.1:8767; Ctrl-C to stop
ask-friend queue --help
ask-friend audit --help
ask-friend answer --help
```

The dashboard includes the checkout's committed audits. JSON and HTML snapshots
live under `~/.local/state/ask-friend` (`XDG_STATE_HOME` is honored). A failed
refresh preserves the previous snapshots. On the workstation, run
`xdg-open http://127.0.0.1:8767` while the browser relay is connected, or forward
port 8767 over SSH. The server binds only to localhost.

Update scripts and shared audits with `git -C ~/sandbox-of-power pull --ff-only`.
Setup preserves existing checkouts. `ASK_FRIEND_CHECKOUT` overrides the source
path; set it for both installation and command use. Audits write local reports
under the checkout's `bdmurray/ask-friend/audits/` directory. Answers default to
dry runs; `--yes` submits a human ruling after review. Scores are review aids.

## About

I use this primarily to keep my dev environment current on my local MacOS and my GitHub Codespaces VMs.

## Notes

- If neovim or kitty reformats their release file structure, it'll need fixing
- You'll need to enable dotfiles for GH Codespaces
- The GH Codespaces path is an implementation detail
  - Currently something like `/workspaces/.codespaces/.persistedshare/dotfiles`
