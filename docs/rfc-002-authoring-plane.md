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

*(Locked design — see §4.1 onward.)*

## 5. The proposal IR

## 6. Ontology and schema delta

## 7. Gate set

## 8. Point-and-click authoring (meridian)

## 9. Chat authoring — intent grounding and formalization

## 10. Agent fanout over an authored spec

## 11. Worked corpus — AMPERE

## 12. Phased roadmap

## 13. Open questions
