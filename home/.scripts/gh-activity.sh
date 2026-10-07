#!/bin/bash

# gh-activity.sh [-d days] [-s YYYY-MM-DD]
#
# Uses the `gh` user's events feed to summarize cross-repo GitHub activity:
#   - Authored PRs: opened, pushed, commented, merged, closed
#   - Others' PRs: reviewed, commented, pushed, merged, closed
#   - Issues commented on, opened, or closed
#   - Pushes to branches with no PR
# Only PRs with activity by you in the window are listed, not ones others touched.
# The events feed stops at 300 events / 90 days; warns if the window reaches past that.

set -euo pipefail

DAYS=7
SINCE_DATE=""

while getopts "d:s:" opt; do
  case $opt in
    d) DAYS="$OPTARG" ;;
    s) SINCE_DATE="$OPTARG" ;;
    *) echo "Usage: $0 [-d days] [-s YYYY-MM-DD]" >&2; exit 1 ;;
  esac
done

ME=$(gh api user --jq '.login')
if [[ -z $SINCE_DATE ]]; then
  SINCE_DATE=$(date -d "-${DAYS} days" +%F 2>/dev/null || date -v-"${DAYS}"d +%F)
fi
# Local midnight; day buckets below are local too.
SINCE=$(date -d "$SINCE_DATE" +%s 2>/dev/null || date -j -f "%F %T" "$SINCE_DATE 00:00:00" +%s)
FEED_LIMIT=$(( $(date +%s) - 90 * 86400 ))

PR_FIELDS='fragment F on PullRequest {
  number url title state isDraft
  author { login }
  repository { nameWithOwner }
  headRefName
  headRepository { nameWithOwner }
}'

