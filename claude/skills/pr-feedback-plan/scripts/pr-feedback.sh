#!/usr/bin/env bash
# Gather every piece of feedback on a GitHub PR (inline review comments,
# review summaries, and issue comments) into one markdown file, with links to
# the comment anchors and the code each comment refers to embedded inline.
#
# Usage: drop/pr-feedback.sh [PR_NUMBER] [-o OUTPUT.md] [-R owner/repo]
set -euo pipefail

REPO=""
PR=""
OUT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--out)  OUT="$2"; shift 2 ;;
    -R|--repo) REPO="$2"; shift 2 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *)         PR="$1"; shift ;;
  esac
done

command -v gh >/dev/null || { echo "gh CLI is required" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

[[ -n "$REPO" ]] || REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
if [[ -z "$PR" ]]; then
  PR="$(gh pr view --json number -q .number)"
fi
[[ -n "$OUT" ]] || OUT="drop/pr-${PR}-feedback.md"

REPO_ROOT="$(git rev-parse --show-toplevel)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Fetching feedback for ${REPO}#${PR} ..." >&2
gh api "repos/${REPO}/pulls/${PR}"          > "$WORK/pr.json"
gh api "repos/${REPO}/pulls/${PR}/comments"  --paginate --slurp | jq 'flatten' > "$WORK/inline.json"
gh api "repos/${REPO}/pulls/${PR}/reviews"   --paginate --slurp | jq 'flatten' > "$WORK/reviews.json"
gh api "repos/${REPO}/issues/${PR}/comments" --paginate --slurp | jq 'flatten' > "$WORK/issues.json"

# Language hint for a fenced block, from the file extension.
lang_for() {
  case "${1##*.}" in
    go)            echo go ;;
    sh|bash)       echo bash ;;
    tf|tfvars)     echo hcl ;;
    ya?ml)         echo yaml ;;
    json)          echo json ;;
    md)            echo markdown ;;
    proto)         echo proto ;;
    py)            echo python ;;
    ts|tsx)        echo typescript ;;
    js|jsx)        echo javascript ;;
    sql)           echo sql ;;
    *)             echo "" ;;
  esac
}

# Print ±CONTEXT lines of the current working-tree file around a line number.
CONTEXT=6
emit_snippet() {
  local path="$1" line="$2" file="${REPO_ROOT}/$1"
  [[ -f "$file" && "$line" =~ ^[0-9]+$ ]] || return 0
  local start=$(( line - CONTEXT )); (( start < 1 )) && start=1
  local end=$(( line + CONTEXT ))
  printf '<details><summary>Current code — <code>%s</code> around line %s</summary>\n\n' "$path" "$line"
  printf '```%s\n' "$(lang_for "$path")"
  awk -v s="$start" -v e="$end" 'NR>=s && NR<=e { printf "%6d\t%s\n", NR, $0 }' "$file"
  printf '```\n\n</details>\n\n'
}


