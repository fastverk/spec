# Running the console and the agent locally

Everything here runs without touching production. The console writes to a local
JSONL file unless you deliberately point it at Neon, and the agent has no door to
the log except the console you give it.

## Prerequisites

| | why |
|---|---|
| Node 22+ | the console |
| **Node 24+** | the agent — eve's own `engines` constraint, and it is enforced |
| pnpm 10 | the console's lockfile |
| AWS credentials with `bedrock:InvokeModel` | only for the agent, and only on the Bedrock route |

The two halves need different Node versions, so run them in separate shells with
whatever version manager you use.

---

## 1. The console

```sh
cd console
pnpm install

# ⛔ Local development only. `SPEC_AUTHOR` stands in for a signed-in Google
# account so writes have someone to be attributed to — invariant ⑤ is that
# nothing is attributed to nobody, and without this every write is refused
# rather than recorded anonymously.
export SPEC_AUTHOR='you@savvifi.com'

# The append-only log, as a file. Point this at a scratch path, NOT at
# logs/proposals.jsonl — that file is committed and gated, and the promotion
# pipeline reads it.
export SPEC_PROPOSAL_LOG=/tmp/spec-proposals.jsonl
touch "$SPEC_PROPOSAL_LOG"

pnpm dev            # http://127.0.0.1:5175
```

`GET /api/health` is the fastest check that it came up correctly:

```jsonc
{
  "log_backend": "jsonl",          // "neon" if DATABASE_URL is set
  "write_enabled": true,
  "principal": "present",          // "absent" ⇒ SPEC_AUTHOR is unset and writes will 401
  "grounding_adapter": "unset",
  "deployment": { "commit": "", "stage": "local" }
}
```

**Against Neon instead** — set `DATABASE_URL` to the **`spec_app`** credential, never
the owner. `spec_app` holds `INSERT` and `SELECT` and nothing else; the owner can
`ALTER TABLE … DISABLE TRIGGER`, which is the one thing the whole schema exists to
prevent. Migrations are CI's job (`.github/workflows/migrate.yml`), not a laptop's.

⚠ **Writes to Neon cannot be undone.** The log is append-only by trigger and by
grant, and the only cleanup for a test record is dropping the schema. Use the
JSONL backend to try things.

**As a machine** — the credential a consumer's CI would hold (RFC-004a §4):

```sh
export SPEC_MACHINE_TOKEN_SECRET=$(openssl rand -hex 32)   # set BEFORE pnpm dev; must differ from SESSION_SECRET
TOKEN=$(node tools/mint-machine-token.mjs --implementation studio-nextjs)
curl -s -X POST localhost:5175/api/evaluation \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"claim":"auth-24","implementation":"studio-nextjs","outcome":"Examined","population":1412}'
# 202 {"recorded":true,…,"author":"machine:studio-nextjs"}
tail -1 /tmp/spec-proposals-evaluations.jsonl
```

The same token against `/api/proposal/op` is a 401: it is accepted by the
evaluation route and nowhere else. `SPEC_AUTHOR` is not consulted while an
`Authorization` header is present — a presented credential is judged, never
ignored. `/api/health` reports `machine_credentials.configured` so a deployment
that forgot the secret reads as one.

### What to look at

| | |
|---|---|
| `/requirements` | the list, with each row's grounding fraction |
| `/requirements/auth-24` | **the one to look at.** The motivating claim, its two words highlighted by whether they point at anything, and the walkthrough |
| `/requirements/new` | write a requirement and watch the decomposition preview as you type |
| `/terms` | the same words as entities, ordered by how many claims each unblocks |
| `/terms/studio/sponsor:edit` | one word, and the 11 claims waiting on it |

A five-minute pass that exercises the whole loop:

1. Open `/requirements/auth-24` — *"2 of 2 terms not pinned down"*, both words amber.
2. Record a reading for `deploy:*` — say `permissions.key = 'deploy:*'`.
3. It turns green in the sentence, the bar moves to 1/2, and it leaves the walkthrough.
4. `/terms/studio/deploy:*` now shows what it reads as, and every claim that waited on it.
5. `cat $SPEC_PROPOSAL_LOG` — one record, with your author, the parent read point, and canonical bytes.

Nothing there has been *adopted*. Pending means differs-from-the-corpus, and
promotion is `tools/proposals/materialize.py` plus a human merging a PR.

---

## 2. The agent

```sh
cd agent            # Node 24 shell
npm install
```

### On Bedrock (no Vercel account involved)

```sh
export SPEC_AGENT_BEDROCK_MODEL="us.anthropic.claude-sonnet-4-5-20250929-v1:0"
export AWS_REGION=us-east-1
export SPEC_CONSOLE_URL=http://127.0.0.1:5175      # the console from §1

npx eve build

# ⛔ NOT `eve dev` — see "eve dev cannot build this agent" below.
VERCEL=1 VERCEL_ENV=development npx eve start
```

⛔ **`SPEC_AGENT_BEDROCK_MODEL` must be set for `build` AND for `dev`/`start`.**
`agent.ts` is evaluated once at build time to compile the manifest and again at
runtime to resolve the model. Set it for only one and they disagree:
`MODEL_SELECTION_FAILED: Expected the authored agent config … to provide a dynamic
model definition`.

