---
name: mergeable-prs
description: "List Nathan's open GitHub PRs that can be merged right now (approved, required checks green, no conflicts), or with -a every open PR he authored and what blocks it. Use when asked which of my PRs are ready to merge, what I can merge, what's blocking my PRs, or to merge my ready PRs. Trigger terms: mergeable PRs, ready to merge, what can I merge, PRs ready, blocked PRs, merge my PRs."
---

# mergeable-prs

```bash
bash ~/.claude/skills/mergeable-prs/scripts/mergeable-prs.sh              # mergeable only
bash ~/.claude/skills/mergeable-prs/scripts/mergeable-prs.sh -a           # all, with blockers
bash ~/.claude/skills/mergeable-prs/scripts/mergeable-prs.sh -q org:chainguard-dev -j
```

- Scope: open, non-draft PRs authored by the `gh` user (`author:@me`). `-q` adds
  search qualifiers (`repo:owner/name`, `org:…`, `label:…`).
- "Mergeable" is GitHub's merge state: `clean` or `has hooks`, or `unstable`
  (only non-required checks failing; noted). `behind` and `blocked` are not.
- Notes list what's in the way: conflicts, behind base, review needed or changes
  requested, failing or pending checks, unresolved threads. `blocked` with no
  visible cause means a protection rule (CODEOWNERS, ruleset) the API doesn't
  expose; check the PR page.
- PRs already in a merge queue or with auto-merge on are marked; they need nothing.
- Unknown merge state after retries means GitHub hasn't computed it yet; rerun.

Report the table as-is. Merging is outward-facing: only run `gh pr merge` when
Nathan asks, and confirm the list first. Pass the method explicitly (non-interactive
`gh pr merge` requires one); see what the repo allows with
`gh repo view <repo> --json squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed`.

Source is `~/dotfiles/claude/skills/mergeable-prs/`; `bootstrap.sh` copies it to
`~/.claude/skills/`. Edit there, then re-sync.
