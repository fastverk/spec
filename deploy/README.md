# Deploying the `spec` plugin

The `spec` plugin is a read-only console BFF: it scans a git-synced source tree
(`$SPEC_SOURCE_ROOT`) for the estate's formal specs and serves three console
tables (Specs / Contracts / Proof-Status) over `/api/gw/spec/*`.

## Image

Built by the promoted `fastverk_plugin` macro:

```sh
bazel build //services/spec:spec-image                      # local
bazel run   //services/spec:spec-image_push -- --tag <sha>  # push ghcr.io/fastverk/spec-server:<sha>
```

## Registration (how the console finds it)

The fastverk-deploy operator's `ConsolePlugin` reconciler renders a Deployment +
Service but its `ensureRegistered` step is a stub, so the console picks the plugin
up by one of:

1. **In-cluster (preferred):** the Service carries label `fastverk.dev/plugin=spec`
   with a named `http` port → botnoc-web's `discovery.rs` maps it to
   `http://spec.<ns>.svc.cluster.local:8080`. Verify the operator stamps that
   label (it renders `app.kubernetes.io/*` but not `fastverk.dev/plugin` today —
   patch it, or add the label to the Service).
2. **Env:** set `FASTVERK_BACKEND_SPEC=<base-url>` on botnoc-web (`gateway.rs`).

## Source tree (the one real deploy dependency)

The index is a filesystem scan, so the pod needs the estate checked out at
`$SPEC_SOURCE_ROOT` (immediate subdirs = repos). The `ConsolePlugin` CRD models
`env` but **not** volumes / a git-sync sidecar, so provide the tree out-of-band:

- a **git-sync sidecar** + shared `emptyDir` mounted at `SPEC_SOURCE_ROOT` (the
  pattern modgraph-operator uses — `gitSync.periodSeconds` bounds freshness), or
- an existing **synced PVC** shared with other read-only consumers.

Deploy via a Deployment/Helm chart carrying that sidecar+volume rather than the
bare `ConsolePlugin` CR when you need live data; the CR alone yields an empty
index (the honest pre-sync posture) until the mount exists. Extending the
`ConsolePlugin` CRD with a `sourceSync` field is the clean follow-up.

## Local iteration (no cluster)

```sh
SPEC_SOURCE_ROOT=/path/to/fastverk/repos \
SPEC_REPOS=botnoc,agora,rules_postgres \
PORT_ADDR=127.0.0.1:8091 \
bazel run //services/spec:spec-server        # or cargo run -p spec-server
curl -s localhost:8091/specs | jq '.specs | length'
```
