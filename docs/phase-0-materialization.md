# Phase 0 — the ratio spec corpus, materialized as a gated graph

**Status:** Done (slice 1) · **Companion to:** [RFC-001](./rfc-001-unified-spec-graph.md),
[RFC-001b](./rfc-001b-crystallization-math.md), [crank-001](./crank-001-first-step.md)

The crank-001 measurements were computed by agents reading prose. Phase 0 turns
the corpus into an actual graph: every claim, edge, and hub now has a triple
behind it, loaded into Jena, validated by SHACL, gated by the consistency
invariants, and **measured by SPARQL** — so subsequent cranks descend `E(G)` over
real data, not estimates.

## What landed

- **Seed graph** — [`corpus/ratio-corpus.ttl`](../corpus/ratio-corpus.ttl): the
  conservation kernel + the 16 advertised components as `:Document`s /
  `:NormativeStatement`s in the shared vocabulary
  ([`rdf/ontology/aion-rfc.ttl`](../rdf/ontology/aion-rfc.ttl)). No new vocabulary
  was needed — the existing Aion RFC ontology + gates already speak claims,
  modalities, and `dependsOn`/`refines` edges, and its semantic lints
  (`claim-contradiction`, `modality-conflict`, `dead-depends-on`, `grounding`,
  `term-drift`) map onto the `E(G)` terms.
- **Gates green** — `//corpus:ratio_corpus_gates_*`: SHACL conformance + the four
  consistency invariants (dangling refs, dependency cycles, diagnostic-code
  collisions, asymmetric inverse edges) all pass over the real graph.
- **Measured `E(G)`** — `//corpus:eg_measure` (`bazel build` →
  `bazel-bin/corpus/eg_measure.tsv`), read off the graph:

  | metric | value |
  |---|---|
  | documents | 17 |
  | claims (NormativeStatements) | 19 |
  | dependsOn / refines / containsRule edges | 20 / 1 / 19 |
  | conservation-hub (RFC-0900) in-degree | **13** |
  | read-projection-hub (RFC-0901) in-degree | **5** |
  | MUST / MAY / MUST_NOT | 16 / 2 / 1 |
  | proven (provenBy) | 2 |

  The near-star crank-001 estimated is now quantitatively confirmed: the
  conservation hub dominates connectivity.

- **First frontier standard internalized** —
  [`corpus/nav-sec-2a4.ttl`](../corpus/nav-sec-2a4.ttl): SEC mutual-fund NAV
  (17 CFR 270.2a-4 / 22c-1 / 2a-5; §2(a)(41)) as 19 `:NormativeStatement`s with
  modality, citation, and verbatim `:evidence`, linked into the corpus via
  `:references` (portfolio-accounting, alternative-investments). The combined
  `//corpus:corpus_standards_gates_*` pass (the internalization edges resolve);
  `//corpus:standards_measure`: 38 total claims, 18 documents, 8 with verbatim
  evidence, 2 components grounded. Source research:
  [`docs/frontier/nav-sec-2a4.claims.json`](./frontier/nav-sec-2a4.claims.json).

- **Topology from SPARQL** — `//corpus:corpus_edges` reads the graph's typed edges
  straight from the store: the data a SPARQL→dot renderer turns into the hero
  graph (the "deck is an output of the pipeline" step).

## What's next

1. **tsv → dot render**: format `//corpus:corpus_edges` output as `.dot` and
   `dot_pdf` it, so the hero graph regenerates from the graph (mechanical).
2. **Deterministic compaction** (RFC-001 §5): symmetry detection + redundancy
   collapse (16 → 7 motifs) over the graph — the corrector pass; the
   before/after `E(G)` drop becomes graph-measured.
3. **NAV → theorems** (RFC-001 §6): materialize each NAV `:NormativeStatement` as
   a `:Theorem` (normative-is-theorem.rule) and turn the JSON `depends_on` into
   `:premise`/`:derivedVia` so grounding is checkable.
4. **uslm bridge**: IRC tax-lot (§1012/§6045, Title 26 USC) is internalizable via
   the `uslm` legislative-KG vertical today; CFR Title 17 (NAV) is regulation, so
   it stays on the §6 document track for now.
