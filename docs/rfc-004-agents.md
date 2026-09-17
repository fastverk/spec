# RFC-004 — making the console useful: measurement first, agents where judgement lives

Status: **proposed**. Companion to RFC-003 (the hosted console). RFC-003 shipped a
console that can write and has never been written to. This one is about the fact
that nothing in it has ever moved.

---

## 1. What is actually broken

**Agents are not the bottleneck, and the plan says so before it uses them.** The
request was for eve agents; the goal is a useful app. Those are not the same
thing, and the evidence says the shortest path to the second does not start with
the first. State it once, plainly, then get on with the plan.

Studio's numbers, read off the committed read model at
`corpus:0e06b2f9fd1047a1`: **69 requirements, 0 evaluated, every one carrying
`population "—"` and `outcome "NOT-EVALUATED"`** (`services/spec/readmodel/requirements.json`).
**107 term rows over 60 distinct surfaces, 0 bound, 0 retired**
(`services/spec/readmodel/terms.json`). **Both append-only logs are 0 bytes**
(`wc -l logs/*.jsonl`). `corpus/studio/proposals.ttl` is 22 lines of header. The
grounding page currently reads **"60 not pinned down · 60 total"**
(`console/app/grounding/GroundingClient.tsx:39-45` groups holes by surface, not
by row) above an alert that says *"No grounding adapter is answering."*

Nothing here is blocked on authoring throughput. Four things are broken, in
descending order of how much they cost:

1. **No population source.** `spec.v1.GroundingAdapter` (`proto/spec/v1/grounding_adapter.proto:117-122`)
   has zero implementations anywhere. The console proxies to it
   (`console/app/api/ground/[...path]/route.ts:43`) and nothing calls the proxy.
2. **Binding a term does not move a requirement.** `blocked_on` and `rung` are
   frozen literals written once by `tools/import/decompose.py:138-146` and read
   back verbatim by `tools/readmodel/emit_readmodel.py`'s `Q_REQUIREMENTS`
   (`OPTIONAL { ?claim au:stalledOn ?stall }`). Nothing derives either.
3. **Promotion drops 11 of 17 ops.** `tools/proposals/materialize.py:139-156`
   dispatches six kinds and `else: continue`s the rest, silently.
4. **Promotion is five hand-run commands.** `.github/workflows/` holds `ci.yml`
   and `migrate.yml` and nothing else.

Only (1) requires a customer. None requires an agent. And two of the four units
this repo measures in are **already live-rendered from the log**:
`console/app/api/overlay/route.ts:38-48` rebuilds the overlay on every request
with `revalidate = 0`; `console/lib/evaluated.ts:63-65` overwrites `population`
and `outcome` on the requirement row; `console/lib/overlay.ts` `applyTerms` sets
`bound_to` and `open`. One authenticated `POST /api/evaluation` — a deployed,
correct, authenticated route whose only mention anywhere in `console/app` is its
own `route.ts` — changes AUTH-24 from `— / NOT-EVALUATED` to **"1,412 records,
undecided"** (`console/lib/evaluated.ts:113-116`) on the next page load. No
service, no promotion, no redeploy.

So the plan front-loads the parts that need nobody's permission, and puts eve
where a machine genuinely cannot decide: **choosing between three readings of a
word that differ by 47 records.**

**Assumption this plan runs under:** SAVVI wants the app useful to a product
owner within one quarter, and is willing to spend a Studio engineer's time on a
Probe endpoint. If Studio cannot fund that, stop after Phase 2 — everything after
it is scaffolding around a count that will never arrive.

---

## 2. The shape

```
  CUSTOMER ENVIRONMENT                VERCEL (one project, one deploy)
  ─────────────────────               ────────────────────────────────
  studio-nextjs                       console/            (EXISTS)
   ├ POST /api/spec/probe    ◀──────── /api/ground/[...path]  (EXISTS, dead)
   ├ POST /api/spec/evaluate           /api/proposal/op       (EXISTS, 1 caller)
   └ GET  /api/spec/health             /api/evaluation        (EXISTS, 0 callers)
     (holds Studio's DB credential;    /api/overlay           (EXISTS, live)
      spec holds none)                 /api/derive            (Phase 6 only)
        ▲                             console/agent/     (Phase 5)
        │ x-vercel-oidc-token          ├ grounding-interviewer
        │ aud = studio host            └ drift-watch      (Phase 6)
        │                                mounted by withEve() at /eve/v1/*
        │                                     │
  ══════╪═════════════════════════════════════╪══════════════════════
        │                                     ▼
        │                              NEON  spec.proposal_log
        │                                    spec.evaluation_log
        │                                    (append-only, +drafted_by)
        │                                          │
        │                                          │ promote.yml (Phase 4)
        ▼                                          ▼
  CI — BAZEL (unchanged home of all symbolic checking)
   ├ //rdf:gates.bzl               40 corpus gate targets
   ├ //rdf:authoring_gates.bzl     4 gates + 4 measures  ← Phase 4 repairs
   ├ //conformance:conformance_test   evaluation + overlay + STALL (Phase 2)
   ├ //tools/readmodel:emit           derived stall lands here (Phase 2)
   └ //corpus/studio:proposals_ttl_matches_the_log

  AWS FARGATE — nothing, until §4's trigger condition fires.
```

**What existing files become what.** `console/lib/overlay.ts` and
`console/lib/evaluated.ts` stay the only overlay implementations and gain no
third runner. `tools/readmodel/emit_readmodel.py` gains the derived stall and
becomes the corpus-side half of a new conformance fixture. `java/BUILD.bazel`'s
thirteen entry-point-less `java_library` targets gain exactly one
`java_binary` — `//java:gate_cli` — invoked by Bazel, not by a server.
`rdf/lint/authoring/envelope-unrecorded.rq` gets rewritten and gains the positive
control `rdf/lint/authoring/fixtures/BUILD.bazel:71-77` says was skipped.
`proto/spec/v1/invariant.proto` gains one enum value. `services/spec/` is not
touched: `backend.rs` indexes a Lean estate that has no meaning here, and
`build.rs:1-3` generates message types only, so adding gRPC there is new codegen
with no caller.

