# Mock UX artifacts — the spec authoring plane

**Companion to:** [RFC-002](../../docs/rfc-002-authoring-plane.md) §8–§10

These are **mocks**. Nothing here is running code. They exist so the RFC can be
argued about concretely, and every one is built over the real
[AMPERE corpus](../../corpus/ampere/) so the data on screen is the data the gates
actually run on.

## Contents

| Artifact | What it shows |
|---|---|
| **[Interactive console mock](https://claude.ai/code/artifact/2483c84d-86f3-4ec9-b195-071c203d0206)** | Seven walkable screens: conflict board, the INV-01 witness with the empty envelope, the discipline atlas with dark fraction, a claim with its R0–R5 ladder, per-op proposal review, the chat grounding loop, and the fanout board |
| [`panels.authoring.textproto`](./panels.authoring.textproto) | The proposed meridian `PanelBundle` — 8 adhoc handlers + 2 declarative tables, with the delivery argument in the header comment |
| [`chat/01-ground-new-intent.md`](./chat/01-ground-new-intent.md) | A market-ops engineer authors a fire-safety claim. Includes a gate failure, the model refusing to adjudicate, and the split proposal routed to the fire marshal |
| [`chat/02-conflict-adjudication.md`](./chat/02-conflict-adjudication.md) | INV-01 adjudicated — **and the model being wrong about INV-10 and refuted by the expert** |
| [`chat/03-agent-fanout.md`](./chat/03-agent-fanout.md) | Fanout over the coherent slice, an agent's good failure, and the replay guarantee |

## The one screen that matters

The witness panel, showing four instruments on one MW axis:

```
≥ 82  market       capacity commitment            defeasible, priced
≤ 78  thermal      OEM derate at 45 °C            non-defeasible
≤ 70  fire-safety  SOC window ÷ 4h                non-defeasible
≤ 55  warranty     throughput budget 80% spent    defeasible, priced   ← binding
────────────────────────────────────────────────────────────────────
      intersection [82, 55] = ∅            deficit 27 MW, 5 disciplines
```

Every instrument is individually satisfiable. Jointly they are not. **No document
in the corpus states this** — it comes out of a `GROUP BY` with a `HAVING` clause
once bounds are data rather than prose.

The defeasibility column is what makes the panel actionable rather than merely
alarming: two of the four bounds cannot be breached at any price, so the decision
is only ever between the two that can.

## Where authoring is genuinely easier than prose

Worth being blunt, because "convenient formal authoring" is the claim most likely
to be hand-waved. Three places, and only three:

1. **Term entry refuses free text.** The typeahead is over the aligned glossary,
   and an unmatched term forces an explicit `bindTerm` with a definition. Writing
   "state of charge" in a Word document takes one second and silently commits you
   to one of three disjoint concepts. Here it takes one extra click and commits
   you to the right one. This is the only place in the UI where the formal path is
   *fewer* decisions than the prose path, because prose defers the decision rather
   than avoiding it.
2. **Scope and defeasibility are fields, not paragraphs.** "Which edition, whose
   jurisdiction, can an emergency override this" are four dropdowns. In prose they
   are four sentences that most authors don't write, which is why prose specs
   cannot answer "what binds the thermal subsystem".
3. **The consequence is reported at authoring time.** The 27 MW deficit surfaces
   when the fire cap is entered — not in a review cycle, not in production. That
   is the actual convenience: not fewer keystrokes, but finding out now.

Everywhere else, authoring a formal claim is **more** work than writing a
sentence. The honest pitch is that the extra work buys a machine-checkable
consequence, and the UI's job is to keep the overhead to the three points above.

## What exists vs. what is mocked

| Surface | State in `fastverk/spec` |
|---|---|
| Read-only table panels (Specs / Contracts / Proof Status) | **exists** — `services/spec/ui/panels.textproto` |
| gRPC nav subtree, MCP read tools, `/describe` web routes | **exists** — `services/spec/src/{main,mcp,http}.rs` |
| Ten semantic gates + four consistency invariants | **exists** — `rdf/lint/semantic/`, `rdf/queries/consistency/` |
| Corrector invariants (meaning-preserving, non-increasing, idempotent) | **exists** — `lean/Spec/Compaction/Projection.lean` |
| Un-gameable grounding (fabricated `provenBy` rejected) | **exists** — `//grounding:grounding_verified` |
| Authoring ontology (proposal, ladder, conflict, quantity, scope) | **written, validated, not gated** — `rdf/ontology/authoring.ttl` |
| Five authoring gates with positive/negative controls | **written, executed** — `rdf/lint/authoring/`; see the discrimination table in `fixtures/README.md`. **Not yet wired into BUILD.bazel** |
| AMPERE corpus | **written, SHACL-conformant, measured** — `corpus/ampere/` |
| `Proposal` object, `Door.admit`, per-op review | **does not exist** — the core of the RFC |
| Any adhoc authoring handler, `POST /proposal` | **does not exist** |
| MCP write tools (`spec__preview_proposal`, `spec__apply_proposal`, …) | **does not exist** — tool names in the transcripts are proposed |
| Work orders, obligation closure, dispatch gating | **does not exist** |
| Declarative write/form/action descriptors | **not available** — owned upstream in `meridian_schemas`; see RFC-002 §3.3 for why the mocks use `adhoc` instead |

The confirm-gated mutation pattern in the transcripts (`confirm:false` preview →
user approves → `confirm:true`) **is** the real one `plugin-chat` implements
today, and the `HumanPrompt` escalation **is** the real `agents` CRD. Those two
are load-bearing borrowings, not inventions.

## Caveat on the corpus data

Every clause number, edition and numeric value in AMPERE is a **lead, not a
fact**, and no real market operator, manufacturer, insurer or jurisdiction is
named. See [`corpus/ampere/README.md`](../../corpus/ampere/README.md#citation-posture--read-this-before-quoting-anything).
The mocks inherit that caveat in full: they demonstrate mechanisms, and the
numbers on screen are synthetic.
