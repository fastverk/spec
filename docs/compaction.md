# Deterministic compaction — the corrector pass (RFC-001 §5 / RFC-001b §5)

The reverse-diffusion step is *predict then project*. The **corrector** `P` is the
deterministic, machine-checkable projection that never raises the energy — the
safe half of each crank. This is its first implementation over the materialized
graph, built as the hybrid you chose: a **Lean-proven core** + **executable
passes** over the live graph: a Lean-proven core + SPARQL passes, with Lean→Rust
emission available later via the kernel's existing path.

> **Correction (2026-08-05).** This section previously said Rust passes were
> deferred because "`rules_rust` isn't in the ecosystem." That is no longer true —
> `MODULE.bazel` declares `bazel_dep(name = "rules_rust", version = "0.70.0")`
> with a Rust 1.95.0 toolchain and an isolated `crate_universe`, and
> `services/spec/` is a Rust binary. The SPARQL passes below remain the right
> first cut on their own merits (they run where the data lives), but the hot-path
> Rust option RFC-001 §5 wanted is available today and needs no new dependency.
> See [RFC-002](./rfc-002-authoring-plane.md) §3.2.

## Lean-proven core — the corrector invariants

[`lean/Spec/Compaction/Projection.lean`](../lean/Spec/Compaction/Projection.lean),
built by `//lean:compaction_test` (pure Lean 4 core, no Mathlib, **no `sorry`**).
For the redundancy-collapse pass `dedupE` over the asserted-edge list, with
redundancy cost `R(l) := l.length`:

| invariant | theorem | meaning |
|---|---|---|
| meaning-preserving | `mem_dedupE` : `x ∈ dedupE l ↔ x ∈ l` | the edge set is unchanged |
| energy-non-increasing | `dedupE_length_le` : `(dedupE l).length ≤ l.length` | `E(P G) ≤ E(G)` for R |
| idempotent | `dedupE_idem` : `dedupE (dedupE l) = dedupE l` | `P` is a true projection (a crystal fixed point) |

These are exactly the three properties RFC-001b §5 requires of the corrector.
`redCost_dedupE_le` restates the second in energy terms.

## Executable passes — over the live graph (//corpus)

**Transitive reduction (L↓).** [`compaction-reduce.rq`](../corpus/compaction-reduce.rq)
drops every `:dependsOn` edge implied by a longer path. Because `:dependsOn` is
`owl:TransitiveProperty`, the transitive closure (reachability) is invariant, so
the reduction is meaning-preserving. Measured (`//corpus:compaction_measure`,
`//corpus:redundant_edges`):

- **20 → 16** dependsOn edges; **4 redundant** removed:
  RFC-0905→RFC-0900 (via RFC-0901), RFC-0906→RFC-0900 (via RFC-0901),
  RFC-0910→RFC-0900 (via RFC-0902), RFC-0912→RFC-0900 (via RFC-0902).

**Symmetry detection (S).** [`motifs.ttl`](../corpus/motifs.ttl) makes the motif
structure explicit; [`motif-orbits.rq`](../corpus/motif-orbits.rq) groups the
components into orbits. Measured: **7 motif templates cover all 16 components**
(25 `realizesMotif` edges), confirming crank-001's S = 7 from the graph itself:

| motif | members |
|---|---|
| M1 propose → kernel admits | 7 |
| M7 content-addressed artifact | 4 |
| M3 read-only projection | 3 |
| M4 gRPC extension | 3 |
| M5 typed fact plane | 3 |
| M6 conserved-dimension generalization | 3 |
| M2 sandboxed simulation | 2 |

## Net E(G) movement (this corrector pass)

- **L (connectivity)**: redundant edges down 4 (20 → 16), closure preserved.
- **S (symmetry)**: 7 templates extracted over 16 components — the recoverable
  symmetry is now explicit and measured, ready for the collapse-to-template step.
- **R (redundancy)**: the dedup pass is proven energy-non-increasing in Lean.

## What's next

1. **Collapse to templates**: rewrite each orbit's per-instance claims to a single
   parametrized motif template + thin instance tuples (the full S↑ realization;
   detection is done, rewrite is next).
2. **Wire P into the crank loop**: run predict (LLM) → project (this corrector)
   per crank and record the `E(G)` series.
3. **Lean transitive reduction**: lift the L↓ closure-preservation proof into Lean
   (needs a reachability model) to match the dedup pass's rigor.
