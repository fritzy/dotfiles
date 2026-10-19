# Sourced by the pr-iterate scripts.

# parse_pr [PR URL | owner/repo#N]: sets OWNER, REPO, NUMBER, URL and STATE (this
# PR's state file). With no argument, uses the current branch's PR.
parse_pr() {
  local ref=${1:-}
  [[ -n $ref ]] || ref=$(gh pr view --json url -q .url)
  if [[ $ref =~ github\.com/([^/]+)/([^/]+)/pull/([0-9]+) || $ref =~ ^([^/[:space:]]+)/([^#[:space:]]+)#([0-9]+)$ ]]; then
    OWNER=${BASH_REMATCH[1]} REPO=${BASH_REMATCH[2]} NUMBER=${BASH_REMATCH[3]}
  else
    echo "Not a PR URL or owner/repo#N: $ref" >&2
    exit 1
  fi
  URL="https://github.com/$OWNER/$REPO/pull/$NUMBER"
  STATE="${XDG_STATE_HOME:-$HOME/.local/state}/pr-iterate/$OWNER/$REPO/$NUMBER.json"
}
