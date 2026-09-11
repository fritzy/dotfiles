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

### 3. Get customer escalations

Run:

```bash
~/.scripts/customer-escalations.sh
```

Open issues in chainguard-dev/customer-issues that are labeled `eng:ecosystems:javascript` or that involve the current user (assigned, authored, commented, or mentioned).

### 4. Get onboarding issues

Run:

```bash
~/.scripts/libraries-onboarding.sh
```

Open issues in chainguard-dev/internal-dev labeled `libraries-onboarding-js` and assigned to the current user. This list is intentionally not capped — present every entry.

### 5. Present recommendations

Output four sections:

**Next up** — the output from linear-cycle-issues.sh should be currated to and prioritized by priority, impact, and low-hanging fruit. Include the Linear link at the end of each line.

**PRs to review** — list the output from pr-reviews.sh as-is.

**Customer escalations** — list the output from customer-escalations.sh as-is.

**Onboarding** — list the output from libraries-onboarding.sh as-is.

Keep the output concise. Do not editorialize — just present the data.
