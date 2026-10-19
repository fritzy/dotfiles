#!/bin/bash

# pr-mark.sh <pr> -n note key...   record feedback keys from pr-status.sh as handled
# pr-mark.sh <pr> -a check         count a rerun or fix of a failing check; prints the total
#
# <pr> is a PR URL or owner/repo#N.

set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  echo "Usage: $0 <pr> -n note key... | $0 <pr> -a check" >&2
  exit 1
}

(( $# >= 1 )) || usage
parse_pr "$1"
shift

NOTE=""
CHECK=""
while getopts "n:a:" opt; do
  case $opt in
    n) NOTE="$OPTARG" ;;
    a) CHECK="$OPTARG" ;;
    *) usage ;;
  esac
done
shift $((OPTIND - 1))

mkdir -p "$(dirname "$STATE")"
[[ -f $STATE ]] || echo '{}' > "$STATE"
tmp=$(mktemp "$STATE.XXXXXX")
trap 'rm -f "$tmp"' EXIT

if [[ -n $CHECK ]]; then
  jq --arg c "$CHECK" '.attempts[$c] += 1' "$STATE" > "$tmp"
  mv "$tmp" "$STATE"
  jq --arg c "$CHECK" '.attempts[$c]' "$STATE"
else
  [[ -n $NOTE ]] && (( $# > 0 )) || usage
  jq --arg note "$NOTE" --arg at "$(date -Iseconds)" \
    '.handled += ($ARGS.positional | map({key: ., value: {note: $note, at: $at}}) | from_entries)' \
    "$STATE" --args "$@" > "$tmp"
  mv "$tmp" "$STATE"
fi
