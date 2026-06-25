#!/bin/bash

# customer-escalations.sh [-r org/repo] [-L label] [-l limit=20]
#
# Lists open customer escalation issues relevant to the current user: those
# labeled with the team's ecosystem tag, plus any the user is involved in
# (assigned, authored, commented on, or mentioned). Results are unioned,
# deduped, and sorted most-recently-updated first. Assigned-to-me issues are
# flagged with ★.

set -euo pipefail

REPO="chainguard-dev/customer-issues"
LABEL="eng:ecosystems:javascript"
LIMIT=20

while getopts "r:L:l:" opt; do
  case $opt in
    r) REPO="$OPTARG" ;;
    L) LABEL="$OPTARG" ;;
    l) LIMIT="$OPTARG" ;;
    *) echo "Usage: $0 [-r org/repo] [-L label] [-l limit]" >&2; exit 1 ;;
  esac
done

ME=$(gh api user --jq '.login')

echo "## Customer escalations for @$ME ($REPO)"
echo ""

FIELDS="number,title,url,updatedAt,assignees,labels"

# Bucket 1: open issues labeled with the ecosystem tag.
BY_LABEL=$(gh search issues --repo "$REPO" --include-prs=false --state open \
  --label "$LABEL" --limit 200 --json "$FIELDS")

# Bucket 2: open issues the user is involved in (assigned/authored/commented/mentioned).
BY_INVOLVES=$(gh search issues --repo "$REPO" --include-prs=false --state open \
  --involves "$ME" --limit 200 --json "$FIELDS")

jq -rn --argjson a "$BY_LABEL" --argjson b "$BY_INVOLVES" \
  --arg me "$ME" --arg label "$LABEL" --argjson limit "$LIMIT" '
  ($a + $b)
  | group_by(.number)
  | map(.[0])
  | sort_by(.updatedAt) | reverse
  | .[:$limit]
  | .[]
  | (.assignees // []) as $as
  | (any($as[]; .login == $me)) as $mine
  | (any((.labels // [])[]; .name == $label)) as $js
  | [
      (if $js then "🟡" else "⚪" end),
      "[#\(.number) \(.title)](\(.url))",
      ([ (if $mine then "★ assigned" else empty end),
         (if $js then "js" else empty end) ] | join(", ")),
      .updatedAt[:10]
    ]
  | "- \(.[0]) \(.[1])\(if .[2] != "" then " — \(.[2])" else "" end) — updated \(.[3])"
'
