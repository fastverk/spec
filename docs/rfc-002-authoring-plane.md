# RFC-002 — The Authoring Plane

**Status:** Draft · **Spine:** `spec` · **Depends on:** [RFC-001](./rfc-001-unified-spec-graph.md), [RFC-001b](./rfc-001b-crystallization-math.md)
**Date:** 2026-08-05

> *RFC-001 made the spec graph provable. It did not make it authorable. This RFC
> adds the missing half: one write path, two front ends, and a cross-discipline
> conflict as the system's most valuable output.*

---

## 1. Motivation — the bottleneck moved

RFC-001 asked how to make a spec graph *coherent* and answered it well: a
deterministic corrector with Lean-proven invariants, ten semantic gates, an
un-gameable grounding check, and a measurable energy `E(G)`. That machinery
works. `//grounding:grounding_verified` rejects a fabricated `:provenBy`;
`//grounding:adversarial_gate` detects a planted cycle, a dangling reference and
a MUST/MUST_NOT contradiction; `//corpus:compaction_measure` removes four
transitively-implied edges that a prose corpus would have kept forever.

The bottleneck is no longer checking. It is **getting claims in at all.**

Concretely, as of `9bac9d7`:

| Concern | State |
|---|---|
| Write surface | `java/kg/edit/` — a CLI: `add-edge`, `scaffold-term`, `scaffold-rule`, `scaffold-diagnostic`, `remove-term`, one triple at a time, `--apply` to commit |
| Anything expressive | Hand-written Turtle |
| The one internalized external standard | `corpus/nav-sec-2a4.ttl` — 19 claims, researched by agents into `docs/frontier/nav-sec-2a4.claims.json`, then **hand-transcribed** |
| Console plugin | Read-only. 3 table panels, 3 read-only MCP tools, one static gRPC nav subtree |
| Provenance of a change | None. No record of who, from what intent, against which graph state |
| Cross-discipline conflict | *Counted* into `E(G)`'s `C` term by `claim-contradiction.rq` / `modality-conflict.rq`. Never witnessed, routed, or resolved as an object |

The most valuable thing this system has ever produced is in
`docs/crank-001-first-step.md` §4: **C1**, the discovery that ratio's positioning
brief claimed an LLM "cannot write an unbalanced *or unauthorized* entry" while
the kernel's only proven invariant is conservation — *authorization is not a
kernel theorem.* A real correction to real marketing copy, found because two
claims were forced into the same graph.

That is the product. And today it arrives as a row in a tension table in a
markdown result log, with no owner, no witness, and no way to record that it was
resolved.

### 1.1 Why this matters for fanout

The reason to care is scale. An agent fleet building a large system needs to be
handed obligations it can bind against. Today it would be handed prose, and the
failure is silent: two agents satisfy two documents that were never checked
against each other, and the incoherence surfaces in production. The spec graph is
the only artifact that can catch that *before* dispatch — but only if the
obligations are actually in it, typed, and known to be mutually satisfiable.

So the three asks are one ask:

1. **Authoring must be convenient** or the graph stays empty and nothing else
   matters.
2. **Coherence must be mechanical** or a conveniently-authored graph is just a
   faster way to write contradictions.
3. **Conflict must be a first-class object** or the system's best output has
   nowhere to live.

---

## 2. What exists, and what is genuinely missing

Reuse is the default. The inventory below is what an authoring plane builds *on*,
not around.

### 2.1 Reusable as-is

| Component | Path | Role in the authoring plane |
|---|---|---|
| Ontology + SHACL | `rdf/ontology/{aion-rfc,shapes}.ttl` | The schema authoring is typed against |
| Semantic gates | `rdf/lint/semantic/*.rq` (10) | The pre-commit gate set |
| Structural queries | `rdf/queries/**` (48) | Navigation, coverage, frontier |
| Gate harness | `java/kg/{Gates,GateHarness,Loader,Writer}.java` | The single validation entry point |
| Grounding check | `grounding/{GroundingCheck,AdversarialGateCheck}.java` | `provenBy` cannot be faked |
| Corrector core | `lean/Spec/Compaction/Projection.lean` | `mem_dedupE` / `dedupE_length_le` / `dedupE_idem` — meaning-preserving, non-increasing, idempotent |
| Corpus schema | `lean/Spec/Corpus/Schema.lean` | `Modality` / `Tier` / `Document` / `NormativeStatement` |
| Lean ⇄ TTL round-trip | `java/kg/lean/{CorpusToLean,ProvenBySyncCheck}`, `lean/Spec/Emit/TtlEmit.lean` | Keeps the two representations honest |
| Edit primitives | `java/kg/edit/{WriteOps,Handles}` + `cmd/*` | The op implementations, below a better interface |
| Loop contract | `crank`'s `fastverk.crank.v1.CrankPredictor`, `JenaEnergy`, `JenaGate` | Where a proposal gets measured |
| Plugin shape | `services/spec/` + `rules_fastverk_plugin` + `fastverk-layout` | The console surface to extend |
| Chat plane | `plugin-chat` — `POST /turn`, SSE, confirm-gated mutation | The chat front end |
| Human-in-the-loop | `agents` `HumanPrompt` CRD | Fanout escalation |

### 2.2 Genuinely missing

1. **A proposal object.** No content-addressed, typed, signed delta. Therefore no
   review, no provenance, no replay, and no way for a human-authored and an
   agent-authored change to be treated identically.
