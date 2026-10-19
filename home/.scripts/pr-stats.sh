#!/bin/bash

# pr-stats.sh [-m] [-j] [file | owner/repo#123 | PR URL ...]
#
# Prints state, author, merge time and +/- lines for GitHub PRs, with totals.
# PRs come from the arguments: files (markdown or Slack text, which links PRs as
# <url|text>), PR URLs, or owner/repo#123 refs. With no arguments, reads stdin.
#   -m  merged PRs only (e.g. a week's line count from its standup posts)
#   -j  JSON instead of a markdown table

set -euo pipefail

MERGED_ONLY=false
JSON=false

while getopts "mj" opt; do
  case $opt in
    m) MERGED_ONLY=true ;;
    j) JSON=true ;;
    *) echo "Usage: $0 [-m] [-j] [file | owner/repo#123 | PR URL ...]" >&2; exit 1 ;;
  esac
done
shift $((OPTIND - 1))

input() {
  if (( $# == 0 )); then
    cat
    return
  fi
  local arg
  for arg in "$@"; do
    if [[ -f $arg ]]; then
      cat "$arg"
    elif [[ $arg =~ ^([^/[:space:]]+/[^#[:space:]]+)#([0-9]+)$ ]]; then
      echo "https://github.com/${BASH_REMATCH[1]}/pull/${BASH_REMATCH[2]}"
    else
      echo "$arg"
    fi
  done
}

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

# owner/repo<TAB>number, one per unique PR.
refs=$(input "$@" \
  | grep -oE 'github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/pull/[0-9]+' \
  | sed -E 's#github\.com/([^/]+/[^/]+)/pull/([0-9]+)#\1\t\2#' \
  | sort -u || true)

if [[ -z $refs ]]; then
  echo "No GitHub PR links found." >&2
  exit 1
fi

# One aliased query: r<i> per repo, p<n> per PR.
query=$(printf '%s\n' "$refs" | jq -Rrs '
  split("\n") | map(select(. != "") | split("\t") | {repo: .[0], number: (.[1] | tonumber)})
  | group_by(.repo) | to_entries
  | "query { " + (map(
      (.value[0].repo | split("/")) as [$o, $n]
      | "r\(.key): repository(owner: \"\($o)\", name: \"\($n)\") { "
        + (.value | map("p\(.number): pullRequest(number: \(.number)) { ...F }") | join(" ")) + " }"
    ) | join(" ")) + " }
    fragment F on PullRequest {
      number url title state isDraft mergedAt additions deletions changedFiles
      author { login } repository { nameWithOwner }
    }"
')

gh api graphql -f query="$query" --jq '[.data[] | values | .[] | values]' \
  | jq --argjson merged_only "$MERGED_ONLY" '
      map({
        repo: .repository.nameWithOwner, number, url, title, author: (.author.login // "ghost"),
        state: (if .isDraft and .state == "OPEN" then "draft" else (.state | ascii_downcase) end),
        mergedAt, additions, deletions, changedFiles
      })
      | map(select(($merged_only | not) or .state == "merged"))
      | sort_by(.mergedAt // "~", .repo, .number)
    ' > "$tmp"

if [[ $JSON == true ]]; then
  jq '{
    prs: .,
    totals: {prs: length, additions: (map(.additions) | add // 0),
             deletions: (map(.deletions) | add // 0), files: (map(.changedFiles) | add // 0)},
    byRepo: (group_by(.repo) | map({repo: .[0].repo, prs: length,
             additions: (map(.additions) | add), deletions: (map(.deletions) | add)}))
  }' "$tmp"
  exit 0
fi

jq -r '
  def n: tostring | if length > 3 then .[:-3] + "," + .[-3:] else . end;
  "| PR | author | state | merged | + | − | files |",
  "|---|---|---|---|---:|---:|---:|",
  (.[] | "| [\(.repo | split("/")[1])#\(.number)](\(.url)) \(.title | .[:60]) | \(.author) | \(.state) | \(.mergedAt // "" | .[:10]) | \(.additions | n) | \(.deletions | n) | \(.changedFiles) |"),
  "| **Total (\(length) PRs)** | | | | **\(map(.additions) | add // 0 | n)** | **\(map(.deletions) | add // 0 | n)** | \(map(.changedFiles) | add // 0) |",
  "",
  (group_by(.repo)[] | "- \(.[0].repo): \(length) PR\(if length == 1 then "" else "s" end), +\(map(.additions) | add | n) / −\(map(.deletions) | add | n)")
' "$tmp"
