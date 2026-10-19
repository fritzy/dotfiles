---
name: work-report
description: "Script-generate a self-contained HTML work report for Nathan over a date range (default: Monday of last week through yesterday) from GitHub PRs, Linear tickets and #eng-ecosystems-standup posts — KPI tiles, a pie of authored PRs by workstream, a stacked daily PR-activity chart (inline SVG, light/dark, hover tooltips), highlights, and collapsible detail sections — plus a PNG screenshot for Slack, drafted to Nathan's self-DM for approval before it goes to his manager (bdmurray) and skip (Dan Ryan). Use when asked for a work report, an HTML/visual report of recent work, a report with graphs, or to send such a report to someone. Trigger terms: work report, html report, two-week report, report with charts, report for my manager."
metadata:
  tags: work-report, html, charts, svg, github, linear, slack
---

# work-report

The draft is **fully scripted**: `scripts/draft.sh` gathers data with the
**[[work-summary]]** scripts (`~/.scripts/gh-activity.sh -j`,
`~/.scripts/linear-activity.sh -j`, the `standup-log.sh` post log), drafts
`content.json`, builds the HTML and screenshots it. Don't hand-write the report.
Your job is to run it, check it, run the Slack draft/approval flow, and make edits
Nathan asks for. `example/` holds a hand-refined report and its `content.json`;
use it as a reference when he asks for richer prose.

## Draft

```bash
bash ~/.claude/skills/work-report/scripts/draft.sh            # Monday of last week → yesterday
bash ~/.claude/skills/work-report/scripts/draft.sh -s 2026-10-05 -u 2026-10-15
bash ~/.claude/skills/work-report/scripts/draft.sh -c ~/.claude/skills/work-report/people/malachid.json
```

- Writes `~/notes/work/<year>/work-report-<start>-<end>-<login>.html` (`-o` to override).
  Working files (`gh.json`, `linear.json`, `content.json`, `summary.png`) go in
  `~/.local/state/work-report/<start>/`.
- A re-run gathers fresh data but **keeps an existing `content.json`**, so edits
  survive. `-f` redrafts it; `-n` rebuilds from cached data without gathering.
- **Today is excluded** unless Nathan asks for it (`-u <today>`): a partial day
  drags the velocity averages down, especially in the morning.
- Days are Pacific time and run **4 AM → 4 AM**, so after-midnight work counts for
  the night it started — except **Monday, which runs 6 PM Sunday → 4 AM Tuesday**
  (Sunday-night work counts toward the week; Sunday is 4 AM–6 PM). Settings:
  `config.json` `day_start_hour`, `monday_start_sunday_hour`; logic in
  `scripts/days.py`, which all scripts and the gather window use. "Today" is the
  day in progress (before 4 AM, still yesterday).
- **A teammate's report** ("but for Malachi"): `-c people/<login>.json`, a copy of
  `config.json` with that `author` (plus `author.linear`, their Linear email),
  `filed_label` ("On tickets Malachi filed"), their own `workstreams` and
  `project_aliases`, and no `standup_channel`. The gather runs as them
  (`gh-activity.sh -U/-L`, `linear-activity.sh -U`); working files go in
  `<start>-<login>/`. Pronouns:
  use the ones in their Slack profile, otherwise they/them. Configs so far:
  `malachid`.
- If Nathan says days before a Monday had no work, start on that Monday and report
  what falls out (PRs opened, ticket moves).
- Fix every `warning:` before sharing. An unassigned PR lands in Other; if it
  belongs to a stream, add a rule to `config.json` (see below).
- Read `summary.png` and look at it: label collisions, wrapping, empty sections.
  `scripts/screenshot.py --expanded <html> <png>` captures the whole page.

What the script drafts:

- **Workstreams:** `config.json` rules first (match on the primary ticket's Linear
  project, linked ticket teams, commit scope, repo or title regex; first rule wins),
  then the Linear project or commit scope. Rule streams take the four slots, the
  largest auto groups fill the rest, and the remainder folds into Other.
  Summaries are factual counts plus the Done tickets each stream owns.
- **Highlights:** milestone tickets done (`config.milestone.title`, default
  `^Phase demo`), then per-stream merged/done/open counts. Done tickets with no PR
  (labeling, parks, validations) don't reach the highlights on their own; add them
  as count bullets when they're a large share of the Done list.
- **Linear, open PRs:** computed by `build_report.py` from the data.
- **On tickets I filed:** others' net changes; automation moves are credited to
  the ticket's assignee and marked "auto-moved", never to Nathan.
- **Standup log:** one row per post recorded in `standup-log.sh`, with its stats and
  permalink.
- **Next:** In Progress issues assigned to Nathan, by priority.

## Editing

When Nathan asks for changes, edit `~/.local/state/work-report/<start>/content.json`,
then `draft.sh -s <start> -n` to rebuild and re-screenshot. Durable changes
(workstream grouping, names, the milestone pattern, author/team) belong in
`~/dotfiles/claude/skills/work-report/config.json`; re-sync the skill afterwards
(`bootstrap.sh`, or copy the directory to `~/.claude/skills/`).

