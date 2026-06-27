# `crank/` — the E(G)-descent harness

This package wires the **deterministic half** of the spec-crystallization crank
loop and records the energy series `E(G)` across cranks so we can watch it
descend (RFC-001b §6).

## The loop

Each crank is one reverse-diffusion step:

```
predict  ->  project  ->  gate  ->  measure
 (LLM)      (corrector)   (gates)   (this harness)
```

1. **predict** — an LLM / agent fleet proposes graph edits (new claims, edges,
   dedup/collapse moves). This is the **out-of-band** step: it runs as cloud-style
   agents, **not** in the Bazel build. The corpus is read read-only and structured,
   mergeable edits come back (see `docs/crank-001-first-step.md`).
2. **project** — the deterministic corrector `P` that never raises the energy:
   the SPARQL passes in `//corpus` (transitive reduction of the `dependsOn` DAG via
   `compaction-reduce.rq`, and motif/symmetry detection via `motif-orbits.rq`),
   with the **Lean-proven core** `//lean:compaction_test`
   (`dedupE` is proven meaning-preserving, energy-non-increasing, and idempotent;
   see `docs/compaction.md`).
3. **gate** — the consistency gates `//corpus:ratio_corpus_gates_*`
   (SHACL shapes + dangling-ref / dependency-cycle / diagnostic-code-collision /
   asymmetric-inverse-edge invariants). Green = the graph is well-formed and
   internally consistent.
4. **measure** — build the two SPARQL measurement targets and read the
   E(G)-relevant counts off the graph (`//corpus:eg_measure`,
   `//corpus:compaction_measure`), then record one normalized row.

The energy being driven down is

```
E(G) = w1·R + w2·C + w3·D + w4·U − w5·L − w6·S
```

Cranks should drive R/C/D/U **down** and L/S **up**.

## The recorded series — `crank/eg-series.tsv`

Tab-separated, one row per crank:

| column | meaning | E(G) role |
|---|---|---|
| `crank`  | crank index (zero-padded, `001`, `002`, …) | |
| `R`      | redundant edges (transitively implied)      | redundancy proxy (down) |
| `L`      | `dependsOn` edges after transitive reduction | connectivity proxy |
| `S`      | motif templates                              | symmetry (up) |
| `claims` | `NormativeStatement`s in the graph           | |
| `docs`   | `Document`s in the graph                      | |
| `note`   | provenance of the row                        | |

Seeded rows:

- **001** — the prose-estimated snapshot from `docs/crank-001-first-step.md`
  (`note = prose estimate`), before the corpus was materialized into the graph.
- **002** — the same structure **measured off the materialized graph**
  (`note = graph-measured`). `R`/`L`/`claims` drop sharply vs. the prose estimate
  because the graph counts asserted triples and typed `NormativeStatement`s, not
  prose sentences; `S = 7` is confirmed identically from the graph itself.

## Appending a new crank

After a predict→project→gate pass, record the new measurement:

```sh
sh crank/record-eg.sh N            # N = crank index, e.g. 3
```

This is **idempotent**: re-running for an existing crank index replaces that row
rather than duplicating it. The script builds `//corpus:eg_measure` and
`//corpus:compaction_measure`, parses the resulting tsvs, and upserts one row.

A buildable/runnable snapshot target re-derives the *current* graph's normalized
row as a Bazel artifact (used to keep the measure stage reproducible in-build):

```sh
bazel build //crank:record_eg
cat bazel-bin/crank/eg-snapshot.tsv
```

> Note: the in-build target is a native `genrule` (named `record_eg`) rather than
> an `sh_binary` because `rules_shell` is not a direct dependency of this module.
> The committed series is written by the `record-eg.sh` script above.

## The net Spec Score — `crank/spec-score.tsv`

A single number in **[0, 100], higher = better** — the human-facing **dual of
E(G)**. The agent fleet's north star is to **push this up** (which is exactly
driving E(G) down):

```
Score = 100 · (0.45·grounding + 0.35·density + 0.10·parsimony + 0.10·structure)
  grounding = proven / claims           (claims carrying a provenBy)
  density   = mean(claims/73, edges/64) (vs the crank-002 target sizes)
  parsimony = 1 − redundant / dependsOn (transitive-reduction headroom)
  structure = motif-covered / documents (recoverable symmetry, MDL)
```

Soundness is a **gate, not points**: the score is only meaningful when
`//corpus:ratio_corpus_gates_*` are green. A failing gate means the score is
**void**, not merely low — you can't bank maturity on an unsound graph.

Current (Phase-0 seed): **score ≈ 32** — sound but early; grounding is only ~11%
(2/19 claims proven) and density ~29% of target. That is the gap the fleet closes.

```sh
bazel build //crank:spec_score && cat bazel-bin/crank/spec-score.snapshot.tsv  # current
sh crank/record-score.sh N                                                     # record crank N
```

`record-score.sh` is idempotent (upsert by crank index), same as `record-eg.sh`.
Watch `score` climb as the fleet grounds claims and densifies the graph.
