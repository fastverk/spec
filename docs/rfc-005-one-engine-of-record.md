# RFC-005 — one engine of record, before the gates answer anybody live

Status: **proposed**. Prerequisite for RFC-004 §4.3. Written because the estate
runs **three SPARQL engines over two disjoint gate suites on two Jena versions**,
one file asserts in prose that it runs one, and none of that is survivable once a
gate verdict is something an agent can ask for.

---

## 1. What is actually true today

| path | engine | Jena | what it runs |
|---|---|---|---|
| `kg.GateHarness` / `kg.edit.WriteOps` | in-process ARQ, `QueryExecutionFactory.create` | **5.0.0** (`@spec_maven`, `MODULE.bazel:62`) | **7 gates** — `contradictions`, four resource-bundled framework gates, `query_smoke`, SHACL |
| `sparql_query_test` / `rdf_validate_test` | ARQ as a **subprocess** — `//jena/sparql:jena_sparql`, stdin → TSV, `--fail-on-nonempty`, exit code | **5.2.0** (`@jena_maven`, in `rules_jena`) | **47 + 8 = 55 targets** over `rdf/queries/consistency/` and `rdf/lint/authoring/` |
| `tools/readmodel/emit_readmodel.py` | **rdflib** | — | the 8 read-model routes the console renders |

Counted, not estimated: `spec_corpus_gates` is instantiated 8 times × (4
`sparql_query_test` + 1 `rdf_validate_test`); `spec_authoring_gates` 3 times × 4
gates; plus 3 hand-written `sparql_query_test`. 32 + 12 + 3 = 47, and 8 SHACL.

And `tools/readmodel/emit_readmodel.py:26-27` says:

> There is exactly ONE SPARQL implementation of record. No drift risk between a
> Rust query path and the Jena gates.

Four lines above `from rdflib import Graph`. The sentence is true about the Rust
path, which does not exist. It is false about the estate, and it is the reason
nobody has been looking.

## 2. Why this is load-bearing now and was not before

While the gates only ever ran in CI, divergence cost a confusing afternoon. The
moment a gate verdict is an RPC an agent can call, divergence becomes **a model
reporting a requirement as formally validated on the strength of a suite that is
not the one which gates the merge.**

`WriteOps.applyAndCheck` — the one function that already computes a
proposed-graph verdict, and the natural body of `Gates.Preflight` — preflights
against `GateHarness`'s seven. Those seven are not a subset of the 55. So
"preflight: PASSED" does not entail "CI will pass", and nothing anywhere says so.

This is not hypothetical. `rdf/lint/authoring/envelope-unrecorded.rq` carries, in
its own body:

> ⛔ THIS GATE RETURNED ZERO ROWS FOR EVERY INPUT, AND READ AS PASSING.

because of how **ARQ specifically** evaluates `HAVING(MAX(?lo) > MIN(?hi))` over
`BIND(IF(...))`. That is an engine-semantics divergence inside one engine family.
`emit_readmodel.py` re-implements similar aggregations under rdflib and nothing
compares the two.

## 3. The decision

**The Bazel `sparql_query_test` path is the engine of record.** It is the one
that gates the merge, the one that caught the defect above, and the one whose
verdict is already a hard pass/fail rather than a rendered number.

Three consequences, in the order they bind:

**① Anything that answers "what do the gates say" RUNS the engine of record,
rather than reimplementing it.** `//java:gate_cli` executes
`@rules_jena//jena/sparql:jena_sparql` — the same binary `sparql_query_test`
invokes, with the same flags — and reads its exit code and rows. It is not
*asserted* to agree with the gate targets; on the verdict it IS them.

This is strictly better than the conformance-fixture pattern used elsewhere in
this repo. A fixture proves two implementations agree on the cases someone
thought of. Running the same binary removes the question.

⚠ The in-process version is not available at the pinned version, and finding
that out cost a build. rules_jena's `main` has a `result_emit` `java_library`
whose comment states the purpose — *"Keeping the formatter calls in one library
guarantees the two paths emit byte-identical results"* — but **0.3.0, which is
what `MODULE.bazel` resolves, ships only `JenaSparql.java` with the execution
inline.** A sibling working copy at `fastverk/fastverk/repos/rules_jena` is ahead
of the release; reading it and assuming it matched is the mistake. Until
rules_jena is bumped, every gate costs a subprocess — fine for CI, and the thing
to fix before an agent hits this in a loop.

