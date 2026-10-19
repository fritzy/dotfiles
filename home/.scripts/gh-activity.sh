#!/bin/bash

# gh-activity.sh [-d days | -s YYYY-MM-DD | -S timestamp] [-u until] [-p PR]... [-b branch]... [-U login [-L linear-user]] [-A] [-j]
#
# Summarizes your cross-repo GitHub activity in a window:
#   - Authored PRs: opened, pushed, ready for review, to draft, commented, merged, closed
#   - Others' PRs: reviewed, commented, pushed (your commits), merged, closed
#   - Issues commented on, opened, or closed
#   - Pushes to branches with no PR
# Only PRs with activity by you in the window are listed, not ones others touched.
#
# Actions come from the user events feed and from each candidate PR's timeline. The feed
# lags, caps at 300 events / 90 days, misses some merges, and omits pushes to other
# people's forks; the timeline fills those in. Candidates are:
#   - PRs you authored, reviewed, or are involved in (commented, mentioned, assigned)
#     that were updated in the window, plus any PR in the feed
#   - PRs attached to Linear issues you own, filed, or follow that were updated in the
#     window — how someone else's PR you pushed to or merged (a handoff) is found, since
#     GitHub search can't find PRs by commit author. Needs the `linear` CLI; set
#     GH_ACTIVITY_LINEAR=0 to skip.
#   - -p owner/repo#N or a PR URL, and -b <head branch>, each repeatable
# Commits count as yours when you're any of their authors (co-authored commits too).
# Label, assignment, and review-request events are dropped.
#
# Each PR line shows its state: review decision and human approvers while open, +/- lines
# once merged. -j prints JSON instead, with reviewers (bots flagged), requested reviewers,
# base branch, Linear refs, and timestamped actions.
#
# Window: -d starts at local midnight N days ago (default 7); -s starts at local midnight;
# -S takes any timestamp `date -d` accepts (e.g. the last standup's cutoff). -u ends it.
# Reviewers of GitHub's Bot type are flagged; GH_ACTIVITY_BOTS adds logins that act as bots.
# -U reports on another GitHub user. Their events feed shows public events only, so private-repo
# issues and pushes without a PR are missing; -L (Linear email or user id) keeps the Linear PR
# lookup, which is skipped under -U otherwise. -A keeps authored PRs only, skipping the
# reviewed/involved searches and the Linear lookup (fast for heavy reviewers).

set -euo pipefail

DAYS=7
SINCE_DATE=""
SINCE_TS=""
UNTIL_ARG=""
JSON=false
EXTRA_PRS=()
EXTRA_BRANCHES=()
USER_ARG=""
LINEAR_USER=""
AUTHORED_ONLY=false
BOTS=${GH_ACTIVITY_BOTS:-"chainguard-review approver-doc-driven depthfirst-app chainguard linear"}

while getopts "d:s:S:u:p:b:U:L:Aj" opt; do
  case $opt in
    d) DAYS="$OPTARG" ;;
    s) SINCE_DATE="$OPTARG" ;;
    S) SINCE_TS="$OPTARG" ;;
    u) UNTIL_ARG="$OPTARG" ;;
    p) EXTRA_PRS+=("$OPTARG") ;;
    b) EXTRA_BRANCHES+=("$OPTARG") ;;
    U) USER_ARG="$OPTARG" ;;
    L) LINEAR_USER="$OPTARG" ;;
    A) AUTHORED_ONLY=true ;;
    j) JSON=true ;;
    *) echo "Usage: $0 [-d days | -s YYYY-MM-DD | -S timestamp] [-u until] [-p PR]... [-b branch]... [-U login [-L linear-user]] [-A] [-j]" >&2; exit 1 ;;
  esac
done

# Any `date -d` input -> epoch, read as local time (a bare date is local midnight).
to_epoch() {
  date -d "$1" +%s 2>/dev/null || date -j -f "%Y-%m-%d %H:%M:%S" "$1 00:00:00" +%s
}