**AWS gets nothing in Phases 0–5.** The corpus is 220 KB of Turtle across 3,669
lines; the gates are `sparql_query_test` rules that run hermetically in CI. A
Fargate task would be a warm JVM idle 99.9% of the time, and Fargate cannot scale
to zero. §4 specifies the service in full and names the condition under which it
earns its keep, so nothing blocks on the decision.

---

## 3. The agents

Two eve agents, both mounted into the existing Next.js project with
`withEve(nextConfig)` — `console/package.json` is Next `^15.5.0` / React `^19.2.8`,
which matches vercel/eve's own `apps/frameworks/next` example. Same origin, no
CORS, no agent credential, no URL env var. The build requires Node ≥ 24, so
`@types/node` moves off `^22.10.0`.

Neither agent lands before Phase 5. Both are scoped by one rule: **an agent gets
a job only where a deterministic script demonstrably loses.**

### 3.0 What the script wins, measured

Of Studio's 60 surfaces:

| class | surfaces | rows | how a script disposes of it |
|---|---:|---:|---|
| colon-form permission tokens (`sponsor:edit`, `deploy:*`, …) | 8 | 38 | exact match against Studio's permission enum |
| decomposer noise (`or`, `act`, `rule, not rows`, `deletion`, `intersected`, `at issue time`) | 6 | 6 | `retractTerm` — "this is not a term" |
| identifier-shaped (`team_memberships`, `sponsor_grants.created_by_id`, `/dev/login`, …) | 9 | 9 | exact match against the schema catalog |
| **residual — judgement** (`public`, `admin`, `org admins`, `SAVVI admin`, `reseller agreement`, `two-level hierarchy`, …) | **37** | **54** | somebody has to decide |

All 38 colon-form rows come from `term_source: "code-span"` — the author's own
backticks (`tools/import/decompose.py` reads terms off markup and nothing else).
Exact string matching over an author's deliberate code span is not a task an LLM
improves. It is replayable, fingerprintable, free, and structurally incapable of
inventing a count. **23 of 60 surfaces and 53 of 107 rows go to a script**, and
that fully disposes of **14 of the 46 decomposed requirements — including
AUTH-24, whose only two terms are `sponsor:edit` and `deploy:*`.**

That is the answer to "is an agent the right tool" for the majority of the named
work: **no, and the script ships first.** The script is not an agent in
disguise — it emits a reviewable list of proposed ops, one human reads it once,
and the batch is POSTed under that human's session. One judgement covering 38
rows, honestly attributed.

### 3.1 `console/agent/grounding-interviewer/` — Phase 5

**Job.** The 37 residual surfaces. For `public`, Studio's schema plausibly offers
`organizations.visibility = 'public'`, `sponsor_grants.public = true`, and a
`public_sponsor_permissions` column; those are three different populations and
choosing between them is a statement about the business. The agent runs the
probe, presents the readings with their counts, and parks.

**Deterministic alternative considered:** a ranked candidate list rendered in the
grounding page with no model at all. It loses on exactly one thing — the residual
surfaces are the ones where the *right question* is not obvious from the schema
(`reseller agreement`, `two-level hierarchy`, `Lifecycle management` are not
columns), and an interview that reads the requirement's prose and proposes
candidate locators is genuinely language work. That is a narrow win over a
dropdown, and it is the only win claimed.

**Files.**

```
console/agent/grounding-interviewer/
  agent.ts            model; limits.sessionTimeoutMs = 7 days (explicit, not false);
                      limits.maxInputTokensPerSession set; disableTool() on the
                      built-in bash and web_fetch harness; NO sandbox slot.
  instructions.md     the six invariants; the closed 17-op vocabulary; the standing
                      rule that it may not state a number.
  instrumentation.ts  recordInputs: false, recordOutputs: false. Both default TRUE.
  channels/eve.ts     AuthFn reading the console's spec_session cookie →
                      { principalId: "google:<sub>", principalType: "user" };
                      turnPolicy: "queue".
  tools/list_open_surfaces.ts    read /api/overlay, rank by claims waiting
  tools/read_requirement.ts      the predicate text and its named terms
  tools/probe_term.ts            calls /api/ground/probe; STRIPS examples in execute()
  tools/propose_binding.ts       approval: input-dependent policy
  tools/propose_retraction.ts    approval: always()
  skills/reading-a-probe.md
  skills/what-is-not-a-term.md
console/evals/
  evals.config.ts
  probes-before-proposing.eval.ts     t.toolOrder(["probe_term","propose_binding"])
  never-proposes-unmeasured.eval.ts   probe returns 0 → t.notCalledTool("propose_binding")
  parks-before-every-write.eval.ts    t.parked()
  never-types-a-number.eval.ts        t.calledTool("propose_binding", { input: {...} })
                                      asserting the input carries no population field
```

**The model cannot type a number.** `probe_term` writes
`{locator, count, query_fingerprint}` into eve session state keyed by
`(term, index)`. `propose_binding`'s `inputSchema` is
`{ term: string, probe_index: number, definition: string }` — **there is no
`population` and no `query_fingerprint` field**. The tool re-reads both from
session state and builds the op body server-side. This is the single most
important line in this section: Design 1's fatal defect was a model-typed
`population` flowing into an append-only table that has no DELETE, and every
existing refusal tests `population > 0`, never provenance
(`console/lib/evaluation.ts:138-153`, `services/spec/src/evaluation.rs:102-117`,
`tools/proposals/materialize.py:115-117`, `console/db/migrations/0001_schema.sql:143-145`).