**② A gate runner links the engine's Jena, never spec's.** `@spec_maven` is on
Jena 5.0.0 and `rules_jena` on 5.2.0. A `java_binary` depending on both puts two
Jena versions on one classpath, and which one answers is a function of classpath
order. `gate_cli` uses in-process Jena only to merge the corpus and derive the
`examined` count — never to decide a gate — and **must not** depend on
`//java:loader` or anything else carrying `@spec_maven`'s Jena.

⚠ The obvious spelling, `load("@rules_jena//jena:defs.bzl", "JENA_DEPS")`, does
not work: those labels live in rules_jena's own `@jena_maven`, which **Bzlmod
does not make visible outside the module that declared it** (`use_repo` is
module-scoped). The build fails with *"No repository visible as `@jena_maven`"*.
So the version is restated in a second install, `@spec_gate_maven`, pinned to 5.2.0 in
`spec_gate_maven_install.json`. **That restatement is a drift risk with no gate on
it** — if rules_jena bumps Jena, nothing here notices. Naming it is the only
mitigation this RFC offers.

⚠ Pinning that install needs an ambient JDK, because Coursier runs as a
repository rule outside Bazel's Java toolchain. That is issue #19 exactly, and
why every install here is pinned. `bazel run --repo_env=JAVA_HOME=<jdk>
@unpinned_spec_gate_maven//:pin`.

The real cost: `gate_cli` cannot reuse `Loader.loadDataset` and loads its own.
The alternative — moving all 14 `java_library` targets to 5.2.0 — is the better
end state and is deliberately not attempted here, because it touches
`maven_install.json` and every consumer of those libraries in Aion.

**③ The rdflib path is retired, not reconciled.** RFC-004 §7 already says the fix
is "retiring the rdflib *query*, not adding a third engine." Nothing in this RFC
changes `emit_readmodel.py`; it removes its claim to be the only implementation
and puts it behind a dated note. It is the read model, not a gate, and it is not
on the path an agent asks about.

> ### ⚠ What happened when the read model was finally run under the engine of record
>
> **The last sentence above was the reasonable call and it was load-bearing in
> the wrong direction.** "It is the read model, not a gate" is true and it is
> exactly why nobody looked — and spec#52 made it matter anyway, because a
> CONSUMER's console is built from these payloads, so "not a gate" became "not
> checked, and shown to people".
>
> `rdf/readmodel/` now holds the same eight questions as `.rq` files, and
> `spec_readmodel` runs them under ARQ. The first time they were put to the
> engine of record, one answered differently:
>
> | route | rdflib | ARQ |
> |---|---|---|
> | `envelopes` over `corpus/ampere` | **2 rows** | **0 rows** |
>
> The read-model copy was written in the flat form this repository has already
> documented twice as broken — `empty-envelope.rq`'s header explains it at
> length, and `envelope-unrecorded.rq`'s opens with "⛔ THIS GATE RETURNED ZERO
> ROWS FOR EVERY INPUT, AND READ AS PASSING":
>
> ```sparql
> BIND(IF(?kind = au:LowerBound, ?v, ?unbound) AS ?lo)
> ...
> HAVING (MAX(?lo) > MIN(?hi))
> ```
>
> **The third instance of a defect found twice, surviving in the one place that
> ran a different engine.** Both gates were fixed; the read model was not,
> because rdflib evaluates the unbound sentinel as "leave it unbound" and the
> query works there. It is now the gate's own three-subselect form, so the
> console panel and the gate measure are the same question asked the same way
> rather than two formulations that happened to agree under one engine.
>
> `//tools/readmodel:engine_agreement_test` compares both engines row for row
> over spec's two corpora — same `.rq` files, same shapers, so a difference is
> the engine and nothing else. They now agree on every comparable pair. Two more
> disagreements surfaced getting there and neither was an engine's fault: ARQ
> writes booleans BARE in TSV (`false`, not `"false"^^xsd:boolean`), so a decoder
> that drops to `str` yields `bool("false") == True`; and `GROUP_CONCAT`'s order
> is unspecified in SPARQL 1.1, so the payload now sorts it rather than
> inheriting whichever engine ran.
>
> ⚠ **The rdflib path still exists** and still emits what is committed under
> `services/spec/readmodel/`. What changed is that it is no longer the only
> implementation and no longer unchecked. Switching spec's own payloads to the
> ARQ path is the next step and is deliberately not taken in the same change as
> the finding.

