# spec console

The authoring console, as one Next.js app: requirements, the terms they depend
on, and what a check would actually examine.

## Running it

```sh
cd console && pnpm install
SPEC_AUTHOR='you@example.com' \
SPEC_PROPOSAL_LOG=/tmp/spec-proposals.jsonl \
  pnpm dev
# http://127.0.0.1:5175
```

That is the whole setup. There is no read-model server to start and no corpus to
regenerate first: the eight payloads are **imported** from
`services/spec/readmodel/*.json`, so they ship with the build.

⚠ `pnpm dev`, not `pnpm start`, if you want the write path. `next start` sets
`NODE_ENV=production` and the dev identity shim refuses to run in production —
deliberately, because a local convenience that survives into a deployment is an
authentication bypass with a friendly name. In production, identity comes from
Google OAuth, restricted to one Workspace domain (`GOOGLE_ALLOWED_DOMAIN`) —
see `DEPLOY.md`.

⚠ Unset `SPEC_PROPOSAL_LOG` and the console is **read-only**, and says so in
every pane rather than letting the buttons appear to work.

## What each environment variable does

| variable | effect |
|---|---|
| `DATABASE_URL` | Neon. What a deployment uses. Takes precedence over the file. |
| `SPEC_PROPOSAL_LOG` | a local JSONL file — exactly the shape the Rust service appends to, so local work is promotable by the same `materialize.py` invocation |
| `SPEC_EVALUATION_LOG` | measurements; defaults to `<proposal log>-evaluations.jsonl` |
| `SPEC_AUTHOR` | local dev identity. Unset ⇒ writes are refused, never attributed to nobody |
| `GROUNDING_ADAPTER_URL` | the project's grounding adapter. Unset ⇒ the Grounding pane says no adapter is answering |
| `SPEC_KERNEL_SUBS` | CSV of subs holding kernel capability. Empty means **nobody** — it fails closed |
| `SPEC_AGENT_SUBS` | CSV of subs treated as agents (`assertNS` at R0 only). A sub prefixed `agent:` is one regardless |
| `SPEC_MACHINE_TOKEN_SECRET` | signs machine credentials for `POST /api/evaluation` — a consumer CI's way in, and its only one. `openssl rand -hex 32`, **never `SESSION_SECRET`**. Unset ⇒ every bearer token is refused |
| `SPEC_MACHINE_TOKEN_REVOKED` | CSV of `jti`s to refuse — revokes one machine token by name |

## What you can do in it

- **Overview** — the funnel, and the two counts that matter: how many
  requirements are checked by nothing, and how many examine nothing.
- **Requirements** — search 133 rows, open one, reword it or withdraw it. Both
  are proposals against the read point in the sidebar; nothing is edited in place.
- **Grounding** — the term queue, ordered by how many claims wait on each word.
  Bind a term to a real referent, mark two surfaces as the same term, or clear a
  bad extraction as "not a term".
- **Proposals** — what has been decided, and whether the corpus has caught up.

## Seeing the thing this is all for

`AUTH-24` — *"sponsor:edit never implies deploy"* — is the measured finding that
motivated the console. Grounded on the deployer role it examines **zero** records
in Studio, so a check there would report success forever, having examined
nothing.

Record that honestly and the door accepts it:

```sh
curl -X POST localhost:5175/api/evaluation -H 'content-type: application/json' \
  -d '{"claim":"auth-24","implementation":"studio-nextjs","outcome":"Vacuous","population":0}'
# 202
```

Claim it passed, and the door refuses before anything is written:

```sh
curl -X POST localhost:5175/api/evaluation -H 'content-type: application/json' \
  -d '{"claim":"auth-24","implementation":"studio-nextjs","outcome":"Passes","population":0}'
# 422 — examined 0 records but reports Passes. An invariant that examined nothing
#       succeeds trivially; record it as Vacuous, which is what it is
```

`Examined` over zero is refused too — it is the same lie in a quieter voice.
Then open Requirements, search `auth-24`, and it reads **Examines nothing**.

A consumer's CI records the same kind of thing under a **machine credential**,
which this route accepts and no other does (RFC-004a §4):

```sh
export SPEC_MACHINE_TOKEN_SECRET=$(openssl rand -hex 32)   # before pnpm dev; must differ from SESSION_SECRET
TOKEN=$(node tools/mint-machine-token.mjs --implementation studio-nextjs)
curl -X POST localhost:5175/api/evaluation -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"claim":"auth-24","implementation":"studio-nextjs","outcome":"Examined","population":1412}'
# 202 — author machine:studio-nextjs
```

Change `Examined` to `Passes` and it is a 422: a machine reports, never judges.
Replay the token against `/api/proposal/op` and it is a 401: a machine may not
author. The consumer's half is `tools/evaluation/`.

## Promotion

The console never edits the corpus. Adopt what is waiting:

```sh
python3 tools/proposals/materialize.py \
    --log /tmp/spec-proposals.jsonl --corpus corpus/studio --project studio
python3 tools/readmodel/emit_readmodel.py
bazel test //corpus/studio/... //conformance/...
```

The log the console writes is byte-compatible with the Rust service's, so this is
the same command either way.

## Layout

```
lib/evaluation.ts   the vacuous refusal, and "a machine reports, never judges"
                                             ← conformance/evaluation_cases.json
lib/auth/machine.ts the machine credential — accepted by /api/evaluation and nowhere else
tools/              mint-machine-token.mjs, run on a laptop with the secret
lib/overlay.ts      pending + adoption       ← conformance/overlay_cases.json
lib/evaluated.ts    measurements, and stateOf (the display half of the refusal)
lib/proposal.ts     the closed op vocabulary, 17 constructors
lib/canonical.ts    canonical JSON — the pre-image of a content address
lib/corpus.ts       the imported read model, and CORPUS_VERSION
lib/store.ts        Neon | local JSONL | read-only
db/migrations/      the two append-only tables
```

`lib/evaluation.ts` and `lib/overlay.ts` implement rules that also exist in Rust.
Neither owns its test cases — both run `conformance/*.json`, and so does
`services/spec`. See `conformance/README.md` for why, and for which half of that
arrangement is not yet running in CI.

## Extraction

This directory is self-contained apart from two relative paths: the read-model
imports in `lib/corpus.ts` and the fixture path in `test/conformance.test.ts`.
Both become one package import when the console moves to its own repo, so
`git subtree split` plus two edits is the whole move.
