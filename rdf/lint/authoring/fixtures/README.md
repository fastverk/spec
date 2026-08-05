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

## Verified results

Executed against `rdf/ontology/aion-rfc.ttl` + `rdf/ontology/authoring.ttl` +
the fixture:

| Gate | conflict | clean |
|---|---:|---:|
| `empty-envelope.rq` | 1 | 0 |
| `cross-discipline-coconstraint.rq` | 6 | 0 |
| `homonym-unregistered.rq` | 1 | 0 |
| `ladder-integrity.rq` | 4 | 0 |
| `conflict-hygiene.rq` | 6 | 0 |

All five discriminate.

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

The canonical path is bazel (`//rdf/lint/authoring:*`). These fixtures were
developed and verified in a container with no bazel, using `rdflib` 7.6 and
`pyshacl` directly — the same SPARQL, the same SHACL shapes. That path is worth
keeping working, because agent sessions frequently have Python but not a
provisioned bazel.

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