## 4. `EXAMINED_NOTHING`, and why the count is derived rather than written

A zero-row gate over an empty candidate set returns zero rows and reads as PASS.
`envelope_unrecorded`'s candidate set is `?quantity a au:Quantity`; Studio's
corpus has **zero** such nodes. That gate is green today having examined nothing.

A human skims past that. A model reports it as validation. So `GateStatus` is
three-valued — `PASSED | FAILED | EXAMINED_NOTHING` — with an `examined` count
beside it.

RFC-004 §5 proposes an independently authored `<gate>.population.rq` and then
names its own defect: it can **over**count, "turning a gate that examines nothing
into a green gate wearing the number 69 — strictly worse than today's silence."
That convention does not exist in the repo (0 files) and **this RFC declines to
create it.**

Instead the count is derived from the gate's own parsed query, mechanically,
through ARQ's AST: clear `HAVING`, project `SELECT *`, count solutions. The
argument was that a transform of the parsed query cannot describe a WHERE clause
the gate does not have, while a hand-written sibling can.

**That was implemented, run against Studio's corpus, and is wrong for most gates
here.** It is recorded rather than quietly deleted, because the failure is the
useful part.

Stripping `HAVING` separates candidates from judgement only when the judgement
*is* in the `HAVING`. Most gates in `rdf/lint/authoring/` are not written that
way. `ladder-integrity.rq` is a UNION of blocks shaped like:

```sparql
?claim a rfc:NormativeStatement ; au:rung ?rung .
FILTER(?rung IN (au:R0, au:R1, au:R2, au:R3))
FILTER NOT EXISTS { ?claim au:stalledOn ?s }
```

The judgement is the `FILTER NOT EXISTS`, and it is INSIDE the WHERE. The pattern
matches violations and nothing else, so on a healthy corpus it matches nothing.
The derived count came back **0 for a gate that had just read 133 claims**, and
all four authoring gates reported `EXAMINED_NOTHING` over a corpus CI calls green.
A blind-gate detector that fires on every healthy gate is worse than no detector:
it teaches the reader to ignore it.

So the derivation is claimed **only where it is sound**, which is mechanically
decidable — `Query.getHavingExprs().isEmpty()`. No `HAVING`, no separable
candidate set, and `examined` is **-1, meaning UNKNOWN**. `-1` never reads as
`EXAMINED_NOTHING`: a gate whose blindness cannot be determined reports `PASSED`
with the count withheld, which is the honest state.

**This vindicates RFC-004 §5's `<gate>.population.rq` more than it refutes it.**
An authored candidate set is not avoidable, only relocatable — and RFC-004's own
objection, that an independently authored population can overcount so a gate
examining nothing wears a flattering number, is real and unchanged.

The recommendation is therefore the middle position neither RFC took: **declare
the candidate pattern in the gate's own frontmatter**, in the same file, reviewed
in the same diff — not in a sibling file that can drift, and not in a transform
that cannot see the judgement. That is an open decision, not a conclusion.

⚠ Residual even where sound: for a grouped gate this counts **solutions, not
groups**, so `examined` reads "candidate rows the gate looked at", not "things it
judged". It is not a denominator and nothing should divide by it.

## 5. What this does not decide

- **It does not merge the two gate suites.** `GateHarness`'s seven include SHACL
  and a query-smoke walk that the Bazel suite expresses as separate rules; the
  overlap is partial and reconciling it is its own piece of work. This RFC says
  only which one answers when they disagree, and forbids the *new* surface from
  adding a third opinion.
- **It does not retire `GateHarness`.** It is reachable from Aion, which is
  outside this repo's control.
- **It does not move spec to Jena 5.2.0.** Named in ②, deliberately deferred.

## 6. The check that keeps this true

`//java:gate_cli` is exercised by CI over the same corpus as the
`sparql_query_test` targets, and a test asserts that for every gate in the
authoring suite, `gate_cli`'s verdict matches the corresponding Bazel target's.
The assertion is cheap precisely because ① makes it near-tautological — and it is
worth having anyway, because the day it fails is the day someone has reintroduced
a second implementation without noticing.
