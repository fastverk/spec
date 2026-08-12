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

npx eve build && npx eve dev
```

⛔ **`SPEC_AGENT_BEDROCK_MODEL` must be set for `build` AND for `dev`/`start`.**
`agent.ts` is evaluated once at build time to compile the manifest and again at
runtime to resolve the model. Set it for only one and they disagree:
`MODEL_SELECTION_FAILED: Expected the authored agent config … to provide a dynamic
model definition`.

**Model access is per-model per-region in the Bedrock console and is off by
default.** An untouched account returns `AccessDeniedException` for a model that
plainly exists. That is the first thing to check if it fails.

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
python3 conformance/check_conformance.py     # 254 checks
python3 tools/readmodel/check_wiring.py      # 194 checks
cd console && pnpm test && pnpm typecheck    # 73 vitest cases
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
