---
name: argo-monitor
description: "Monitor active Argo workflows and pods for the ecosystems-rebuilder.js clusters (namespace workflows-js). Use when asked to list active argo/kube jobs, check what workflows are running, get a workflow status breakdown, see which step a workflow is on, or tail workflow logs. Trigger terms: argo jobs, active workflows, workflows-js, list argo jobs, kube jobs, workflow status, what's running on the cluster."
metadata:
  tags: argo, kubernetes, kubectl, workflows, monitoring, workflows-js, ecosystems
---

## Clusters

| Environment | Project | Cluster | Region | Namespaces |
|-------------|---------|---------|--------|------------|
| **Prod** | prod-eco-js-rmk3 | eco | us-central1 | workflows-js (workflows), argo (backfiller) |
| **Dev** | dev-eco-jb8z | eco | us-central1 | workflows-js (workflows), argo (backfiller) |

Assumes kubeconfig already has the eco cluster context. If not:

```bash
gcloud container clusters get-credentials eco --project prod-eco-js-rmk3 --region us-central1
```

Workflows are Argo `Workflow` CRDs — use raw `kubectl` (not `argo list`).
Completed workflows are TTL-cleaned after ~3 minutes, so listings are mostly
active + failed. Failed pods are deliberately retained for inspection — filter
on phase, don't assume listed means live.

## Status breakdown

Counts by phase — the first thing to run:

```bash
kubectl -n workflows-js get workflows -o custom-columns='STATUS:.status.phase' --no-headers | sort | uniq -c
```

## List active workflows

```bash
kubectl -n workflows-js get workflows --field-selector=status.phase=Running
```

## Which step is each active workflow on?

```bash
kubectl -n workflows-js get workflows -o json | jq -r '
  .items[] | select(.status.phase == "Running") |
  "\(.metadata.name) nodes=\([.status.nodes[] | select(.type == "Pod") |
  select(.phase == "Running") | "\(.displayName):\(.phase)"] | join(", "))"'
```

## Active pods

```bash
kubectl -n workflows-js get pods --field-selector=status.phase=Running

# Pending pods (scheduling problems)
kubectl -n workflows-js get pods --field-selector=status.phase=Pending
```

## Recent failures

```bash
# Failed in the last 10 minutes (GNU date; on macOS use: date -u -v-10M ...)
kubectl -n workflows-js get workflows -o json | jq -r --arg since "$(date -u -d '-10 minutes' +%Y-%m-%dT%H:%M:%SZ)" \
  '[.items[] | select(.status.phase == "Failed") | select(.status.finishedAt > $since)] |
  sort_by(.status.finishedAt) | reverse | .[:10] | .[] |
  "\(.metadata.name) finished=\(.status.finishedAt) message=\(.status.message)"'

# Failed-pod messages inside still-running workflows
kubectl -n workflows-js get workflows -o json | jq -r '
  .items[] | select(.status.phase == "Running") |
  .status.nodes[] | select(.type == "Pod") | select(.phase == "Failed") |
  "\(.displayName): \(.message)"'
```

## Logs

```bash
# Main container (actual job output)
kubectl -n workflows-js logs <pod-name> -c main

# Wait container (Argo executor, deadline info)
kubectl -n workflows-js logs <pod-name> -c wait

# All containers for a workflow (add -f to follow)
kubectl -n workflows-js logs -l workflows.argoproj.io/workflow=<workflow-name> --all-containers
```

## Deeper debugging

For failure diagnosis, known failure signatures, backfiller queue ops, and a
polling mode, use the full `argo-debug` skill in the ecosystems-rebuilder.js
repo: `~/projects/ecosystems-rebuilder.js/skills/argo-debug/` (its
`scripts/poll.sh` collects all monitoring data as one JSON snapshot). Read its
`rules/production-safety.md` before any destructive kubectl operation.
