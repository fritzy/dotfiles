#!/bin/bash

# standup-log.sh last | record | list | week [-s YYYY-MM-DD] [-u YYYY-MM-DD]
#
# Local log of posted standups, one JSON object per line in
# ${XDG_STATE_HOME:-~/.local/state}/work-summary/posts.jsonl.
#   last    Print the newest record's cutoff (UTC ISO). The next summary starts there.
#   record  Append one JSON object read from stdin. Required: date (the day it covers),
#           cutoff (when its data was gathered). Optional: window_start, permalink, stats.
#           Records with the same date replace earlier ones.
#             {"date":"2026-10-14","cutoff":"2026-10-15T06:30:00Z",
#              "permalink":"https://...","stats":{"prs":{"unique":7,"merged":3},
#              "issues":{"unique":9,"filed":1}}}
#   list    Print the log as a table.
#   week    Sum each numeric stat over records dated in the window (default: Monday of
#           this week through today). Snapshot stats (open_for_review, draft) show the
#           latest value. Unique counts add across days, so repeats count again.

set -euo pipefail

LOG_DIR=${XDG_STATE_HOME:-$HOME/.local/state}/work-summary
LOG=$LOG_DIR/posts.jsonl
SNAPSHOT='["open_for_review", "draft"]'

cmd=${1:-}
[[ -n $cmd ]] && shift

case $cmd in
  last)
    [[ -s $LOG ]] || exit 0
    jq -rs 'max_by(.cutoff) | .cutoff' "$LOG"
    ;;

  record)
    mkdir -p "$LOG_DIR"
    record=$(jq -ce 'select(.date and .cutoff) | . + {recorded_at: (now | todate)}') \
      || { echo "record needs a JSON object with date and cutoff on stdin" >&2; exit 1; }
    touch "$LOG"
    jq -c --argjson r "$record" 'select(.date != $r.date)' "$LOG" > "$LOG.tmp"
    echo "$record" >> "$LOG.tmp"
    jq -sc 'sort_by(.date)[]' "$LOG.tmp" > "$LOG"
    rm -f "$LOG.tmp"
    echo "Recorded $(jq -r .date <<< "$record") (cutoff $(jq -r .cutoff <<< "$record")) in $LOG"
    ;;

  list)
    [[ -s $LOG ]] || { echo "No posts recorded in $LOG"; exit 0; }
    jq -rs '
      "| date | window start | cutoff | PRs | merged | issues | link |",
      "|---|---|---|---:|---:|---:|---|",
      (.[] | "| \(.date) | \(.window_start // "") | \(.cutoff) | \(.stats.prs.unique // "") | \(.stats.prs.merged // "") | \(.stats.issues.unique // "") | \(.permalink // "") |")
    ' "$LOG"
    ;;

  week)
    since="" until=""
    while getopts "s:u:" opt; do
      case $opt in
        s) since="$OPTARG" ;;
        u) until="$OPTARG" ;;
        *) echo "Usage: $0 week [-s YYYY-MM-DD] [-u YYYY-MM-DD]" >&2; exit 1 ;;
      esac
    done
    if [[ -z $since ]]; then
      dow=$(date +%u)
      since=$(date -d "-$((dow - 1)) days" +%F 2>/dev/null || date -v-"$((dow - 1))"d +%F)
    fi
    until=${until:-$(date +%F)}
    [[ -s $LOG ]] || { echo "No posts recorded in $LOG"; exit 0; }
    jq -rs --arg since "$since" --arg until "$until" --argjson snap "$SNAPSHOT" '
      map(select(.date >= $since and .date <= $until)) | sort_by(.date) as $posts
      | if ($posts | length) == 0 then "No posts recorded from \($since) to \($until)." else
        ($posts | map(.stats // {})) as $stats
        | [ $stats[] | paths(numbers) ] | unique as $paths
        | "**Week \($since) – \($until)** (\($posts | length) post\(if ($posts | length) == 1 then "" else "s" end): \($posts | map(.date[5:]) | join(", ")))",
          ( $paths | group_by(.[0])[] | .[0][0] as $group
            | "- **\($group)**",
              ( .[] | . as $p | ($p[1:] | join(".")) as $name
                | if ($snap | index($p[-1])) then
                    "  - \($name): \([ $stats[] | getpath($p) | numbers ] | join(", ")) (per post)"
                  else
                    "  - \($name): \([ $stats[] | getpath($p) | numbers ] | add)"
                  end ) ),
          ( [ $posts[] | select(.window_start != null and .window_start < $since) ] as $early
            | if ($early | length) > 0
              then "", "Note: \($early | map(.date) | join(", ")) covers days before \($since)."
              else empty end )
        end
    ' "$LOG"
    ;;

  *)
    echo "Usage: $0 last | record | list | week [-s YYYY-MM-DD] [-u YYYY-MM-DD]" >&2
    exit 1
    ;;
esac
