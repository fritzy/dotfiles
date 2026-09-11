---
name: slack-pr-reviews
description: "Given a Slack message that lists GitHub PRs (asking Nathan to review them), open each PR in the browser to review, then — when prompted — build a bulleted list annotating how he reviewed each one (:green-circle-check: / :approved-with-comments: / :request-changes:) and reply in the Slack thread. Use when asked to 'review the PRs in this slack message', 'react to the PR list', 'reply with my review status', or given a Slack permalink full of PR links. Trigger terms: slack pr reviews, react to PRs, review status reply, PR review reactions."
metadata:
  tags: slack, github, pr-review, reactions, gh
---

# slack-pr-reviews

Nathan gets Slack messages (often from teammates) that list several GitHub PRs and ask
him to review. This skill drives that end-to-end: open the PRs so he can review, then
reply in-thread with a per-PR reaction annotation reflecting how he reviewed each one.

## Inputs

A Slack message reference — usually a permalink like
`https://<workspace>.slack.com/archives/<CHANNEL_ID>/p<TS>`. Convert the permalink `p`
timestamp to `ts` form by inserting a decimal 6 digits from the end:
`p1782910558187389` → `1782910558.187389`. Then read it with
`mcp__plugin_slack_slack__slack_read_thread {channel_id, message_ts}` (falls back to
`slack_read_channel` if it's not a thread parent).

Extract every GitHub PR URL from the message body (and thread replies). Each maps to
`owner/repo` + PR number.

## Step 1 — Open PRs in the browser (do this first)

Open each PR so Nathan can review it, in the order listed in the message:

```bash
for url in <pr-urls>; do xdg-open "$url"; done
```

Then **stop and wait**. Tell him the PRs are open and you'll build the reply once he's
reviewed them. Do not fetch review state yet — he hasn't reviewed.

He may also ask to open a specific PR (or re-open one) at any point — just `xdg-open`
that URL.

## Step 2 — Build the reply (only when prompted)

When Nathan says he's done / asks for the reply, determine his review state per PR. His
GitHub login is `fritzy`.

For each PR:

```bash
gh pr view <num> --repo <owner/repo> --json reviews \
  --jq '.reviews[] | select(.author.login=="fritzy") | "state=\(.state) bodylen=\(.body|length)"'
gh api repos/<owner/repo>/pulls/<num>/comments \
  --jq '[.[] | select(.user.login=="fritzy")] | length'
```

Map state → reaction:

- `CHANGES_REQUESTED` → `:request-changes:`
- `APPROVED` **with** a non-empty review body OR any inline comments → `:approved-with-comments:`
- `APPROVED` clean (empty body, zero inline comments) → `:green-circle-check:`
- **No review by `fritzy`** → flag it as ⚠️ not-reviewed; don't invent a reaction. Nathan
  may still need to review it, so call it out rather than silently dropping it.

## Step 3 — Format

Raw markdown, one bullet per PR, **in the order the message listed them**, reaction on
the left, PR as a markdown link on the right:

```markdown
- :green-circle-check: [repo-name#1366](https://github.com/owner/repo-name/pull/1366)
- :request-changes: [repo-name#1362](https://github.com/owner/repo-name/pull/1362)
- :approved-with-comments: [repo-name#1364](https://github.com/owner/repo-name/pull/1364)
```

Use the bare repo name (e.g. `ecosystems-rebuilder.js`), not the full `owner/repo`.

## Step 4 — Reply in the thread (only when asked)

Post the list as a reply in the same Slack thread with
`mcp__plugin_slack_slack__slack_send_message {channel_id, thread_ts: <parent ts>, text}`.
**Don't post without being asked** — show him the output first and confirm.

Also react to the **original (parent) message** with each distinct reaction used in the
list — one `mcp__plugin_slack_slack__slack_add_reaction {channel_id, timestamp: <parent ts>, name}`
per unique emoji (`name` without the surrounding colons, e.g. `green-circle-check`,
`approved-with-comments`, `request-changes`). Only the distinct set, not one per PR.
