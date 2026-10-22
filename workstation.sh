#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
export PATH="$HOME/.local/bin:$PATH"

case "${1:-}" in
  --local) shift; exec bash "$root/bootstrap-worklaptop.sh" "$@" ;;
  --remote) shift; exec bash "$root/bootstrap-workstation.sh" "$@" ;;
  *)
    echo 'Run bootstrap.sh first, then bootstrap-worklaptop.sh or bootstrap-workstation.sh.' >&2
    exit 2
    ;;
esac
