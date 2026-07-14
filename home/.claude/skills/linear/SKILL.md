---
name: linear
description: "Read and manage Linear issues, projects, cycles, and more from the command line via the `linear` CLI. Use when asked to look up / create / update / comment on a Linear issue, list your issues or the current cycle, find work assigned to you, or pull Linear data. Trigger terms include: linear, linear issue, ECO-1234 (or any TEAM-#### code), my linear issues, current cycle, assign in linear, linear ticket."
metadata:
  tags: linear, issues, cycles, projects, ECO, chainguard
---

# linear

Drive [Linear](https://linear.app) from the terminal with the `linear` CLI (`linear 2.0.0`).
Nathan is authenticated as `nathan.fritz@chainguard.dev` in the **chainguard** workspace;
his default team is **ECO** (Ecosystems). Credentials live in
`~/.config/linear/credentials.toml` — no need to log in.

Issues are referenced by their code, e.g. `ECO-1443` (`<TEAM_KEY>-<number>`).

## Ground rules

- **Discover flags with `-h`.** Every command supports `linear <cmd> <subcmd> -h`.
  Caveat: `-h` after a subcommand that takes a positional arg (e.g. `view`, `start`,
  `comment`) prints the top-level help instead — for those, trust the docs below or run
  the command against a real issue.
- **Team/issue inference.** Many commands infer the team from the current directory
  name or the git branch's issue code. Outside a matching repo you'll see
  *"Could not determine team key"* or *"Could not determine issue ID"* — pass `--team ECO`
  (or the relevant key) or an explicit issue code.
- **Prefer `--json` for parsing.** `linear issue query --json` etc. emit structured JSON;
  pipe to `jq`. Human commands auto-page — add `--no-pager` when capturing output.
- **Mutations need a green light.** Creating, updating, commenting, deleting, assigning,
  or changing state writes to shared Linear. Confirm with Nathan before any write unless
  he clearly asked for it. Reads are always fine.

## Reading issues

```bash
linear issue view ECO-1443          # rendered issue detail (title, state, description, checklist)
linear issue view ECO-1443 -w       # open in browser  (-a opens the Linear.app desktop app)
linear issue url ECO-1443           # just print the URL
linear issue title ECO-1443         # just the title
linear issue id                     # issue code inferred from the current git branch
```

### Listing your work

```bash
linear issue list --sort priority                 # your unstarted issues (default state filter)
linear issue list --state started --sort priority # what you're actively working on
linear issue list --all-states --team ECO --sort priority
```

`issue list` (aliases `mine`, `l`) always needs a sort — pass `--sort priority` (or set
`LINEAR_ISSUE_SORT`) and a team it can resolve (`--team ECO` outside an ECO repo).
Useful filters: `--state`, `--project`, `--cycle active`, `--label`, `--milestone`,
`--limit N` (0 = unlimited).

### Structured queries (any team / assignee)

```bash
linear issue query --search "api v2" --search-comments
linear issue query --all-teams --state started --state unstarted --json
linear issue query --team ECO --cycle active --unassigned --json
linear issue query --assignee nathanfritz --updated-after 2026-06-01 --json
```

`query` is the flexible read: full-text `--search`, repeatable `--state` / `--team` /
`--label`, `--project`, `--milestone`, `--created-after` / `--updated-after`,
`--unassigned`, `--include-archived`, `--limit`, `--json`.

## Writing issues

Confirm first (see Ground rules).

```bash
# Create — title/team/etc. or interactive prompts; --no-interactive to script it
linear issue create -t "Fix packument caching" --team ECO -p 2 -l bug --start
linear issue create -t "Design doc" --description-file /tmp/desc.md --project "API v2 - GA Launch"

# Update an existing issue
linear issue update ECO-1443 -s "In Progress" -a self -p 1
linear issue update ECO-1443 --description-file /tmp/new-body.md

# State / assignment shortcuts
linear issue start ECO-1443                 # move to started + assign to self
linear issue update ECO-1443 -a self        # just assign to yourself
```

Common create/update flags: `-t/--title`, `-d/--description` or `--description-file`
(preferred for markdown), `-a/--assignee` (`self` or a name/username), `-s/--state`
(name or type), `-p/--priority` (1=urgent … 4=low), `-l/--label` (repeatable),
`--project`, `--milestone`, `--cycle` (name/number/`active`), `--estimate`,
`--due-date`, `--parent ECO-1200`.

### Comments, links, relations

```bash
linear issue comment list ECO-1443
linear issue comment add ECO-1443 -b "Deployed the fix, watching metrics."   # or --body-file for markdown
linear issue link ECO-1443 https://github.com/org/repo/pull/123
linear issue attach ECO-1443 ./screenshot.png
linear issue pr ECO-1443            # create a GitHub PR pre-filled with issue details
```

## Other resources

```bash
linear team list                    # teams;  members [teamKey]
linear project list                 # projects;  project view <id>
linear cycle list --team ECO        # cycles;  cycle view active
linear label list --team ECO
linear document list                # docs;  document view <id>
linear auth whoami                  # current user / workspace
```

Add `--workspace <slug>` to any command to target a non-default workspace.

## Raw GraphQL

For anything the subcommands don't cover, hit the API directly. This is what Nathan's
helper scripts use.

```bash
linear api "{ viewer { id name } }"
linear api --variable userId="$UID" \
  'query($userId: ID) { issues(filter: { assignee: { id: { eq: $userId } } }) { nodes { identifier title } } }'
linear api --paginate '{ issues(first: 100) { nodes { identifier } pageInfo { hasNextPage endCursor } } }'
linear schema                        # dump the full GraphQL schema
```

`--variable key=value` (coerces bool/number/null; `@file` reads from a path),
`--variables-json '{...}'`, `--paginate` (auto-cursor a single connection),
`--silent`. Output is JSON — pipe to `jq`.

## Related shell scripts

Nathan keeps two ready-made summaries in `~/.scripts/` (built on `linear api`):

- `linear-activity.sh [-d days] [-t team-key]` — cycles, assigned, and created issues
  for the current user over a window (default 1 day, team ECO).
- `linear-cycle-issues.sh [-t team-key] [-l limit]` — current-cycle issues that are
  unassigned or assigned to you, sorted by priority.

Prefer these when asked "what did I do" / "what's in the current cycle" — they emit
tidy markdown already. See also the [[notes]] skill for logging that work.
