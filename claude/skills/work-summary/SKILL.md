---
name: work-summary
description: "Summarize what Nathan has been working on over a period (default: last week) by pulling from fw, git/GitHub PRs, Linear tickets, and Slack discussions, formatted as a first-person bullet tree ready to paste into Slack or notes. Use when asked to summarize my work, write a weekly/standup update, recap what I did, or 'what have I been working on'. Trigger terms: work summary, weekly summary, what did I work on, recap my week, standup."
metadata:
  tags: work-summary, weekly, standup, fw, linear, slack, prs
---

# work-summary

Produce a terse, first-person recap of Nathan's recent work by combining four sources.
Default window is the last 7 days unless he specifies otherwise. Convert relative dates
to absolute before querying.

## Window

- **Standups start where the last one stopped.** `bash ~/.scripts/standup-log.sh last`
  prints the last recorded post's cutoff (UTC ISO). Pass it as `-S "$CUTOFF"` to both
  activity scripts so late-evening work after a post isn't lost or repeated. If nothing
  is recorded, use the requested day (today, or yesterday through now in the morning).
- If the cutoff is older than the previous workday (a skipped day), cover every day since
  and group by day.
- Note the time gathering starts. It becomes this post's cutoff when you record it.
- Before drafting, re-run both scripts if time has passed since the first gather;
  Nathan often keeps working while the draft is out.

## Gather (run in parallel)

