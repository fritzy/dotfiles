#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: libraries-build-work.sh [--tty | --markdown] [--workspace SLUG]

Libraries Build work from github.com/chainguard-dev/mono and Linear:
  - Open, non-draft PRs related to mentat, judge, or axlotl needing review.
  - All your unfinished Linear assignments, across teams.
  - Unfinished ECO issues related to mentat, judge, or axlotl.

Options:
  --tty              Terminal layout (color when stdout is a TTY).
  --markdown, --md   Markdown suitable for redirecting to a file.
  --workspace SLUG   Select Linear credentials for this workspace.
  -h, --help         Show this help.

Defaults to terminal output on a TTY, Markdown otherwise. NO_COLOR disables
color. Requires authenticated gh and schpet/linear-cli, plus jq (1.6+).
All result sets are paginated. API failures exit nonzero without a report.
EOF
}

die() { printf 'libraries-build-work: %s\n' "$*" >&2; exit 1; }
mode=markdown
[[ ! -t 1 ]] || mode=tty
workspace_args=()
while [[ $# -gt 0 ]]; do
  case $1 in
    --tty) mode=tty; shift ;;
    --markdown|--md) mode=markdown; shift ;;
    --workspace)
      [[ $# -ge 2 && -n $2 && $2 != -* ]] || die '--workspace requires a slug'
      workspace_args=(--workspace "$2"); shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1 (see --help)" ;;
  esac
done
for dependency in gh linear jq; do
  command -v "$dependency" >/dev/null 2>&1 || die "missing dependency: $dependency"
done

umask 077
report_tmp=$(mktemp -d "${TMPDIR:-/tmp}/libraries-build-work.XXXXXX")
trap 'rm -rf "$report_tmp"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

linear_api() { linear api "$@" ${workspace_args[@]+"${workspace_args[@]}"}; }
check_response() {
  jq -e '(.errors // [] | length) == 0 and .data != null' "$1" >/dev/null ||
    die "invalid or failed GraphQL response: $(jq -c '.errors // .' "$1")"
}

printf 'Gathering Linear assignments and ECO work...\n' >&2
linear_api '{ viewer { id name } teams(filter: { key: { eq: "ECO" } }) { nodes { id name } } }' > "$report_tmp/viewer.json"
check_response "$report_tmp/viewer.json"
jq -e '.data.viewer.id and (.data.teams.nodes | length > 0)' "$report_tmp/viewer.json" >/dev/null ||
  die 'could not identify the Linear user or ECO team; check --workspace'

linear_query='query LibrariesBuildIssues($filter: IssueFilter!, $after: String) {
  issues(first: 100, after: $after, includeArchived: false, filter: $filter) {
    nodes {
      id identifier title url priority dueDate updatedAt
      state { name type } assignee { id name } team { key }
    }
    pageInfo { hasNextPage endCursor }
  }
}'
fetch_issues() {
  local filter=$1 destination=$2 after=null variables next
  : > "$report_tmp/issue-pages.jsonl"
  while :; do
    variables=$(jq -nc --argjson filter "$filter" --argjson after "$after" '{filter: $filter, after: $after}')
    linear_api "$linear_query" --variables-json "$variables" > "$report_tmp/issue-page.json"
    check_response "$report_tmp/issue-page.json"
    jq -e '.data.issues.nodes | type == "array"' "$report_tmp/issue-page.json" >/dev/null || die 'missing Linear issues'
    jq -c '.data.issues.nodes[]' "$report_tmp/issue-page.json" >> "$report_tmp/issue-pages.jsonl"
    [[ $(jq -r '.data.issues.pageInfo.hasNextPage' "$report_tmp/issue-page.json") == true ]] || break
    next=$(jq -c '.data.issues.pageInfo.endCursor' "$report_tmp/issue-page.json")
    [[ $next != null && $next != "$after" ]] || die 'Linear pagination did not advance'
    after=$next
  done
  jq -s 'unique_by(.id) | sort_by((if .priority == 0 then 5 else .priority end), (.dueDate // "9999"), .identifier)' \
    "$report_tmp/issue-pages.jsonl" > "$destination"
}

active_filter='{"state":{"type":{"nin":["completed","canceled"]}}}'
mine_filter=$(jq -nc --argjson active "$active_filter" '$active + {assignee: {isMe: {eq: true}}}')
eco_filter=$(jq -nc --argjson active "$active_filter" '
  $active + {team: {key: {eq: "ECO"}}, or: [
    ["mentat", "judge", "axlotl"][] as $term |
    {title: {containsIgnoreCase: $term}},
    {description: {containsIgnoreCase: $term}},
    {labels: {name: {containsIgnoreCase: $term}}},
    {project: {name: {containsIgnoreCase: $term}}}
  ]}')
fetch_issues "$mine_filter" "$report_tmp/mine.json"
fetch_issues "$eco_filter" "$report_tmp/eco.json"

printf 'Gathering open mono PRs and changed paths...\n' >&2
# Keep nested file pagination separate from the outer PR connection.
gh api graphql --hostname github.com --paginate -f query='
  query LibrariesBuildPRs($endCursor: String) {
    repository(owner: "chainguard-dev", name: "mono") {
      pullRequests(states: OPEN, first: 25, after: $endCursor) {
        nodes {
          number title body url isDraft headRefName updatedAt reviewDecision
          author { login }
          reviewRequests { totalCount }
          decisiveReviews: reviews(states: [APPROVED, CHANGES_REQUESTED]) { totalCount }
          files(first: 100) { nodes { path } filePage: pageInfo { hasNextPage endCursor } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }' > "$report_tmp/pr-pages.json"
jq -se 'length > 0 and all(.[]; (.errors // [] | length) == 0 and (.data.repository.pullRequests.nodes | type == "array"))' \
  "$report_tmp/pr-pages.json" >/dev/null || die 'failed to fetch GitHub PRs'
jq -s '[.[].data.repository.pullRequests.nodes[] |
  select(.isDraft == false) |
  select(.reviewDecision == "REVIEW_REQUIRED" or .reviewRequests.totalCount > 0 or
    (.reviewDecision == null and .decisiveReviews.totalCount == 0))
] | unique_by(.number) | .[]' "$report_tmp/pr-pages.json" > "$report_tmp/candidates.jsonl"

: > "$report_tmp/prs.jsonl"
while IFS= read -r pr; do
  # Only fetch extra file pages when the first page and metadata do not match.
  if ! jq -e '[.title, .body, .headRefName, .files.nodes[].path] | any((. // "") | test("mentat|judge|axlotl"; "i"))' <<< "$pr" >/dev/null; then
    [[ $(jq -r '.files.filePage.hasNextPage' <<< "$pr") == true ]] || continue
    number=$(jq -r '.number' <<< "$pr")
    cursor=$(jq -r '.files.filePage.endCursor' <<< "$pr")
    gh api graphql --hostname github.com --paginate -F number="$number" -f endCursor="$cursor" -f query='
      query LibrariesBuildFiles($number: Int!, $endCursor: String) {
        repository(owner: "chainguard-dev", name: "mono") {
          pullRequest(number: $number) {
            files(first: 100, after: $endCursor) {
              nodes { path } pageInfo { hasNextPage endCursor }
            }
          }
        }
      }' > "$report_tmp/file-pages.json"
    jq -se 'length > 0 and all(.[]; (.errors // [] | length) == 0 and (.data.repository.pullRequest.files.nodes | type == "array"))' \
      "$report_tmp/file-pages.json" >/dev/null || die "failed to fetch files for PR #$number"
    jq -se '[.[].data.repository.pullRequest.files.nodes[].path] | any(test("mentat|judge|axlotl"; "i"))' \
      "$report_tmp/file-pages.json" >/dev/null || continue
  fi
  printf '%s\n' "$pr" >> "$report_tmp/prs.jsonl"
done < <(jq -c '.' "$report_tmp/candidates.jsonl")
jq -s 'sort_by(.updatedAt) | reverse' "$report_tmp/prs.jsonl" > "$report_tmp/prs.json"

bold='' reset=''
if [[ $mode == tty && -t 1 && -z ${NO_COLOR+x} && ${TERM:-dumb} != dumb ]]; then
  bold=$'\033[1m'; reset=$'\033[0m'
fi
jq -nr --arg mode "$mode" --arg bold "$bold" --arg reset "$reset" \
  --arg generated "$(date -u '+%Y-%m-%d %H:%M UTC')" \
  --slurpfile viewer "$report_tmp/viewer.json" --slurpfile prs "$report_tmp/prs.json" \
  --slurpfile mine "$report_tmp/mine.json" --slurpfile eco "$report_tmp/eco.json" '
  def clean: tostring | gsub("[\u0000-\u001f\u007f-\u009f]"; " ");
  def md: clean | gsub("&"; "&amp;") | gsub("<"; "&lt;") | gsub(">"; "&gt;") |
    gsub("\\\\"; "\\\\") | gsub("\\*"; "\\*") | gsub("_"; "\\_") |
    gsub("`"; "\\`") | gsub("\\["; "\\[") | gsub("\\]"; "\\]") | gsub("\\|"; "\\|");
  def text: if $mode == "markdown" then md else clean end;
  def heading($level; $title):
    if $mode == "markdown" then ("#" * $level) + " " + ($title | md)
    else $bold + ($title | clean) + $reset end;
  def entry($label; $url; $details):
    if $mode == "markdown" then "- [\($label | md)](<\($url | gsub("[<>\\s]"; ""))>) — \($details | md)"
    else "  \($label | clean)\n    \($details | clean)\n    \($url | clean)" end;
  def issues($items):
    if ($items | length) == 0 then "No matching issues."
    else $items[] | entry("\(.identifier) \(.title)"; .url;
      "\(.state.name) · \(["No priority", "Urgent", "High", "Medium", "Low"][.priority]) · \(.assignee.name // "Unassigned")" +
      (if .dueDate then " · due \(.dueDate)" else "" end)) end;
  heading(1; "Libraries Build work"), "",
  ("Generated \($generated) · Linear: \($viewer[0].data.viewer.name)" | text), "",
  heading(2; "PRs needing review — chainguard-dev/mono (\($prs[0] | length))"), "",
  (if ($prs[0] | length) == 0 then "No matching PRs."
   else $prs[0][] | entry("#\(.number) \(.title)"; .url;
     "@\(.author.login // "deleted") · \(.reviewDecision // "UNREVIEWED") · \(.reviewRequests.totalCount) review requests · updated \(.updatedAt[:10])") end), "",
  heading(2; "Assigned to me — all Linear teams (\($mine[0] | length))"), "",
  issues($mine[0]), "",
  heading(2; "ECO — mentat, judge, axlotl (\($eco[0] | length))"), "",
  issues($eco[0])
'
