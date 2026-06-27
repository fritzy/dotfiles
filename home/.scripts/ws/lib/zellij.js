// ws zellij — opening/closing the three-pane Zellij tab for a workstream.
//
// Shared by the CLI and the MCP server. Like core.js, this writes diagnostics to
// stderr only (never stdout) so it's safe to use from the stdio MCP server whose
// stdout carries the JSON-RPC stream. Functions throw Error on failure rather than
// exiting, so callers decide how to surface the problem.

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WS_SESSION } from './core.js';

const progress = (msg) => process.stderr.write(`${msg}\n`);

export const inZellij = () => Boolean(process.env.ZELLIJ);

function zellij(args, opts = {}) {
  return spawnSync('zellij', args, { encoding: 'utf8', ...opts });
}

function tabNames() {
  const r = zellij(['action', 'query-tab-names']);
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

// Names of sessions that are currently running (excludes EXITED/resurrectable ones).
function runningSessions() {
  const r = zellij(['list-sessions', '--no-formatting']);
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout.split('\n')
    .filter((l) => l.trim() && !l.includes('EXITED'))
    .map((l) => l.trim().split(/\s+/)[0]);
}

function writeLayout(row, opts = {}) {
  const file = join(tmpdir(), `ws-layout-${process.pid}-${row.id}.kdl`);
  // Open nvim on a specific file when asked (e.g. `ws notes`), else a bare editor.
  const nvimPane = opts.nvimFile
    ? `pane name="nvim" command="nvim" {
                args "${opts.nvimFile}"
            }`
    : `pane name="nvim"   command="nvim"`;
  // Include the tab-bar plugin pane explicitly: a layout passed to `new-tab`
  // replaces that tab's whole template, so without it this tab would lose the
  // top tab row that default tabs show. We deliberately omit the bottom
  // status-bar (shortcut) pane to keep the tab clean.
  const kdl = `layout {
    tab name="${row.tab_name}" cwd="${row.path}" {
        pane size=1 borderless=true {
            plugin location="zellij:tab-bar"
        }
        pane split_direction="vertical" {
            pane name="zsh"
            ${nvimPane}
            // Resume this worktree's most recent Claude session; if there is
            // none (a brand-new worktree), --continue exits non-zero and we
            // fall back to a fresh session. --continue is scoped to cwd, so it
            // picks up exactly this workstream's prior conversation.
            pane name="claude" command="zsh" {
                args "-c" "claude --continue || claude"
            }
        }
    }
}
`;
  writeFileSync(file, kdl);
  return file;
}

// Open (or focus) the workstream's tab. Inside a Zellij session this adds/focuses
// the tab in place; from outside it attaches to (or starts) the WS_SESSION session.
export function openTab(row, opts = {}) {
  const file = writeLayout(row, opts);

  // Inside a session already: add (or focus) the tab in that session. These
  // `zellij action` calls capture their output (the default) rather than inheriting
  // stdio: when openTab runs from the MCP server, stdout is the JSON-RPC stream and
  // any child output on it would corrupt the protocol. They talk to the running
  // session over its socket, so no TTY is needed.
  if (inZellij()) {
    if (tabNames().includes(row.tab_name)) {
      zellij(['action', 'go-to-tab-name', row.tab_name]);
      return;
    }
    const r = zellij(['action', 'new-tab', '--layout', file]);
    if (r.status !== 0) throw new Error('failed to create Zellij tab');
    zellij(['action', 'go-to-tab-name', row.tab_name]);
    return;
  }

  // Outside any session: land the user in the ws session with this tab open.
  // `--layout` only *adds a tab* and errors ("There is no active session!") if the
  // session doesn't exist yet, so when it's not running we create it with
  // `--new-session-with-layout` (which creates the session and attaches in one go).
  if (runningSessions().includes(WS_SESSION)) {
    progress(`Attaching to Zellij session "${WS_SESSION}" for "${row.tab_name}"...`);
    // Add the tab to the running session, then attach so the user lands in it.
    zellij(['--session', WS_SESSION, 'action', 'new-tab', '--layout', file]);
    spawnSync('zellij', ['attach', WS_SESSION], { stdio: 'inherit' });
  } else {
    progress(`Starting Zellij session "${WS_SESSION}" for "${row.tab_name}"...`);
    // Create the session detached first so it inherits Zellij's built-in default
    // layout — and with it a proper new-tab template (tab-bar + status-bar) for the
    // tabs the user later opens with Ctrl-t n. Starting the session *from* our
    // layout file (--new-session-with-layout) instead leaves those new tabs blank,
    // since the file defines no default tab template. We then reshape the session's
    // single placeholder tab into our (deliberately status-bar-less) ws tab with
    // `override-layout`, which — unlike a tab born from the startup layout — is used
    // as-is rather than wrapped by the default template.
    zellij(['attach', '--create-background', WS_SESSION]);
    const r = zellij(['--session', WS_SESSION, 'action', 'override-layout', file]);
    if (r.status !== 0) throw new Error('failed to lay out Zellij tab');
    spawnSync('zellij', ['attach', WS_SESSION], { stdio: 'inherit' });
  }
}

export function closeTab(row) {
  if (inZellij() && tabNames().includes(row.tab_name)) {
    zellij(['action', 'go-to-tab-name', row.tab_name]);
    zellij(['action', 'close-tab']);
  }
}
