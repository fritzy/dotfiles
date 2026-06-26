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

  // Inside a session already: add (or focus) the tab in that session.
  if (inZellij()) {
    if (tabNames().includes(row.tab_name)) {
      zellij(['action', 'go-to-tab-name', row.tab_name], { stdio: 'inherit' });
      return;
    }
    const r = zellij(['action', 'new-tab', '--layout', file], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('failed to create Zellij tab');
    zellij(['action', 'go-to-tab-name', row.tab_name], { stdio: 'inherit' });
    return;
  }

  // Outside any session: attach to (or create) the ws session. With --session,
  // `--layout` adds the tab to an existing session or starts a new one named WS_SESSION.
  const verb = runningSessions().includes(WS_SESSION) ? 'Attaching to' : 'Starting';
  progress(`${verb} Zellij session "${WS_SESSION}" for "${row.tab_name}"...`);
  spawnSync('zellij', ['--session', WS_SESSION, '--layout', file], { stdio: 'inherit' });
}

export function closeTab(row) {
  if (inZellij() && tabNames().includes(row.tab_name)) {
    zellij(['action', 'go-to-tab-name', row.tab_name]);
    zellij(['action', 'close-tab']);
  }
}
