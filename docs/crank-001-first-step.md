# Crank-001 — the first measured reverse-diffusion step

**Status:** Result log · **Companion to:** [RFC-001](./rfc-001-unified-spec-graph.md), [RFC-001b](./rfc-001b-crystallization-math.md)
**Corpus (rough $G_0$):** the 17 ratio competitive component specs + the ratio
whitepaper + the positioning brief + RFC-001/001b + `Ratio.Core` (Lean).
**Method:** one *predict → project → gate → frontier* pass, run as four parallel
cloud-style agents (the predictor/corrector/gate stages plus a frontier stage that
fanned out its own sub-researchers). This is the first turn of the crank described
in RFC-001b §4 — not yet over the materialized Jena graph (Phase 0), but over the
document corpus directly.

---

## 1. Measured energy snapshot $E(G_0)$

First measurement of the RFC-001b §3 energy terms over the rough corpus:

| Term | Meaning | First measurement |
|---|---|---|
| $R$ redundancy | duplicated claims/edges | **8 clusters** (R1–R8); top-5 boilerplate sentences repeated 5–7× each |
| $C$ contradictions | claims that can't co-hold | **3** (C1–C3) |
| $D$ dangling | loose references / missing definers | **5** (D1–D5) |
| $U$ under-spec | frontier (thin, ungrounded leaves) | **~8 leaves**, mappable to ~20 external standards |
| $L$ connectivity | meaningful typed edges | **64 edges** over **73 claims**; 3 hub nodes |
| $S$ symmetry | MDL gain from collapsing isomorphic sub-graphs | **7 motif templates** cover all 16 component specs |

The dominant signal: the corpus is **highly symmetric and highly redundant** (big
recoverable $S$, big $R$), with a small but important contradiction set ($C$)
concentrated on one overclaim, and a well-defined frontier ($U$) that is mostly
groundable from **open** sources.

---

## 2. Predictor — claims & edges (the score step)

- **73 claims** extracted (13 core/paper + 60 across the 17 components), each with
  RFC-2119 modality and a tier guess (Structural / Derivational / Implemented).
- **64 typed edges**: 19 `livesIn`, 20 `refines`, 9 `realizes`, 16 `dependsOn`,
  5 `benchmarkedAgainst`.
- **Three hub nodes** (highest centrality):
  1. `core:2` — *a transaction conserves value iff its net vector is zero* (the sole
     invariant nearly every component `refines`/`realizes`).
  2. `core:12` — *CreateTransaction rejects non-conserving transactions* (the single
     write-door every proposing component routes through).
  3. `portfolio-accounting:3` — *read-only ledger projections* (dependency root for
     client-portal, CRM, BI, billing).

This is the connectivity backbone $L$: the graph is a near-star around conservation.

## 3. Corrector — projection targets (the deterministic step)

The 16 specs are **one document orbit** that collapses to **7 parametrized motif
templates** (this is the bankable symmetry $S$):

| Motif | Template | Members |
|---|---|---|
| M1 propose → kernel admits | `\proposeadmit{proposer}{artifact}{check}{records?}` | trading, billing, compliance, proposal, model-mgmt, integrations, ai-insights |
| M2 sandboxed sim over kernel | `\simover{states}{facts}{output}` | proposal-generation, risk-analytics |
| M3 read-only projection | `\readproj{surface}{audience}{guarantee}` | portfolio-accounting, client-portal, BI (+read sides) |
| M4 extension over gRPC API | `\extension{app}{lang}{holds}` | crm, integrations, client-portal, connectors |
| M5 typed facts / fact plane | `\factplane{external-data}` | data-aggregation, alts, risk-analytics |
| M6 conserved-dimension generalization | `\dimension{asset-line}{new-dims}` | alts, specialized-servicing, portfolio-accounting |
| M7 content-addressed artifact | `\cca{artifact}` (cross-cutting) | model-mgmt, billing, compliance, data-governance, … |

- **Redundancy clusters R1–R8** deduped to canonical forms (e.g. R1 "admission runs
  through the kernel / can never produce an unbalanced book" appears verbatim in 5
  specs → one M1 sentence; R7 the boilerplate `statusbox` is identical in all 16 →
  hoist to `_preamble.tex`).
- **Transitively-reducible edges E2–E7** dropped (e.g. `billing → portfolio-accounting`
  is implied by `billing → M1 → kernel`).