**Examples never reach the agent.** `probe_term` strips `examples` inside
`execute()`, not via `toModelOutput`. `toModelOutput` projects what the *model*
sees; the durable workflow checkpoints the tool's actual return value so it can
replay a resumed run, so an un-stripped result puts Studio's customer rows at
rest in Vercel Workflow storage — inside spec's own plane, where
`//proto/spec/v1:data_boundary_test` cannot see them. The browser fetches
examples directly from `POST /api/ground/probe` for rendering. This is the only
sound answer to invariant ① under durable execution.

**Forbidden.** No `bindTerm` without a probe with `count > 0` in the same
session — enforced by the approval policy returning
`{type: "denied", reason: "a binding nobody measured is the shape this system
refuses — probe first"}`, which the model reads rather than retries. No
`assertNS`, no `amendNS`, no `retractNS`, no `openConflict`, no
`declarePrecedence`: those tools do not exist, and a tool that does not exist is
a stronger refusal than one that is denied. No evaluations — `record_evaluation`
is deliberately **not** an agent tool (§3.3).

**Identity in the log.** `author` is the **approving human's** `google:<sub>`,
taken from `ctx.session.auth.current`, which the channel AuthFn derived from the
console's own cookie. `surface` is `"Agent"` — accepted since
`0001_schema.sql:92` and set by nothing today
(`console/app/useOverlay.ts:66` hard-codes `"Meridian"`). The agent is recorded
in a new column `drafted_by = 'eve/grounding-interviewer@<VERCEL_GIT_COMMIT_SHA>'`.

We **never construct an agent principal.** `console/lib/proposal.ts:141-146`
rejects any agent op that is not `assertNS` at R0, before the capability table is
consulted; that rule stays enforced and untouched, and no code path in this plan
tries to route around it. The agent is an instrument, not an author.

**Where a human approves.** In the eve pane in the console, and in Slack. The
approval request carries **the full op body plus the probe's locator, count and
fingerprint** — never an opaque handle. There is no mutable staging table: a
draft that nobody approves leaves no row anywhere, which is both invariant ② one
level up and the fix for an audit trail that was mutable while the outcome was
permanent.

### 3.2 `console/agent/drift-watch/` — Phase 6, conditional

**Job.** Re-probe every bound term's stored `query_fingerprint` on a cadence.
When a count moves without a corpus change, open a thread asking a named human
whether the referent drifted. This is the DRIFT half of the three failures and
the only component that produces value on a schedule.

**File:** `console/agent/drift-watch/schedules/nightly.ts` using
`defineSchedule({ cron, run })` — the handler form, not markdown. Markdown/task-mode
schedules are fire-and-forget and cannot park for a human, and a drift finding
that cannot ask is a drift finding nobody acts on.

**Deterministic alternative considered — and it wins for the detection half.** A
cron job that re-probes and diffs needs no model. The agent earns only the
*second* step: turning "sponsor:edit went 1,412 → 1,398" into a question worth a
person's attention, with the requirement text and the 11 claims that wait on it.
So the schedule's `run()` does the diff deterministically and only invokes the
model when a threshold is crossed. Ship it that way.

**Hard prerequisite, non-negotiable.** This agent issues aggregate queries
against a customer's production database on a timer, unattended, with retry
amplification underneath it (eve steps run up to four attempts; there is no
per-tool timeout, only `ctx.abortSignal`). It does not ship until Studio's
adapter has a `statement_timeout`, a read replica or equivalent, and this
schedule has a per-night probe budget and a circuit breaker. Absent those, the
worst realistic incident is that the spec console degrades Studio's production
database at 03:00 UTC and Studio's on-call is paged for a system they do not
operate.

### 3.3 What has no agent, on purpose

**Recording an evaluation.** `record_evaluation` is a **console form**, not a
tool. The human picks the outcome from `Examined | Vacuous | CannotBeGrounded`;
the `population` and `query_fingerprint` come from the probe response the form
already holds. Two failure modes are closed at once: a model cannot type a count,
and the adapter cannot decide the predicate. The proto's willingness to carry
`OUTCOME_PASSES` over the wire (`proto/spec/v1/invariant.proto:131-138`) is a
defect to route around, not a feature to consume — a wire `PASSES` or `FAILS` is
logged as a protocol violation and refused, never recorded.

**Promotion.** `promote.yml` is a workflow, not an agent. It opens a PR; a human
merges.

**The 23 undecomposed requirements.** 22 of them carry zero author markup. The
correct intervention is asking their author to mark up their own sentences — a
Slack message, not a pipeline.

---

## 4. The services

### 4.1 What changes in `proto/spec/v1` — Phase 1, one line

```protobuf
// proto/spec/v1/invariant.proto:131-138
enum Outcome {
  OUTCOME_UNSPECIFIED = 0;
  OUTCOME_PASSES = 1;
  OUTCOME_FAILS = 2;
  OUTCOME_CANNOT_BE_GROUNDED = 3;
  OUTCOME_VACUOUS = 4;
  OUTCOME_EXAMINED = 5;   // ← NEW
}
```

`au:Examined` has existed in the ontology since RFC-002
(`rdf/ontology/authoring.ttl:454-456`), is in `OUTCOMES`
(`console/lib/evaluation.ts:54`), and is in the table's CHECK
(`0001_schema.sql:128`). It is **not** on the wire. Without this line a
conforming adapter physically cannot say *"I measured 1,412 records and I refuse
to decide the implication"* — the one honest answer to AUTH-24. `DisplayExample`
stays declared only in `grounding_adapter.proto` and `invariant.proto` keeps
importing nothing, so `//proto/spec/v1:data_boundary_test` passes unchanged.

### 4.2 The adapter — the customer's service, and it is HTTP

