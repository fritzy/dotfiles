#!/bin/bash

# standup-count.sh [-v] [file]
#
# Counts what a standup draft links, so its stats reply matches the post:
#   - unique PRs in the body, excluding the Blockers and Next sections
#   - unique Linear issues in the body's Tickets sub-sections (the stats count), and
#     those linked only from other lines such as PR descriptions
#   - :pr-merged: and :pr: tags in the body
#   - PRs and issues linked from Blockers and Next, reported separately
# Reads markdown drafts (`- **Next**`, `  - Tickets`) or the Slack-rendered text
# (`• *Next*`, `    ◦ Tickets`), from the file or stdin. Issues count only when linked
# to linear.app, so bare mentions don't.
#   -v  list the counted links

set -euo pipefail

VERBOSE=false
while getopts "v" opt; do
  case $opt in
    v) VERBOSE=true ;;
    *) echo "Usage: $0 [-v] [file]" >&2; exit 1 ;;
  esac
done
shift $((OPTIND - 1))

# Tag each line with its top-level section (body, blockers, next) and, inside the body,
# its sub-section (PRs, Tickets, ...).
awk '
  /^(- |• )/ {
    section = "body"; sub_section = ""
    if ($0 ~ /^(- |• )\*+Blockers/) section = "blockers"
    else if ($0 ~ /^(- |• )\*+Next/) section = "next"
  }
  /^(  - |    ◦ )[A-Z][A-Za-z]*( |$)/ {
    sub_section = $0
    sub(/^(  - |    ◦ )/, "", sub_section)
    sub(/ .*/, "", sub_section)
  }
  { if (section == "") section = "body"; print section "\t" sub_section "\t" $0 }
' "${1:-/dev/stdin}" | jq -Rrs --argjson verbose "$VERBOSE" '
  split("\n") | map(select(. != "") | capture("^(?<section>[a-z]+)\t(?<sub>[^\t]*)\t(?<text>.*)$"))
  | def prs: [ .[].text | scan("github\\.com/([^/]+/[^/]+)/pull/([0-9]+)") | "\(.[0] | split("/")[1])#\(.[1])" ] | unique;
    def issues: [ .[].text | scan("linear\\.app/[^/]+/issue/([A-Z][A-Z0-9]*-[0-9]+)")[0] ] | unique;
    def tag($t): [ .[].text | scan($t) ] | length;
    def n($word): "\(length) \($word)\(if length == 1 then "" else "s" end)";
    def list($xs): if $verbose and ($xs | length) > 0 then "    " + ($xs | join(" ")) else empty end;
  (map(select(.section == "body"))) as $body
  | ($body | map(select(.sub == "Tickets")) | issues) as $tickets
  | (($body | issues) - $tickets) as $linked
  | (map(select(.section == "blockers"))) as $blockers
  | (map(select(.section == "next"))) as $next
  | "Body: \($body | prs | n("PR")); \($tickets | n("issue")) in Tickets, \($linked | n("more issue")) linked elsewhere",
    list($body | prs), list($tickets), list($linked),
    "Tags: \($body | tag(":pr-merged:")) :pr-merged:, \($body | tag(":pr:")) :pr:",
    "Blockers: \($blockers | prs | n("PR")), \($blockers | issues | n("issue"))",
    list($blockers | prs),
    "Next: \($next | prs | n("PR")), \($next | issues | n("issue"))",
    list(($next | prs) + ($next | issues))
'
