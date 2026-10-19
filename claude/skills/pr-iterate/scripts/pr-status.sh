#!/bin/bash

# pr-status.sh [PR URL | owner/repo#N]
#
# One pr-iterate round's view of a PR, as JSON: merge state, failing and pending
# checks, unresolved review threads, reviews and PR comments. With no argument,
# uses the current branch's PR.
#
# Feedback items carry a `key`, `trusted` and `handled`. A key is handled once
# pr-mark.sh records it; a thread's key is its latest comment by someone else, so a
# new reply reopens it. Handled items are listed without bodies. `unhandled` counts
# trusted items that aren't handled yet.
#
# Trusted: you, repo owners/members/collaborators and GitHub App bots.
# PR_ITERATE_TRUSTED adds logins (space-separated).

set -euo pipefail

# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
parse_pr "${1:-}"

# mergeStateStatus is still behind a preview header.
fetch() {
  gh api graphql -H "Accept: application/vnd.github.merge-info-preview+json" \
    -f owner="$OWNER" -f name="$REPO" -F number="$NUMBER" -f query='
      query($owner: String!, $name: String!, $number: Int!) {
        viewer { login }
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            url title state isDraft headRefName baseRefName headRefOid
            author { login }
            headRepository { nameWithOwner }
            mergeable mergeStateStatus reviewDecision isInMergeQueue
            autoMergeRequest { enabledAt }
            commits(last: 1) { nodes { commit { committedDate } } }
            reviewRequests(first: 20) { nodes { requestedReviewer {
              ... on User { login } ... on Bot { login } ... on Team { slug }
            } } }
            reviewThreads(first: 100) { nodes {
              id isResolved isOutdated path line
              comments(first: 50) { nodes { id url body createdAt authorAssociation author { login __typename } } }
            } }
            reviews(last: 100) { nodes { id url body state submittedAt authorAssociation author { login __typename } } }
            comments(last: 100) { nodes { id url body createdAt authorAssociation author { login __typename } } }
          }
        }
      }' --jq '{viewer: .data.viewer.login, pr: .data.repository.pullRequest}'
}

# GitHub computes mergeability lazily; the first query after a push is often UNKNOWN.
data=$(fetch)
for _ in 1 2 3; do
  [[ $(jq -r '.pr.state + " " + .pr.mergeable' <<<"$data") == "OPEN UNKNOWN" ]] || break
  sleep 3
  data=$(fetch)
done

# gh pr checks paginates (mono runs 140+ checks); its exit code reflects check state.
checks() {
  local out
  out=$(gh pr checks "$URL" "$@" 2>&1) || true
  if jq -e 'type == "array"' <<<"$out" >/dev/null 2>&1; then
    printf '%s\n' "$out"
  elif [[ $out == *"no checks reported"* || $out == *"no required checks reported"* ]]; then
    echo '[]'
  else
    printf '%s\n' "$out" >&2
    exit 1
  fi
}
all_checks=$(checks --json name,bucket,link,workflow)
required=$(checks --required --json name)

state_json=$(cat "$STATE" 2>/dev/null || echo '{}')

jq -n \
  --argjson d "$data" --argjson checks "$all_checks" --argjson required "$required" \
  --argjson st "$state_json" --arg state "$STATE" --arg extra "${PR_ITERATE_TRUSTED:-}" '
  $d.viewer as $me
  | $d.pr as $pr
  | ($st.handled // {}) as $handled
  | ($extra | split(" ") | map(select(. != ""))) as $extra
  | ($required | map(.name)) as $req
  | def who: .author.login // "ghost";
    def trusted: who == $me or (.authorAssociation | IN("OWNER", "MEMBER", "COLLABORATOR"))
      or .author.__typename == "Bot" or (who | IN($extra[]));
    def body: (.body // "") | if length > 4000 then .[:4000] + "\n…(truncated; see url)" else . end;
    # Handled items keep only enough to identify them.
    def brief: if .handled then {key, author, url, handled, note} else . end;

  [ $pr.reviewThreads.nodes[] | select(.isResolved | not)
    | .comments.nodes as $c
    | ([$c[] | select(who != $me)] | last // ($c | last)) as $k
    | {key: $k.id, id, path, line, outdated: .isOutdated, url: $c[0].url, author: ($c[0] | who),
       trusted: ($k | trusted), handled: ($handled[$k.id] != null), note: $handled[$k.id].note,
       comments: [$c[] | {author: who, trusted: trusted, createdAt, body: body}]}
    | brief ] as $threads
  | [ $pr.reviews.nodes[] | select(who != $me)
      | select((.body // "") != "" or .state == "CHANGES_REQUESTED")
      | {key: .id, author: who, state, url, submittedAt, trusted: trusted,
         handled: ($handled[.id] != null), note: $handled[.id].note, body: body}
      | brief ] as $reviews
  | [ $pr.comments.nodes[] | select(who != $me)
      | {key: .id, author: who, url, createdAt, trusted: trusted,
         handled: ($handled[.id] != null), note: $handled[.id].note, body: body}
      | brief ] as $comments
  | {
      pr: {url: $pr.url, title: $pr.title, state: $pr.state, isDraft: $pr.isDraft,
           author: ($pr | who), headRef: $pr.headRefName, headRepo: $pr.headRepository.nameWithOwner,
           baseRef: $pr.baseRefName, headSha: $pr.headRefOid},
      viewer: $me,
      state: $state,
      merge: {
        # Same rule as mergeable-prs.sh.
        mergeable: ($pr.mergeStateStatus | IN("CLEAN", "HAS_HOOKS", "UNSTABLE")),
        mergeState: $pr.mergeStateStatus,
        conflicts: ($pr.mergeable == "CONFLICTING"),
        review: ($pr.reviewDecision // "NONE"),
        changesRequestedBy: ([$pr.reviews.nodes[] | select(.state | IN("APPROVED", "CHANGES_REQUESTED", "DISMISSED"))]
          | group_by(who) | map(last | select(.state == "CHANGES_REQUESTED") | who)),
        pendingReviewers: [$pr.reviewRequests.nodes[].requestedReviewer | .login // .slug],
        inMergeQueue: $pr.isInMergeQueue,
        autoMerge: ($pr.autoMergeRequest != null)
      },
      checks: {
        counts: ($checks | group_by(.bucket) | map({key: .[0].bucket, value: length}) | from_entries),
        failing: [$checks[] | select(.bucket | IN("fail", "cancel"))
          | {name, workflow, link, required: (.name | IN($req[])),
             runId: ([(.link // "") | capture("/actions/runs/(?<id>[0-9]+)") | .id | tonumber] | .[0]),
             attempts: ($st.attempts[.name] // 0)}],
        pending: [$checks[] | select(.bucket == "pending") | {name, required: (.name | IN($req[]))}]
      },
      unhandled: ([$threads[], $reviews[], $comments[] | select(.trusted and (.handled | not))] | length),
      lastActivity: ([$pr.commits.nodes[0].commit.committedDate, $pr.reviews.nodes[].submittedAt,
        $pr.comments.nodes[].createdAt, $pr.reviewThreads.nodes[].comments.nodes[].createdAt]
        | map(select(. != null)) | max),
      threads: $threads,
      reviews: $reviews,
      comments: $comments
    }
'