2. **A ladder.** `NormativeStatement.tier` defaults to `.Structural` and is
   self-declared. There is no representation for *partially formalized* — a claim
   is either in the graph or not, so authoring is all-or-nothing and a stall is
   invisible.
3. **Conflict as an object.** No witness, no owner, no resolution record, no
   defeasibility status.
4. **Quantity and scope typing.** No units, no measurement referent, no
   jurisdiction/edition/effective-interval. Most cross-domain errors are homonym
   and referent errors, and today nothing can express them as type errors.
5. **Any write affordance in the UI.**

---

## 3. Estate-fit constraints (verified — these bind the design)

Four facts about this estate were checked against the source and each one rules
out an otherwise-attractive design. They are recorded here because getting any of
them wrong produces a plan that cannot ship.

### 3.1 `spec` is *upstream* of `aion`, not downstream

`lean/BUILD.bazel` exports the `Spec.*` modules as source labels precisely so
"cross-repo consumers (Aion's `lean_test` targets)" can list them, and the
namespace is deliberately neutral `Spec.*` "so any consumer can ground its own
corpus on the kernel without inheriting an `Aion`-specific name." `MODULE.bazel`
has **no `aion` dependency**.

**Consequence.** The authoring plane cannot use Aion's permission machinery —
`lean/Aion/Db/Policies.lean`, `hasPermission_emit_iff_kernelImpl`, the
`PermissionBounds`/`PermissionSecurity`/`PermissionCache` trio. Those are the
natural place to enforce "an agent may not promote a claim," and they are
unavailable by dependency direction. Write capability must be enforced inside
`spec` on its own terms, and new modules are `Spec.Authoring.*`, never
`Aion.Authoring.*`.

### 3.2 `rules_rust` is present — `docs/compaction.md` is stale on this point

`docs/compaction.md` says Rust passes "were the original aspiration; since
`rules_rust` isn't in the ecosystem…". That is no longer true:
`MODULE.bazel:150` declares `bazel_dep(name = "rules_rust", version = "0.70.0")`
with a Rust 1.95.0 toolchain and an isolated `crate_universe` over the root
`Cargo.toml`, and `services/spec/` is a Rust axum binary.

**Consequence.** The hybrid RFC-001 §5 originally wanted — Lean-proven core plus
Rust hot-path passes — is available today. The note in `compaction.md` should be
corrected so the next reader does not re-litigate a settled question.

### 3.3 The meridian descriptor vocabulary is `table` / `lro` / `adhoc`

Across every `panels.textproto` in the estate — `spec/services/spec/ui`,
`botnoc/proto/botnoc/ui/v1`, `plugin-mycelium/ui`, `agents/services/agent/ui` —
exactly two panel kinds appear: `table` and `adhoc`. `botnoc/web/static/assets/main.js`
dispatches on `body.case` for `table`, `lro`, and `adhoc`.

**There is no form, action, mutation, or confirmation descriptor.** Point-and-click
authoring is not expressible in the declarative vocabulary.

Further, `meridian_schemas` is an **upstream bazel module** (`MODULE.bazel:158`,
version `0.5.0`) that this repo does not own — and `botnoc` mirrors `v0.6.0`, so
there is already a version skew we cannot unilaterally resolve.

**Consequence — and this is the delivery decision.** A design that requires
extending the meridian descriptor vocabulary blocks on an upstream module and a
version negotiation. It cannot be phase 1.

But it does not need to be. `main.js` carries an `ADHOC_HANDLERS` registry keyed
by `AdhocPanel.handler_id`, and `meridian-bridge.js`'s `renderPanelInto` takes an
`adhocFactories` map. The estate already ships **nine** adhoc handlers —
`chat`, `fleet`, `agents_launch`, `agents_graph`, `configs_manager`,
`tools_gallery`, `image_explorer`, `workspaces_cards`, `access_keys` — and
`access_keys` **mutates**: it "mints a scoped RBE token via `POST /api/keys/rbe`."

So mutation through an adhoc panel is established precedent, not a new hole. The
authoring plane's rich surfaces (conflict board, witness, delta review, ladder)
ship as adhoc handlers against spec's own web routes, exactly as `chat` does.
Extending `meridian_schemas` with declarative descriptors becomes a **later
promotion step** for whichever surfaces prove stable — done upstream, from
evidence, once.

### 3.4 The gate set is real but narrower than it reads

Two honest limits on what "machine-checked" currently buys:

- `//grounding:grounding_verified` proves a `:provenBy` string **resolves to a
  sorry-free theorem**. It does not prove the theorem *says what the claim says*.
  That gap is real and should be stated in the plan rather than papered over; the
  ladder's top rung is what makes it visible instead of implicit.
- `lean/Spec/Grounding/WriteDoor.lean` proves `admit_conserves` and
  `trades_compose_conserving` over `Int` — a genuine result about *integer
  conservation*, and the existence proof `docs/crank-proof.md` claims it to be.
  It is **not** a theorem about graph admission. A design that says "the write
  door already proves coherence is preserved" is misreading it. The admission
  theorem for the authoring plane has to be written.

---

## 4. Architecture

Three independent designs were developed and scored. The locked architecture
takes one spine and grafts from the other two; where they conflicted, the choice
and its one-line reason are recorded.

