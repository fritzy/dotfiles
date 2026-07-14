---
name: work-summary
description: "Summarize what Nathan has been working on over a period (default: last week) by pulling from ws, git/GitHub PRs, Linear tickets, and Slack discussions, formatted as a first-person bullet tree ready to paste into Slack or notes. Use when asked to summarize my work, write a weekly/standup update, recap what I did, or 'what have I been working on'. Trigger terms: work summary, weekly summary, what did I work on, recap my week, standup."
metadata:
  tags: work-summary, weekly, standup, ws, linear, slack, prs
---

# work-summary

Produce a terse, first-person recap of Nathan's recent work by combining four sources.
Default window is the last 7 days unless he specifies otherwise. Convert relative dates
to absolute before querying.

## Gather (run in parallel)

1. **Workstreams** — `mcp__ws__ws_list {all: true}`. This is the spine: each active
   workstream maps to a branch, a repo, and linked Linear/GitHub issues. Use it to
   discover which PRs and tickets to pull.
2. **PRs** — for the repos/branches ws surfaces:
   `gh pr view <num> --repo <owner/repo> --json title,state,createdAt,updatedAt,body`.
   Also `gh search prs --author=@me --updated ">=<date>"` to catch anything ws missed.
   Read the PR `body` for the real "what/why" — summarize from it, don't just restate the title.
3. **Tickets** — invoke the **[[linear]]** skill, which documents the `linear` CLI
   (authenticated as Nathan, default team ECO). Use it for:
   - `linear issue view <CODE>` on each issue ws links (title, state, description).
   - `bash ~/.scripts/linear-activity.sh -d <days> -t ECO` — cycles + assigned/created
     issues with state changes (moved to In Review, Canceled, etc.) over the window. This
     is the fastest "what did I do" read.
   - `bash ~/.scripts/linear-cycle-issues.sh -t ECO` — current-cycle issues assigned to
     him, for the forward-looking `Currently` bullet.
   - `linear issue query --json` for anything ad-hoc.
4. **Discussions** — the **Slack MCP** (`plugin_slack_slack`). Nathan's user id is
   `U0AK03QS2Q1`. Search his messages with
   `mcp__plugin_slack_slack__slack_search_public_and_private`, query
   `from:<@U0AK03QS2Q1> after:YYYY-MM-DD`, `sort: timestamp`. Use
   `slack_read_thread` to expand a thread when the search snippets aren't enough.
   Collapse each back-and-forth into one line about the *topic and his position*. Skip
   trivial one-word replies.

## Format

Output **raw markdown in a code block** so Nathan can edit and copy it. Not headings —
a **bullet tree**:

- Lead top-level bullets group by **day or day-range** (e.g. `**Monday and Tuesday**`),
  each with a short theme after an em-dash. Add sibling top-level bullets for standalone
  themes like **PR reviews for others** (reviewing others' PRs is real work — call it out).
  - Under each, sub-bullets for `PRs`, `Tickets`, `Discussions` (only those with content).
    - Leaf bullets are the individual items.
- End with a top-level **`Currently`** bullet: what's in-flight and what's next.

```markdown
- **Monday and Tuesday** — <one-line theme>
- Reviews of <person>'s <kind> PRs
- PRs (open, in review)
  - [repo#123](https://github.com/org/repo/pull/123) — what it does, briefly.
- Tickets
  - [ECO-1835](https://linear.app/chainguard/issue/ECO-1835) short title — state + one clause.
- Discussions
  - **Attestation/verify-tool coverage** — clarified X; suggested Y. (weave in who else raised it).
- Currently
  - Get feedback on the rebuilder-api PRs and iterate.
  - Coordinate API/architecture decisions between teams.
```

## Voice and conventions (learned from iteration — follow these)

- **First person**, but terse — clauses over sentences, no filler.
- **Link PRs and tickets**, don't bold them: `[repo#123](url)`, `[ECO-1835](url)`.
  - GitHub: `https://github.com/<owner>/<repo>/pull/<num>`.
  - Linear: `https://linear.app/chainguard/issue/<CODE>` (bare code URL resolves fine).
- **No PR line counts** (`+x/−y`) — Nathan strips them.
- **Soft language.** He "clarified" / "noted" / "suggested" / "gave opinion" / "floated"
  — not "explained" / "argued" / "proved". Don't overclaim certainty or authorship.
- Discussions: bold the **topic** as the lead (not the person), then the soft narration;
  weave attribution in-line ("Something Julian has raised too"). Keep only substantive
  threads — drop trivial handoffs and one-word exchanges.
- Name tools/commands precisely (`chainctl verify`, not "the verify tool").
- Include ticket state transitions (In Review, Canceled) — they show progress.

Offer to log the result to [[notes]] (weekly work log) or post it to Slack when done —
don't do either without being asked.