`spec.v1.GroundingAdapter.Probe/Evaluate`, implemented in `studio-nextjs` as
protobuf-JSON route handlers at `POST /api/spec/probe`, `POST /api/spec/evaluate`,
`GET /api/spec/health`. The `.proto` stays the schema of record; the transport is
JSON because `console/app/api/ground/[...path]/route.ts:43` already POSTs to
exactly `${GROUNDING_ADAPTER_URL}/api/spec/<path>`, and `services/spec/build.rs:1-3`
generates message types only with no `proto_library` in
`proto/spec/v1/BUILD.bazel` — gRPC here would be new codegen serving no caller.

It runs in Studio's environment because
`grounding_adapter.proto:114-116` says so: *"Implemented BY THE PROJECT, called
by spec … a project can implement this without granting spec any credential."*
Hosting it on our Fargate would require Studio's database credential in our
account — invariant ① broken at the infrastructure layer while every line of code
still looks correct.

**Auth, Vercel → Studio.** `getVercelOidcToken({ audience: 'https://<studio-host>' })`,
verified by Studio against the `oidc.vercel.com` JWKS with `aud` **and**
`environment:production` pinned. **Not** the default-audience token. Vercel's
default OIDC `aud` is `https://vercel.com/<team-slug>` and its `sub` is
`owner:<team>:project:<project>:environment:<env>` — precisely the claims an AWS
trust policy pins for `sts:AssumeRoleWithWebIdentity`. Forwarding the raw token
would hand a customer-operated service, on every probe, a credential replayable
against STS for any role in our account trusting that project. Audience-scoping
is one parameter and it inverts nothing.

**Probe is the deliverable. Evaluate may never ship, and that is acceptable.**
Probe is a count over a schema. `Evaluate` for AUTH-24 is a decision procedure
over Studio's authorization lattice — 25 of 69 Studio predicates use
implication/lattice language and 0 carry a numeric threshold. If Studio ships
Probe and stops, every Studio requirement lands on **Examined** forever. Say that
out loud now: **no Studio requirement can ever read "Enforced" under this plan.**
`console/lib/evaluated.ts:94,103` gates `Enforced` on `outcome ∈ {Passes, Fails}`,
and this plan deliberately forbids the adapter from producing either. A
stakeholder shown the page will see zero green chips and a column of numbers.
That is the honest state and it is enormously better than `—`, but nobody should
be told otherwise before funding it.

### 4.3 The Fargate service — specified, not scheduled

**Trigger condition.** Build this when *either* holds, and not before:
(a) the corpus carries ≥ 1 `au:Quantity` with bounds, so a preflight over the
post-admission graph has something to examine — Studio has **zero**, so
`envelope_unrecorded` would preflight nothing today; or (b) the console needs to
answer *"what would admitting this proposal do to the gates"* interactively for a
corpus that has grown past the point where CI's answer arrives soon enough.
`services/spec/src/proposal.rs:30-34` names this gap in the code: *"that is a
GROUP BY … HAVING over the post-admission graph and this plugin has no query
engine."*

**Surface.** A new `proto/spec/v1/derivation.proto`, importing nothing from
`grounding_adapter.proto` — it carries counts, never rows, so the data-boundary
test extends unchanged.

| RPC | maps to what exists | Bazel target that computes it today |
|---|---|---|
| `Derivation.Derive(corpus_version, hypothetical_bindings[]) → DerivedRequirement[]` | the Phase 2 stall rule, run online instead of at emit time | `//tools/readmodel:emit` + `//conformance:conformance_test` |
| `Gates.RunGates(project, suites[]) → GateReport` | the 4 authoring gates + 4 measures | `//rdf:authoring_gates.bzl` (3 instantiations) |
| `Gates.Preflight(parent_corpus_version, ops[]) → GateDelta[]` | **nothing** — this is the named gap | `java/kg/edit/WriteOps.applyAndCheck(edits, kgRoot, apply=false)` |
| `Gates.SelfTest() → GateFireResult[]` | the adversarial control never wired | `//rdf/lint/authoring/fixtures` + `//grounding:adversarial_gate` |
| `Gates.Explain(gate) → {sparql, population_sparql, rationale}` | the `.rq` frontmatter | `//rdf:lint` filegroup |
| `grpc.health.v1.Health/Check` | **nothing** — `services/spec/src/main.rs:108-140` registers only meridian `LayoutService` | — |

`GateResult` carries `status ∈ {PASSED, FAILED, EXAMINED_NOTHING}` and an
`examined` count. That idea is the single best thing in any of the three
candidate designs and it does **not** wait for this service — it lands in Bazel
in Phase 4 (§5).

**Deployment.** One ECS Fargate task, 1 vCPU / 2 GB (sized for the JVM's warm
Jena `Dataset`, not for the data — the corpus is 220 KB), us-east-1, image to the
existing private ECR at `042825952740.dkr.ecr.us-east-1.amazonaws.com` named in
`deploy/charts/plugin-spec/values.yaml:4-9`. Public subnet, security group
admitting only the front door; **no NAT gateway** (+$32.85/mo for nothing — the
task has no outbound need). Deployed by a workflow modeled exactly on
`migrate.yml:18-21,63`: `workflow_dispatch` and push-to-main only, never
`pull_request`, gated by a `compute-production` GitHub Environment with a required
reviewer, GitHub OIDC to an AWS role. Day-one blocker: the image build needs a
GitHub App token for the private `fastverk-plugin-crates` repo — `ci.yml:81-84`
records the live 401, and `MODULE.bazel:170-173` records that the Bazel OCI image
"could not be built by CI and had to be produced by hand."

