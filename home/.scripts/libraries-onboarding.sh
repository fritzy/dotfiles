#!/bin/bash

# libraries-onboarding.sh [-r org/repo] [-L label]
#
# Lists all open onboarding issues assigned to the current user, sorted
# most-recently-updated first. Unlike the other work-this-cycle scripts, this
# list is intentionally NOT capped — every assigned onboarding issue is shown.

set -euo pipefail

REPO="chainguard-dev/internal-dev"
LABEL="libraries-onboarding-js"

while getopts "r:L:" opt; do
  case $opt in
    r) REPO="$OPTARG" ;;
    L) LABEL="$OPTARG" ;;
    *) echo "Usage: $0 [-r org/repo] [-L label]" >&2; exit 1 ;;
  esac
done

ME=$(gh api user --jq '.login')

echo "## Onboarding issues for @$ME ($REPO)"
echo ""

gh search issues --repo "$REPO" --include-prs=false --state open \
  --label "$LABEL" --assignee "@me" --limit 1000 \
  --json number,title,url,updatedAt \
  | jq -r '
    sort_by(.updatedAt) | reverse
    | .[]
    | "- [#\(.number) \(.title)](\(.url)) — updated \(.updatedAt[:10])"
  '