ME=${USER_ARG:-$(gh api user --jq '.login')}
if [[ -n $SINCE_TS ]]; then
  SINCE=$(to_epoch "$SINCE_TS")
else
  if [[ -z $SINCE_DATE ]]; then
    SINCE_DATE=$(date -d "-${DAYS} days" +%F 2>/dev/null || date -v-"${DAYS}"d +%F)
  fi
  SINCE=$(to_epoch "$SINCE_DATE")
fi
UNTIL=$(if [[ -n $UNTIL_ARG ]]; then to_epoch "$UNTIL_ARG"; else date +%s; fi)
# Search dates are UTC days; the UTC date of SINCE never starts after it.
SEARCH_DATE=$(date -u -d "@$SINCE" +%F 2>/dev/null || date -u -r "$SINCE" +%F)
SINCE_ISO=$(date -u -d "@$SINCE" +%FT%TZ 2>/dev/null || date -u -r "$SINCE" +%FT%TZ)
FEED_LIMIT=$(( $(date +%s) - 90 * 86400 ))

PR_FIELDS='fragment F on PullRequest {
  number url title body state isDraft createdAt mergedAt
  additions deletions changedFiles
  author { login }
  mergedBy { login }
  repository { nameWithOwner }
  baseRefName headRefName
  headRepository { nameWithOwner }
  reviewDecision
  reviewRequests(first: 20) {
    nodes { requestedReviewer { __typename ... on User { login } ... on Bot { login } ... on Team { slug } } }
  }
  latestReviews(first: 20) { nodes { state author { __typename login } } }
  latestOpinionatedReviews(first: 20) { nodes { state author { __typename login } } }
  timelineItems(last: 100, itemTypes: [PULL_REQUEST_COMMIT, HEAD_REF_FORCE_PUSHED_EVENT,
      READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, MERGED_EVENT, CLOSED_EVENT,
      REOPENED_EVENT, PULL_REQUEST_REVIEW, ISSUE_COMMENT]) {
    nodes {
      __typename
      ... on PullRequestCommit { commit { committedDate authors(first: 5) { nodes { user { login } } } } }
      ... on HeadRefForcePushedEvent { createdAt actor { login } }
      ... on ReadyForReviewEvent { createdAt actor { login } }
      ... on ConvertToDraftEvent { createdAt actor { login } }
      ... on MergedEvent { createdAt actor { login } }
      ... on ClosedEvent { createdAt actor { login } }
      ... on ReopenedEvent { createdAt actor { login } }
      ... on PullRequestReview { createdAt state author { login } }
      ... on IssueComment { createdAt author { login } }
    }
  }
}'