**Auth from Vercel — a Lambda Function URL, not an ALB.** `AWS_IAM` auth type,
SigV4-signed with credentials from `sts:AssumeRoleWithWebIdentity` against
`https://oidc.vercel.com/<team>`, transcoding JSON to the task. This is the only
free, keyless path. ALB has no SigV4 authorizer — its built-in auth is
redirect-based OIDC for interactive users — so a gRPC ALB front door means mTLS
with a client certificate living in Vercel env, unrevokable without a CRL
pipeline nobody will run, and present in every preview deployment. gRPC and
Vercel-OIDC meet at no AWS front door except VPC Lattice, which needs Enterprise
Secure Compute peering. **gRPC is kept between the Rust and JVM containers on
loopback, where it is free, and off the internet-facing hop, where it costs the
auth story.**

**Cost.** Fargate 1 vCPU / 2 GB = $36.04/mo (0.25 vCPU / 0.5 GB = $9.01 if the
JVM is dropped); Lambda + Function URL ≈ $0 at this volume; ECR ~$1; CloudWatch
~$1 if Rust tracing stays at `info`. **≈ $38/mo**, no ALB, no public IPv4, no NAT.
Two AZs: ≈ $75/mo. Fargate cannot scale to zero, so that floor is unavoidable —
which is exactly why it waits for a trigger condition.

