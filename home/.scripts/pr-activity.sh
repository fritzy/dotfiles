#!/bin/bash

# pr-activity.sh [-d days] [-r org/repo]
#
# Given the github repo of the current directory
# this script uses `gh` to summarize PR activity of the current `gh` user:
#   - PRs reviewed (approved, changes requested)
#   - PRs authored (opened, merged, closed)

set -euo pipefail

DAYS=1

REPO_OVERRIDE=""

while getopts "d:r:" opt; do
  case $opt in
    d) DAYS="$OPTARG" ;;
    r) REPO_OVERRIDE="$OPTARG" ;;
    *) echo "Usage: $0 [-d days] [-r org/repo]" >&2; exit 1 ;;
  esac
done

CURRENT_USER=$(gh api user --jq '.login')
REPO="${REPO_OVERRIDE:-$(gh repo view --json nameWithOwner --jq '.nameWithOwner')}"
SINCE=$(date -u -d "-${DAYS} days" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -v-"${DAYS}"d +"%Y-%m-%dT%H:%M:%SZ")
SINCE_DATE="${SINCE%%T*}"

echo "## PR activity for $CURRENT_USER in $REPO (last ${DAYS} day(s))"
echo ""

echo "### Reviews"
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
          reviews(first: 100, states: [APPROVED, CHANGES_REQUESTED, DISMISSED]) {
            nodes {
              author { login }
              submittedAt
              state
            }
          }
        }
      }
    }
  }
' -f q="repo:${REPO} is:pr reviewed-by:${CURRENT_USER} updated:>=${SINCE_DATE}" --jq "
  .data.search.nodes[]
  | . as \$pr
  | .reviews.nodes[]
  | select(.author.login == \"$CURRENT_USER\" and .submittedAt >= \"$SINCE\")
  | \"- [\(.state)] [#\(\$pr.number) \(\$pr.title)](\(\$pr.url)) — \(.submittedAt)\"
"

echo ""
echo "### Authored"
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
          state
          createdAt
          mergedAt
          closedAt
        }
      }
    }
  }
' -f q="repo:${REPO} is:pr author:${CURRENT_USER} updated:>=${SINCE_DATE}" --jq "
  .data.search.nodes[]
  | . as \$pr
  | [
      (if .createdAt >= \"$SINCE\" then \"- [OPENED] [#\(\$pr.number) \(\$pr.title)](\(\$pr.url)) — \(.createdAt)\" else empty end),
      (if .mergedAt != null and .mergedAt >= \"$SINCE\" then \"- [MERGED] [#\(\$pr.number) \(\$pr.title)](\(\$pr.url)) — \(.mergedAt)\" else empty end),
      (if .closedAt != null and .state == \"CLOSED\" and .closedAt >= \"$SINCE\" then \"- [CLOSED] [#\(\$pr.number) \(\$pr.title)](\(\$pr.url)) — \(.closedAt)\" else empty end)
    ][]
"
