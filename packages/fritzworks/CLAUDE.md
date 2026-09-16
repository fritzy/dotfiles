# FritzWorks

This is a web, terminal, mcp tool designed to manage a developers work across repos using git-trees. It's a terminal emulator that associates AI tools and other terminals with git worktree branches, scratchpads, and manually configured directories. It is designed for management simulateous streams of work.

## Architecture

Everything flows through the daemon. The clients can connect to multiple configured daemons. The clients are web, cli, and mcp. Websockets inform the web client of changes, so that it can then use the REST api for pulling up the authoritive state.

The web client may be the primary consumer, but the cli tool and mcp server should be able to take any daemon-based actions the web client can, including ones that change the web client's state. This gives both the user and the ai agent control.

## Future

This project is iterated on daily while using it. That is why terminal sessions are made through zellij for reliability across daemon restarts and web refreshes. Everything is designed to be durable.

We will iterate toward Linear / GitHub Issues / GitHub PR Review driven work in the near future, adding views, flexibilty, and means of creating sessions from work sources.

## Code Style

### Comments

Comments should be terse and need not be prose. Avoid essays. Avoid describing self-evident code and providing examples. Code comments should be limited to what, narrow why, and hazards.

### Web Code

A react app with a focus on re-usable components, flexible panels, easy navigation, and terminal emulation.
