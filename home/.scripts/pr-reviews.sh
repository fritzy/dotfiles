#!/bin/bash

# pr-reviews.sh [-r org/repo] [-l limit=5]
#
# Lists PRs that need reviews from the current directory repo or override [org/repo]
# Prioritizes first by teammates authorship [indexzero, jumoel, dakaneye] then by recency

set -euo pipefail

LIMIT=5
REPO_OVERRIDE=""

while getopts "r:l:" opt; do
  case $opt in
    r) REPO_OVERRIDE="$OPTARG" ;;
    l) LIMIT="$OPTARG" ;;
    *) echo "Usage: $0 [-r org/repo] [-l limit]" >&2; exit 1 ;;
  esac
done

REPO="${REPO_OVERRIDE:-$(gh repo view --json nameWithOwner --jq '.nameWithOwner')}"
TEAMMATES="indexzero jumoel dakaneye"

echo "## PRs needing review in $REPO"
echo ""

gh api graphql --paginate -f query='
  query($q: String!, $cursor: String) {
    search(query: $q, type: ISSUE, first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ... on PullRequest {
          number
          title
          url
          createdAt
          author { login }
          reviewRequests(first: 10) {
            nodes {
              requestedReviewer {
                ... on User { login }
              }
            }
          }
        }
      }
    }
  }
' -f q="repo:${REPO} is:pr is:open draft:false review:required" --jq "
  .data.search.nodes[]
  | {
      number: .number,
      title: .title,
      url: .url,
      createdAt: .createdAt,
      author: .author.login,
      teammate: (
        .author.login as \$a
        | [\"indexzero\", \"jumoel\", \"dakaneye\"]
        | map(select(. == \$a))
        | length > 0
      )
    }
" | jq -s --argjson limit "$LIMIT" '
  sort_by([(.teammate | not), (.createdAt | explode | map(-.))])
  | .[:$limit]
  | .[]
  | "- [#\(.number) \(.title)](\(.url)) by @\(.author)\(if .teammate then " ★" else "" end) — \(.createdAt[:10])"
'
