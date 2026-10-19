#!/bin/bash
# draft.sh [-s YYYY-MM-DD] [-u YYYY-MM-DD] [-c config.json] [-o report.html] [-f] [-n]
#
# Scripted work-report draft: gather GitHub and Linear activity with the
# work-summary scripts, draft content.json, build the HTML, and screenshot it.
# Days run 4 AM → 4 AM, except Monday: 6 PM Sunday → 4 AM Tuesday (config.json
# day_start_hour, monday_start_sunday_hour; logic in days.py).
#   -s  window start (default: Monday of last week)
#   -u  window end, inclusive (default: yesterday; today is partial and drags
#       the per-day averages down, so include it only when asked)
#   -c  config (default: config.json). One whose author.login isn't you reports on that
#       person: author.linear (email or Linear user id) is required, there's no standup
#       log, and working files get a -<login> suffix.
#   -o  report path (default: ~/notes/work/<year>/work-report-<start>-<end>-<login>.html)
#   -f  redraft content.json even if one exists (discards edits to it)
#   -n  no gather: rebuild from the cached gh.json / linear.json
#
# Working files live in ${XDG_STATE_HOME:-~/.local/state}/work-report/<start>[-<login>]/.
# An existing content.json is kept, so edits survive a rebuild with fresh data.

set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
skill=$(dirname "$here")
start="" end="" out="" config=$skill/config.json redraft=false gather=true

while getopts "s:u:c:o:fn" opt; do
  case $opt in
    s) start=$OPTARG ;;
    u) end=$OPTARG ;;
    c) config=$OPTARG ;;
    o) out=$OPTARG ;;
    f) redraft=true ;;
    n) gather=false ;;
    *) sed -n '2,19p' "$0" >&2; exit 1 ;;
  esac
done

days() { python3 -I "$here/days.py" "$@" "$config"; }

login=$(jq -r '.author.login' "$config")
gh_user=() lin_user=() tag="" standup_log=${XDG_STATE_HOME:-$HOME/.local/state}/work-summary/posts.jsonl
if [[ $login != "$(gh api user --jq .login)" ]]; then
  linear_user=$(jq -r '.author.linear // empty' "$config")
  [[ -n $linear_user ]] || { echo "$config: author.linear is required to report on $login" >&2; exit 1; }
  gh_user=(-U "$login" -L "$linear_user") lin_user=(-U "$linear_user") tag=-$login standup_log=""
fi
# "today" is the day in progress (before 4 AM it's still yesterday)
today=$(days today)
[[ -n $start ]] || start=$(days default-start)
[[ -n $end ]] || end=$(date -d "$today -1 day" +%F)
read -r since until < <(days bounds "$start" "$end")
[[ -n $out ]] || out=$HOME/notes/work/${start%%-*}/work-report-$start-$end-$login.html

work=${XDG_STATE_HOME:-$HOME/.local/state}/work-report/$start$tag
mkdir -p "$work" "$(dirname "$out")"

window="$since $until"
if ! $gather && [[ $(cat "$work/window" 2>/dev/null) != "$window" ]]; then
  echo "Cached data doesn't cover $start → $end; gathering" >&2
  gather=true
fi

if $gather; then
  until_args=()
  # -u is exclusive; the scripts default to now
  [[ $end < $today ]] && until_args=(-u "$until")
  echo "Gathering $start → $end ..." >&2
  (cd /tmp && bash "$HOME/.scripts/gh-activity.sh" -A -S "$since" ${until_args[@]+"${until_args[@]}"} ${gh_user[@]+"${gh_user[@]}"} -j) > "$work/gh.json"
  (cd /tmp && bash "$HOME/.scripts/linear-activity.sh" -S "$since" ${until_args[@]+"${until_args[@]}"} ${lin_user[@]+"${lin_user[@]}"} -j) > "$work/linear.json"
  echo "$window" > "$work/window"
fi

if $redraft || [[ ! -s $work/content.json ]]; then
  python3 -I "$here/draft_content.py" --gh "$work/gh.json" --linear "$work/linear.json" \
    --config "$config" --start "$start" --end "$end" \
    ${standup_log:+--standup-log "$standup_log"} --out "$work/content.json"
else
  echo "Keeping existing $work/content.json (-f to redraft)" >&2
fi

python3 -I "$here/build_report.py" --gh "$work/gh.json" --linear "$work/linear.json" \
  --content "$work/content.json" --start "$start" --end "$end" --out "$out"
python3 -I "$here/screenshot.py" "$out" "$work/summary.png"

echo "report:     $out"
echo "screenshot: $work/summary.png"
echo "content:    $work/content.json"
