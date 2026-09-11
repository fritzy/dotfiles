---
name: notes
description: "Read and update Nathan's personal notes — weekly work logs and journal — under ~/notes. Use when asked to log work, record what was done, add to this week's notes, start a new week, check what happened on a day/week, or summarize recent work. Trigger terms include: my notes, work notes, log this, weekly note, journal, what did I do this week."
metadata:
  tags: notes, journal, work-log, weekly, ~/notes
---

# notes

Nathan's personal notes live in the git repo at `~/notes/`, split into two trees:

```
~/notes/
  work/<YYYY>/<YYYY-MM-DD>-week.md      # running record of work done each day
  journal/<YYYY>/<YYYY-MM-DD>-week.md   # personal journal, same weekly layout
```

`<YYYY-MM-DD>` is the **Monday** that starts the week (e.g. work done on Thu 2026-06-25
goes in `~/notes/work/2026/2026-06-22-week.md`). It's a git repo — commit when asked,
not automatically.

> Older files may use a compact `<YYYYMMDD>-week.md` name (no dashes). When creating a
> new week's file, use the dashed `<YYYY-MM-DD>-week.md` form.

## Work notes

A running record of what was accomplished each day. Keep them updated as work completes
— especially when a `ws` workstream finishes a chunk of work (see the **ws** skill).

**Structure:** one section per weekday, items as checked bullets with nested links and
follow-ups:

```markdown
## Monday, June 22nd, 2026

## Tuesday, June 23rd, 2026

- [x] Short summary of what was done
    - https://link.to/slack-thread-or-pr-or-issue
    - [ ] follow-up still to do
- [x] Another item
```

**To log work:**
1. Find (or create) the current week's file under `~/notes/work/<YYYY>/`.
2. Find the `## <Weekday>, <Month> <Day><ord>, <Year>` heading for the day (create it if
   missing — note the ordinal suffix: `22nd`, `23rd`, `25th`), and append a `- [x]`
   bullet summarizing what was done.
3. Nest supporting links (Slack threads, PRs, Linear/GitHub issues) and any `- [ ]`
   follow-ups indented beneath the item.

When logging work tied to a `ws` workstream, reference its linked issues — `ws issue
list` (from inside the worktree) gives the Linear/GitHub links to drop under the day's
entry.

## Journal

Personal (non-work) journal under `~/notes/journal/<YYYY>/`, using the same Monday-based
weekly file and per-weekday heading layout as work notes. Entries are free-form rather
than the `- [x]` task style.

## Reading notes

To answer "what did I do this/last week" or "what happened on <day>", open the relevant
week file(s) and read the matching weekday section(s). To summarize a span longer than a
week, read each week's file in the range.