| content.json key | Purpose |
|---|---|
| `workstreams[]` / `other` | `name`, `sub`, `prs` (`repo#num`, short names from `repo_aliases`), `summary` HTML. ≤4 named. |
| `highlights[]` | `<b>lead</b> — detail` bullets. |
| `tiles[]` | Extra KPI tiles. |
| `on_my_filed[]`, `standups[]`, `next[]` | Lists; standups take `label`, `url` or `ts`, `summary`. |
| `open_notes{}` | Replacement text for an open PR in Needs review / Approved. |

In prose, `[[ECO-1234]]` becomes a Linear link and `[[mono#123]]` a PR link. Prose
is inserted as HTML — escape `<` and `&`.

Only if Nathan asks for richer prose: pull his standup posts
(`slack_search_public_and_private`, `from:<@U0AK03QS2Q1> in:<#C08AW1DU4G4>
after:<day before start>`, `sort: timestamp`) and `gh pr view` bodies, then
rewrite summaries, highlights and standup lines in [[work-summary]]'s voice:
first person, soft language, teammates by name (they/them, never guessed
pronouns), **no PR line counts**.

**Never include personal notes.** `~/notes` weekly files can hold private
journal-style entries; nothing from them goes in a report.

## Design decisions (don't regress)

Learned from iterating with Nathan; the builder already does these:

- Hero tile gives **PRs authored and PRs merged equal weight**, with a segmented
  state bar (merged / approved / in review / draft / closed) under them.
- **Velocity** tile beside the hero: PRs touched and PRs merged per day (sum over
  active days ÷ active days; days with no authored-PR activity are excluded) and
  per week (per-day × 5). Same per-day buckets as the daily chart.
- Section order: tiles (hero + velocity, then the small tiles) → **Where the work went** (pie + daily chart) →
  **Highlights** → a "Hide details" toggle, **open by default**, wrapping
  Workstreams, Linear, Standup log (when there are posts), Open now & next.
- **No reviews** of teammates' PRs anywhere: no tile, section or highlight. The
  gather runs `gh-activity.sh -A` (authored PRs only), which also keeps heavy
  reviewers' gathers fast.
- Pie: authored PRs by workstream, legend with count and %.
- Daily chart: **stacked** columns of authored PRs touched per day — created,
  updated (pushes or ready-for-review), merged — each PR counted once per day by
  furthest step so the cap number is "PRs touched". Uses the `days.py` day rules.
- Colors: categorical slots s1–s4 + gray for workstreams; one-hue blue ordinal ramp
  for PR state/activity (merged darkest). Validated with the **dataviz** skill's
  `validate_palette.js`; re-run it if colors change.
- The tooltip element lives inside `.viz-root`, or its CSS variables don't resolve
  and the background goes transparent.

## Sharing on Slack: draft, approve, send

Slack shows `.html` uploads as source, so every send is **the PNG screenshot
first, then the HTML** ("open in browser").

| Recipient | User | DM channel |
|---|---|---|
| Nathan (self-DM, drafts) | `U0AK03QS2Q1` | `D0AJZUUR7PB` |
| Brian Murray (`bdmurray`, manager) | `U07LBD7F4UT` | `D0B3HQ9SWCD` |
| Dan Ryan (skip) | `U089Q2JE6EL` | `D0AKD3P6K46` |

If a channel id fails, look it up again with `slack_list_user_channels types=im`.

1. **Draft to self-DM.** Once `draft.sh` runs without warnings and the PNG has been checked,
   send both files to `D0AJZUUR7PB` without asking first. Titles end in
   `(draft)` and match the HTML `<title>`: `Work report · Oct 5–15, 2026 · <author name>`,
   e.g. `Work report · Oct 5–15, 2026 · Nathan Fritz (summary, draft)`. Upload the PNG
   as `work-report-<start>-<end>-<login>.png`.
2. **Stop and ask for approval** in the conversation: link the two draft files and
   name the final recipients (Brian Murray and Dan Ryan by default). Don't
   treat a missing reply, a Slack reaction or the draft upload itself as approval.
3. **Changes requested:** edit `content.json` (see Editing), `draft.sh -s <start> -n`,
   send a new draft, and ask again.
4. **Approved:** send the same two files to each recipient's DM, dropping
   `(draft)` from the titles. Send only to the recipients Nathan approved; if he
   adds or removes people, follow that.
5. Report the file links per recipient.

Upload mechanics:

- Per file: `slack_get_file_upload_url` → `curl -X POST "$URL" --data-binary @file`
  (URL in a shell variable, byte-exact) → `slack_complete_file_upload` with the DM
  channel id and a title. Give the PNG `alt_txt`.
- A completed upload can't be re-shared; upload again for each recipient.
- No `initial_comment` unless Nathan supplies the text; use his wording exactly.
- Scheduled or unattended runs stop after step 2, leaving the final send for Nathan
  to approve.
