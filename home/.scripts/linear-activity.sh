#!/bin/bash

# linear-activity.sh [-d days | -s YYYY-MM-DD | -S timestamp] [-u until] [-t team-key] [-U user] [-a] [-v] [-j]
#
# Uses the Linear CLI to summarize the current user's Linear activity in a window:
#   - Current cycle for each of your teams
#   - Filed: issues you created
#   - Mine: net state change, assignment, team, and project moves on issues you own
#   - On tickets I filed: changes others made to issues you created but don't own
#   - Other issues I changed: your changes to issues you neither filed nor own
#   - Open and assigned (-a): every open issue assigned to you
# Each change names who made it: me, automation (integrations and workflows), or a person.
# State changes collapse to first -> last state in the window; churn that nets out is
# hidden unless -v.
#
# Window: -d counts back from now (default 1 day); -s starts at local midnight; -S takes
# any timestamp `date -d` accepts (e.g. the last standup's cutoff). -u ends the window.
# All teams unless -t. -U reports on another user (email or Linear user id); "me" then
# means them. -j prints JSON instead of markdown.

set -euo pipefail

DAYS=1
SINCE_DATE=""
SINCE_TS=""
UNTIL_ARG=""
TEAM_KEY=""
SHOW_ASSIGNED=false
VERBOSE=false
JSON=false
USER_ARG=""

while getopts "d:s:S:u:t:U:avj" opt; do
  case $opt in
    d) DAYS="$OPTARG" ;;
    s) SINCE_DATE="$OPTARG" ;;
    S) SINCE_TS="$OPTARG" ;;
    u) UNTIL_ARG="$OPTARG" ;;
    t) TEAM_KEY="$OPTARG" ;;
    U) USER_ARG="$OPTARG" ;;
    a) SHOW_ASSIGNED=true ;;
    v) VERBOSE=true ;;
    j) JSON=true ;;
    *) echo "Usage: $0 [-d days | -s YYYY-MM-DD | -S timestamp] [-u until] [-t team-key] [-U user] [-a] [-v] [-j]" >&2; exit 1 ;;
  esac
done

# Any `date -d` input -> UTC ISO. Parse without -u so a bare date is local midnight.
to_utc() {
  local epoch
  epoch=$(date -d "$1" +%s 2>/dev/null || date -j -f "%Y-%m-%d %H:%M:%S" "$1 00:00:00" +%s)
  date -u -d "@$epoch" +%FT%TZ 2>/dev/null || date -u -r "$epoch" +%FT%TZ
}

if [[ -n $SINCE_TS ]]; then
  SINCE=$(to_utc "$SINCE_TS")
elif [[ -n $SINCE_DATE ]]; then
  SINCE=$(to_utc "$SINCE_DATE")
else
  SINCE=$(date -u -d "-${DAYS} days" +%FT%TZ 2>/dev/null || date -u -v-"${DAYS}"d +%FT%TZ)
fi
UNTIL=$(if [[ -n $UNTIL_ARG ]]; then to_utc "$UNTIL_ARG"; else date -u +%FT%TZ; fi)

TEAM_FILTER=""
[[ -n $TEAM_KEY ]] && TEAM_FILTER="team: { key: { eq: \"$TEAM_KEY\" } }"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

USER_FIELDS='id name teams { nodes { key activeCycle { number name startsAt endsAt } } }'
if [[ -z $USER_ARG ]]; then
  linear api "{ viewer { $USER_FIELDS } }" | jq '.data.viewer'
elif [[ $USER_ARG == *@* ]]; then
  linear api --variable email="$USER_ARG" \
    "query(\$email: String!) { users(filter: { email: { eq: \$email } }) { nodes { $USER_FIELDS } } }" \
    | jq '.data.users.nodes[0]'
else
  linear api --variable id="$USER_ARG" "query(\$id: String!) { user(id: \$id) { $USER_FIELDS } }" | jq '.data.user'
fi > "$tmp/viewer.json"
USER_ID=$(jq -r '.id // empty' "$tmp/viewer.json")
[[ -n $USER_ID ]] || { echo "No Linear user ${USER_ARG:-viewer}" >&2; exit 1; }

# Subscribers covers issues you changed without filing or owning them; Linear subscribes
# you when you edit an issue.
linear api --paginate --variable since="$SINCE" --variable uid="$USER_ID" "
  query(\$since: DateTimeOrDuration!, \$uid: ID!, \$after: String) {
    issues(first: 50, after: \$after, filter: {
      updatedAt: { gte: \$since }
      or: [
        { creator: { id: { eq: \$uid } } }
        { assignee: { id: { eq: \$uid } } }
        { subscribers: { some: { id: { eq: \$uid } } } }
      ]
      $TEAM_FILTER
    }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        identifier title url createdAt
        state { name type }
        team { key }
        project { name }
        creator { id name }
        assignee { id name }
        history(first: 100) {
          nodes {
            createdAt
            actor { id name }
            fromState { name } toState { name }
            fromAssignee { id name } toAssignee { id name }
            fromTeam { key } toTeam { key }
            fromProject { name } toProject { name }
            fromProjectMilestone { name } toProjectMilestone { name }
          }
        }
      }
    }
  }" > "$tmp/issues.json"