**Spine — the proposal and the door.** Nothing writes the graph directly. Every
change, from any surface, is a content-addressed, signed `Proposal` admitted by a
single `Door.admit`. *Chosen because it is the only design whose central claim is
already half-built* — `lean/Spec/Grounding/WriteDoor.lean` is a choke point, even
though what it currently proves is narrower than the name suggests (§3.4).

**Graft 1 — the formalization ladder** (`au:R0`…`au:R5`). Intent is a node in the
same graph as formal claims, and formalization is a monotone climb with a
nameable stall. *Chosen because without it, authoring is all-or-nothing: a
half-formalized claim has no legal representation, so the honest answer "we have
captured this but not yet formalized it" cannot be recorded, counted, or ranked.*

**Graft 2 — a closed op vocabulary with decidable preconditions.** Each op is
individually reviewable and individually checkable.

**Rejected — generating the authoring UI from the ontology.** The most elegant of
the three: make the schema *be* the editor, so an illegal edit has no
representation in any surface. *Rejected as a phase-1 goal because it requires
the meridian descriptor extension that §3.3 shows is blocked on an upstream
module we do not own.* It is retained as the north star for the promotion step in
§8.3 — and the argument for it gets stronger, not weaker, once the op vocabulary
has stabilized against real use.

**Rejected — dependent typing as the well-formedness mechanism.** Design 1 made
`Proposal.ops` a list of `Σ op, WellTyped schema op`, so an ill-typed edit is a
non-term rather than a rejected term. Genuinely stronger, and the estate has
precedent (the `*Safe` PgAst constructors certified by `decide`). *Rejected
because the write path must be callable from the Rust plugin and the Java gate
harness, not only from Lean* — a guarantee that exists only inside Lean does not
constrain the service that actually accepts the write. The door instead runs a
decidable well-typedness check and returns a witness on failure, which is weaker
by exactly the gap between "cannot be constructed" and "is rejected on
construction", and that gap is stated rather than hidden.

### 4.1 The layers

```
  surfaces          meridian (adhoc panels)   chat (plugin-chat)   ingest   agent
                             │                       │              │        │
                             └───────────┬───────────┴──────────────┴────────┘
                                         ▼  composes
  IR                              au:Proposal { parent, ops, intent, provenance }
                                         │
                                         ▼  Door.admit(state, {parents, ops})
  admission          ┌─────────────────────────────────────────────────┐
                     │ well-typedness · capability · gate set · corrector│
                     └─────────────────────────────────────────────────┘
                                         │  Verdict: Admitted | Rejected | Queued
                                         ▼
  store                    Jena (RDF truth) + append-only proposal log
                                         │
                                         ▼  emit
  artifacts             corpus TTL · Spec.Corpus.* Lean · mdbook · work orders
```

The load-bearing structural decision is that `Door.admit` takes
`{parents, ops}` and **not** provenance. Provenance lives one level up, in the
`Proposal`. So "a chat-authored change and a click-authored change are
indistinguishable downstream" is enforced by the signature, not by review
discipline: there is no `admit` overload that can see who wrote it. Correspondingly
the audit that keeps this true is small and static — there must be exactly one
callsite that applies ops, inside the door.

## 5. The proposal IR

```
Proposal
  id          : Hash          -- content address over (parent, author, ops)
  parent      : Hash          -- the bitemporal read point the author saw
  author      : Principal
  surface     : au:Surface    -- Meridian | Chat | Ingest | Agent  (audit only)
  ops         : [Op]          -- ordered, individually reviewable
  intent      : IntentRecord  -- prose + formalization attempts, incl. REJECTED ones
  verdict     : au:Verdict    -- Admitted (may declare conflicts) | Rejected | Queued
```

`Op` is closed. Every constructor carries a decidable precondition:

| Op | Effect |
|---|---|
| `assertNS` / `amendNS` / `retractNS` | claims (retract never deletes; it demotes) |
| `bindTerm` / `alignTerm` | the glossary — `bindTerm` is *forced* when a term typeahead has no match |
| `declQuantity` / `assertDisjoint` | the homonym registry |
| `declScope` / `narrowGuard` | scope and the cheapest conflict fix |
| `promote` / `demote` | ladder movement, with rung-tagged evidence |
| `groundNS` | attach an `isAxiom` or `derivedVia` chain |
| `openConflict` / `witness` / `adjudicate` | the conflict lifecycle |
| `declarePrecedence` | assert `au:precedes` — **kernel capability only** |

Three properties fall out and are worth naming:

1. **Replay is by id, never by re-running a model.** A chat-authored proposal
   replays because the ops are recorded, not because the LLM is deterministic —
   which it is not. This is the answer to "how can an LLM-authored spec be
   reproducible."
2. **Review is at op granularity.** Accepting three of five ops emits a derived
   proposal against the same parent. A form panel models one record; a proposal is
   a diff with per-row triage.
3. **Partial admission is normal.** `declarePrecedence` requires kernel
   capability, so one proposal routinely splits into an admitted part and a queued
   part. Precedence is deliberately the expensive move: it changes the lattice for
   every discipline.

### 5.1 Why conflict is *admitted* rather than rejected

The counter-intuitive call. When a new claim makes an envelope empty, the door
admits the proposal and attaches an `au:Conflict` with a witness.

Rejecting would mean the fire-safety cap **could never be recorded at all**,
because the market commitment already in the graph contradicts it. The corpus
would stay quietly wrong instead of loudly conflicted, and the system's single
most valuable output would be the thing it structurally cannot express. Admission
and coherence are different questions.

