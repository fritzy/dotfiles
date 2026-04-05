#!/bin/bash

# linear-activity.sh [-d days] [-t team-key]
#
# Uses the Linear CLI to summarize activity for the current user:
#   - Cycles overlapping the time window
#   - Issues currently assigned to you (with state changes in the window)
#   - Issues created by you within the window

set -euo pipefail

DAYS=1
TEAM_KEY="ECO"

while getopts "d:t:" opt; do
  case $opt in
    d) DAYS="$OPTARG" ;;
    t) TEAM_KEY="$OPTARG" ;;
    *) echo "Usage: $0 [-d days] [-t team-key]" >&2; exit 1 ;;
  esac
done

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
SINCE=$(date -u -d "-${DAYS} days" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -v-"${DAYS}"d +"%Y-%m-%dT%H:%M:%SZ")

USER_JSON=$(linear api "{ viewer { id name } }")
USER_ID=$(echo "$USER_JSON" | jq -r '.data.viewer.id')
USER_NAME=$(echo "$USER_JSON" | jq -r '.data.viewer.name')

TEAM_FILTER=""
[ -n "$TEAM_KEY" ] && TEAM_FILTER="team: { key: { eq: \"$TEAM_KEY\" } }"

echo "## Linear activity for $USER_NAME (last ${DAYS} day(s))"
echo ""

echo "### Cycles"
echo ""
linear api "{
  cycles(first: 50, filter: {
    startsAt: { lte: \"$NOW\" }
    endsAt: { gte: \"$SINCE\" }
    $TEAM_FILTER
  }) {
    nodes { number name startsAt endsAt team { name } }
  }
}" | jq -r --arg now "$NOW" '.data.cycles.nodes[] | "- \(.team.name) Cycle \(.number)\(if .name != "" and .name != null then " — \(.name)" else "" end) (\(.startsAt[:10]) to \(.endsAt[:10]))\(if .startsAt <= $now and .endsAt >= $now then " (CURRENT)" else "" end)"'

echo ""
echo "### Assigned"
echo ""
linear api \
  --variable userId="$USER_ID" \
  "query(\$userId: ID) {
    issues(first: 250, filter: {
      assignee: { id: { eq: \$userId } }
      state: { type: { nin: [\"completed\", \"cancelled\"] } }
      $TEAM_FILTER
    }) {
      nodes {
        identifier title url
        state { name }
        history(first: 50) {
          nodes { createdAt fromState { name } toState { name } }
        }
      }
    }
  }" | jq -r --arg since "$SINCE" '
  .data.issues.nodes[]
  | . as $issue
  | (.history.nodes | map(select(.createdAt >= $since and .fromState != null and .toState != null))) as $changes
  | if ($changes | length) > 0 then
      "- [\($issue.state.name)] [\($issue.identifier) \($issue.title)](\($issue.url))",
      ($changes[] | "  - \(.fromState.name) → \(.toState.name) on \(.createdAt[:10])")
    else
      "- [\($issue.state.name)] [\($issue.identifier) \($issue.title)](\($issue.url))"
    end
'

echo ""
echo "### Created"
echo ""
linear api \
  --variable userId="$USER_ID" \
  "query(\$userId: ID) {
    issues(first: 250, filter: {
      creator: { id: { eq: \$userId } }
      createdAt: { gte: \"$SINCE\" }
      $TEAM_FILTER
    }) {
      nodes { identifier title url state { name } createdAt }
    }
  }" | jq -r '.data.issues.nodes[] | "- [\(.state.name)] [\(.identifier) \(.title)](\(.url)) — \(.createdAt[:10])"'