**Explicitly refused in this service:** health checks gated on `SelfTest` (a data
defect becomes a crash-looping outage with no rollback signal, since the image is
fine and every replacement task fails the same deterministic check); reusing
`SESSION_SECRET` as a service credential (`console/lib/auth/session.ts:22-33` —
"a known secret lets anyone forge a session, and a forged session forges an
author"); and colocating the JVM and the front door in one task at one replica.

---

## 5. The phases

Each phase names a number a SAVVI person can watch move, and the gate that proves
it. Phase 0 is measured in hours.

### Phase 0 — retract the six noise surfaces. **Day 1.**

Six `retractTerm` ops through the already-deployed grounding page, one per noise
surface: `or`, `act`, `intersected`, `at issue time`, `rule, not rows`,
`deletion`. `retractTerm` is in the closed vocabulary
(`console/lib/proposal.ts:52-53`), `materialize.py:145-146` dispatches it, and
`console/app/grounding/GroundingClient.tsx:39-45` drops a retracted surface from
the hole list entirely.

- **Number:** the grounding page reads **"60 not pinned down · 60 total" → "54 not
  pinned down · 54 total"**. `spec.proposal_log` goes 0 → 6 rows, the first in the
  repo's history.
- **Gate:** `GET /api/overlay` returns `records: 6`; `AUTH-23` — the one
  requirement blocked *only* by noise — has an empty term queue.
- **Cost:** zero code, zero dollars, one person, twenty minutes.

### Phase 1 — the deterministic binder and the evaluation form. **Week 1.**

Three things, none of which needs anybody outside this repo.

1. `OUTCOME_EXAMINED = 5` in `invariant.proto`; `au:Examined` added to
   `vacuous-invariant.rq:24`'s refused set, which today filters only
   `au:Passes`/`au:Fails` and is therefore the weakest of the four zero-refusals.
2. `tools/import/bind_catalog.py` — reads a Studio-supplied catalog of permission
   tokens and schema identifiers, emits a **reviewable JSON list** of candidate
   `bindTerm` ops for the 8 colon-form and 9 identifier-shaped surfaces, exact
   match only, no fuzzy matching, no model. A human reads the 17 rows once and
   POSTs the batch under their own session.
3. An evaluation form in the console — the first caller `POST /api/evaluation`
   has ever had. Outcome narrowed to `Examined | Vacuous | CannotBeGrounded`.

Also in this phase, because Phase 5 depends on it and it is cheap: add
`locator`, `query_fingerprint`, `population` to `bindTerm`'s **optional** list in
both `console/lib/proposal.ts:44-45` and `services/spec/src/proposal.rs`. The
vocabulary stays at 17, which is all `check_wiring.py:383` asserts. Without this,
`checkOp`'s unknown-field rejection (`proposal.ts:105-108`) means a binding's
evidence cannot enter the log line, the canonical bytes, or the promoted TTL —
and a permanent corpus statement would be forever indistinguishable from a guess.

- **Number:** open holes **54 → 37**. Requirements with zero remaining unbound
  terms: **0 → 14**, AUTH-24 among them.
- **Gate:** extend `check_wiring.py` to parse `console/lib/proposal.ts`'s `OPS`
  and assert 17 there too — today it reads only the Rust file despite that file's
  own comment at `proposal.ts:28-31` claiming otherwise, and the console is the
  live write door.
- **Length:** one week.

### Phase 2 — derived stall: make binding a term visible on the requirement. **Weeks 2–3.**

One rule, one definition, two runners — the pattern RFC-003 §3 established for
the vacuous refusal and the overlay:

- `conformance/stall_cases.json` — the fixture, in a language neither runner is
  written in.
- `tools/readmodel/emit_readmodel.py` computes `blocked_on` from the graph
  (bound terms, retracted terms, retirement, evaluation presence) instead of
  reading `au:stalledOn` verbatim.
- `console/lib/overlay.ts` recomputes it against the pending overlay, so a
  binding made 30 seconds ago moves the requirement without a redeploy.

**The rule does not promote anything to R3.** A bound term is not a measurement.
When a requirement's last term is bound, `blocked_on` becomes
`"unmeasured: N term(s) bound, no evaluation recorded"`. `au:rung` is untouched,
so `ladder-integrity.rq`'s UNNAMED-STALL branch stays satisfied — every claim at
R0–R3 still carries an `au:stalledOn`.

This is the whole point of the phase: it converts *"107 unbound terms"* into
*"14 requirements ready to measure and nothing to measure them with"*, which is a
specific, actionable, embarrassing number that creates the demand signal for
Phase 3.

- **Number:** requirements whose `blocked_on` string changed: **0 → 14**. AUTH-24
  goes from `"unbound-terms: 2 term(s) named and none confirmed — sponsor:edit,
  deploy:*"` to `"unmeasured: 2 term(s) bound, no evaluation recorded"`.
- **Gate:** a new zero-row authoring gate,
  `rdf/lint/authoring/stall-drift.rq`, firing on any claim whose recorded
  `au:stalledOn` differs from the derived one. Two answers with nothing asserting
  their agreement is DRIFT — the failure this repo exists to prevent — and the
  gate is what stops us introducing it.
- **Length:** two weeks.

### Phase 3 — Studio's Probe, and the first population. **Weeks 3–6, in parallel with 2.**

Ship Studio a runnable reference implementation, not a `.proto` and a request:
the two route handlers stubbed against fixtures, the audience-scoped OIDC
verifier, and a conformance suite they can run. Then Studio implements Probe
against its permission and role tables. `console/app/api/ground/[...path]/route.ts`
gains the outbound `x-vercel-oidc-token` header and keeps its 15s timeout and its
503/502 bodies verbatim — the refusal to manufacture `{population: {count: 0}}`
at `route.ts:20-38` is the fifth independent refusal of a vacuous zero and stays
byte-identical.

- **Numbers, in order:** `GET /api/health` reports `grounding_adapter: "configured"`
  where it says `"unset"` today; the grounding page renders three candidate
  readings with counts instead of *"No grounding adapter is answering"*;
  `SELECT count(*) FROM spec.evaluation_log` goes **0 → 1**; **AUTH-24 reads
  "1,412 records, undecided"** on the requirements page.
- **Gate:** an eve-free integration test asserting that a probe returning
  `count: 0` produces `outcome: Vacuous` and never `Examined`, and that a 502
  from the adapter produces `CannotBeGrounded` with `population: null`.
- **Length:** three weeks of Studio's time, and it is the only item on the
  critical path this repo cannot unblock. **If no count has arrived six weeks
  after the reference implementation is handed over, stop and call the bet.**

### Phase 4 — the promotion loop and the gate plane. **Weeks 6–8.**

Two independent tracks, both prerequisites for volume.

**Promotion.** `promote.yml` — landed (#49): modeled on `migrate.yml`,
`workflow_dispatch` and a daily schedule, `corpus-production` Environment with a
required reviewer, SELECT-only credential, a pinned export (`WHERE seq <=
$THROUGH`, both pins taken once), `materialize.py` and `emit_readmodel.py` via
`tools/proposals/promote.sh`, the gates over the result, then `logs/*.jsonl`
**and** `corpus/*/proposals.ttl` **and** the read model in one commit (or
`//corpus/studio:proposals_ttl_matches_the_log` goes red), opened as a PR. A
human merges. Alongside it, `materialize.py` becomes total over the
vocabulary — the `else: continue` at `:139-156` becomes a hard failure naming the
unhandled kind — and stops erasing attribution: it must emit one `au:Proposal`
node **per log record** rather than the single shared `st:authoring` node at
`:174-180`, carry `surface` from the record instead of hard-coding
`au:surface au:Meridian` at `:177`, and emit `au:authoredBy st:principal-<sub>`,
declared at `rdf/ontology/authoring.ttl:359-364` and used nowhere. Budget a full
day for the one-node-per-record change: it alters `proposals.ttl`'s shape and what
`ladder-integrity.rq` resolves as `au:promotedBy`.

**The gate plane.** Rewrite `rdf/lint/authoring/envelope-unrecorded.rq:25-26,34`
out of the `BIND(IF(?kind = au:LowerBound, ?v, ?unbound))` + `HAVING(MAX(?lo) >
MIN(?hi))` form that `empty-envelope.rq:11-32` documents as returning **zero rows
under ARQ** — the gate `authoring_gates.bzl:21-26` calls "the load-bearing gate"
is written in the exact form known to detect nothing. Wire the positive control
`fixtures/BUILD.bazel:71-77` says was deliberately skipped. Add
`//java:gate_cli`, the first `java_binary` over the thirteen entry-point-less
`java_library` targets, so the fixtures can be run adversarially. And add
`GateStatus.EXAMINED_NOTHING` to the Bazel gate output with an `examined` count —
`envelope_unrecorded`'s candidate set is `?quantity a au:Quantity`
(`envelope-unrecorded.rq:16`) and Studio's corpus has **zero** such nodes, so the
load-bearing gate is green having examined nothing, right now, today.

One caution the plan carries openly: an independently-authored
`<gate>.population.rq` can **over**count, turning a gate that examines nothing
into a green gate wearing the number 69 — strictly worse than today's silence.
So `examined` is derived from the gate's own WHERE clause with the HAVING
stripped, mechanically, not hand-written beside it.

- **Numbers:** `wc -l logs/*.jsonl` non-zero in git for the first time. Gates
  reporting `EXAMINED_NOTHING` for Studio: named and counted rather than reported
  as passes.
- **Gate:** `//conformance:conformance_test` — which reads `ci.yml` as a source
  and asserts every gate-holding package is named in its explicit lists
  (`BUILD.bazel:9-19`) — must be updated for any new package, or CI fails.
- **Length:** two weeks, two people in parallel.

### Phase 5 — `grounding-interviewer`. **Weeks 8–11.**

The eve agent of §3.1, scoped to the 37 residual surfaces, with its eval suite in
CI as `eve eval --strict --junit .eve/junit.xml`. eve is pinned; every eve-facing
call goes through `console/lib/agentwrite.ts` so a breaking minor — 0.32.0 alone
renamed the approval response wire value from `deny` to `cancel` — reaches ten
small tool files and never `checkProposal` or `appendEvaluation`.

- **Number:** open holes falling from 37 toward 0 — and, critically, the **A/B**:
  run the deterministic matcher over the same 37 surfaces and diff. If the agent
  does not beat exact matching plus a ranked dropdown, it does not touch those
  surfaces again. Nobody has proposed measuring an agent against the null
  hypothesis; this plan does, and it is the one experiment that justifies the
  token bill.
- **Gate:** the four evals above, as deterministic CI gates. `t.parked()` and
  `t.notCalledTool` are how "the agent stopped for a human" and "the agent refused
  after a zero-population probe" become facts rather than prompt hopes.
- **Length:** three weeks.

### Phase 6 — `drift-watch`, and the Fargate service if its trigger fires. **Conditional.**

Neither is scheduled. `drift-watch` unblocks when Studio's adapter has a
statement timeout, a read replica, and a probe budget. The Fargate service
unblocks on §4.3's trigger condition. Both are fully specified so that saying
"yes" later costs a sprint, not a design.

---

## 6. The invariant ledger

| # | invariant | what threatens it **in this plan** | what enforces it | where that lives |
|---|---|---|---|---|
| ① | spec never holds project data | eve checkpoints every tool result into durable Workflow storage for the session's life; OTel `recordInputs`/`recordOutputs` default **TRUE** | `probe_term` strips `examples` inside `execute()`; its `outputSchema` has no field that could hold one; the browser fetches examples from the proxy for rendering; `instrumentation.ts` sets both record flags false | `console/agent/grounding-interviewer/tools/probe_term.ts`, `.../instrumentation.ts`, `console/app/api/ground/[...path]/route.ts`; the type boundary at `proto/spec/v1/grounding_adapter.proto:18-27`, asserted by `//proto/spec/v1:data_boundary_test` |
| ① | (residual) | a human copy-pastes an example row back into the chat | **nothing.** Stated, not enforced. | — |
| ② | a proposal is not the corpus | a live derived `blocked_on` could be computed from log presence rather than difference | `Pending.applyTerms` compares against the corpus value before marking pending (`overlay.ts`); the Phase 2 stall rule takes the *overlay-applied* rows as input and never reads the log directly; no third overlay implementation is created | `console/lib/overlay.ts`, `conformance/overlay_cases.json`, `conformance/stall_cases.json` |
| ③ | zero is an exception, never a pass | agent volume; a model-typed population | **six independent refusals**: the door (`console/lib/evaluation.ts:138-153`, `services/spec/src/evaluation.rs:102-117`); promotion (`materialize.py:115-117`); the SPARQL gate (`vacuous-invariant.rq:13-38`, **gaining `au:Examined` in Phase 1**); the table CHECK (`0001_schema.sql:143-145`); the proxy's refusal to manufacture a zero (`ground/route.ts:20-38`); and the approval policy denying a `bindTerm` with no probe | as cited |
| ③ | (provenance, not magnitude) | all six refusals above test `population > 0`; **none tests where the number came from** | the number is never a tool input: `propose_binding`'s `inputSchema` has no `population` field, and the tool re-reads it from session state; `record_evaluation` is a form, not a tool | `console/agent/grounding-interviewer/tools/propose_binding.ts`; the eval `never-types-a-number.eval.ts` |
| ③ | (in the gate plane) | a correct gate over an empty candidate set still returns zero rows and reads as PASS | `EXAMINED_NOTHING` as a distinct status with an `examined` count derived from the gate's own WHERE clause; the wired adversarial control | Phase 4: `rdf/authoring_gates.bzl`, `rdf/lint/authoring/fixtures/BUILD.bazel`, `//java:gate_cli` |
| ④ | Examined ≠ Passes | the adapter's `Outcome` enum can carry `OUTCOME_PASSES`; a model will summarize "Examined 1,412" as "passing" | the outcome is chosen by the approving human from a form narrowed to `Examined \| Vacuous \| CannotBeGrounded`; a wire `PASSES`/`FAILS` is a logged protocol violation and is refused, never recorded; the display layer gates `Enforced` on `Passes\|Fails` independently | the Phase 1 evaluation form; `console/lib/evaluation.ts:54,61`; `console/lib/evaluated.ts:94,103` |
| ⑤ | nothing is attributed to nobody | an agent has no credential and cannot get one honestly | the author is always the approving human's `google:<sub>` from `ctx.session.auth.current`, never the model; the agent principal is **never constructed**, so `proposal.ts:141-146` stays enforced rather than dead; `drafted_by` is a new NOT-NULL-when-`Agent` column with a CHECK; `au:authoredBy` reaches the corpus in Phase 4 | `console/agent/*/channels/eve.ts`; migration `0004`; `materialize.py` |
| ⑤ | (in the corpus) | nothing in the current gate suite would fail if agent- and human-authored claims were indistinguishable — `ladder-integrity.rq:17` checks only that `au:promotedBy` **exists** | a new zero-row gate `agent-unattested.rq`: any `au:Proposal` with `au:surface au:Agent` and no `au:authoredBy` resolving to an `au:Principal` | Phase 4, `rdf/lint/authoring/` |
| ⑤ | (in the evaluation log) | `spec.evaluation_log` has **no `surface` column** (`0001_schema.sql:98-146`) and stores the *email*, not the sub | `drafted_by` added to **both** logs, with the `decomposition_matches_the_line` CHECK extended to cover it | migration `0004` |
| ⑥ | the corpus is generated | agent-scale volume against a five-command manual promotion; retried eve steps double-appending to a log with no DELETE | `promote.yml` writes both halves in one commit or `//corpus/studio:proposals_ttl_matches_the_log` goes red; every agent write carries an idempotency key `sha256(session_id ‖ canonical)` behind a partial unique index — `meta.id` explicitly does not cover retried steps | Phase 4; migration `0004` |
| ⑥ | (residual) | the idempotency key would also collapse a legitimate identical re-approval in the same session; the schema deliberately has no unique constraint on `line` because "binding a term to the same reading twice is a fact, not a duplicate" | **partially enforced.** The key is scoped per session and the collapse is accepted as the lesser error. Named, not solved. | — |

Three rows in that table say **nothing** or **partially**. Those are the honest
residuals; everything else names a file.

---

## 7. What this plan refuses to do

**No agent authors a proposal alone, and no agent principal is ever constructed.**
`console/lib/proposal.ts:141-146` rejects every agent op that is not `assertNS` at
R0, before the capability table. A design that mints `author = 'agent:eve.<name>'`
and then submits `bindTerm` gets `E_OP_REJECTED` 422 with nothing appended
(`proposal/op/route.ts:45-54`). Rather than amend that rule to make an agent
plan work, this plan leaves it enforced and routes around it by never needing an
agent principal.

**No mutable staging table.** A `spec.review_queue` with the append-only triggers
deliberately omitted inverts the audit trail — the record of what an agent
drafted and a human rejected would be deletable while the record of what got
through is permanent — and requires granting UPDATE/DELETE inside the `spec`
schema to `spec_app`, the role `0003_grants.sql` exists to hold to INSERT+SELECT.
It is also invisible: `console/app/api/overlay/route.ts:39-40` reads
`proposalRecords()` and `evaluationRecords()` and nothing else, so a staged draft
changes no number on any page. The approval request carries the full op body
instead.

**No `toModelOutput` as a data-boundary control.** It projects what the model
sees; the durable workflow checkpoints the real return value. Redaction happens
in `execute()` or it does not happen.

**No population, outcome, or fingerprint as a model-typed tool input.** Every
existing refusal tests magnitude, never provenance, and `checkEvaluation` is pure
by design — *"no database, no clock, no environment"* (`evaluation.ts:85-90`) — so
it structurally cannot verify a count even in principle.

**No `SESSION_SECRET` shared with any service.** No mTLS client certificate in
Vercel env. No raw default-audience `x-vercel-oidc-token` forwarded to a
customer-operated service.

**No `grpc.health.v1.Health` gated on a gate self-test.** A data defect that fails
identically on every replacement task is an outage with no rollback signal.

**No gRPC on the internet-facing hop.** It costs the free keyless auth path and
buys nothing the console needs; `@grpc/grpc-js` from a Vercel Function is also
unproven — the string `grpc` has zero hits across the entire vercel/eve tree.

**No AWS in Phases 0–5.** The trigger condition is written down; the service is
specified; it waits.

**No retirement of `emit_readmodel.py` in favour of a live service.** That would
remove the CI check at `ci.yml:231-237` which proves the eight payloads parse and
agree on one `corpus_version`, and trade a verified batch artifact for an
unverified live one in a repo whose purpose is preventing drift. (The rdflib/ARQ
divergence is real and worth fixing — `emit_readmodel.py:23-29` denies in writing
a divergence visible in the committed `envelopes.json` — but it is fixed by
retiring the *rdflib query*, not by adding a third engine.)

**No claim that any Studio requirement will read "Enforced."** It cannot, by
construction, and saying so after funding rather than before is the kind of
quiet overclaim this whole repo exists to refuse.

---

## 8. Open questions, each with a default so nothing blocks

1. **Will Studio staff a Probe endpoint, and by when?**
   *Default:* hand over the reference implementation and fixtures in Phase 1 and
   set a six-week clock from that date. If no count has arrived, stop after Phase
   2 and report that the pipeline is complete and unfed. **This is the only
   question that can invalidate the plan.**

2. **Who reviews the Phase 1 binding batch?** 17 exact-match bindings need one
   named person's judgement, once.
   *Default:* mmarshall@savvifi.com, since `SPEC_KERNEL_SUBS` is already his
   problem.

3. **Approval throughput.** Phase 5 will generate roughly 37 approvals. At three
   minutes of genuine judgement each that is ~2 hours of senior attention, and if
   the reviewer spends less, human approval is not a safety property — it is a
   click. This cost appears in no budget anywhere and it decides whether the agent
   is safe.
   *Default:* batch by surface, not by row (one decision covers `sponsor:edit`
   across all 11 claims it blocks), cap the agent at 5 surfaces per session, and
   measure approval dwell time as a CI-adjacent metric. If median dwell falls
   under 30 seconds, turn the agent off.

4. **Which Vercel plan is the team on?** Secure Compute / VPC peering is
   Enterprise-only; Static IPs are $100/mo/project.
   *Default:* assume Pro. The plan is designed to need neither — audience-scoped
   OIDC to Studio, SigV4 to a Lambda Function URL, no private connectivity.

5. **eve model and token budget.** `vercel.com/docs/eve/pricing` was unreachable
   from every research session and is not vendored in the OSS repo, so the
   dominant line item in the eve budget is a guess. The only cost controls
   expressible in code are `limits.maxInputTokensPerSession` (default 40,000,000)
   and `limits.sessionTimeoutMs`.
   *Default:* set both explicitly before the first session — 2,000,000 input
   tokens and 7 days — and read the pricing page from an unblocked network before
   Phase 5 starts.

6. **Does the Fargate trigger condition ever fire?** Studio has zero
   `au:Quantity` nodes and zero conflicts, and its actual conflict class
   (25 of 69 predicates use implication/lattice language; 0 byte-equal predicate
   pairs) has no detector at all.
   *Default:* no. Revisit when a second customer corpus with numeric thresholds
   lands, or when someone writes an `IMPLICATION_LATTICE` detector — which is a
   `.rq` file and a Bazel target, not a service.

7. **Kill switch.** Nothing in the console today can stop an agent without a
   redeploy, and `spec_app` is shared between the agent and the console.
   *Default:* `SPEC_AGENT_ENABLED` read per request in
   `console/lib/agentwrite.ts`, defaulting to **false**, plus a documented
   `POST /eve/v1/session/:id/cancel` sweep. Ship it in Phase 5 before the first
   agent write, not after.

8. **Who is paged?** For the adapter, for a wedged eve session, and (later) for a
   Fargate task.
   *Default:* the adapter is Studio's; a wedged session is whoever merged Phase 5;
   there is no Fargate task to page for, which is one more argument for §4.3's
   trigger condition.