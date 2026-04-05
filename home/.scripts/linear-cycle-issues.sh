#!/bin/bash

# linear-cycle-issues.sh [-t team-key] [-l limit=20]
#
# Lists issues in the current cycle that are either unassigned or assigned to
# the current user. Prioritizes assigned-to-me issues, then sorts by priority
# (urgent > high > medium > low > none).

set -euo pipefail

TEAM_KEY="ECO"
LIMIT=20

while getopts "t:l:" opt; do
  case $opt in
    t) TEAM_KEY="$OPTARG" ;;
    l) LIMIT="$OPTARG" ;;
    *) echo "Usage: $0 [-t team-key] [-l limit]" >&2; exit 1 ;;
  esac
done

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

USER_JSON=$(linear api "{ viewer { id name } }")
USER_ID=$(echo "$USER_JSON" | jq -r '.data.viewer.id')
USER_NAME=$(echo "$USER_JSON" | jq -r '.data.viewer.name')

echo "## Current cycle issues for $USER_NAME ($TEAM_KEY)"
echo ""

linear api "{
  cycles(first: 5, filter: {
    startsAt: { lte: \"$NOW\" }
    endsAt: { gte: \"$NOW\" }
    team: { key: { eq: \"$TEAM_KEY\" } }
  }) {
    nodes {
      number name startsAt endsAt
      issues(first: 100, filter: {
        state: { type: { nin: [\"completed\", \"cancelled\"] } }
      }) {
        nodes {
          identifier title url priority
          state { name }
          assignee { id name }
        }
      }
    }
  }
}" | jq -r --arg userId "$USER_ID" --arg userName "$USER_NAME" --argjson limit "$LIMIT" '
  .data.cycles.nodes[0]
  | "### Cycle \(.number)\(if .name != "" and .name != null then " — \(.name)" else "" end) (\(.startsAt[:10]) to \(.endsAt[:10]))\n",
    (
      .issues.nodes
      | map(select(.assignee == null or .assignee.id == $userId))
      | sort_by([
          (.assignee == null | if . then 1 else 0 end),
          (if .priority == 0 then 99 else .priority end)
        ])
      | .[:$limit]
      | .[]
      | [
          (if .priority == 1 then "🔴" elif .priority == 2 then "🟠" elif .priority == 3 then "🟡" elif .priority == 4 then "🔵" else "⚪" end),
          "[\(.identifier) \(.title)](\(.url))",
          "[\(.state.name)]",
          (if .assignee then "@\(.assignee.name)" else "unassigned" end)
        ]
      | "- \(.[0]) \(.[1]) \(.[2]) — \(.[3])"
    )
'
