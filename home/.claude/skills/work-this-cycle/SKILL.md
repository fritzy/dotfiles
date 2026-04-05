# work-this-cycle

Show what to work on next: candidate issues from the current Linear cycle and PRs needing review.

## Steps

### 1. Get current cycle issues

Run:

```bash
~/.scripts/linear-cycle-issues.sh
```

### 2. Get PRs needing review

Run:

```bash
~/.scripts/pr-reviews.sh
```

If there is no git repo in the current directory, it will fail — in that case skip this step silently.

### 3. Present recommendations

Output two sections:

**Next up** — the output from linear-cycle-issues.sh should be currated to and prioritized by priority, impact, and low-hanging fruit. Include the Linear link at the end of each line.

**PRs to review** — list the output from pr-reviews.sh as-is.

Keep the output concise. Do not editorialize — just present the data.
