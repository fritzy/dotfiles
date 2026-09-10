# FritzWorks TODO

The web and MCP clients largely follow the daemon-centered architecture in
`CLAUDE.md`. Multi-daemon web panes, WebSocket invalidation with REST refresh,
daemon-owned browser state, persistent Zellij terminals, and reusable terminal
panel components are in place. The main remaining work is completing the daemon
boundary for the CLI and closing client parity and release-confidence gaps.

## Priority 1: Restore a green release gate

- [ ] Update configured-location terminal assertions in `test/api.test.js` for
  the injected `AI_WORKSTREAM_ID=<location>` environment variable and shifted
  command indexes.
- [ ] Run `npm test` and confirm all tests pass. Current baseline: 88 pass, 1
  fails at the first stale terminal-command assertion.
- [ ] Run the complete `npm run check` release gate.

## Priority 2: Finish the daemon boundary

- [ ] Add a CLI daemon selector, consistent with MCP's `daemon` argument.
- [ ] Route CLI target resolution through the selected daemon instead of opening
  the local SQLite database.
- [ ] Move remaining CLI stack, issue-list, note, digest, configuration, and
  archive-preflight operations behind REST endpoints.
- [ ] Remove local database reads from MCP target/current-context resolution
  where the daemon can resolve the request.
- [ ] Ensure every remote operation executes filesystem, Git, GitHub, notes,
  and lifecycle work on the selected daemon.

## Priority 3: Complete client action parity

- [ ] Document a web/CLI/MCP action matrix and decide which browser-only state
  operations are intentionally excluded.
- [ ] Expose agent selection through CLI and MCP without requiring a resume.
- [ ] Expose per-workstream and global terminal reset through CLI and MCP.
- [ ] Decide whether host-side `open-path` and `open-notes` actions belong in
  CLI/MCP, then implement or document the exclusion.
- [ ] Decide whether agents need APIs/tools for standalone terminal groups,
  Markdown sessions, and browser workspace selection.

## Priority 4: Strengthen confidence

- [ ] Add a smoke test covering a real Zellij-backed terminal session across a
  daemon restart and browser reconnect.
- [ ] Add end-to-end coverage for switching between local and remote daemons,
  including independent terminal and Markdown state.
- [ ] Verify CLI and MCP mutations immediately update an open browser and are
  restored correctly when no browser is connected.

## Release cleanup

- [ ] Review the large working-tree refactor and split it into coherent commits.
- [ ] Confirm generated `web/v2` assets match the final source build.
- [ ] Reconcile README claims with the final CLI daemon and client-parity behavior.
- [ ] Keep comments terse and limited to narrow rationale or hazards, per
  `CLAUDE.md`.
