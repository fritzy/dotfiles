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