- **Compaction estimate:** 16 specs → **7 templates + 16 thin parameter tuples**;
  only `portfolio-accounting` and `data-governance` keep a small bespoke remainder.
  $R$ falls steeply, $S$ rises steeply, meaning-preserving.

## 4. Gate — tensions (what blocks the manifold $\mathcal{M}$)

15 tensions: **3 contradictions, 2 modality conflicts, 4 term-drift, 5 dangling.**
The cross-cutting pattern: the conservation *theorem* is being silently widened to
cover properties it does not prove. **Resolve first — C1 + D2 together:**

- **C1 (overclaim):** the positioning brief says an LLM "cannot write an unbalanced
  **or unauthorized** entry," but the kernel's sole proven invariant is conservation;
  *authorization is not a kernel theorem.* The guarantee rides on a proof it doesn't
  have.
- **D2 (missing definer):** the authorization claim is grounded only in
  `specs/components/security/` specs that are **referenced but absent** from the
  corpus.
- **Fix:** either (a) scope the marketing guarantee to conservation only, or (b)
  admit the security specs and prove an authorization invariant the kernel actually
  enforces. *(This is a real correction to our own ratio marketing copy.)*

Other notable: T1 term-drift "trusted core" vs "proven kernel" vs "trusted computing
base" (pick one canonical definer); T3 "claim" means both the prose assertion and the
graph primitive — *will collide at Phase-0 ingest*, so name them apart now.

## 5. Frontier — standards to internalize ($U$ → groundings)

~8 under-specified leaves map to external standards; **most are OPEN-licensed**
(per the RFC-001 §7.1 licensing gate). Highest-value, all OPEN:

| Leaf | Standard | Body | License |
|---|---|---|---|
| NAV / fund pricing | Investment Company Act **Rule 2a-4 / 22c-1** (17 CFR 270) | SEC | OPEN (public domain) |
| Fair-value valuation | **FASB ASC 820** (IFRS 13 convergent) | FASB | OPEN (Basic View, free reg.) |
| Performance returns (TWR/MWR) | **GIPS 2020** | CFA Institute | OPEN-to-read (copyrighted) |
| Tax-lot / cost basis | **IRC §1012, §6045** + Treas. Reg. | IRS/Treasury | OPEN (public domain) |
| Books & records / compliance | **17 CFR 275.204-2, 206(4)-7** | SEC | OPEN (public domain) |
| Alt-investment valuation | **IPEV Guidelines 2025** | IPEV Board | OPEN (free PDF) |
| API / HTTP layer | **RFC 9110 / 9113** + gRPC | IETF / CNCF | OPEN |
| Identifiers | **FIGI** (OMG), **LEI** (ISO 17442 data) | OMG / GLEIF | OPEN (data) |
| Content hashing | **FIPS 180-4 / 202** (SHA-2/3) | NIST | OPEN (public domain) |
| Money arithmetic | **IEEE 754-2019** | IEEE | PAYWALLED (metadata-only) |
| Risk (VaR/ES) | **Basel/FRTB** (open) · ISO 31000 (paywalled) | BCBS/BIS · ISO | mixed |

**Recommended first internalization:** SEC **Rule 2a-4 (NAV)** — open, public-domain,
load-bearing for the valuation/P&L dimensions, and the exact "Wikipedia → standard"
path from RFC-001 Appendix A.

## 6. Next reverse step (the prioritized action queue)

1. **Project** (deterministic, safe): collapse the 16 specs to the 7 M-templates;
   dedupe R1–R8; drop E2–E7. Banks $S$, cuts $R$ — no semantic risk.
2. **Gate-fix** (highest priority): resolve C1+D2 (scope the authorization claim or
   add+prove a security invariant); disambiguate T3 "claim" before Phase-0 ingest.
3. **Frontier**: internalize SEC Rule 2a-4 (NAV) first, then FASB ASC 820 and GIPS —
   all OPEN; formalize via the RFC-001 §6 normative-document track.
4. **Materialize**: feed these claims/edges as the seed for Phase 0 (the Jena graph),
   so subsequent cranks measure $E(G)$ over the real graph, not the corpus.

## 7. Provenance & reproducibility

Four agents, run in parallel; each read the corpus read-only and returned structured,
mergeable output (claims keyed by `<slug>:<n>` for dedup). Re-running is cheap and
convergent because claim identity is content-addressable (RFC-001 §3.1). Counts here
are this pass's measurement, not a fixed ground truth; the next crank should move them
monotonically (more $S$/$L$, less $R$/$C$/$D$/$U$) — the $E(G)$ descent of
RFC-001b §6.
