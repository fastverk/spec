# The markup assistant

An [eve](https://vercel.com/eve) agent that helps a person find the words in a
requirement that carry weight, and proposes the sentence as a claim.

It exists because of one measurement: the corpus decomposer reads a requirement's
`code spans` and **emphasis** and infers nothing from the prose, so a sentence
written with no markup produces no terms and can never be checked by anything.
**Twenty-two of Studio's twenty-three undecomposed requirements are in exactly
that state**, and nothing ever told their authors.

## What it may do, and what it structurally cannot

| | |
|---|---|
| `preview_decomposition` | Runs the **real** rule and returns the terms, the dropped spans, and whether the sentence decomposes to nothing. |
| `read_corpus` | Reads requirements through the console's overlay. Reports truncation rather than hiding it. |
| `propose_requirement` | `assertNS` at R0, behind `always()` approval. The only write. |

Everything else is **absent rather than denied**, which is a stronger refusal
than one that argues:

- **No `bindTerm`.** Binding says a word points at a population of real records.
  That is a judgement about someone's business made against a count the agent
  cannot see, and it is the one step in this pipeline a machine is not qualified
  for.
- **No tool that accepts a number.** Every refusal in this system tests the
  *magnitude* of a population and none tests its *provenance*, so a count the
  model typed would be indistinguishable from a count something measured.
- **No `amendNS`, `retractNS`, or evaluation.** `console/lib/proposal.ts` rejects
  every agent op that is not `assertNS` at R0, before the capability table. That
  rule was left enforced and the agent built to need nothing more, rather than
  amended to make an agent design work.

**There is no agent principal.** The agent holds no database credential and no
identity in the log. It writes through `POST /api/proposal/op` — the same route
the browser posts to — so the closed vocabulary, the parent read point, the
canonical bytes and the append-only table all apply unchanged. `surface` is
recorded as `Agent`, a value the schema's CHECK has always accepted and nothing
has ever set; `author` is the human whose approval released the write.

## One rule, three runners

`preview_decomposition` imports `console/lib/decompose.ts` directly rather than
restating the rule in a prompt. A model asked to "find the marked terms" is right
most of the time and confidently wrong on the cases that matter — a five-word
bolded clause, a surface marked both ways, an odd number of backticks — which are
exactly the cases the author needs the truth about.

`conformance/decomposition_cases.json` holds fifteen cases and is executed
against both `tools/import/decompose.py` and `console/lib/decompose.ts` on every
PR, so the agent, the console's live preview and the corpus decomposer cannot
disagree about what a sentence decomposes to.

## Running it

Requires **Node ≥ 24** (eve's own `engines` constraint) and a model credential.

```sh
npm install
AI_GATEWAY_API_KEY=… SPEC_CONSOLE_URL=http://127.0.0.1:5175 npx eve dev
```

### On Bedrock instead, bypassing the Vercel AI Gateway

```sh
export SPEC_AGENT_BEDROCK_MODEL="us.anthropic.claude-sonnet-4-5-20250929-v1:0"
export AWS_REGION=us-east-1
npx eve build && npx eve start          # AWS creds from env, or a task role
```

Verified to reach `bedrock-runtime.us-east-1.amazonaws.com/model/…/converse-stream`
through `@ai-sdk/amazon-bedrock` with no Vercel in the path. The provider pins the
same `@ai-sdk/provider@4.0.7` that eve's `ai@7` peer resolves, so it needs no shim.

Worth it beyond the billing: the prompt carries a customer's authorization
vocabulary — their roles, their permission names, their org structure. Invariant ①
keeps their DATA out of spec; their MODEL still goes to whoever serves the tokens,
and Bedrock keeps that in an account SAVVI controls. On Fargate or Lambda a task
role signs the request, so there is no key in an environment variable and nothing
to rotate.

**Two footguns, both hit while wiring this, both loud rather than silent:**

1. **The env var must be set for `build` AND for `start`.** `agent.ts` is
   evaluated at build time to compile the manifest, and again at runtime to
   resolve the dynamic model. Set it for only one and the two disagree —
   `MODEL_SELECTION_FAILED: Expected the authored agent config … to provide a
   dynamic model definition`.
2. **A live provider may only be returned from `step.started`.** A static
   `model: bedrock(id)` is *serialized* into the manifest as the string
   `amazon-bedrock/us.anthropic.…`, which is a Vercel **gateway** id. The agent
   then compiles, reports that id, looks entirely correct, and routes every call
   back through the gateway — failing with `AI Gateway received no credentials`
   for a model you believed you were reaching directly.

Bedrock model access is granted per model per region in the AWS console and is
**not** on by default; an untouched account returns `AccessDeniedException` for a
model that plainly exists.

`eve info` reports discovery without needing either. Without a credential the
runtime starts, accepts a session, receives the message and stops at the model
call with `MODEL_CALL_FAILED / gateway-auth-missing-credentials` — everything
except the model is exercised.

`SPEC_CONSOLE_URL` points at a running console; the agent has no other door to
the log.

## Why this is not mounted in the console yet

`channels/eve.ts` admits `localDev()` and `vercelOidc()`. Neither admits a SAVVI
person signing in with Google, so an approval has no identity attached to it —
and an approval anyone can release is not an approval, it is a delay. Mounting
this into the console with `withEve()` means first reading the console's
`spec_session` cookie into an eve principal.

The second reason is duller and just as real: eve requires Node ≥ 24, and the
console is a live deployment. Adding the dependency to `console/package.json`
before confirming the deployment's Node version risks the build of a thing that
currently works.

So this runs locally against a local console, which is the honest shape of
something built and not yet trusted.
