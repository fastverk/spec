# Authoring-gate fixtures — the positive and negative controls

The RFC-002 authoring gates in `rdf/lint/authoring/*.rq` are checked the way
`grounding/AdversarialGateCheck.java` checks the consistency invariants: against
a graph engineered to break them, *and* against a graph engineered not to. A gate
that has never been shown to reject anything is an assertion, not a check; a gate
that fires on both files is a false-positive generator.

| Fixture | Role |
|---|---|
| `envelope-conflict.ttl` | **Positive control.** A four-discipline slice that is genuinely incoherent — the feasible sustained-discharge envelope is empty — plus one planted instance of every hygiene and ladder defect. |
| `envelope-clean.ttl` | **Negative control.** The same slice, honestly adjudicated. Every gate must return zero rows. |
| `envelope-undocumented.ttl` | **Positive control for `envelope-unrecorded.rq` alone.** An empty envelope with no `au:Conflict` naming it. |

### Why the third fixture exists

The first two are both *negative* controls for `envelope-unrecorded.rq`, and that
went unnoticed for as long as the gate has existed. The conflict fixture records
its own infeasibility with `fx:conflict-envelope`, so the gate is correctly silent
there; the clean fixture is silent by construction. The gate `authoring_gates.bzl`
calls **the load-bearing gate** had two proofs that it can say no and none that it
can say yes.

It could not. It was written in the flat `BIND(IF(…)) + HAVING(MAX > MIN)` form
that `empty-envelope.rq` documents as returning zero rows under ARQ *for every
input* — the measure was rewritten out of that form when it was caught and the
gate was not. Two independent reasons to detect nothing, and neither control
could see either one.

`envelope-undocumented.ttl` is the direction that was missing: one quantity, two
instruments, bounds intersecting to the empty set, and deliberately no
`au:Conflict`. `expect-undocumented.rq` asserts the gate finds exactly one row
with a deficit of 30.0 MW, and `expect-detections.rq` gained
`envelope-unrecorded-silent-when-documented` so the silent direction is asserted
rather than assumed.

## Verified results

Executed against `rdf/ontology/aion-rfc.ttl` + `rdf/ontology/authoring.ttl` +
the fixture:

**Gates** (zero-row, fail the build):

| Gate | conflict | clean |
|---|---:|---:|
| `envelope-unrecorded.rq` | 0 † | 0 |
| `conflict-hygiene-strict.rq` | 4 | 0 |
| `ladder-integrity.rq` | 4 | 0 |
| `vacuous-invariant.rq` | 3 | 0 |
| `tier-rung-coherence.rq` | 1 | 0 |

**Measures** (reported, never fail):

| Measure | conflict | clean |
|---|---:|---:|
| `empty-envelope.rq` | 1 | 0 |
| `conflict-hygiene.rq` | 6 | 0 |
| `cross-discipline-coconstraint.rq` | 6 | 0 |
| `homonym-unregistered.rq` | 1 | 0 |

† `envelope-unrecorded.rq` is correctly silent on **both** fixtures: the conflict
fixture's empty envelope *is* recorded by an `au:Conflict`. It keys on whether an
infeasibility was documented, not on whether one exists. Strip `conflicts.ttl`
from the AMPERE corpus and it fires with 2 rows — that is the demonstration it has
teeth, and `corpus/ampere/BUILD.bazel` carries the verified numbers in a comment
(RFC-002 §12.1 explains why that is deliberately not a target: it would be
permanently red). If this gate ever fires on the conflict fixture, it has started
failing on the empty envelope itself, which is the confusion the gate/measure
split exists to prevent.

Every gate is silent on the clean fixture, so none false-positives — but that
direction alone is passed trivially by a gate that always returns zero. The
positive control is `expect-detections.rq`, a zero-row test asserting each gate's
detection **count** over the planted fixture (including that the deficit computes
to exactly 27.0 MW). It returns **0 rows** over the conflict fixture and **7** over
the clean one (one branch per gate count that is not met there; the
`envelope-unrecorded` branch expects 0 and is silent on both), so the assertions
are demonstrably live.

The headline row is `empty-envelope.rq` on the conflict fixture:

```
quantity                 unit  greatestLower  leastUpper  deficit  disciplines
q-sustained-discharge    MW             82.0        55.0     27.0            4
```

Four instruments — a capacity commitment, an OEM thermal derate, a fire-safety
state-of-charge cap, and a warranty throughput budget — each individually
satisfiable, none citing any other, and jointly infeasible by 27 MW. **No
document in the corpus states this.** It falls out of a `GROUP BY` with a
`HAVING` clause once bounds are data rather than prose, which is the entire
argument for `au:Bound`.

Two row counts exceed the number of defect *kinds*, and that is correct — the
gates report one row per defect, not per subject:

- `ladder-integrity` = 4 because `fx:bad-unprovenanced` carries two defects
  (no `au:promotedBy` **and** no `au:stalledOn`).
- `conflict-hygiene` = 6 because `fx:conflict-unwitnessed` carries three
  (unwitnessed, unowned, unresolved).

## Why the clean fixture is a real fix, not a suppression

The interesting property of the negative control is *how* it resolves. The
binding constraint was the warranty budget at 55 MW, so the **capacity
commitment was re-offered down to 55 MW** — `au:Narrow` applied to the claim that
actually bound, not to whichever claim was easiest to edit. The fire-safety cap
and thermal derate are `au:defeasible false` and were left untouched. The
conflict object is **retained** with its witness and an `au:Resolution` recording
who decided and why; the record of the decision is the deliverable.

The tempting alternative — an `au:Exempt` waiver on the fire cap — is what
`conflict-hygiene.rq`'s `UNBOUNDED-WAIVER` and `EXPIRED-WAIVER` rows exist to
make expensive. A waiver with no expiry is indistinguishable from having quietly
dropped the requirement.

## Running them without bazel

The canonical path is bazel (`bazel test //rdf/lint/authoring/fixtures/...`), but
note that `fastverk/build` is red on `main` for pre-existing environmental reasons
(RFC-002 §12.1), so these targets have never actually been exercised.

Everything above was developed and verified in a container with no bazel, using
`rdflib` 7.6 and `pyshacl` directly — the same SPARQL, the same SHACL shapes. That
path is worth keeping working, because agent sessions frequently have Python but
not a provisioned bazel.

```sh
pip install rdflib pyshacl
python3 - <<'PY'
from rdflib import Graph
import glob, os
g = Graph()
for f in ['rdf/ontology/aion-rfc.ttl', 'rdf/ontology/authoring.ttl',
          'rdf/lint/authoring/fixtures/envelope-conflict.ttl']:
    g.parse(f, format='turtle')
for q in sorted(glob.glob('rdf/lint/authoring/*.rq')):
    print(os.path.basename(q), len(list(g.query(open(q).read()))))
PY
```

Cross-check that the harness agrees with the bazel gates by running the existing
`rdf/lint/semantic/*.rq` over the shipped corpus: it reproduces
`docs/phase-0-materialization.md`'s numbers exactly (18 documents, 38 claims,
SHACL conformant, all four consistency invariants at zero).

## Caveat

Every numeric value and citation in these fixtures is **synthetic**. They exist
to exercise gates, not to state facts about any real asset, standard, or
contract. The worked corpus and its citation-confidence marking live in
`corpus/ampere/`.
