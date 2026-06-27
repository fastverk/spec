# RFC-001 — The Unified Spec Graph

**Status:** Draft · **Spine:** `spec` · **Depends on:** `decomposer`, `mycelium`, `agora`
**Author:** (scaffold) · **Date:** 2026-06-26

> *Crystallize a vision — or a normative standard — into a proven, compact,
> self-extending knowledge graph, by alternating stochastic refinement (cloud
> agents) with a deterministic, machine-checked projection.*

---

## 1. Motivation

fastverk has, independently, built almost every piece of a system that can turn
prose into a verified semantic graph — but the pieces live in three repos with
**three overlapping copies of five things**:

| Concern | `spec` / `@spec` | `agora` | `mycelium` |
|---|---|---|---|
| Graph store / reasoner | Jena 5 + `kg.Loader` (inference) | Jena (in `CompositeMergeFn`) | Jena (in `kg_research` spike) |
| Claim model | `Spec.Corpus.Schema` (`Modality`, `Tier`), `:NormativeStatement` | `decomposer.v1.Claim` + `agora.v1.Fragment` + `graph.proto` | `kg_research` `claim:contradicts` |
| Grounding vocabulary | rules_rdf gates | `OntologyValidator` (schema.org TSVs) | Wikidata Q-IDs |
| Content-addressing | `md5(rfc\|section\|predicate)` | `claim.hash`, `ClaimCache` | `sha256(sparql)` |
| Gates / validation | `kg.GateHarness`, `rdf/lint/semantic/*.rq` | `SidecarDeriveGateFn` | — |

Three Jenas, three claim schemas, three hashes. The spec library "doesn't scale"
not because anything is missing, but because there is **no single spine**: no one
canonical claim identity for parallel agents to dedupe against, no one ontology
for the deterministic optimizer to canonicalize, no one gate harness.

This RFC unifies the three behind **`spec` as the spine**, adds the one genuinely
missing capability — a **deterministic projection kernel** — and shows how the
result turns "improve the spec library" into a single, formal, scalable loop.

---

## 2. The crystallization model (diffusion)

Refinement is modeled as a **diffusion / denoising process** over a graph `G`.

**Forward (noising) operator — `decompose`.** A vision narrative (or a normative
document) is exploded into a cloud of atomic, content-hashed claims — high
entropy: redundant, loosely linked, locally contradictory. This is the seed
graph `G₀`.

**Reverse (denoising) step — two alternating halves:**

1. **Stochastic score step** (cloud agents): propose links, merges, rewrites, and
   new claims (`agora`: `ClaimPropose → CompositeMerge → Ensemble → Verify`). This
   is the *learned sampler* — it guesses the direction of lower energy.
2. **Deterministic projection step** (the new kernel): exact, idempotent passes
   that project `G` onto the *coherent manifold* — dedup by content hash,
   transitive reduction, symmetry/automorphism collapse, canonical normal form.
   Entropy-non-increasing and **replayable**, the way the `ratio` kernel is.

The alternation is annealed Langevin / proximal-gradient: noisy explore, then
project to the constraint set, repeat at a falling temperature.

**Energy descended ("make it better"):**

```
E(G) = w1·R + w2·C + w3·D + w4·U  −  w5·L − w6·S
       └─── entropy ───┘             └── order ──┘
  R = redundancy        L = meaningful connectivity
  C = contradictions    S = symmetry compression (MDL gain)
  D = dangling links / loose threads
  U = under-specification (frontier)
```

- Stochastic steps mostly cut `C, D, U` and add `L`.
- Deterministic steps provably cut `R` and bank `S` (a symmetry *is* a
  compression — Occam / minimum description length).
- **Crystallized** = a fixed point of the loop: a compact, strongly-linked,
  contradiction-free canonical graph. Lower `E` ⇒ a better spec.