# Search query -> JSON array of PRs.
search_prs() {
  gh api graphql --paginate -f query='
    query($q: String!, $endCursor: String) {
      search(query: $q, type: ISSUE, first: 100, after: $endCursor) {
        pageInfo { hasNextPage endCursor }
        nodes { ... on PullRequest { ...F } }
      }
    }
  '"$PR_FIELDS" -f q="$1" --jq '.data.search.nodes[]' | jq -s '[.[] | select(.number)]'
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

gh api --paginate "/users/$ME/events?per_page=100" --jq '.[]' | jq -s . > "$tmp/raw.json"

read -r total oldest < <(jq -r '"\(length) \(map(.created_at | fromdate) | min // 0)"' "$tmp/raw.json")
if (( SINCE < FEED_LIMIT || (total >= 300 && oldest > SINCE) )); then
  echo "> WARNING: events feed caps at 90 days / 300 events (oldest returned: $(jq -nr "$oldest | todate")); earlier activity is missing." >&2
  echo "> Fill gaps with: gh search prs --author|--reviewed-by|--commenter=@me --updated \">=$SINCE_DATE\" --limit 100" >&2
fi

# Normalize to chronological {date, repo, action, kind: pr|issue|push, number|ref}.
# Payloads are slimmed (no PR title/author), so PR numbers come from URLs where needed.
jq --argjson since "$SINCE" '
  def prnum:
    .payload.number // .payload.issue.number // .payload.pull_request.number
    // ((.payload.review.pull_request_url // .payload.comment.pull_request_url // "")
        | try (capture("/pulls/(?<n>[0-9]+)$").n | tonumber) catch null);
  def is_pr:
    (.type != "IssueCommentEvent" and .type != "IssuesEvent")
    or .payload.issue.pull_request != null
    or ((.payload.issue.html_url // "") | test("/pull/"));
  [ reverse[] | select((.created_at | fromdate) >= $since)
    | (if .type == "PullRequestEvent" then
         (if .payload.action == "closed" and .payload.pull_request.merged == true then "merged" else .payload.action end)
       elif .type == "PullRequestReviewEvent" then "reviewed:" + (.payload.review.state // "?" | ascii_downcase)
       elif .type == "PullRequestReviewCommentEvent" then "review-commented"
       elif .type == "IssueCommentEvent" then "commented"
       elif .type == "IssuesEvent" then .payload.action
       elif .type == "PushEvent" then "pushed"
       else empty end) as $action
    | {date: (.created_at | fromdate | strflocaltime("%Y-%m-%d")), repo: .repo.name, action: $action}
      + if .type == "PushEvent" then {kind: "push", ref: (.payload.ref | sub("^refs/heads/"; ""))}
        elif is_pr then {kind: "pr", number: prnum}
        else {kind: "issue", number: prnum, title: .payload.issue.title} end
  ]
  | map(select(.kind != "push" or (.ref | test("^(main|master)$|^refs/tags/") | not)))
' "$tmp/raw.json" > "$tmp/events.json"

# Authored PRs updated in the window carry head refs for matching pushes.
search_prs "is:pr author:$ME updated:>=$SINCE_DATE" > "$tmp/authored.json"

# Fetch PRs from the feed that the authored search didn't return (others' PRs).
jq -r --slurpfile authored "$tmp/authored.json" --arg frag "$PR_FIELDS" '
  ($authored[0] | map("\(.repository.nameWithOwner)#\(.number)")) as $have
  | map(select(.kind == "pr" and .number != null) | {repo, number})
  | unique
  | map(select("\(.repo)#\(.number)" as $k | $have | any(. == $k) | not))
  | group_by(.repo)
  | if length == 0 then empty else
      "query { " + (to_entries | map(
        (.value[0].repo | split("/")) as [$o, $n]
        | "r\(.key): repository(owner: \"\($o)\", name: \"\($n)\") { "
          + (.value | map("p\(.number): pullRequest(number: \(.number)) { ...F }") | join(" ")) + " }"
      ) | join(" ")) + " } " + $frag
    end
' "$tmp/events.json" > "$tmp/others.graphql"

if [[ -s $tmp/others.graphql ]]; then
  gh api graphql -f query="$(cat "$tmp/others.graphql")" --jq '[.data[] | values | .[] | values]' > "$tmp/others.json" || echo '[]' > "$tmp/others.json"
else
  echo '[]' > "$tmp/others.json"
fi

# Pushes to branches not yet matched to a PR (e.g. someone else's PR): look up by head ref.
jq -s 'add' "$tmp/authored.json" "$tmp/others.json" > "$tmp/prs.json"
jq -r --slurpfile prs "$tmp/prs.json" '
  map(select(.kind == "push")) | unique_by([.repo, .ref])[]
  | select(. as $p | $prs[0] | any(.headRepository.nameWithOwner == $p.repo and .headRefName == $p.ref) | not)
  | "\(.repo)\t\(.ref)"
' "$tmp/events.json" | while IFS=$'\t' read -r repo ref; do
  search_prs "is:pr head:$ref" | jq --arg repo "$repo" 'map(select(.headRepository.nameWithOwner == $repo))'
done | jq -s 'add // []' > "$tmp/pushed.json"

jq -s 'add | unique_by(.url)' "$tmp/prs.json" "$tmp/pushed.json" > "$tmp/all-prs.json"

jq -r --arg me "$ME" --arg since "$SINCE_DATE" --slurpfile prs "$tmp/all-prs.json" '
  def acts:
    group_by(.date)
    | map("\(.[0].date[5:]): " + (reduce (.[].action) as $a ([]; if any(.[]; . == $a) then . else . + [$a] end) | join(", ")))
    | join("; ");
  def state: if .isDraft and .state == "OPEN" then "draft" else (.state | ascii_downcase) end;
  def matches($p):
    (.kind == "pr" and .repo == $p.repository.nameWithOwner and .number == $p.number)
    or (.kind == "push" and .repo == ($p.headRepository.nameWithOwner // "") and .ref == $p.headRefName);
  def section($title; $lines): if ($lines | length) > 0 then "", "### \($title)", $lines[] else empty end;
  . as $ev
  | [ $prs[0][] | . as $p
      | ($ev | map(select(matches($p)))) as $mine
      | select($mine | length > 0)
      | $p + {first: ($mine | map(.date) | min), acts: ($mine | acts)}
    ] | sort_by(.first) as $rows
  | def line: "- [\(.repository.nameWithOwner)#\(.number)](\(.url)) \(.title) — \(state)"
      + (if .author.login != $me then ", @\(.author.login // "ghost")" else "" end) + " — \(.acts)";
  "## GitHub activity for \($me) since \($since)",
  section("Authored PRs"; [$rows[] | select(.author.login == $me) | line]),
  section("Others'"'"' PRs"; [$rows[] | select(.author.login != $me) | line]),
  section("Issues"; [$ev | map(select(.kind == "issue")) | group_by([.repo, .number])[]
    | "- [\(.[0].repo)#\(.[0].number)](https://github.com/\(.[0].repo)/issues/\(.[0].number)) \(map(.title // empty)[0] // "") — \(acts)"]),
  section("Pushes without a PR"; [$ev | map(select(.kind == "push") | . as $e
      | select($prs[0] | any(. as $p | $e | matches($p)) | not))
    | group_by([.repo, .ref])[] | "- \(.[0].repo) `\(.[0].ref)` — \(map(.date[5:]) | unique | join(", "))"])
' "$tmp/events.json"
