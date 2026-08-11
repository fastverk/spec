# spec portal

The authoring console: requirements, the terms they depend on, and the grounding
conversation that binds those terms to real records.

## Running it

Two services, then the portal.

```sh
# 1. the read model — regenerate whenever the corpus changes
python3 tools/readmodel/emit_readmodel.py

# 2. spec, serving the read model over HTTP
bazel build //services/spec:spec-server
SPEC_READMODEL_DIR=$PWD/services/spec/readmodel SPEC_SOURCE_ROOT=$PWD \
  ./bazel-bin/services/spec/spec-server --http-addr 127.0.0.1:8091

# 3. the portal
cd portal && pnpm install
DEV_SESSION='user_savvi_staff@org_...' pnpm dev     # http://127.0.0.1:5174
```

⚠ `--http-addr` is a FLAG, not an env var. Without it the server binds 8080 and
the portal's proxy finds nothing. `SPEC_READMODEL_DIR` is an env var and defaults
to `./spec/services/spec/readmodel` — a path that exists only when this repo is
checked out inside another one, so it looks broken locally in a way that reports
every route as "read model unavailable" rather than as an error.

## The grounding adapter is a separate origin, on purpose

`/api/ground/*` proxies to a PROJECT (Studio on `:3010`), not to spec. spec never
queries a project database: the project evaluates in its own environment and
returns counts. Without the adapter running, the Grounding pane says so and shows
nothing — a missing answer, which is not the same as an empty one.

`DEV_SESSION` exists because the adapter is staff-gated and the portal is a
different origin, so its cookies never reach it. It reuses Studio's own dev-login
path (`DEV_AUTH_ENABLED`, which AUTH-66 forbids outside local development) rather
than adding a bypass to the product. Unset it and probes return 401.

## What the panes show, and what they cannot

The read model is the whole data source, so a pane is empty exactly when the work
behind it has not been done. Nothing here is stubbed to look further along than
it is:

| pane | state today |
|---|---|
| Requirements | 133 rows across the corpora |
| Grounding | 60 distinct terms, all open; 3 surfaces have a proposed reading |
| Conflicts, Proof | populated from the corpus; empty means none recorded |
| Plan mode, Liveness | not built — the pane says so rather than showing a mock |