#### ⛔ `eve dev` cannot build this agent, and `eve start` refuses the caller

Both halves of the documented `eve build && eve dev` path are broken, in
different ways, and the workaround above threads between them.

`eve dev` copies the agent into `.eve/dev-runtime/snapshots/<id>/source/agent/`
and builds from there. `agent/tools/preview_decomposition.ts` and
`propose_requirement.ts` import `../../../console/lib/decompose` — deliberately,
so the rule has one definition — and that path escapes the snapshot, which
contains no `console/`. The build fails with two `UNRESOLVED_IMPORT` errors
before the server starts. `eve build` is unaffected: it bundles from the real
tree, where the import resolves.

So the agent must be run from the production build, `eve start` — and *that*
rejects every request with `401 unauthorized`. `agent/channels/eve.ts` admits
`vercelOidc()` and `localDev()`, and `localDev()` returns a principal only when
`VERCEL` is set **and** `VERCEL_ENV === "development"`, or when eve is in dev
mode. Under `eve start` neither holds.

Hence `VERCEL=1 VERCEL_ENV=development`. It is a **local shim, and it must never
be set in a deployment** — it is the switch that makes the agent admit an
unauthenticated caller. The real fix is one of: give the agent its own copy of
the decomposition rule (losing the single-definition property the conformance
fixture exists to protect), make `console` a resolvable package rather than a
relative path, or add a real auth strategy to the channel.

#### Model access is per-model, per-account, and Anthropic wants a form

**Anthropic models on Bedrock additionally require a use-case details form to be
submitted for the account**, in the Bedrock console. Until it is, every Claude
model id returns:

```
ResourceNotFoundException: Model use case details have not been submitted for
this account. Fill out the Anthropic use case details form before using the
model.
```

That is a **404, not a 403**, and it names a model that `bedrock
list-foundation-models` will happily list — so it reads like a wrong model id
rather than an entitlement problem. Both `740659854426` and `491117466965`
returned it on 2026-08-12.

To tell entitlement apart from credentials, call a non-Anthropic model with the
same credentials — `us.amazon.nova-pro-v1:0` succeeded where every
`us.anthropic.*` id failed. If Nova answers, the credential chain, region and
signing are all correct and the problem is the form.

⚠ **`--profile` does not reach the provider.** `@ai-sdk/amazon-bedrock@5` signs
with `aws4fetch`; there is no `@aws-sdk/credential-providers` in the tree
(`grep -c @aws-sdk agent/package-lock.json` → 0) and `agent.ts` passes no
`credentialProvider`, so `AWS_PROFILE` is ignored. Materialize the credentials
instead:

```sh
eval "$(aws configure export-credentials --profile <profile> --format env)"
```

### On the Vercel AI Gateway instead

```sh
export AI_GATEWAY_API_KEY=…        # vercel.com/dashboard/ai/api-keys
npx eve build && npx eve dev
```

Blocked today with `customer_verification_required` — the AI Gateway will not
service inference until the Vercel team has a card on file. The credential itself
authenticates fine (`GET /v1/models` returns 200).

### Driving it without the TUI

```sh
SID=$(curl -s -X POST localhost:3000/eve/v1/session \
  -H 'content-type: application/json' \
  -d '{"message":"Which words carry weight in AUTH-24, and why?"}' | jq -r .sessionId)

curl -N "localhost:3000/eve/v1/session/$SID/stream"          # NDJSON events
```

An approval parks the run at `session.waiting`; answer it with:

```sh
curl -X POST "localhost:3000/eve/v1/session/$SID" \
  -H 'content-type: application/json' \
  -d '{"inputResponses":[{"requestId":"req_…","optionId":"approve"}]}'
```

### What it may do

Three tools. `preview_decomposition` runs the real rule, `read_corpus` reads
through the console's overlay, `propose_requirement` submits `assertNS` at R0
behind `always()` approval. There is no `bindTerm`, no tool that accepts a number,
and no agent principal — it writes through the same HTTP route the browser uses,
attributed to the human whose approval released it. `agent/README.md` has the
reasoning.

---

## 3. The gates, without Bazel

Most of the safety machinery runs on stdlib Python:

```sh
python3 conformance/check_conformance.py     # 295 checks
python3 tools/readmodel/check_wiring.py      # 194 checks
cd console && pnpm test && pnpm typecheck    # 108 vitest cases
```

The SPARQL gates need Bazel (`bazel test //rdf/...`), but they also run under
rdflib if you only want to look:

```sh
pip install rdflib
python3 - <<'PY'
import re
from rdflib import Graph
g = Graph()
for f in ["rdf/ontology/authoring.ttl", "rdf/lint/authoring/fixtures/envelope-undocumented.ttl"]:
    g.parse(f, format="turtle")
q = re.sub(r"\A# ---.*?\n# ---\n", "", open("rdf/lint/authoring/envelope-unrecorded.rq").read(), flags=re.S)
print(len(list(g.query(q))), "rows — expect 1")
PY
```

⚠ **ARQ is the engine that runs them in CI and it is the authority.** rdflib
disagrees with ARQ on at least one gate today: `conflict-hygiene-strict` finds 3
of its 4 planted defects under rdflib because of a date-comparison difference the
query's own comment documents. Do not "fix" a gate against rdflib.