This is only defensible if admitted conflicts cannot rot, which is what
`conflict-hygiene.rq` (§7) enforces: unwitnessed, unowned, unresolved, and
expired-waiver are all gate failures.

## 6. Ontology and schema delta

Landed in `rdf/ontology/authoring.ttl` — a domain-neutral profile over
`aion-rfc.ttl`, additive only, so the 55 per-RFC diff gates and the existing
corpus are unaffected. 15 classes, 51 properties, 31 vocabulary individuals.

| Group | Terms | Why |
|---|---|---|
| Discipline | `au:Discipline`, `au:discipline`, `au:stewardedBy` | A conflict is interesting exactly when its parties differ here, because then no single reviewer holds the context to see it. `stewardedBy` gives an adjudication an addressee. |
| Quantity | `au:Quantity` + `dimension`, `unit`, `measurementPoint`, `estimator`, `timeBase`, `viaModel`, `disjointQuantity` | **Dimension checking is insufficient.** MW and MVAr share a dimension; "capacity" resolves to nameplate, accredited, contracted, insured, and permitted values. Identity is dimension *plus referent*. |
| Bound | `au:Bound` + `boundKind`, `boundValue`, `boundGuard` | Reifying bounds is what makes the feasible envelope a `GROUP BY` instead of a reading comprehension exercise. |
| Scope | `au:Scope` + jurisdiction/body/instrument/edition/effective interval, `au:precedes` | `precedes` is a **partial** order and stays partial: an undefined pair raises an owned decision instead of inventing a ranking nobody agreed to. |
| Ladder | `au:Rung` R0–R5, `au:rung`, `promotedBy`, `demotedBy`, `stalledOn` | R4 is the binding threshold. `stalledOn` must name the blocker — an unnamed stall is unrankable and unassignable. |
| Conflict | `au:Conflict`, 5 `ConflictKind`s, `party`, `witness`, `detector`, `owner`, `blocksWorkOrder` | `blocksWorkOrder` is the board's sort key: a conflict matters in proportion to how much construction it stops. |
| Resolution | `au:Resolution`, 5 `Outcome`s incl. `au:Refute`, `expires` | The decision is itself a formal, expiring object. `au:Refute` exists because **a spec system a domain expert cannot correct is worthless** — it records both the correction and the detector that produced the false positive. |
| Defeasibility | `au:defeasible`, `au:Defeater`, 6 `ComplianceStatus` values | Collapsing `Excused` / `BreachedButLiquidated` / `Breached` / `Unresolved` into "allowed" is precisely the prose failure this profile exists to prevent. |
| Proposal | `au:Proposal` + `parent`, `surface`, `intent`, `transcript`, `verdict` | `surface` is recorded and never read by admission. |

### 6.1 `au:rung` is orthogonal to the Lean `Tier` — and `Tier` has no TTL form

`Spec.Corpus.Schema.Tier` (Structural / Derivational / Implemented) grades how a
claim's **proof** is discharged. `au:rung` grades how far the claim has been
**formalized at all**. A claim can be fully formalized at R4 and still
Structural; it cannot be Derivational below R4. Conflating the two is what makes
"partially authored" unrepresentable today.

Discovered while writing the gates and worth fixing independently: **`rfc:tier`
does not exist in the TTL ontology at all.** `Tier` is Lean-only, so it is
neither queryable nor drift-checkable, and per `aion-rfc.ttl` the authoritative
TTL signal for kernel-verified is `rfc:provenBy`. `ladder-integrity.rq` therefore
checks `provenBy`, and adding a TTL projection of `Tier` is filed in §13.

## 7. Gate set

Landed in `rdf/lint/authoring/`, in the style of `rdf/lint/semantic/`, wired by
`//rdf:authoring_gates.bzl` and executed against a positive and a negative control
(`rdf/lint/authoring/fixtures/`, following the
`grounding/AdversarialGateCheck.java` discipline).

**Only three of the seven are gates.** The split is the important part.

**Gates** — zero-row, fail the build:

| Gate | Rejects | conflict / clean |
|---|---|---|
| `envelope-unrecorded.rq` | an empty envelope with **no `au:Conflict` recording it** | 0 / 0 † |
| `conflict-hygiene-strict.rq` | unwitnessed · unowned · unbounded or expired waiver | 4 / 0 |
| `ladder-integrity.rq` | hand-set rungs · unnamed stalls · `provenBy` below R4 | 4 / 0 |

† Correctly silent on *both* fixtures: the conflict fixture's empty envelope **is**
recorded. Strip `conflicts.ttl` from the AMPERE corpus and it fires with 2 rows —
which is the `//corpus/ampere:ampere_undocumented_authoring_*` target, tagged
`manual` + `known-failing-by-design` so it can be run as the demonstration that
the gate has teeth.

**Measures** — reported, never fail:

| Measure | Reports | AMPERE |
|---|---|---:|
| `empty-envelope.rq` | the infeasibilities, with deficits | 2 |
| `conflict-hygiene.rq` | the full report, **including `UNRESOLVED`** | 7 |
| `cross-discipline-coconstraint.rq` | implicit co-constraint candidates | 25 |
| `homonym-unregistered.rq` | the glossary-alignment work queue | 21 |

`UNRESOLVED` is deliberately **not** gated, and neither is an empty envelope. Both
are *true findings about the world*: a real multidisciplinary corpus has open
conflicts, and two instruments can genuinely be jointly unsatisfiable. Gating on
them would push authors toward fake resolutions and unrecorded infeasibility —
the exact failure this system exists to prevent. What *is* gated is an
infeasibility nobody wrote down, and a conflict nobody can act on. The
distinction is between *"we have open problems"* and *"we have problems nobody
can work on."*