# Search query -> JSON array of PRs. Timelines make pages heavy: a page that times out
# (GitHub answers with an HTML error page) is retried from the start at a smaller size.
search_prs() {
  local size out
  for size in 50 20 10; do
    if out=$(gh api graphql --paginate -F size="$size" -f query='
      query($q: String!, $size: Int!, $endCursor: String) {
        search(query: $q, type: ISSUE, first: $size, after: $endCursor) {
          pageInfo { hasNextPage endCursor }
          nodes { ... on PullRequest { ...F } }
        }
      }
    '"$PR_FIELDS" -f q="$1" --jq '.data.search.nodes[]' 2> /dev/null); then
      jq -s '[.[] | select(.number)]' <<< "$out"
      return
    fi
    echo "> Search failed at page size $size: $1" >&2
  done
  return 1
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

gh api --paginate "/users/$ME/events?per_page=100" --jq '.[]' | jq -s . > "$tmp/raw.json"

read -r total oldest < <(jq -r '"\(length) \(map(.created_at | fromdate) | min // 0)"' "$tmp/raw.json")
if (( SINCE < FEED_LIMIT || (total >= 300 && oldest > SINCE) )); then
  echo "> WARNING: events feed caps at 90 days / 300 events (oldest returned: $(jq -nr "$oldest | todate"))." >&2
  echo "> PR activity is still recovered from timelines; issue comments and pushes without a PR before then are missing." >&2
fi

# Normalize to chronological {at, repo, action, kind: pr|issue|push, number|ref}.
# Payloads are slimmed (no PR title/author), so PR numbers come from URLs where needed.
# Review comments are dropped: the timeline reports the review they belong to.
jq --argjson since "$SINCE" --argjson until "$UNTIL" '
  def prnum:
    .payload.number // .payload.issue.number // .payload.pull_request.number
    // ((.payload.review.pull_request_url // .payload.comment.pull_request_url // "")
        | try (capture("/pulls/(?<n>[0-9]+)$").n | tonumber) catch null);
  def is_pr:
    (.type != "IssueCommentEvent" and .type != "IssuesEvent")
    or .payload.issue.pull_request != null
    or ((.payload.issue.html_url // "") | test("/pull/"));
  [ reverse[] | (.created_at | fromdate) as $t | select($t >= $since and $t <= $until)
    | (if .type == "PullRequestEvent" then
         {opened: "opened", reopened: "reopened", ready_for_review: "ready for review",
          converted_to_draft: "to draft",
          closed: (if .payload.pull_request.merged == true then "merged" else "closed" end)
         }[.payload.action] // empty
       elif .type == "PullRequestReviewEvent" then "reviewed:" + (.payload.review.state // "?" | ascii_downcase)
       elif .type == "IssueCommentEvent" then "commented"
       elif .type == "IssuesEvent" then .payload.action
       elif .type == "PushEvent" then "pushed"
       else empty end) as $action
    | {at: .created_at, repo: .repo.name, action: $action, source: "feed"}
      + if .type == "PushEvent" then {kind: "push", ref: (.payload.ref | sub("^refs/heads/"; ""))}
        elif is_pr then {kind: "pr", number: prnum}
        else {kind: "issue", number: prnum, title: .payload.issue.title} end
  ]
  | map(select(.kind != "push" or (.ref | test("^(main|master)$|^refs/tags/") | not)))
' "$tmp/raw.json" > "$tmp/events.json"

# Searches catch PRs the feed dropped; authored PRs also carry head refs for pushes.
# involves: covers commenter, mentions, and assignee.
search_prs "is:pr author:$ME updated:>=$SEARCH_DATE" > "$tmp/authored.json"
if $AUTHORED_ONLY; then
  echo '[]' | tee "$tmp/reviewed.json" > "$tmp/involved.json"
else
  search_prs "is:pr reviewed-by:$ME -author:$ME updated:>=$SEARCH_DATE" > "$tmp/reviewed.json"
  search_prs "is:pr involves:$ME -author:$ME updated:>=$SEARCH_DATE" > "$tmp/involved.json"
fi
jq -s 'add | unique_by(.url)' "$tmp/authored.json" "$tmp/reviewed.json" "$tmp/involved.json" > "$tmp/searched.json"

# Extra candidates: -p refs, and PRs attached to Linear issues updated in the window.
{
  for ref in ${EXTRA_PRS[@]+"${EXTRA_PRS[@]}"}; do
    if [[ $ref =~ github\.com/([^/]+/[^/]+)/pull/([0-9]+) || $ref =~ ^([^/#]+/[^/#]+)#([0-9]+)$ ]]; then
      printf '{"repo":"%s","number":%s}\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"
    else
      echo "> Skipping -p $ref: expected owner/repo#N or a PR URL." >&2
    fi
  done
  if $AUTHORED_ONLY; then
    :
  elif [[ -n $USER_ARG && -z $LINEAR_USER ]]; then
    echo "> -U without -L: skipping the Linear PR lookup." >&2
  elif [[ ${GH_ACTIVITY_LINEAR:-1} != 0 ]] && command -v linear > /dev/null 2>&1; then
    if [[ -z $LINEAR_USER ]]; then
      linear_me='isMe: { eq: true }' linear_decl="" linear_vars=()
    elif [[ $LINEAR_USER == *@* ]]; then
      linear_me='email: { eq: $who }' linear_decl=', $who: String!' linear_vars=(--variable who="$LINEAR_USER")
    else
      linear_me='id: { eq: $who }' linear_decl=', $who: ID!' linear_vars=(--variable who="$LINEAR_USER")
    fi
    linear api --paginate --variable since="$SINCE_ISO" ${linear_vars[@]+"${linear_vars[@]}"} '
      query($since: DateTimeOrDuration!'"$linear_decl"', $after: String) {
        issues(first: 50, after: $after, filter: {
          updatedAt: { gte: $since }
          or: [
            { assignee: { '"$linear_me"' } }
            { creator: { '"$linear_me"' } }
            { subscribers: { some: { '"$linear_me"' } } }
          ]
        }) {
          pageInfo { hasNextPage endCursor }
          nodes { attachments(first: 20) { nodes { url } } }
        }
      }' 2> /dev/null \
      | jq -c '.[].attachments.nodes[].url
          | capture("github\\.com/(?<repo>[^/]+/[^/]+)/pull/(?<number>[0-9]+)")
          | .number |= tonumber' \
      || echo "> Linear lookup failed; PRs found only through Linear are missing." >&2
  fi
} | jq -s 'unique' > "$tmp/extra-refs.json"

# Fetch feed and extra PRs the searches didn't return, 20 per query to keep timelines
# under GraphQL limits. Inaccessible PRs come back null and are dropped.
jq -c --slurpfile have "$tmp/searched.json" --slurpfile extra "$tmp/extra-refs.json" '
  ($have[0] | map("\(.repository.nameWithOwner)#\(.number)")) as $keys
  | (map(select(.kind == "pr" and .number != null) | {repo, number}) + $extra[0])
  | unique
  | map(select("\(.repo)#\(.number)" as $k | $keys | any(. == $k) | not))
  | [range(0; length; 20) as $i | .[$i:$i + 20]][]
' "$tmp/events.json" > "$tmp/fetch-chunks.jsonl"

: > "$tmp/others.jsonl"
while IFS= read -r chunk; do
  query=$(jq -r --arg frag "$PR_FIELDS" '
    group_by(.repo) | to_entries
    | "query { " + (map(
        (.value[0].repo | split("/")) as [$o, $n]
        | "r\(.key): repository(owner: \"\($o)\", name: \"\($n)\") { "
          + (.value | map("p\(.number): pullRequest(number: \(.number)) { ...F }") | join(" ")) + " }"
      ) | join(" ")) + " } " + $frag
  ' <<< "$chunk")
  # A PR or repo you can't read fails the query but still returns the rest.
  gh api graphql -f query="$query" --jq '[.data[] | values | .[] | values]' 2> /dev/null >> "$tmp/others.jsonl" || true
done < "$tmp/fetch-chunks.jsonl"
jq -s 'add // []' "$tmp/others.jsonl" > "$tmp/others.json"

# Pushes to branches not yet matched to a PR (e.g. someone else's PR): look up by head ref.
# -b branches are looked up the same way, in any repo.
jq -s 'add' "$tmp/searched.json" "$tmp/others.json" > "$tmp/prs.json"
{
  jq -r --slurpfile prs "$tmp/prs.json" '
    map(select(.kind == "push")) | unique_by([.repo, .ref])[]
    | select(. as $p | $prs[0] | any(.headRepository.nameWithOwner == $p.repo and .headRefName == $p.ref) | not)
    | "\(.repo)\t\(.ref)"
  ' "$tmp/events.json" | while IFS=$'\t' read -r repo ref; do
    search_prs "is:pr head:$ref" | jq --arg repo "$repo" 'map(select(.headRepository.nameWithOwner == $repo))'
  done
  for branch in ${EXTRA_BRANCHES[@]+"${EXTRA_BRANCHES[@]}"}; do
    search_prs "is:pr head:$branch"
  done
} | jq -s 'add // []' > "$tmp/pushed.json"

jq -s 'add | unique_by(.url)' "$tmp/prs.json" "$tmp/pushed.json" > "$tmp/all-prs.json"

# One record per PR you acted on: feed + timeline actions, deduped by local day.
jq --arg me "$ME" --arg bots "$BOTS" --argjson since "$SINCE" --argjson until "$UNTIL" \
   --argjson authored "$AUTHORED_ONLY" --slurpfile ev "$tmp/events.json" '
  . as $prs
  | ($bots | split(" ") | map(select(. != ""))) as $botlist
  | def bot: .__typename == "Bot" or (.login as $l | $botlist | any(. == $l));
  def inwin: fromdate as $t | $t >= $since and $t <= $until;
  def matches($p):
    (.kind == "pr" and .repo == $p.repository.nameWithOwner and .number == $p.number)
    or (.kind == "push" and .repo == ($p.headRepository.nameWithOwner // "") and .ref == $p.headRefName);
  def timeline:
    (.state == "MERGED") as $merged
    | [ (if .author.login == $me and (.createdAt | inwin) then {at: .createdAt, action: "opened"} else empty end),
        (.timelineItems.nodes[]
         | if .__typename == "PullRequestCommit" then
             select(any(.commit.authors.nodes[]; .user.login == $me))
             | {at: .commit.committedDate, action: "pushed"}
           elif .__typename == "PullRequestReview" then
             select(.author.login == $me) | {at: .createdAt, action: ("reviewed:" + (.state | ascii_downcase))}
           elif .__typename == "IssueComment" then
             select(.author.login == $me) | {at: .createdAt, action: "commented"}
           else
             select(.actor.login == $me)
             | {at: .createdAt, action: {
                 HeadRefForcePushedEvent: "pushed", ReadyForReviewEvent: "ready for review",
                 ConvertToDraftEvent: "to draft", MergedEvent: "merged",
                 ClosedEvent: (if $merged then null else "closed" end), ReopenedEvent: "reopened"
               }[.__typename]}
             | select(.action != null)
           end)
      ] | map(select(.at | inwin) + {source: "timeline"});
  [ $prs[] as $p
    | select(($authored | not) or $p.author.login == $me)
    | (($ev[0] | map(select(matches($p)))) + ($p | timeline))
      | map(. + {day: (.at | fromdate | strflocaltime("%Y-%m-%d"))})
      | unique_by([.day, .action]) | sort_by(.at) as $acts
    | select($acts | length > 0)
    | $p | {
        repo: .repository.nameWithOwner, number, url, title,
        author: (.author.login // "ghost"), mine: (.author.login == $me),
        state: (if .isDraft and .state == "OPEN" then "draft" else (.state | ascii_downcase) end),
        reviewDecision, createdAt, mergedAt, mergedBy: .mergedBy.login,
        additions, deletions, changedFiles,
        base: .baseRefName, head: .headRefName,
        linear: ([ (.title | scan("\\b[A-Z][A-Z0-9]{1,5}-[0-9]{2,}\\b")),
                   ((.body // "") | scan("linear\\.app/[^/]+/issue/([A-Z][A-Z0-9]{1,5}-[0-9]+)")[0]),
                   (.headRefName | ascii_upcase | scan("(?:^|/)([A-Z][A-Z0-9]{1,5}-[0-9]{2,})")[0]) ] | unique),
        requested: [ .reviewRequests.nodes[].requestedReviewer | (.login // .slug) | select(. != null) ],
        # latestReviews can omit approvals; latestOpinionatedReviews has the latest
        # approve or request-changes per reviewer, so it wins.
        reviews: ([ .latestOpinionatedReviews.nodes[], .latestReviews.nodes[] ]
          | reduce .[] as $r ({}; ($r.author.login // "ghost") as $l | if has($l) then . else . + {($l): $r} end)
          | [ .[] | {login: (.author.login // "ghost"), state, bot: (.author | bot)} ]),
        actions: ($acts | map({at, day, action, source}))
      }
  ] | sort_by(.actions[0].at)
' "$tmp/all-prs.json" > "$tmp/rows.json"

# Issues and pushes without a PR come from the feed alone.
jq --slurpfile prs "$tmp/all-prs.json" '
  def matches($p):
    .kind == "push" and .repo == ($p.headRepository.nameWithOwner // "") and .ref == $p.headRefName;
  map(. + {day: (.at | fromdate | strflocaltime("%Y-%m-%d"))})
  | {
      issues: [ map(select(.kind == "issue")) | group_by([.repo, .number])[]
        | {repo: .[0].repo, number: .[0].number, title: (map(.title // empty)[0] // ""),
           url: "https://github.com/\(.[0].repo)/issues/\(.[0].number)",
           actions: (unique_by([.day, .action]) | map({at, day, action}))} ],
      pushes: [ map(select(.kind == "push") | . as $e | select($prs[0] | any(. as $p | $e | matches($p)) | not))
        | group_by([.repo, .ref])[] | {repo: .[0].repo, ref: .[0].ref, days: (map(.day) | unique)} ]
    }
' "$tmp/events.json" > "$tmp/extra.json"

if [[ $JSON == true ]]; then
  jq -n --arg me "$ME" --argjson since "$SINCE" --argjson until "$UNTIL" \
     --slurpfile rows "$tmp/rows.json" --slurpfile extra "$tmp/extra.json" '{
    user: $me, since: ($since | todate), until: ($until | todate),
    prs: $rows[0], issues: $extra[0].issues, pushes: $extra[0].pushes
  }'
  exit 0
fi

jq -rn --arg me "$ME" --argjson since "$SINCE" --argjson until "$UNTIL" \
   --slurpfile rows "$tmp/rows.json" --slurpfile extra "$tmp/extra.json" '
  def acts:
    group_by(.day)
    | map("\(.[0].day[5:]): " + (map(.action) | reduce .[] as $a ([]; if index([$a]) then . else . + [$a] end) | join(", ")))
    | join("; ");
  def humans($s): [ .reviews[] | select(.state == $s and (.bot | not)) | .login ]
    | if length == 0 then "no human reviewer" else join(", ") end;
  def status:
    if .state == "merged" then "merged"
      + (if .mergedBy != null and .mergedBy != $me then " by @\(.mergedBy)" else "" end)
      + " (+\(.additions)/−\(.deletions))"
    elif .state == "open" then
      if .reviewDecision == "APPROVED" then "open, approved by \(humans("APPROVED"))"
      elif .reviewDecision == "CHANGES_REQUESTED" then "open, changes requested by \(humans("CHANGES_REQUESTED"))"
      elif (.requested | length) > 0 then "open, review requested: \(.requested | join(", "))"
      else "open, no reviewer requested" end
    else .state end;
  def line: "- [\(.repo)#\(.number)](\(.url)) \(.title) — \(status)"
    + (if .mine then "" else ", @\(.author)" end) + " — \(.actions | acts)";
  def section($title; $lines): if ($lines | length) > 0 then "", "### \($title)", $lines[] else empty end;
  "## GitHub activity for \($me)",
  "Window: \($since | strflocaltime("%Y-%m-%d %H:%M")) → \($until | strflocaltime("%Y-%m-%d %H:%M")) (local)",
  section("Authored PRs"; [ $rows[0][] | select(.mine) | line ]),
  section("Others'"'"' PRs"; [ $rows[0][] | select(.mine | not) | line ]),
  section("Issues"; [ $extra[0].issues[] | "- [\(.repo)#\(.number)](\(.url)) \(.title) — \(.actions | acts)" ]),
  section("Pushes without a PR"; [ $extra[0].pushes[] | "- \(.repo) `\(.ref)` — \(.days | map(.[5:]) | join(", "))" ])
'