**Temperature schedule = ensemble tiering.** Early steps are hot/broad
(`agora`'s Haiku×2 breadth, many parallel trajectories); late steps are
cold/precise (Sonnet→Opus verify, then the deterministic projection).

**Reproducibility ("never lose the thread").** Every claim is content-addressed
and every projection pass is deterministic, so the whole *narrative → crystal*
trajectory replays bit-for-bit — and parallel cloud trajectories never collide,
because they dedupe through the content-addressed `ClaimCache`.

---

## 3. Unified architecture: one spine, three jobs, no cycles

Make **`spec` the spine** — it already hosts Jena + the Lean spec framework +
the gates. Each repo gets exactly one job and a single dependency direction:

```
decomposer ──▶ spec ──▶ mycelium
   (forward     (SPINE)      (grounding service:
    operator)      │          implements spec's
                   ▼          GroundingService iface)
                 agora
            (pipelines + cloud fan-out + frontier)
```

- **`decomposer`** — the forward/noising operator only: `decompose(nl) → List<Claim>`,
  each `Claim{hash, raw, index}` content-addressed. Leaf dependency.
- **`spec` (SPINE)** — owns:
  - the **one canonical Claim/Graph ontology** (authored in `Spec.Corpus.Schema`
    Lean, emitted to TTL via `Spec.Emit.TtlEmit` — the ontology is itself
    Lean-defined and proven);
  - the **one gate harness** (`kg.GateHarness` + `rdf/lint/semantic/*.rq`);
  - the **Lean proofs** (`Spec.Kernel`, `Spec.Axioms`, `kg.lean.{GenerateProofs,
    ValidateProofs, ProvenBySyncCheck}`);
  - the **new deterministic projection kernel** (§5).
- **`mycelium`** — promoted from Wikidata-accessor to the **grounding service**:
  implements a `GroundingService` interface *defined in spec* ("does IRI X
  ground? what is its canonical Q-ID anchor?"), absorbing `agora`'s schema.org
  `OntologyValidator` so there is **one** grounding tier.
- **`agora`** — the **pipelines**: the Beam `decompose → propose → merge →
  ensemble → verify → gate` flow, the content-addressed `ClaimCache`, the
  `research_closure` frontier BFS, and the Beam→Dataflow + RunPod cloud fan-out.
  Consumes spec's ontology/gates/projection and mycelium's grounding — drops its
  private copies.

This resolves the **source-of-truth** question: **RDF/Jena in `spec` is the
store; `graph.proto` is the wire format** between the Rust projection passes and
Beam (exactly what `agora`'s sidecar already does); **mycelium is the grounding
tier**.

### 3.1 Seams (contracts that make it one system)

1. **One Claim/Graph schema.** `Spec.Corpus.Schema` is canonical (Lean → TTL +
   proto). `decomposer.v1.Claim` is its forward-op subset; `agora.v1.Fragment` /
   `graph.proto` import it; `kg_research`'s `claim:contradicts` merges in.
2. **One grounding service.** spec defines `GroundingService`; mycelium implements
   it (Wikidata + schema.org closures under one API); agora wires it into gates.
3. **One content hash.** Standardize on the `decomposer` canonical claim hash for
   `ClaimCache`, the projection passes, and replay. (`mycelium`'s `sha256(sparql)`
   stays internal to its Wikidata cache.)
4. **One gate harness.** All validation — grounding, contradiction, modality
   conflict, dangling, **and the new canonical-form gate** — runs through
   `kg.GateHarness`, callable from `agora`'s `DeriveGate` and from CLI.

### 3.2 Migration deltas (what moves)

- Consolidate the claim/graph schemas into `Spec.Corpus.Schema` (+ a thin
  `graph.proto` profile). `agora` and `decomposer` import rather than redefine.
- Lift `agora.OntologyValidator` grounding into mycelium's `GroundingService`.
- Point `agora.ClaimCache` and the projection at the one canonical hash.
- Generalize `aion-rfc.ttl` → a `normative` ontology that `aion-rfc` becomes a
  profile of (§6).

---

## 4. Reuse vs. build

| Diffusion role | Component | Status |
|---|---|---|
| Forward / noising | `decompose(nl) → List<Claim>` | **exists** (`@decomposer`) |
| Stochastic reverse | `ClaimPropose → CompositeMerge(Jena) → Ensemble → Verify` | **exists** (`agora`) |
| Grounding / guidance | mycelium (Q-IDs) + schema.org closure | **exists** |
| Gates | `kg.GateHarness`, `rdf/lint/semantic/*.rq`, `DeriveGate` | **exists** |
| Reproducible, parallel-safe | `ClaimCache` (content-addressed) | **exists** |
| Parallel trajectories | Beam fan-out → RunPod vLLM autoscale | **exists** (DirectRunner; Dataflow-ready) |
| Frontier expansion | `research_closure` multi-hop BFS | **exists** (re-point at standards) |
| Crystal store + Lean proofs | `spec` (Jena + Lean + `CorpusToLean` + emit) | **exists** |
| RFC formalization | `Schema.lean` (`Modality`, `Tier`), `aion-rfc.ttl`, `normative-is-theorem.rule` | **exists** (Aion RFCs) |
| **Deterministic projection kernel** | symmetry / redundancy / compaction + `E(G)` | **← build (§5)** |
| **Typed spec ontology edges** (`refines / dependsOn / conflictsWith / realizes / livesIn…`) | extend `Schema.lean` | **← build** |
| **External normative-doc ingest** | mycelium front-end (§6) | **← build** |
| **Internalize gate** (relevance + licensing) | new gate (§7) | **← build** |

The spine is ~70–80% built. The new work is the *provable reverse-diffusion
kernel*, the *typed ontology*, and the *ingest/discovery front-end*.

---

## 5. The deterministic projection kernel

The novel contribution: a set of **deterministic, meaning-preserving graph
transformations** that lower `E(G)` and are **machine-checked**. Per the chosen
*hybrid* implementation:

- **Lean-proven core** (`Spec.Kernel` / a new `Spec.Graph.Projection`): the
  *invariants* — each pass is (a) meaning-preserving (the quotient/rewrite admits
  a graph homomorphism back to the original modulo the collapsed symmetry) and
  (b) entropy-non-increasing (`E` after ≤ `E` before). These mirror `ratio`'s
  conservation theorems: a small proven core relied on forever.
- **Rust passes** (emitted/aligned with the Lean spec, run via the `graph.proto`
  sidecar) for the hot path:
  1. **Content-hash dedup** — identical claims (same canonical hash) collapse to
     one node; provenance edges union.
  2. **Transitive reduction** — drop `A→C` when `A→B→C` exists for transitive
     edge types (`dependsOn`, `refines`).
  3. **Symmetry / automorphism detection** — find isomorphic claim sub-graphs
     (e.g. the "control-plane *proposes* → kernel *checks*" motif recurring across
     trading / billing / compliance) and collapse each orbit into one
     **parametrized template** node, banking the MDL gain `S`.
  4. **Canonical normal form** — a deterministic, replayable serialization so two
     runs over the same claim set produce byte-identical graphs.

`E(G)` is computed by SPARQL over Jena (the `rdf/queries/*` and `rdf/lint/*`
families already compute most terms: `dangling-references.rq` → `D`,
`claim-contradiction.rq`/`modality-conflict.rq` → `C`, `dependency-graph.rq` →
`L`). The kernel reports `E` before/after each step so progress is measurable.

---

## 6. Normative-document formalization track

> *Point mycelium at RFC / ANSI / IEEE / ISO / SEC documents and fully formalize
> them.*

The spine already formalizes **Aion's own** RFCs: each `:NormativeStatement` is
materialized as a `:Theorem` (`normative-is-theorem.rule`), grounded, and
discharged at a `Tier` (`Structural` / `Derivational` / `Implemented`).
Generalizing to *external* normative documents is an ingest + ontology-profile
job, not a new engine.

**Pipeline (per document):**

1. **Fetch** (mycelium front-end): retrieve the document (IETF RFCs are open;
   see §7 on licensing for ANSI/IEEE/ISO).
2. **Segment** → sections, with `SectionKind` (`Normative` / `Definitions` /
   `Grammar` / …) from `Schema.lean`.
3. **Decompose** each normative clause → content-hashed `Claim`s, tagged with
   RFC-2119 `Modality` (MUST / MUST_NOT / SHOULD / MAY / …).
4. **Propose → merge → ground** (agora + mycelium): claims → RDF fragments,
   grounded against the `normative` ontology + Wikidata anchors.
5. **Gate**: `claim-contradiction.rq`, `modality-conflict.rq`, `term-drift.rq`,
   `grounding.rq`, `dangling-references.rq`.
6. **Project** (§5): dedupe, reduce, collapse symmetries, canonicalize.
7. **Formalize**: `CorpusToLean` emits `Spec.Corpus.Schema`-typed Lean; each
   `NormativeStatement → Theorem`; `GenerateProofs` / `ValidateProofs` discharge
   them up the `Tier` ladder; `ProvenBySyncCheck` keeps Lean ⇄ TTL in lockstep.

**"Fully formalized"** is defined operationally as: *every normative statement is
a Lean theorem, grounded, contradiction-free, and discharged at ≥ its target
Tier.* Because the `Tier` ladder is explicit, formalization is **progressive and
measurable** (most clauses land `Structural` first; the frontier is the set not
yet `Derivational`/`Implemented`) — not an all-or-nothing claim.

**Ontology delta:** generalize `aion-rfc.ttl` into a reusable `normative`
ontology (`:Document`, `:Section`, `:NormativeStatement`, `:Term`, `:Grammar`,
`:CrossReference`, …) with `aion-rfc` as one profile and `ietf-rfc`,
`ieee`, `iso`, `ansi` as additional profiles (each adding its document-numbering
+ section conventions).

---

## 7. Discovery / frontier expansion

> *Wikipedia could have an article on "NAV calculation" that links to a standard,
> and we'd want to internalize that standard if it made sense.*

This is `research_closure`'s multi-hop BFS, generalized: the frontier edges are
no longer arXiv citations but **Wikidata/Wikipedia → external-standard links**,
and each candidate passes an **internalize gate** before it is pulled in.

**Loop:**

1. **Anchor** a seed concept (e.g. `wd:` "net asset value") via mycelium → its
   Wikidata/Wikipedia node.
2. **Expand** the frontier: follow `cites` / `seeAlso` / external-standard links
   (Wikidata properties like *described by source*, *standards body*) to candidate
   normative documents.
3. **Internalize gate** decides whether to pull each candidate in:
   - **Relevance** — does the candidate connect (within k hops) to a node already
     in the working graph / the active vision? (graph proximity + LLM judge).
   - **Marginal `E` gain** — would internalizing it lower `E(G)` (fill
     under-specification `U`, add connectivity `L`) more than it adds entropy?
   - **Licensing** — *only documents we have the right to ingest* (see below).
4. **Formalize** accepted documents via §6; loop.

This is exactly "advance the innovation frontier reliably without losing the
thread": the frontier is `U` (under-specification) in `E(G)`; each accepted
standard provably reduces it; everything is content-addressed and replayable.

### 7.1 Licensing constraint (important)

`research_closure`/the internalize gate **must** respect document licensing.
IETF RFCs are freely usable. ANSI / IEEE / ISO standards are **copyrighted and
typically paywalled** — the system may store *metadata, citations, and our own
formalized claims about a standard we are licensed to read*, but must not
redistribute the standard's text. The internalize gate therefore carries a
**licensing predicate** (`mayIngestFullText` / `metadataOnly`) and defaults to
metadata-only for non-open sources. This is a first-class gate, not an
afterthought.

---

## 8. Cloud-parallel execution

- **Fan-out**: Beam `ParDo` over claims/documents. DirectRunner today; the
  `beam_pipeline_binary` `_deploy.jar` is built to swap to Dataflow/Flink for
  true horizontal scale.
- **LLM tier**: `rules_runpod` serverless vLLM endpoints (gemma3 / Llama-3.x for
  decompose; Anthropic Haiku→Sonnet→Opus for propose/verify), with per-model rate
  limiters.
- **Dedup**: the content-addressed `ClaimCache` lets N parallel agents share work
  for free and makes reruns cheap — the substrate that makes parallel refinement
  *converge* rather than thrash.

---

## 9. Phased roadmap

- **Phase 0 — Ontology + seed.** Extend `Spec.Corpus.Schema` with the typed spec
  edges; load the 17 `ratio` competitive component specs (LaTeX → TTL via
  `AstToTtl`) as `G₀`; anchor concepts to Wikidata via mycelium. *(first milestone)*
- **Phase 1 — Forward.** Run `decompose` over the specs' prose → content-hashed
  claims → propose → merge → one grounded RDF graph.
- **Phase 2 — Deterministic projection.** Implement the kernel (§5) + `E(G)`;
  render before/after compaction so symmetries visibly collapse. *(first milestone)*
- **Phase 3 — Refinement loop.** Alternate stochastic propose ↔ deterministic
  project at a falling temperature; gates reject incoherent steps.
- **Phase 4 — Normative ingest.** mycelium front-end + `normative` ontology;
  formalize a first external RFC end-to-end (§6).
- **Phase 5 — Frontier discovery.** Wikidata-anchored BFS + internalize gate
  (relevance + marginal-`E` + licensing) (§7); cloud fan-out (§8).

**First milestone (this RFC's companion build):** Phases 0–2 on the 17 specs,
local, inspectable.

---

## 10. Decisions & open questions

**Decided** (this RFC): spine = `spec`; store = RDF/Jena truth + `graph.proto`
wire + mycelium grounding; projection = hybrid Lean-proven core + Rust passes;
first milestone = seed graph + compaction on the 17 specs, local.

**Open:**

- **Internalize-gate policy.** Exact thresholds for relevance + marginal-`E`;
  human-in-the-loop for accept/reject at the frontier vs. fully automatic.
- **Ontology generalization.** Naming/namespace for the generic `normative`
  ontology and how `aion-rfc` becomes a profile of it without breaking Aion.
- **Symmetry detection cost.** Subgraph isomorphism is expensive in general;
  scope to typed-motif templates + bounded neighborhoods first.
- **Lean proof surface.** Which projection invariants are worth full Lean proofs
  vs. property tests in the first cut.
- **Licensing tooling.** A source registry mapping document origin →
  `mayIngestFullText` / `metadataOnly`.

---

## Appendix A — Worked example: "NAV calculation"

1. **Anchor.** mycelium grounds "net asset value" at its Wikidata Q-ID.
2. **Expand.** The Wikipedia/Wikidata node links to a valuation standard (e.g. an
   accounting/valuation rule or an industry NAV methodology).
3. **Internalize gate.** Relevant (connects to the `ratio` ledger specs' P&L /
   valuation dimensions) ✓; licensing predicate checked ✓/metadata-only.
4. **Formalize.** Decompose the standard's normative clauses → claims (MUST/SHOULD)
   → ground → gate (no contradictions with the existing valuation claims) →
   project → `CorpusToLean` → theorems discharged at a Tier.
5. **Result.** The NAV methodology is now a proven, contradiction-checked
   sub-graph wired into the spec library — and any `ratio` valuation claim that
   depends on it gains a checkable derivation back to the standard.
