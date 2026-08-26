---
name: cgr-registry
description: "Authenticate and interact with Chainguard's npm registry at libraries.cgr.dev/javascript. Use when downloading tarballs, fetching packuments, or running npm/curl commands against the cgr npm registry. Trigger terms include: cgr registry, libraries.cgr.dev, cgr npm, download tarball from cgr, cgr auth, chainctl auth libraries."
metadata:
  tags: cgr, npm, registry, auth, chainguard, libraries.cgr.dev
---

## Registry

The Chainguard npm registry is at:

```
https://libraries.cgr.dev/javascript
```

## Authentication

Tokens are short-lived (~1 hour). Get one with:

```bash
LIBS_TOKEN=$(chainctl auth token --audience libraries.cgr.dev)
```

Verify it works:

```bash
curl -sf -H "Authorization: Bearer $LIBS_TOKEN" \
  "https://libraries.cgr.dev/javascript/express" | head -c 200
```

## Fetch a packument

```bash
LIBS_TOKEN=$(chainctl auth token --audience libraries.cgr.dev)
curl -sf -H "Authorization: Bearer $LIBS_TOKEN" \
  "https://libraries.cgr.dev/javascript/<package-name>"
```

For scoped packages, the `@scope/name` form works as-is in the URL path.

## Classifying versions: built vs. upstream

A packument covers a package as a whole, but **each version within it is classified
independently** — a package can have some versions Chainguard-built and others
upstream-only. Classify a specific version by its own `dist.tarball` URL in the
packument (not by the packument's request URL or any other field):

- `.../javascript/<name>/-/<name>-<version>.tgz` — that version is Chainguard-**built**
  (rebuilt from source and signed).
- `.../javascript-upstream/<name>/-/<name>-<version>.tgz` — that version is a
  passthrough of the **upstream** npm registry, unmodified.

## Check API: does a package/version exist?

serve-v2 exposes a JSON check endpoint (defined in mono at
`ecosystems/serve-v2/js/internal/server/api.go`, `apiCheckPackage`):

```
GET https://libraries.cgr.dev/javascript/-/api/packages/check?packageName=<name>[&version=<ver>][&source_type=<st>]
```

Response: `{"exists": true|false, "packageName": "...", "version": "..."}`.

- `source_type` values: `SOURCE_TYPE_INTERNAL` (Chainguard-built),
  `SOURCE_TYPE_INTERNAL_REMEDIATED`, `SOURCE_TYPE_UPSTREAM_REGISTRY` (passthrough).
- **When `version` is set, `source_type` is required** — omitting it returns a
  500 (`failed to check package version`).
- Without `version`, it checks whether the package has any versions;
  `source_type` is optional and repeatable there.
- Sibling endpoints: `/-/api/packages` (list), `/-/api/packages/<name>/versions`,
  `/-/api/search?query=...`.

### Batch helper: check-package.sh

`check-package.sh` (in this skill's directory) checks specs against the check API
and classifies them. Same auth handling as check-integrity.sh (`$LIBS_TOKEN` or
chainctl). Version is optional per spec; scoped packages work.

```bash
~/.claude/skills/cgr-registry/check-package.sh express@5.2.1 '@types/node@24.0.0' lodash
```

Tab-separated output, one line per spec: `built` / `upstream` / `missing` for
`pkg@version` specs, `exists` / `not-found` for bare packages, `ERROR:<reason>`
otherwise. Prefer this over check-integrity.sh when you only need existence /
classification — it's lighter than fetching full packuments.

### cg CLI alternative

For whole lockfiles, mono's `cg` tool wraps the same endpoint:
`cg libraries coverage check js <package-lock.json>...` (flags: `--token`,
`--workers`, `--index-url`, `--output json`). It only takes lockfiles, not
ad-hoc specs — use check-package.sh for those.

### Batch helper: check-integrity.sh

`check-integrity.sh` (in this skill's directory) resolves one or more `pkg@version`
specs to their `dist.tarball` URLs in a single run — the fastest way to classify
many versions as built vs. upstream. It handles auth itself (uses `$LIBS_TOKEN` if
set, otherwise fetches a token via `chainctl`), caches packuments so repeated
versions of the same package cost one request, and supports scoped packages.

```bash
~/.claude/skills/cgr-registry/check-integrity.sh '@types/d3-delaunay@6.0.1' express@5.2.1
```

Output is tab-separated, one line per spec:

```
<spec>\t<tarball-url>      # classify by /javascript/ vs /javascript-upstream/ in the URL
<spec>\tERROR:<reason>     # bad-spec | http-<code> | version-not-found
```

Prefer this script over hand-rolled curl loops when checking more than a couple of
versions.

## Download a tarball

Tarball URL pattern:
- Unscoped: `https://libraries.cgr.dev/javascript/<name>/-/<name>-<version>.tgz`
- Scoped:   `https://libraries.cgr.dev/javascript/@<scope>/<name>/-/<name>-<version>.tgz`

```bash
LIBS_TOKEN=$(chainctl auth token --audience libraries.cgr.dev)

# Unscoped example
curl -fL -H "Authorization: Bearer $LIBS_TOKEN" \
  "https://libraries.cgr.dev/javascript/express/-/express-5.2.1.tgz" \
  -o express-5.2.1.tgz

# Scoped example
curl -fL -H "Authorization: Bearer $LIBS_TOKEN" \
  "https://libraries.cgr.dev/javascript/@0no-co/graphql.web/-/graphql.web-1.0.13.tgz" \
  -o graphql.web-1.0.13.tgz
```

## Configure npm to use the registry

```bash
LIBS_TOKEN=$(chainctl auth token --audience libraries.cgr.dev)
npm config set registry https://libraries.cgr.dev/javascript
npm config set //libraries.cgr.dev/javascript/:_authToken "$LIBS_TOKEN"
```

Restore after:

```bash
npm config set registry https://registry.npmjs.org
npm config delete //libraries.cgr.dev/javascript/:_authToken
```

## Token expiry

Tokens expire in ~1 hour. For long batch operations, refresh mid-run:

```bash
LIBS_TOKEN=$(chainctl auth token --audience libraries.cgr.dev)
```

No restart of any process is needed — just re-export the variable and pass it in subsequent requests.