The positive control is `fixtures/expect-detections.rq`: a zero-row test
asserting each gate's **detection count** over the planted fixture (including
that the deficit computes to exactly 27.0 MW). It returns 0 rows over the
conflict fixture and 5 over the clean one, so the assertions are demonstrably
live. Written as counted assertions rather than an `emit_diff_test` against a
golden TSV so it carries no dependency on the SPARQL engine's serialization.

The headline result:

```
quantity                 unit  greatestLower  leastUpper  deficit  disciplines
q-sustained-discharge    MW             82.0        55.0     27.0            4
```

Four instruments — a capacity commitment, an OEM thermal derate, a fire-safety
state-of-charge cap, a warranty throughput budget — each individually satisfiable,
none citing any other, jointly infeasible by 27 MW. **No document states this.**
It falls out of a `GROUP BY` with a `HAVING` clause, which is the whole argument
for making bounds data.

These join the existing ten `rdf/lint/semantic` gates rather than replacing them.
Not yet wired into `BUILD.bazel` targets — see §12 P0.

### 7.1 What the door can and cannot prove

Stated plainly, because the gap is where a plan like this usually cheats.

**Can:** that a proposal's ops are well-typed against the schema; that the
principal holds capability for each op; that every named gate returns zero rows
after application; that the corrector is meaning-preserving, energy-non-increasing
and idempotent for the dedup pass (`mem_dedupE`, `dedupE_length_le`,
`dedupE_idem`, already proved); that graph state is untouched on rejection.

**Cannot, today:**

- **That a `provenBy` theorem says what the claim says.**
  `//grounding:grounding_verified` proves the name resolves to a sorry-free
  theorem — genuinely un-gameable as far as it goes, since no LLM output fakes a
  compiling proof. It does not prove correspondence. The narrowing mechanism is
  concrete and belongs in the roadmap: have `CorpusToLean` **generate the theorem
  signature from the claim's formal content**, so the human supplies only the
  proof and the statement cannot drift. That converts a documentation convention
  into a build dependency.
- **That conflict detection is complete.** `empty-envelope.rq` is complete for
  claims that carry `au:Bound`s over a shared quantity, and silent about
  everything else. General cross-domain consistency is not decidable at this
  scale; the honest framing is a *decidable fragment* — linear bounds over typed
  quantities with comparable time bases — that grows as the corpus is typed. The
  dark fraction (§8) is the published measure of what is outside it.
- **That an agent cannot promote a claim.** This is the design's intent, but §3.1
  removes the natural mechanism: Aion's proved permission machinery is
  unavailable by dependency direction. Until an equivalent exists in `spec`,
  capability is enforced by the door in ordinary Rust/Java, and that is a code
  property, not a theorem. Filed in §13 as the largest open gap.

## 8. Point-and-click authoring (meridian)

### 8.1 Delivery: adhoc-first

Per §3.3, the declarative vocabulary is `table` / `lro` / `adhoc` with no write
primitive, and `meridian_schemas` is upstream. So the authoring surfaces ship as
**adhoc handlers** against spec's own web routes — the mechanism `chat`, `fleet`,
`configs_manager`, `image_explorer` and the *mutating* `access_keys` already use.
No upstream change, no version negotiation, week-one shippable.

The mutation surface collapses to two routes: `POST /proposal` and
`POST /proposal/{pid}/verdict-preview`. Every write affordance anywhere composes
an op and submits through them.

### 8.2 The surfaces

Navigation is faceted drill-down, never a global list — with ~8,000 in-scope
claims across 12 disciplines there is no useful flat index.

| Panel | Kind | What it does |
|---|---|---|
| `atlas` | adhoc | Discipline lattice with conflict-heat and **dark fraction** — the share of claims below R4, i.e. how much of the corpus an agent fleet may *not* build against. |
| `scope` | adhoc | The same lattice keyed on scope: *"what constrains the thermal subsystem"* — pulls every obligation from every discipline binding that scope in one aligned vocabulary. **The query nobody can answer today.** |
| `conflicts` | adhoc | The annunciator board, faceted by discipline pair, sorted by blocked work orders. |
| `witness` | adhoc, read-only | The envelope: constraint bars on one axis, the intersection, the deficit, and per-party defeasibility. **No editing affordances at all** — you cannot fix a witness, only arbitrate the claims under it. |
| `claim` | adhoc | Obligation normal form + the R0–R5 ladder with each rung's evidence and gate. |
| `proposal` | adhoc | Per-op diff with accept / reject / defer, the `IntentRecord` prose alongside the ops, and for chat-authored proposals the **rejected** formalization attempts. |
| `frontier` | table | Stalls ranked by how many binding claims depend on them. A plain table suffices. |
| `fanout` | table | Work orders, obligation counts, disciplines bound, hold reasons. |
| `draft bar` | shell | Persistent staging with a live door-verdict chip. Composition spans screens and sessions; without it the door only speaks at submit time, which is the worst moment to learn you contradicted the safety discipline. |

Authoring a claim: from a scope node, a form whose fields are the obligation
normal form, prefilled from the drill path. **Term fields are typeahead over the
aligned glossary and cannot accept free text** — an unmatched term forces an
explicit `bindTerm` with a definition or an `alignTerm` against an existing
concept. That is where corpus reuse is enforced rather than encouraged, and it is
the single highest-leverage constraint in the UI, because most cross-domain errors
are homonym errors.

