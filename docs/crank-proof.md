# Proving the crank works (and isn't fooling itself)

The crank's claim: an agent fleet proposes graph edits; the deterministic
corrector + gates keep the result sound; and the result raises the **Spec Score**
on a real spec. The danger with any LLM-in-the-loop system is that the number
goes up because the model *gamed the metric*, not because the spec got better. So
this proof is built to be **hard to fake** — the LLM is treated as an adversary.

It separates two questions: (1) is the **loop** sound and un-gameable? (2) is the
**LLM** reliable at it? This is the existence proof for (1), with zero API spend —
a real but *hand-written* Lean proof stands in for the fleet's proposal. (2) is
the statistical question that follows once the real proposer is wired.

## The principle: "proven" is machine-checked

Grounding is the score's biggest lever (weight 0.45), and the cheapest fake is to
slap `:provenBy "Ratio.Lemma.Foo"` on a claim with no proof. So the rule is:

> A claim counts as grounded **only when a sorry-free Lean theorem backs it.**

No LLM output can fake a compiling Lean proof of a false statement, so the only
way the score rises is a real proof.

## The existence proof

- **A real proof** — `lean/Spec/Grounding/WriteDoor.lean` proves
  `trades_compose_conserving` (a rebalance of conserving trades conserves, so it
  passes the kernel write-door). `//lean:grounding_test` compiles it, sorry-free.
- **Wired to a real claim** — `RFC-0903 trading-1` now carries
  `:provenBy "Spec.Grounding.WriteDoor.trades_compose_conserving"`.
- **The score moved, for a verified reason** — proven claims 2 → 3, grounding
  0.105 → 0.158, **Spec Score 32.4 → 34.8** (`crank/spec-score.tsv`, crank 003).

## The controls (what makes it a proof, not a demo)

| Control | Target | What it shows |
|---|---|---|
| **Grounding gate + negative control** | `//grounding:grounding_verified` | every in-repo `:provenBy` resolves to a sorry-free theorem; a **fabricated** `:provenBy` is **rejected**. The score's grounding term is un-gameable. |
| **Adversarial gate-rejection** | `//grounding:adversarial_gate` | the consistency gates **detect** a planted `dependsOn` cycle, dangling reference, and MUST/MUST_NOT contradiction; a clean DAG trips none. The gates reject, they aren't decorative. |
| **Corrector ablation** | `//corpus:compaction_measure` | the corrector removes **4 transitively-implied edges** (dependsOn 20 → 16) — without it, that redundancy survives and the energy is worse. It earns its keep. |

Soundness is a **gate, not points**: a red gate *voids* the score rather than
lowering it, so the fleet can't bank maturity on an unsound graph.

## What this proves — and what it doesn't

**Proven:** the loop is sound and the score is un-gameable. A claim's grounding
counts only when Lean says so; unsound deltas are rejected; the corrector reduces
real redundancy; and a verified grounding moves the real, graph-measured score.

**Not yet proven:** that an *LLM* can produce such proofs reliably. That's the
next step — swap the hand-written `WriteDoor.lean` for a real proposer (an
`ANTHROPIC_API_KEY` call), run it N times on a real under-specified leaf, and
report the success rate (proposals that pass the gates *and* yield a compiling
proof). The harness above is exactly what that proposer plugs into — the
existence proof shows the rails are real before the first token is spent.

## Run it

```sh
bazel test //lean:grounding_test //grounding:grounding_verified //grounding:adversarial_gate
bazel build //crank:spec_score && cat bazel-bin/crank/spec-score.snapshot.tsv
```
