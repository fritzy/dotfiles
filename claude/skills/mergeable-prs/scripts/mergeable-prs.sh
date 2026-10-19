#!/bin/bash

# mergeable-prs.sh [-a] [-j] [-q qualifiers]
#
# Lists your open, non-draft PRs that GitHub will let you merge now: merge state
# CLEAN or HAS_HOOKS, or UNSTABLE (only non-required checks failing).
#   -a  all your open PRs, with what blocks each one
#   -j  JSON instead of a markdown table
#   -q  extra search qualifiers, e.g. "org:chainguard-dev" or "repo:owner/name"
#
# GitHub computes mergeability lazily, so the first query after a push or a base
# branch change often returns UNKNOWN. Those are re-queried a few times first.

set -euo pipefail

ALL=false
JSON=false
QUALIFIERS=""

while getopts "ajq:" opt; do
  case $opt in
    a) ALL=true ;;
    j) JSON=true ;;
    q) QUALIFIERS="$OPTARG" ;;
    *) echo "Usage: $0 [-a] [-j] [-q qualifiers]" >&2; exit 1 ;;
  esac
done

search="is:pr is:open author:@me draft:false archived:false $QUALIFIERS"

# mergeStateStatus is still behind a preview header.
fetch() {
  gh api graphql --paginate \
    -H "Accept: application/vnd.github.merge-info-preview+json" \
    -f q="$search" -f query='
      query($q: String!, $endCursor: String) {
        search(query: $q, type: ISSUE, first: 50, after: $endCursor) {
          pageInfo { hasNextPage endCursor }
          nodes { ... on PullRequest {
            number url title baseRefName
            repository { nameWithOwner }
            mergeable mergeStateStatus reviewDecision isInMergeQueue
            autoMergeRequest { enabledAt }
            reviewThreads(first: 100) { nodes { isResolved } }
            commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
          } }
        }
      }' --jq '.data.search.nodes[]' | jq -s .
}

prs=$(fetch)
for _ in 1 2 3; do
  jq -e 'any(.[]; .mergeStateStatus == "UNKNOWN")' <<<"$prs" >/dev/null || break
  sleep 3
  prs=$(fetch)
done

prs=$(jq '
  map(
    (.commits.nodes[0].commit.statusCheckRollup.state // "NONE") as $checks
    | ([.reviewThreads.nodes[] | select(.isResolved | not)] | length) as $unresolved
    | (.mergeStateStatus | IN("CLEAN", "HAS_HOOKS", "UNSTABLE")) as $ok
    | [ if .mergeable == "CONFLICTING" then "merge conflicts" else empty end,
        if .mergeStateStatus == "BEHIND" then "behind \(.baseRefName)" else empty end,
        if .reviewDecision == "REVIEW_REQUIRED" then "needs review"
        elif .reviewDecision == "CHANGES_REQUESTED" then "changes requested" else empty end,
        if ($checks | IN("FAILURE", "ERROR")) then (if $ok then "non-required checks failing" else "checks failing" end)
        elif ($checks | IN("PENDING", "EXPECTED")) then "checks pending" else empty end,
        if $unresolved > 0 then "\($unresolved) unresolved thread\(if $unresolved == 1 then "" else "s" end)" else empty end
      ] as $issues
    | {
        repo: .repository.nameWithOwner, number, url, title, base: .baseRefName,
        mergeable: $ok, mergeState: .mergeStateStatus,
        review: (.reviewDecision // "NONE"), checks: $checks, unresolvedThreads: $unresolved,
        autoMerge: (.autoMergeRequest != null), inMergeQueue: .isInMergeQueue,
        notes: ($issues
          + (if .mergeStateStatus == "UNKNOWN" then ["mergeability not computed"] else [] end)
          # BLOCKED with nothing visible: required reviewers/CODEOWNERS, rulesets, etc.
          + (if .mergeStateStatus == "BLOCKED" and ($issues | length) == 0 then ["blocked by branch protection"] else [] end)
          + (if .isInMergeQueue then ["in merge queue"] elif .autoMergeRequest then ["auto-merge on"] else [] end))
      }
  )
  | sort_by((.mergeable | not), .repo, .number)
' <<<"$prs")

total=$(jq length <<<"$prs")
[[ $ALL == true ]] || prs=$(jq 'map(select(.mergeable))' <<<"$prs")

if [[ $JSON == true ]]; then
  jq . <<<"$prs"
  exit 0
fi

if [[ $(jq length <<<"$prs") == 0 ]]; then
  if [[ $ALL == true ]]; then
    echo "No open PRs." >&2
  else
    echo "No mergeable PRs ($total open). Run with -a to see what blocks them." >&2
  fi
  exit 0
fi

jq -r '
  def lc: ascii_downcase | gsub("_"; " ");
  "| PR | state | review | checks | notes |",
  "|---|---|---|---|---|",
  (.[] | "| [\(.repo | split("/")[1])#\(.number)](\(.url)) \(.title | .[:60] | rtrimstr(" ") | gsub("\\|"; "\\|")) | \(.mergeState | lc) | \(.review | lc) | \(.checks | lc) | \(.notes | join(", ")) |")
' <<<"$prs"