Arbitration is four proposal composers, not four buttons that mutate:
**Narrow** (`narrowGuard`), **Prioritize** (`declarePrecedence`, kernel
capability, routes to review), **Exempt** (waiver with mandatory expiry),
**Escalate** (admit the conflict standing, notify both stewards, hold orders).
Nothing resolves a cross-domain conflict unilaterally.

A visual mock of all of these over the AMPERE corpus is at
[`mocks/ux/README.md`](../mocks/ux/README.md).

### 8.3 The promotion step

Once the op vocabulary has stabilized against real use, the surfaces that proved
stable get promoted **upstream** into `meridian_schemas` as declarative
descriptors — from evidence, once, rather than by guessing now. The candidate set
is `LatticePanel`, `DeltaPanel`, `WitnessPanel`, and an
`Action.emits_proposal_op` field that would let a descriptor lint statically
prove every write affordance composes an op. Deferring this is a sequencing
decision, not an abandonment: it is the only path to design 1's "an illegal edit
has no representation."

## 9. Chat authoring — intent grounding and formalization

Same `Proposal`, composed conversationally, over `plugin-chat`'s existing loop
(`POST /turn`, SSE `HostEvent`s, confirm-gated mutation) and spec's MCP surface
extended with write tools. The user never reads Turtle or Lean.

The loop, and what makes each step honest:

1. **Capture.** The utterance is recorded at R0 with a content hash. Nothing is
   interpreted yet, and nothing is discarded.
2. **Decompose.** `decomposer` produces candidate claims at R2 with named holes.
3. **Interview — only about the holes.** Because R2 skeletons enumerate their
   unbound holes, the model asks about exactly those and nothing else. This is the
   difference between a grounding interview and a questionnaire, and it is what
   makes the loop survivable across thousands of claims.
4. **Back-translate.** The formalization is shown as a **card in the expert's own
   terms** — who / must not / when / because / can it be waived — generated from
   the same op structure the door will read, not a re-description of the prose. The
   expert checks a claim, not a syntax.
5. **Gate before commit.** Gates run on the previewed proposal. On failure the
   user sees the specific contradiction and *the model refuses to choose* when
   resolving it needs authority it does not have. It offers the two real options
   and routes the one needing another signature to that person as a separate
   proposal.
6. **Confirm.** `confirm:true` is the only mutating call and carries a `pid` whose
   content hash the user already saw.
7. **Consequences are reported, not hidden.** Applying may open a conflict and a
   proof obligation. "This is not an error in what you wrote; it is the first time
   the corpus could see it."

The persuasive property is where the model **stops**: unbound holes only, no
adjudication without authority, no quietly widening a scope to make a gate pass.
Annotated transcripts — including a case where the model is *wrong* about a
conflict and the expert refutes it, recorded as `au:Refute` — are in
[`mocks/ux/chat/`](../mocks/ux/chat/).

### 9.1 The equal-citizen gate

The mechanical test that both front ends are one system: **a scripted click
sequence and a scripted chat session that author the same change must produce
proposals with identical content hashes.** Content-addressing collapses them to
one proposal with two provenance records. If the hashes differ, the surfaces are
composing different ops and the claim of equivalence is false.

## 10. Agent fanout over an authored spec

An agent never receives "the spec." It receives a **work order**:

```
WorkOrder
  scope           : ScopeExpr
  obligations     : [ObligationId]   -- lattice closure over scope, ALL disciplines
  glossary        : aligned term slice
  forbidden       : [ScopeExpr]
  conflict_holds  : [ConflictId]     -- MUST be empty to dispatch
  acceptance      : [DecidableCheck]
  write_capability: Capability       -- artifact paths
  as_of           : Hash             -- bitemporal cursor, not "latest"
```

Four mechanisms carry the invariant claim:

1. **Obligation closure, not document handoff.** `obligations` is the upward and
   downward closure on the scope lattice, so the agent building the thermal module
   is handed the safety, market, warranty and cyber obligations that bind its
   scope, in one aligned vocabulary. Ignorance of a cross-discipline requirement
   stops being possible.
2. **Only R4+ binds.** R0–R3 claims arrive explicitly marked non-binding, and
   satisfaction evidence may only reference R4+. Half-formalized spec cannot leak
   into implementation as though settled — the specific failure mode that makes
   "author fast, formalize later" dangerous.
3. **Dispatch is gated on the conflict graph.** `conflict_holds` non-empty ⇒ no
   dispatch. Plus pairwise scope-disjointness with every running order.
4. **Agents may write R0 only.** An agent principal's capability covers its
   artifact paths and `assertNS` at R0 — never `promote`, `adjudicate`, `bindTerm`
   or `declarePrecedence`. §7.1 is honest that this is currently a code property
   rather than a theorem.

**Fanout feeds back into the spec.** An agent that cannot satisfy an obligation
raises a `HumanPrompt` (the `agents` CRD) naming the missing claim rather than
guessing, widening its own scope, or silently marking the obligation met.
Authoring the missing claim amends the spec, recomputes the closure, and resumes
the agent from its checkpoint. That is the good failure mode, and it is the whole
reason to put the obligations in a graph.

## 11. Worked corpus — AMPERE

