#!/bin/bash

# thread-reply.sh [-r] THREAD_ID < body
#
# Replies to a PR review thread (a thread `id` from pr-status.sh) with the body on
# stdin; -r also resolves it. Prints the reply's URL.

set -euo pipefail

usage() {
  echo "Usage: $0 [-r] THREAD_ID < body" >&2
  exit 1
}

RESOLVE=false
while getopts "r" opt; do
  case $opt in
    r) RESOLVE=true ;;
    *) usage ;;
  esac
done
shift $((OPTIND - 1))
(( $# == 1 )) || usage

body=$(cat)
[[ -n ${body//[[:space:]]/} ]] || { echo "Empty reply body." >&2; exit 1; }

gh api graphql -f id="$1" -f body="$body" -f query='
  mutation($id: ID!, $body: String!) {
    addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $id, body: $body}) {
      comment { url }
    }
  }' --jq '.data.addPullRequestReviewThreadReply.comment.url'

if [[ $RESOLVE == true ]]; then
  gh api graphql -f id="$1" -f query='
    mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }' >/dev/null
fi