1. **Workstreams** — the spine for day grouping and themes. Work runs on more than one
   fw daemon (`local` and `workstation`); query every one.
   - `mcp__fw__fw_daemons` → daemon ids.
   - Per daemon, `mcp__fw__fw_digest {daemon, date}` for each day in the window: that
     day's commits per workstream (repo, branch), work-log notes, and linked issues.
     Commit subjects ending in `(#NNNNN)` are merges from main, not his work that day.
   - Per daemon, `mcp__fw__fw_list {daemon}` for workstream branches and linked issues.
     Don't pass `all: true` — closed workstreams overflow the tool output limit.
   - Linked GitHub refs are often context (a parent PR, someone else's PR), not Nathan's
     PRs. Some repos show as `local/<name>-<hash>` (e.g. stereo); match to GitHub by branch.
2. **PRs** — `bash ~/.scripts/gh-activity.sh -S "$CUTOFF"` (or `-s <YYYY-MM-DD>`,
   `-d <days>`; `-u` ends the window). Across all repos: authored PRs, others' PRs he
   reviewed, commented on, pushed to, merged, or closed, plus pushes with no PR — each
   with dated actions. It merges the events feed with each PR's timeline, so merges,
   ready-for-review, and draft changes the feed drops are included; no manual timeline
   or gap-fill searches needed. Only PRs he acted on count. This is the PR list — fw
   only supplies grouping.
   - Others' PRs he only pushed commits to or merged (handoffs) are found through PRs
     attached to his Linear issues; the feed drops pushes to other people's forks and
     GitHub search can't match commit authors. If an fw workstream sits on someone
     else's branch (e.g. `dannfrazier/...`) or links someone else's PR and the script
     didn't list it, re-run with `-b <branch>` or `-p owner/repo#N` (both repeatable).
   - Add `-j` for state, `reviewDecision`, reviewers (with `bot` flags), requested
     reviewers, `base`, `mergedBy`, +/- lines, and Linear refs from title/body/branch.
   - Then `gh pr view <num> --repo <owner/repo> --json body` per PR. Read the body for
     the real "what/why" — summarize from it, don't just restate the title. For his
     replies to review threads, read his review comments (`gh api .../pulls/<n>/comments`).
   - Match PRs to fw workstreams by head branch to place them under the right day/theme.
   - **Blockers:** `gh search prs --owner chainguard-dev --author=@me --state open --json repository,number,isDraft,url`,
     then `gh pr view <num> --repo <repo> --json reviewDecision,reviewRequests,baseRefName`.
     A blocker is a non-draft PR whose `reviewDecision` isn't `APPROVED`. Note requested
     reviewers (or "No reviewer assigned yet"), stacking (`baseRefName` is another of his
     branches, or someone else's PR), and the tickets it blocks. When the hold-up is his
     own rework (a reviewer asked for a rebase), say so and ask whether it belongs in
     Blockers.
3. **Tickets** — invoke the **[[linear]]** skill, which documents the `linear` CLI
   (authenticated as Nathan, default team ECO). Use it for:
   - `bash ~/.scripts/linear-activity.sh -S "$CUTOFF"` — all teams (ECO, BLD, SCM, ...)
     by default. Sections: Filed; Mine (net state change, assignment, team, project and
     milestone moves); On tickets I filed (others); Other issues I changed. Each change
     names who made it: `me`, `automation` (GitHub integration, Linear workflows), or a
     person. `-j` for JSON, `-v` to show churn that netted out, `-a` for open assigned.
   - `linear issue view <CODE>` on each issue fw links or a PR references.
   - `bash ~/.scripts/linear-cycle-issues.sh -t ECO` — current-cycle issues assigned to
     him, for the forward-looking `Next` bullet. Check the assignee before listing a
     ticket under Next; tickets he filed are often assigned to others.
   - `linear issue query --json` for anything ad-hoc.
4. **Discussions** — the **Slack MCP** (`plugin_slack_slack`). Skip when the request is
   PRs and issues only (the scheduled standup). Nathan's user id is `U0AK03QS2Q1`.
   Search his messages with `mcp__plugin_slack_slack__slack_search_public_and_private`,
   query `from:<@U0AK03QS2Q1> after:YYYY-MM-DD`, `sort: timestamp`. Use
   `slack_read_thread` to expand a thread when the search snippets aren't enough.
   Collapse each back-and-forth into one line about the *topic and his position*. Skip
   trivial one-word replies.

## Format

Output **raw markdown in a code block** so Nathan can edit and copy it. Not headings —
a **bullet tree**:

- Lead top-level bullets group by **day or day-range** (e.g. `**Monday and Tuesday**`),
  each with a short theme after an em-dash. Add sibling top-level bullets for standalone
  themes like **PR reviews for others** (reviewing others' PRs is real work — call it out;
  source it from the `Others' PRs` section of `gh-activity.sh`).
  - Under each, sub-bullets for `PRs`, `Tickets`, `Discussions` (only those with content).
    - Leaf bullets are the individual items.
- End with a top-level **`Blockers — need review`** bullet (omit if there are none), then
  **`Next`**: tickets in flight or up next. No `Currently` bullet.

```markdown
- **Monday and Tuesday** — <one-line theme>
- Reviews of <person>'s <kind> PRs
- PRs
  - merged :pr-merged: [repo#123](https://github.com/org/repo/pull/123) — what it does, briefly.
  - opened :pr: [repo#124](https://github.com/org/repo/pull/124) — what it does, awaiting review.
  - [repo#125](https://github.com/org/repo/pull/125) out of draft, approved by <reviewers> — what it does.
- Tickets
  - [ECO-1835](https://linear.app/chainguard/issue/ECO-1835) short title — state + one clause.
  - On tickets I filed: <person> closed [ECO-1840](https://linear.app/chainguard/issue/ECO-1840) (<topic>).
- Discussions
  - **Attestation/verify-tool coverage** — clarified X; suggested Y. (weave in who else raised it).
- **Blockers** — need review
  - :pr: [repo#124](https://github.com/org/repo/pull/124) — what it is; blocks ECO-1836. Requested: <reviewers>.
- **Next**
  - [ECO-1837](https://linear.app/chainguard/issue/ECO-1837) — short description.
```

## Voice and conventions (learned from iteration — follow these)

- **First person**, but terse — clauses over sentences, no filler.
- **Link PRs and tickets**, don't bold them: `[repo#123](url)`, `[ECO-1835](url)`.
  - GitHub: `https://github.com/<owner>/<repo>/pull/<num>`.
  - Linear: `https://linear.app/chainguard/issue/<CODE>` (bare code URL resolves fine).
- **PR emoji** (custom workspace emoji), directly before the link:
  `:pr-merged:` on every PR he merged, `:pr:` on every PR of his awaiting review (body and
  Blockers). None on drafts, others' PRs, or approved PRs waiting to merge — say
  "approved by <reviewers>" instead.
- **No PR line counts** (`+x/−y`) — Nathan strips them.
- **Soft language.** He "clarified" / "noted" / "suggested" / "gave opinion" / "floated"
  — not "explained" / "argued" / "proved". Don't overclaim certainty or authorship.
- **Name teammates, don't guess pronouns.** Use the name or they/them.
- Discussions: bold the **topic** as the lead (not the person), then the soft narration;
  weave attribution in-line ("Something Julian has raised too"). Keep only substantive
  threads — drop trivial handoffs and one-word exchanges.
- Name tools/commands precisely (`chainctl verify`, not "the verify tool").
- Include ticket state transitions (In Review, Canceled) — they show progress.
- **Net state only.** Don't narrate churn (e.g. closed then reopened in the same window).
  If a ticket's net state is unchanged, leave it out of the transitions and the stats.
- **Attribution.**
  - `automation` changes are integration moves (e.g. a PR leaving draft moves its ticket
    to In Progress). Say "auto-moved when ..." rather than implying Nathan moved it.
  - Changes others made to tickets he filed go on one "On tickets I filed: <person> ..."
    line, never as his work. Offer to drop the line.
  - Bot reviewers (`bot: true` in `gh-activity.sh -j`: `chainguard-review`,
    `approver-doc-driven`, `depthfirst-app`) don't count as reviewers or approvals. Ask
    when an account looks automated but isn't flagged (e.g. `mandel-chain`); extend
    `GH_ACTIVITY_BOTS` if he confirms.
- **Flag, don't fix, ticket state.** If a ticket stays open after its PR merged, or
  automation moved it backward, ask Nathan whether to change it. Never write to Linear
  without his go-ahead.
- **Reviews** of others' PRs get their own sub-section. Ask Nathan which he did manually;
  tag those "Personally (human) reviewed". Leave the rest untagged.

## Posting

Offer to log the result to [[notes]] (weekly work log) or post it to Slack when done —
don't do either without being asked, and confirm the exact text first.

- **Standup:** #eng-ecosystems-standup (`C08AW1DU4G4`). One message under 5,000 chars
  (check with `wc -m`); group related PRs on one line rather than splitting.
- **Stats reply:** reply in the standup thread with stats for the window. Omit any stat
  at 0. Save the draft to a file and run `bash ~/.scripts/standup-count.sh -v draft.md`
  so totals match the post: PRs count across the body (Blockers and Next excluded);
  issues count from the `Tickets` sub-sections, with issues linked only from PR lines as
  "N more linked to PRs".

  ```markdown
  **Stats (10/7)**
  - **PRs:** 10 unique (6 mine, 4 reviewed)
    - 1 opened, 2 pushed, 5 merged
    - 1 open for review, 1 draft
    - Reviews: 3 approved (2 human-reviewed), 1 changes requested
  - **Issues:** 9 unique
    - 1 filed
    - 6 closed: 5 → Done, 1 → Canceled
    - 1 → In Review, 1 → In Progress
  ```
- **Blockers to the team:** if there are blockers, after the standup post goes out, post
  just the Blockers section (emoji and links intact) to #team-ixians (`C0C0SMX07CP`),
  then reply in that thread with `Full Status: <standup message link>`. Skip when there are
  no blockers. Say so when asking for approval, so one approval covers both posts.
- **Record the post** once every post has succeeded, so the next run starts at its cutoff:

  ```bash
  bash ~/.scripts/standup-log.sh record <<'EOF'
  {"date":"2026-10-14","cutoff":"<gather start, UTC ISO>","permalink":"<standup link>",
   "stats":{"prs":{"unique":7,"mine":6,"others":1,"opened":1,"pushed":2,"merged":3,
                   "ready_for_review":3,"open_for_review":1,"draft":1},
            "reviews":{"approved":0,"human_reviewed":0,"changes_requested":0,"commented":0},
            "issues":{"unique":9,"filed":1,"done":0,"canceled":0,"in_review":0,
                      "in_progress":5,"moved_project":0,"linked":3},
            "others_on_my_tickets":{"done":0,"in_progress":0,"todo":0}}}
  EOF
  ```

  Use the stats reply's numbers; zeros may be left out. `date` is the day the post
  covers; a post spanning several days also sets `window_start`. Re-recording a date
  replaces it.
- **Scheduled runs (FritzWorks):** complete the run only after every post and the
  record succeed — never in the same tool batch as a post. If a post is denied or fails,
  report it and leave the run open.

## Weekly totals

- `bash ~/.scripts/standup-log.sh week [-s YYYY-MM-DD] [-u YYYY-MM-DD]` sums the recorded
  stats (default: Monday through today). Unique counts add across days, so repeats
  count again; open-for-review and draft show per post.
- Lines of code: save the week's standup posts (`slack_read_channel` on
  `C08AW1DU4G4`, his messages only) to a file and run `bash ~/.scripts/pr-stats.sh -m <file>`
  for per-PR and total +/- on the merged PRs. `-j` for JSON.