A 400 MWh / 100 MW grid-scale battery plus an aggregated DER virtual power plant
bidding into two US wholesale markets, including its financing, safety case,
cybersecurity posture and control software. Twelve disciplines: electrochemistry
and thermal, interconnection, market microstructure and tariff, protection and
controls, fire and life safety, cybersecurity and reliability compliance, tax and
project finance, accounting and revenue recognition, environmental permitting and
land use, software and DER fleet control, metering and settlement, and
insurance / warranty / O&M.

Chosen because **four incommensurable rule systems bind the same five-minute
dispatch decision**: continuous physics; public law in three parallel
jurisdictional stacks; private contract; and executable market software. Scale is
genuinely large — roughly 500 documents and ~50,000 extractable normative
statements, of which ~8,000 are in scope for one asset. But the decisive number is
neither of those: it is the estimated **4,000–8,000 implicit co-constraint pairs**
— statements from different disciplines bounding the same physical, temporal or
financial quantity while citing nothing in common — of which a few hundred bind
and perhaps 60–150 are true conflicts. A citation graph finds almost none of them.

Alternatives considered: a clinical-trial platform (well-structured sources, but
the conflicts are mostly within-discipline), spacecraft avionics (deep, narrow),
cross-border payments (multi-jurisdiction, but one discipline's vocabulary
dominates). AMPERE wins on *cross-domain conflict density*, which is the property
under test.

### 11.1 The result that justifies the whole RFC

The corpus as committed (`corpus/ampere/`, 2,077 triples) is **SHACL-conformant**
and returns **zero rows from all nine pre-existing coherence gates** —
contradiction, modality conflict, dangling references, dependency cycles,
derivation cycles, term drift, diagnostic collisions, dead `dependsOn`, inverse
edges. By every coherence check the spine had before this RFC, it is clean.
(`grounding.rq` correctly reports 64/64 ungrounded — nothing is theorem-backed
yet. That is the frontier, not a defect.)

It nevertheless contains **two empty feasible envelopes**, found by the new
`empty-envelope.rq`:

```
q-sustained-discharge   MW    82.0 > 55.0    deficit 27.0 MW   5 disciplines
q-telemetry-latency     ms   180.0 > 150.0   deficit 30.0 ms   2 disciplines
```

`modality-conflict.rq` cannot see either, because it matches on **byte-equal
predicate text** — and these claims share no words, no document, no discipline and
no citation. The second envelope was **not planted as a headline**: the same
aggregation found it on *time* rather than power, which is the evidence that the
mechanism generalises rather than being tuned to one demo.

That is the argument for the whole RFC in one measurement. The existing gate set is
not weak; it is *structurally blind* to cross-domain infeasibility, and no amount
of prose review closes that gap.

**Citation posture, stated once and prominently:** the corpus is technically
coherent and deliberately **not citation-verified**. Clause numbers are leads, not
facts, and are marked `# UNVERIFIED-CITATION`. No real market operator,
manufacturer, insurer or jurisdiction is named. The corpus exists to exercise
mechanisms.

## 12. Phased roadmap

Each phase is independently shippable with a demonstrable gate. Week numbers are
sequencing, not commitments.

| Phase | Weeks | Deliverable | Gate |
|---|---|---|---|
| **P0** Wire what exists | 1–2 | `BUILD.bazel` targets for `rdf/ontology/authoring.ttl` + the gates + both fixtures. **Written; never exercised — see §12.1** | The §7 control table runs under `bazel test`. Blocked on the pre-existing `//java/...` maven and `//graph/...` svg2pdf failures |
| **P1** Proposal + door | 3–8 | `lean/Spec/Authoring/{Proposal,Op,Door}.lean`; append-only proposal log; `spec propose` / `spec replay` CLI over `java/kg/edit`'s existing `WriteOps` | `spec replay <bootstrap-pid>` reproduces the committed corpus TTL **byte-identically** |
| **P2** TTL becomes emitted | 6–11 | The corpus becomes an emit target of the proposal log via `Spec.Emit.TtlEmit` | **The existing 55× `rfc_NNNN_ttl_diff_test` pass unchanged — same tests, inverted meaning, zero test deletion.** The strongest available proof the new write path is faithful |
| **P3** Ladder + import | 9–13 | R0–R5 as graph state; import the existing corpus, assigning rungs from evidence | Every existing claim lands at its correct rung with **zero hand annotation**, and the rung histogram is published |
| **P4** Adhoc authoring surfaces | 10–16 | The §8.2 panels as adhoc handlers; `POST /proposal`; the draft bar | A requirement authored end-to-end **by clicking** merges through the door |
| **P5** Chat plane | 14–19 | The §9 loop in `plugin-chat`; spec's MCP write tools; back-translation cards | **The equal-citizen gate (§9.1): click and chat produce identical `pid`s** |
| **P6** Conflict engine | 17–24 | The decidable fragment; witness computation; the four arbitration moves | At least one **genuine** cross-domain conflict found in a real corpus with a reviewed witness, and one conflict resolved by each of the four moves |
| **P7** Fanout | 22–28 | Work-order derivation with closure; capability tokens; dispatcher disjointness | N≥8 agents build concurrently with **zero cross-scope writes (verified, not observed)**; an order whose closure touches an open conflict refuses to dispatch |
| **P8** Retire hand-authoring | 26–30 | Remove the hand-TTL workflows from `CLAUDE.md`; make raw writes unreachable | `//ci:pr_gates` green with the raw-write path absent from the dependency graph, asserted by a dep-graph test |