# history(first: N) is newest-first; sort before taking first/last states.
jq --arg since "$SINCE" --arg until "$UNTIL" --arg uid "$USER_ID" --argjson verbose "$VERBOSE" '
  def me: .id == $uid;
  def by: if .actor | me then "me" elif .actor.name then .actor.name else "automation" end;
  # Linear stamps carry milliseconds; strip them so string compares match the bounds.
  def inwin: (.createdAt | sub("\\.[0-9]+Z$"; "Z")) as $t | $t >= $since and $t < $until;
  map(
    . as $i
    | ($i.creator | me) as $filed_by_me
    | (if ($i.assignee | me) or ($i.assignee == null and $filed_by_me) then "mine"
       elif $filed_by_me then "filed-others"
       else "other" end) as $role
    # On issues you neither own nor filed, only your own changes count.
    | [ $i.history.nodes[] | select(inwin) | select($role != "other" or (.actor | me)) ]
    | sort_by(.createdAt) as $h
    | [ $h[] | select(.toState != null and .fromState.name != .toState.name)
        | {at: .createdAt, from: .fromState.name, to: .toState.name, by: by} ] as $states
    | {
        id: $i.identifier, title: $i.title, url: $i.url, team: $i.team.key,
        state: $i.state.name, stateType: $i.state.type, project: $i.project.name,
        creator: $i.creator.name, assignee: $i.assignee.name, role: $role,
        filed: ($filed_by_me and ($i | inwin)),
        createdAt: $i.createdAt,
        net: (if ($states | length) == 0 then null else {
          from: $states[0].from, to: $states[-1].to,
          changed: ($states[0].from != $states[-1].to),
          by: ($states | map(.by) | unique), at: $states[-1].at
        } end),
        transitions: $states,
        assignments: [ $h[] | select(.toAssignee != null or .fromAssignee != null)
          | {at: .createdAt, from: .fromAssignee.name, to: .toAssignee.name,
             toMe: (.toAssignee | me), by: by} ],
        teamMoves: [ $h[] | select(.toTeam != null and .fromTeam.key != .toTeam.key)
          | {at: .createdAt, from: .fromTeam.key, to: .toTeam.key, by: by} ],
        projectMoves: [ $h[] | select((.toProject != null or .fromProject != null)
            and .fromProject.name != .toProject.name)
          | {at: .createdAt, from: .fromProject.name, to: .toProject.name, by: by} ],
        milestoneMoves: [ $h[] | select((.toProjectMilestone != null or .fromProjectMilestone != null)
            and .fromProjectMilestone.name != .toProjectMilestone.name)
          | {at: .createdAt, from: .fromProjectMilestone.name, to: .toProjectMilestone.name, by: by} ]
      }
    | select(.filed or (.net.changed // false) or ($verbose and .net != null)
        or (.assignments | length) > 0 or (.teamMoves | length) > 0
        or (.projectMoves | length) > 0 or (.milestoneMoves | length) > 0)
  )
  | sort_by(.role, .id)
' "$tmp/issues.json" > "$tmp/activity.json"

if [[ $JSON == true ]]; then
  jq --arg since "$SINCE" --arg until "$UNTIL" --slurpfile v "$tmp/viewer.json" '{
    since: $since, until: $until,
    cycles: [ $v[0].teams.nodes[] | select(.activeCycle) | {team: .key} + .activeCycle ],
    issues: .
  }' "$tmp/activity.json"
  exit 0
fi

jq -r --arg since "$SINCE" --arg until "$UNTIL" --slurpfile v "$tmp/viewer.json" '
  def lt: sub("\\.[0-9]+Z$"; "Z") | fromdate | strflocaltime("%m-%d %H:%M");
  def head: "- [\(.state)] [\(.id) \(.title)](\(.url))";
  def parts:
    [ (if .filed then "filed \(.createdAt | lt)" else empty end),
      (if .net != null then
         (if .net.changed then "\(.net.from) → \(.net.to)" else "net unchanged (\(.net.from))" end)
         + " (\(.net.by | join(", ")), \(.net.at | lt))"
       else empty end),
      (.assignments[] | if .to == null then "unassigned (\(.by))"
         elif .toMe and .by == "me" then "self-assigned"
         else "assigned to \(.to) (\(.by))" end),
      (.teamMoves[] | "team \(.from) → \(.to) (\(.by))"),
      (.projectMoves[] | "project \(.from // "none") → \(.to // "none") (\(.by))"),
      (.milestoneMoves[] | "milestone \(.from // "none") → \(.to // "none") (\(.by))")
    ] | join("; ");
  def section($title; $rows):
    if ($rows | length) > 0 then "", "### \($title)", ($rows[] | "\(head) — \(parts)") else empty end;
  "## Linear activity for \($v[0].name)",
  "Window: \($since | lt) → \($until | lt) (local)",
  "",
  "### Current cycles",
  ($v[0].teams.nodes[] | select(.activeCycle) | .activeCycle as $c
    | "- \(.key) Cycle \($c.number)\(if ($c.name // "") != "" then " — \($c.name)" else "" end) (\($c.startsAt[:10]) to \($c.endsAt[:10]))"),
  section("Filed"; map(select(.filed))),
  section("Mine"; map(select(.role == "mine" and (.filed | not)))),
  section("On tickets I filed (others)"; map(select(.role == "filed-others" and (.filed | not))
    | .title += " — @\(.assignee)")),
  section("Other issues I changed"; map(select(.role == "other")))
' "$tmp/activity.json"

if [[ $SHOW_ASSIGNED == true ]]; then
  echo ""
  echo "### Open and assigned"
  linear api --paginate --variable uid="$USER_ID" "
    query(\$uid: ID!, \$after: String) {
      issues(first: 100, after: \$after, filter: {
        assignee: { id: { eq: \$uid } }
        state: { type: { nin: [\"completed\", \"canceled\"] } }
        $TEAM_FILTER
      }) {
        pageInfo { hasNextPage endCursor }
        nodes { identifier title url state { name type } }
      }
    }" | jq -r 'sort_by(.state.type, .identifier)[] | "- [\(.state.name)] [\(.identifier) \(.title)](\(.url))"'
fi