# Re-print a comment body, demoting its markdown headings by DEPTH levels so
# embedded bodies don't fight the document's own heading structure. Fenced
# code blocks are left alone.
demote_body() {
  local depth="$1"
  awk -v d="$depth" '
    /^[[:space:]]*(```|~~~)/ { fence = !fence; print; next }
    !fence && /^#{1,6} / {
      n = 0; while (substr($0, n+1, 1) == "#") n++
      extra = d; if (n + extra > 6) extra = 6 - n
      pad = ""; for (i = 0; i < extra; i++) pad = pad "#"
      print pad $0; next
    }
    { print }
  '
}

# GitHub's diff_hunk can be the whole file for a newly added file. The comment
# always anchors to the hunk's LAST line, so keep the @@ header plus the tail.
HUNK_TAIL=20
trim_hunk() {
  awk -v keep="$HUNK_TAIL" '
    { lines[NR] = $0 }
    END {
      if (NR <= keep + 1) { for (i = 1; i <= NR; i++) print lines[i]; exit }
      print lines[1]
      printf "... (%d lines elided)\n", NR - keep - 1
      for (i = NR - keep + 1; i <= NR; i++) print lines[i]
    }
  '
}

field() { jq -r --arg k "$1" '.[$k] // "" | tostring' "$WORK/rec.json"; }

TITLE="$(jq -r .title "$WORK/pr.json")"
PRURL="$(jq -r .html_url "$WORK/pr.json")"
HEADSHA="$(jq -r .head.sha "$WORK/pr.json")"
N_INLINE=$(jq 'length' "$WORK/inline.json")
N_REVIEWS=$(jq '[.[] | select((.body // "") != "")] | length' "$WORK/reviews.json")
N_ISSUE=$(jq 'length' "$WORK/issues.json")

{
  printf '# Feedback on [%s#%s](%s)\n\n' "$REPO" "$PR" "$PRURL"
  printf '**%s**\n\n' "$TITLE"
  printf '_Collected %s by `drop/pr-feedback.sh`. Head commit `%s`._\n\n' "$(date -u '+%Y-%m-%d %H:%MZ')" "${HEADSHA:0:12}"
  printf -- '- Inline review comments: **%s**\n' "$N_INLINE"
  printf -- '- Review summaries: **%s**\n' "$N_REVIEWS"
  printf -- '- General PR comments: **%s**\n\n' "$N_ISSUE"

  printf '### Index\n\n'
  jq -r 'sort_by(.path, (.in_reply_to_id // .id), .created_at)
         | map(select(.in_reply_to_id == null))
         | .[]
         | "- [`\(.path):\(.line // .original_line)`](\(.html_url)) — @\(.user.login)"
           + (if .line == null then " *(outdated)*" else "" end)
           + " — " + ((.body // "") | gsub("\r";"") | split("\n")
                        | map(select(test("^[[:space:]]*$") | not))
                        | (.[0] // "")
                        | gsub("[*`_]";"") | .[0:110])' \
     "$WORK/inline.json"
  printf '\n'

  printf -- '---\n\n'

  ###########################################################################
  printf '## Inline review comments\n\n'
  if [[ "$N_INLINE" -eq 0 ]]; then
    printf '_None._\n\n'
  else
    prev_path=""
    # Sort so replies follow their thread root, threads grouped per file.
    jq -r 'sort_by(.path, (.in_reply_to_id // .id), .created_at) | .[] | @base64' "$WORK/inline.json" |
    while read -r rec; do
      printf '%s' "$rec" | base64 -d > "$WORK/rec.json"
      path="$(field path)"
      user="$(jq -r '.user.login // "unknown"' "$WORK/rec.json")"
      line="$(jq -r '.line // .original_line // empty' "$WORK/rec.json")"
      startline="$(jq -r '.start_line // empty' "$WORK/rec.json")"
      url="$(field html_url)"
      created="$(field created_at)"
      reply="$(field in_reply_to_id)"
      hunk="$(jq -r '.diff_hunk // ""' "$WORK/rec.json")"
      body="$(jq -r '.body // ""' "$WORK/rec.json")"
      outdated="$(jq -r 'if .line == null then " *(outdated — anchored to an older commit)*" else "" end' "$WORK/rec.json")"

      if [[ "$path" != "$prev_path" ]]; then
        printf '### `%s`\n\n' "$path"
        prev_path="$path"
      fi

      loc="$line"
      [[ -n "$startline" && "$startline" != "$line" ]] && loc="${startline}-${line}"

      if [[ -n "$reply" && "$reply" != "null" ]]; then
        printf '**↳ Reply from @%s** — [comment](%s) · %s\n\n' "$user" "$url" "$created"
        printf '%s\n' "$(printf '%s' "$body" | demote_body 4)"; printf '\n'
      else
        printf '#### [%s:%s](%s) — @%s%s\n\n' "$path" "$loc" "$url" "$user" "$outdated"
        printf '_%s_\n\n' "$created"
        if [[ -n "$hunk" ]]; then
          printf 'Diff the comment is anchored to (comment sits on the last line):\n\n'
          printf '```diff\n%s\n```\n\n' "$(printf '%s\n' "$hunk" | trim_hunk)"
        fi
        emit_snippet "$path" "$line"
        printf '%s\n' "$(printf '%s' "$body" | demote_body 4)"; printf '\n'
      fi
      printf -- '---\n\n'
    done
  fi

  ###########################################################################
  printf '## Review summaries\n\n'
  if [[ "$N_REVIEWS" -eq 0 ]]; then
    printf '_None._\n\n'
  else
    jq -r '[.[] | select((.body // "") != "")] | sort_by(.submitted_at) | .[] | @base64' "$WORK/reviews.json" |
    while read -r rec; do
      printf '%s' "$rec" | base64 -d > "$WORK/rec.json"
      printf '### [Review by @%s — %s](%s)\n\n' \
        "$(jq -r '.user.login' "$WORK/rec.json")" \
        "$(field state)" \
        "$(field html_url)"
      printf '_%s_\n\n' "$(field submitted_at)"
      jq -r '.body' "$WORK/rec.json" | demote_body 3
      printf '\n\n---\n\n'
    done
  fi

  ###########################################################################
  printf '## General PR comments\n\n'
  if [[ "$N_ISSUE" -eq 0 ]]; then
    printf '_None._\n\n'
  else
    jq -r 'sort_by(.created_at) | .[] | @base64' "$WORK/issues.json" |
    while read -r rec; do
      printf '%s' "$rec" | base64 -d > "$WORK/rec.json"
      printf '### [Comment by @%s](%s)\n\n' \
        "$(jq -r '.user.login' "$WORK/rec.json")" \
        "$(field html_url)"
      printf '_%s_\n\n' "$(field created_at)"
      author="$(jq -r '.user.login' "$WORK/rec.json")"
      if [[ "$author" == *"[bot]" ]]; then
        printf '<details><summary>Bot comment (expand)</summary>\n\n'
        jq -r '.body' "$WORK/rec.json" | demote_body 3
        printf '\n\n</details>\n'
      else
        jq -r '.body' "$WORK/rec.json" | demote_body 3
      fi
      printf '\n\n---\n\n'
    done
  fi
} > "$OUT"

echo "Wrote $OUT ($(wc -l < "$OUT") lines, $(wc -c < "$OUT") bytes)" >&2
