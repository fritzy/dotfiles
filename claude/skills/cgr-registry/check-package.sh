#!/usr/bin/env bash
# Check package/version existence via the serve-v2 check API:
#   GET /javascript/-/api/packages/check
#
# Usage:
#   check-package.sh express@5.2.1 '@types/node@24.0.0' lodash ...
#
# Specs may be pkg@version or bare pkg (existence of any version).
#
# Output (tab-separated):
#   <spec>\tbuilt      — version exists as Chainguard-built (SOURCE_TYPE_INTERNAL)
#   <spec>\tupstream   — version exists only as upstream passthrough (SOURCE_TYPE_UPSTREAM_REGISTRY)
#   <spec>\tmissing    — version not found in either source
#   <spec>\texists     — bare-package spec, some version exists
#   <spec>\tnot-found  — bare-package spec, no versions
#   <spec>\tERROR:<reason>

set -u

REGISTRY="${REGISTRY:-https://libraries.cgr.dev/javascript}"
CHECK_URL="$REGISTRY/-/api/packages/check"

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <pkg>[@<ver>] [<pkg>[@<ver>]...]" >&2
  exit 2
fi

LIBS_TOKEN="${LIBS_TOKEN:-$(chainctl auth token --audience libraries.cgr.dev)}"
[[ -n "$LIBS_TOKEN" ]] || { echo "failed to get LIBS_TOKEN" >&2; exit 1; }

# check <pkg> <ver> <source_type> — prints "true"/"false", returns 1 on HTTP error.
# NOTE: source_type is required when version is set; omitting it 500s server-side.
check() {
  local pkg="$1" ver="$2" st="$3" body code
  body=$(curl -sS -G -w '\n%{http_code}' \
    -H "Authorization: Bearer $LIBS_TOKEN" \
    --data-urlencode "packageName=$pkg" \
    ${ver:+--data-urlencode "version=$ver"} \
    ${st:+--data-urlencode "source_type=$st"} \
    "$CHECK_URL") || { echo "000"; return 1; }
  code="${body##*$'\n'}"
  [[ "$code" == "200" ]] || { echo "$code"; return 1; }
  jq -r '.exists' <<<"${body%$'\n'*}"
}

for spec in "$@"; do
  # Split on LAST '@' so scoped packages work; bare '@scope/name' has no version.
  if [[ "$spec" == *@* && "${spec%@*}" != "" ]]; then
    ver="${spec##*@}"
    pkg="${spec%@*}"
  else
    ver=""
    pkg="$spec"
  fi

  if [[ -z "$ver" ]]; then
    if out=$(check "$pkg" "" ""); then
      [[ "$out" == "true" ]] && printf '%s\texists\n' "$spec" || printf '%s\tnot-found\n' "$spec"
    else
      printf '%s\tERROR:http-%s\n' "$spec" "$out"
    fi
    continue
  fi

  if out=$(check "$pkg" "$ver" "SOURCE_TYPE_INTERNAL"); then
    if [[ "$out" == "true" ]]; then
      printf '%s\tbuilt\n' "$spec"
      continue
    fi
  else
    printf '%s\tERROR:http-%s\n' "$spec" "$out"
    continue
  fi

  if out=$(check "$pkg" "$ver" "SOURCE_TYPE_UPSTREAM_REGISTRY"); then
    [[ "$out" == "true" ]] && printf '%s\tupstream\n' "$spec" || printf '%s\tmissing\n' "$spec"
  else
    printf '%s\tERROR:http-%s\n' "$spec" "$out"
  fi
done
