#!/usr/bin/env bash
# Print the dist.tarball URL for each pkg@version from libraries.cgr.dev/javascript/.
#
# Usage:
#   tarball-url.sh '@types/d3-delaunay@6.0.1' express@5.2.1 ...
#
# Output (tab-separated):
#   <spec>\t<tarball-url>
#   or  <spec>\tERROR:<reason>

set -u

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <pkg>@<ver> [<pkg>@<ver>...]" >&2
  exit 2
fi

LIBS_TOKEN="${LIBS_TOKEN:-$(chainctl auth token --audience libraries.cgr.dev)}"
[[ -n "$LIBS_TOKEN" ]] || { echo "failed to get LIBS_TOKEN" >&2; exit 1; }

CACHE_DIR="$(mktemp -d -t pkmt.XXXXXX)"
trap 'rm -rf "$CACHE_DIR"' EXIT

fetch_packument() {
  local pkg="$1"
  local safe="${pkg//\//__}"
  local out="$CACHE_DIR/$safe.json"
  if [[ -s "$out" ]]; then return 0; fi
  local code
  code=$(curl -sS -o "$out" -w '%{http_code}' \
    -H "Authorization: Bearer $LIBS_TOKEN" \
    -H "Accept: application/json" \
    "https://libraries.cgr.dev/javascript/$pkg") || code=000
  [[ "$code" == "200" ]] || { rm -f "$out"; echo "$code"; return 1; }
  return 0
}

for spec in "$@"; do
  # Split on LAST '@' so scoped packages work: @scope/name@1.2.3
  ver="${spec##*@}"
  pkg="${spec%@*}"
  if [[ -z "$pkg" || -z "$ver" || "$pkg" == "$spec" ]]; then
    printf '%s\tERROR:bad-spec\n' "$spec"
    continue
  fi

  if ! code=$(fetch_packument "$pkg"); then
    printf '%s\tERROR:http-%s\n' "$spec" "$code"
    continue
  fi

  safe="${pkg//\//__}"
  url=$(jq -r --arg v "$ver" '.versions[$v].dist.tarball // "MISSING"' "$CACHE_DIR/$safe.json"
)
  if [[ "$url" == "MISSING" || -z "$url" ]]; then
    printf '%s\tERROR:version-not-found\n' "$spec"
  else
    printf '%s\t%s\n' "$spec" "$url"
  fi
done