P0 is deliberately two weeks and mostly wiring: the mechanism layer is already
written and verified, and the fastest way to lose it is to leave it un-gated.

### 12.1 P0 is wired, but CI cannot tell you whether it works

The wiring is present. It has **never been exercised**, and the reason is worth
recording carefully because it cost four commits to establish.

**`fastverk/build` is red on `main`, and has been for a while.** The evidence:

| head | `fastverk/build` |
|---|---|
| PR #16 (merged into `main`) | failure |
| PR #17 (merged into `main`, = current `main`) | failure |
| this branch, at a one-line BUILD change | failure |

And the cause is documented in `main`'s own HEAD commit message (`9bac9d7`):

> *NOT fully verified: `bazel build //...` does not pass on this host either
> before or after this change — `//java/...` cannot fetch maven ("Unable to locate
> a Java Runtime" from coursier) and `//graph/...` fails in svg2pdf under bun.
> Both reproduce identically on unmodified origin/main, so they are pre-existing
> and environmental.*

So the check is a **constant, not a signal**. It says nothing about whether a
change is sound, and cannot validate the P0 wiring either way.

**What that cost.** Three commits chased that red as though the wiring had caused
it — narrowing constructs, then withdrawing the wiring entirely — before checking
whether `main` was red too. The build log at `app.fastverk.com` returns 403 to the
authoring environment and the check run's `output.text` is empty, which removed
the fastest path to the answer. But the merged-PR check history was available the
whole time and would have settled it in one call. **Check whether the baseline is
green before treating a red check as yours.**

**What was genuinely found.** One real bug, and it justified the exercise: an
empty `glob()` across a new package boundary. `rdf/lint/authoring/BUILD.bazel`
makes that directory a subpackage; `glob()` does not match into a subpackage; so
`glob(["lint/authoring/*.rq"])` in `//rdf` matched nothing — and an empty glob is a
hard error under `--incompatible_disallow_empty_glob`, default-on since Bazel 7.
That would have broken loading of `//rdf` for every consumer, locally as much as
in CI. Fixed, with a comment at both sites naming the trap.

**Still unvalidated**, for whoever has a working bazel:

1. `spec_authoring_gates` forwarding `tags` into `sparql_query` / `sparql_query_test`.
2. `rdf_dataset` with two vocab TTLs in `srcs` — chosen over `deps = [":vocab"]`
   precisely because dataset-on-dataset layering has no precedent in this repo.
3. Whether Jena's SHACL engine agrees with `pyshacl` on the three new datasets.
4. Whether `//corpus/ampere:{measure,coverage,frontier}` resolve their
   `queries/*.rq` labels. That subdirectory has no `BUILD.bazel`, so it should be
   the same package — untested.

**One thing was dropped rather than fixed.** An earlier draft wired a permanently
red target — the AMPERE corpus minus `conflicts.ttl`, whose `envelope_unrecorded`
gate then fires with 2 rows — to demonstrate the gate has teeth. In a repo whose
culture is "green gates or it isn't real", a target that always fails is an
invitation to start ignoring CI, and it is doubly wrong when the surrounding check
is already a constant red. The demonstration belongs as a **positive** assertion:
a query over the conflicts-stripped dataset whose expected row count is 2, which
is zero-row exactly when the gate works — the shape
`fixtures/expect-detections.rq` already uses. `corpus/ampere/BUILD.bazel` carries
the verified numbers in a comment meanwhile.

**The independent verification path.** Everything the wiring would gate is
verified by execution under `rdflib` 7.6 + `pyshacl`, and that harness reproduces
`docs/phase-0-materialization.md`'s numbers exactly over the shipped corpus — 18
documents, 38 claims, SHACL conformant, all four consistency invariants at zero.
That agreement on known-good data is what licenses trusting it on the new data.
Keeping a Python-only path working is worth a little effort on its own merits: it
runs where a bazel is not provisioned, which is most agent sessions.

## 13. Open questions

1. **Capability enforcement without Aion's permission proofs (§3.1, §7.1).** The
   largest gap. Options: build a minimal proved policy layer in `Spec.Authoring`;
   invert the dependency so the permission tier lives in `spec` and Aion consumes
   it; or accept a code-level property and say so. This should be decided before
   P7, since fanout is where it bites.
2. **Claim ⇄ theorem correspondence.** Is generating theorem signatures from claim
   content (§7.1) sufficient, or does the claim's formal content need to be
   expressive enough that the signature is the whole statement?
3. **A TTL projection of the Lean `Tier` (§6.1)**, so it becomes queryable and
   drift-checkable like every other field.
4. **The decidable fragment's boundary.** Linear bounds over typed quantities with
   comparable time bases is the proposed starting fragment. What is the next
   increment that pays for itself — intervals? piecewise-linear derate curves?
5. **Where the promotion step lands (§8.3).** Which surfaces earn declarative
   descriptors, and who negotiates the `meridian_schemas` 0.5.0 / 0.6.0 skew.
6. **Rung assignment on import (P3).** Can rungs really be derived from evidence
   for the whole existing corpus with zero hand annotation, or is there an
   irreducible manual tier?
7. **Adjudication authority in practice.** `au:stewardedBy` gives a conflict an
   addressee, but a four-party empty envelope has four stewards and no obvious
   chair. Does the corpus need an explicit escalation order, and is that itself a
   scope-precedence claim?
