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
| [`panels.authoring-form.textproto`](./panels.authoring-form.textproto) | **Declarative WRITE affordances** — four forms, one op each. Also the record of the RFC-002 §3.3 correction: the descriptor vocabulary *does* have a write primitive, and §3.3 measured the wrong version. Gated on one `meridian_schemas` bump |
| [`panels.authoring.textproto`](./panels.authoring.textproto) | **Aspirational.** 8 adhoc handlers + 2 tables. Now a much shorter list than it looks — most of it became declarative |
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
| **The six authoring read-model table panels** | **exists, in the shipped bundle** — same file, merged (the shell fetches exactly one `panels.binpb`, so a second bundle would never be discovered) |
| **The read model itself** (6 routes, 128 rows over AMPERE) | **exists** — `services/spec/readmodel/*.json`, emitted by `tools/readmodel/emit_readmodel.py`, served by `src/readmodel.rs` |
| **The write path, queue-side** (`POST /proposal`, `/proposal/op`, `/proposal/verdict-preview`) | **exists, 32 tests pass** — `src/proposal.rs`. Validates against the closed 16-op vocabulary and appends to an append-only log. Does **not** admit: no content address, no gate verdict — the build adjudicates |
| **The constraint-bar axis** | **exists** — `botnoc/web/static/assets/spec.js` + one `ADHOC_HANDLERS` entry. Parses; not yet rendered in a browser |
| gRPC nav subtree, MCP read tools, `/describe` web routes | **exists** — `services/spec/src/{main,mcp,http,routes}.rs`. Nine nav leaves; six MCP tools |
| Ten semantic gates + four consistency invariants | **exists** — `rdf/lint/semantic/`, `rdf/queries/consistency/` |
| Corrector invariants (meaning-preserving, non-increasing, idempotent) | **exists** — `lean/Spec/Compaction/Projection.lean` |
| Un-gameable grounding (fabricated `provenBy` rejected) | **exists** — `//grounding:grounding_verified` |
| Authoring ontology (proposal, ladder, conflict, quantity, scope) | **written, validated, not gated** — `rdf/ontology/authoring.ttl` |
| Five authoring gates with positive/negative controls | **written, executed** — `rdf/lint/authoring/`; see the discrimination table in `fixtures/README.md`. **Not yet wired into BUILD.bazel** |
| AMPERE corpus | **written, SHACL-conformant, measured** — `corpus/ampere/` |
| `Door.admit`, the content address, the gate verdict | **does not exist** — the core of the RFC, and deliberately not attempted in an environment that cannot build Lean |
| Per-op review of a multi-op proposal (accept 3 of 5) | **does not exist** — the routes carry the verdict split; the review surface is adhoc work |
| MCP **write** tools (`spec__preview_proposal`, …) | **does not exist** — tool names in the transcripts are proposed. The three *read* tools do exist |
| Work orders, obligation closure, dispatch gating | **exists** since #45 — derived by `//rdf/fanout` over any corpus, served at `GET /workorders`, dispatched (or refused) at `POST /workorder/dispatch`, and rendered by the `workorders` panel promoted out of this directory. `spec__list_work_orders` is a real MCP tool. What is still mocked in transcript 03: the write tools it calls (`spec__dispatch`, `spec__preview_proposal`) and the HumanPrompt round trip, which needs the platform's `agents` CRD |
| Declarative write descriptors in the **shipped** bundle | **written, checked, not compiled** — `panels.authoring-form.textproto` needs `meridian_schemas` bumped past `FormPanel` in `spec/MODULE.bazel`. **RFC-002 §3.3's claim that no write descriptor exists was wrong** |

One correction worth reading, because the *shape* of the error recurs: RFC-002 §3.3
concluded that point-and-click authoring was not expressible declaratively and needed
a botnoc change. It had enumerated the descriptor vocabulary at `meridian_schemas`
**0.5.0** — spec's pin — while botnoc, whose shell does the rendering, pins
**0.19.0**. `FormPanel` had been there the whole time. When a capability looks
missing upstream, check the version the *consumer* pins before concluding it does not
exist.

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
