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

# 3. spec, with the WRITE PATH on (see below)
SPEC_PROPOSAL_LOG=/tmp/spec-proposals.jsonl ...same command as above...

# 4. the portal
cd portal && pnpm install
DEV_SESSION='user_savvi_staff@org_...' SPEC_AUTHOR='you@example.com' pnpm dev
# http://127.0.0.1:5174
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

## Writing: proposals, not saves

Nothing in the portal edits the corpus. Every act — binding a term, clearing a
bad extraction, merging two surfaces, rewording or withdrawing a requirement,
writing a new one — is submitted as an **op** against spec's closed vocabulary,
checked, and appended to an append-only log with its author and the corpus
version they were looking at.

```
click  ──▶  POST /proposal/op  ──▶  append-only log  ──▶  overlaid on reads
                                          │                as PENDING
                                          ▼
                        tools/proposals/materialize.py
                                          │
                                          ▼
                     corpus/<project>/proposals.ttl  ──▶  the gates
```

Two properties this keeps, both load-bearing:

- **`pending` means "differs from the corpus", never "is in the log".** The log
  is never rewritten, so a proposal stays in it forever; badging on presence
  would leave adopted work reading "not yet adopted" permanently.
- **Promotion is a deliberate step**, reviewable like a merge. Between "someone
  clicked a button" and "the specification changed" there is a diff a person
  can read, and gates that run over the result.

⚠ `SPEC_PROPOSAL_LOG` unset means read-only. The Proposals pane says so plainly
rather than letting the buttons appear to work.

⚠ `SPEC_AUTHOR` is local dev only. spec refuses a write with no principal — an
append-only log of anonymous edits is worse than no log — and in production the
console's gateway injects the identity headers instead.

Adopt what is waiting:

```sh
python3 tools/proposals/materialize.py \
    --log /tmp/spec-proposals.jsonl --corpus corpus/studio --project studio
python3 tools/readmodel/emit_readmodel.py     # re-project for the portal
bazel test //corpus/studio/...                # the gates, over the result
```

## Theme

Light, dark, or follow the system — cycled from the toolbar, remembered in
`localStorage`. "Follow the system" is stored as itself rather than resolved at
save time, so someone who never touched the toggle still tracks their OS when it
flips.

## What the panes show, and what they cannot

The read model is the whole data source, so a pane is empty exactly when the work
behind it has not been done. Nothing here is stubbed to look further along than
it is:

| pane | state today |
|---|---|
| Requirements | 133 rows across the corpora |
| Grounding | 60 distinct terms; 3 surfaces have a proposed reading. Terms cleared as "not a term" leave the queue |
| Proposals | what has been decided and whether it is adopted yet |
| Conflicts, Proof | populated from the corpus; empty means none recorded |
| Plan mode, Liveness | not built — the pane says so rather than showing a mock |
