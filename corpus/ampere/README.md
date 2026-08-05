# AMPERE — the worked multidisciplinary corpus

**Companion to:** [RFC-002](../../docs/rfc-002-authoring-plane.md) §11

A 400 MWh / 100 MW grid-scale battery energy storage system plus an aggregated
distributed-energy virtual power plant, participating in two US wholesale
electricity markets, including its financing, safety case, cybersecurity posture,
and control software.

## Why this project

Four incommensurable rule systems bind the same five-minute dispatch decision:

1. **Continuous physics** — electrochemistry, thermal derating, degradation.
2. **Public law, in three parallel jurisdictional stacks** — federal reliability
   standards, state interconnection rules, county fire and land use.
3. **Private contract** — interconnection agreement, offtake agreement, OEM
   warranty, insurance binder, tax-equity conditions.
4. **Executable market software** — the plant controller and DER management
   system, where several of these conflicts are actually decided in code.

That is the property under test. Alternatives were considered and rejected on it:
a clinical-trial platform has well-structured sources but its conflicts are mostly
*within* discipline; spacecraft avionics is deep but narrow; cross-border payments
spans jurisdictions but one discipline's vocabulary dominates. AMPERE wins on
**cross-domain conflict density**.

## The central result

The corpus is **SHACL-conformant** and returns **zero rows from every gate the
spine had before RFC-002**:

| Pre-existing gate | Rows |
|---|---:|
| `claim-contradiction.rq` | 0 |
| `modality-conflict.rq` | 0 |
| `dangling-references.rq` | 0 |
| `circular-deps.rq` | 0 |
| `inverse-edges.rq` | 0 |
| SHACL against `shapes.ttl` | conforms |

By every check available before this RFC, it is clean.

It nevertheless contains **two empty feasible envelopes**:

```
quantity                unit  greatestLower  leastUpper  deficit  disciplines
q-sustained-discharge   MW             82.0        55.0     27.0            5
q-telemetry-latency     ms            180.0       150.0     30.0            2
```

`modality-conflict.rq` cannot see them because it requires **byte-equal predicate
text**. *"MUST deliver at least its committed capacity obligation of 82 MW"* and
*"MUST NOT exceed 55 MW … for the remainder of the year"* are not the same string,
are not in the same document, are not in the same discipline, and do not cite each
other. Nothing short of typed quantities with reified bounds finds them.

The second envelope is the more interesting one. **It was not planted as a
headline** — `empty-envelope.rq` found it with no special handling, on *time*
rather than power: a reliability standard mandates malicious-communications
detection at the electronic access point and is silent about latency, while the
control specification sets a 150 ms budget and is silent about inspection. Both
claims are non-defeasible, so neither can be traded away commercially; the
resolution is architectural. That the same two-line aggregation finds a power
conflict and a timing conflict is the evidence that the mechanism generalises.

## Measured

Run over `aion-rfc.ttl` + `authoring.ttl` + all three corpus files (2,077
triples):

| Metric | Value |
|---|---:|
| Documents | 14 |
| Sections | 15 |
| Normative statements | 64 |
| Disciplines | 12 |
| Quantities (with referent) | 20 |
| Reified bounds | 9 |
| Scopes | 12 |
| Precedence edges asserted | 10 |
| Claims carrying a discipline | 64 / 64 |
| Claims constraining a typed quantity | 28 |
| Non-defeasible claims | 23 |
| Recorded conflicts | 11 |

**Rung histogram** — R2: 1 · R3: 4 · R4: 59. **Dark fraction 8%**: five claims
sit below the binding rung, each naming its blocker via `au:stalledOn`. That is
the honest number an agent fleet must not build against, and the point of the
ladder is that it is *countable* rather than invisible.

**Claims per discipline** — market 12, fire-safety 9, interconnection 7,
warranty 7, cyber 6, software 5, permitting 4, tax-finance 4, accounting 4,
settlement 4, electrochemistry 1, protection 1.

## Files

| File | Contents |
|---|---|
| `disciplines.ttl` | The three registries: 12 disciplines with stewards, 20 quantities with dimension **and referent**, 12 scopes with a deliberately partial `au:precedes` order, and 10 explicit topology nodes |
| `corpus.ttl` | 14 documents / 15 sections / 64 claims, with modality, evidence, citation, discipline, rung, bounds and defeasibility |
| `conflicts.ttl` | 11 conflicts as first-class objects with witnesses and owners; 4 adjudicated with recorded resolutions |

## The conflicts

| Id | Kind | Disciplines | State |
|---|---|---|---|
| **INV-01** | empty envelope | market × warranty × fire-safety × thermal × interconnection × software | **derived**, resolved by `au:Narrow` |
| **INV-03** | empty envelope | cyber × protection | **derived**, open — resolution is architectural |
| INV-02 | modality clash | market × fire-safety | resolved by `au:Narrow`, signed by the fire marshal |
| INV-07 | modality clash | market × interconnection × software | open — *already decided in code, undocumented* |
| INV-11 | precedence undefined | warranty × interconnection | open — two private contracts, neither subordinate |
| INV-16 | topology disagreement | settlement × interconnection | resolved by asserting the loss model |
| INV-05 | empty envelope | fire-safety × permitting | open — **gate cannot see it yet** |
| INV-10 | modality clash | market × accounting | **refuted** by the controller |
| INV-12 | homonym (a date) | tax × accounting | open |
| INV-13 | precedence undefined | tax × permitting | open, blocks `wo-057` |
| INV-14 | modality clash | interconnection × software | open — resolution is a *missing claim* |
| INV-19 | homonym ("capacity") | market × permitting × accounting × insurance | resolved by registering 10 disjointness pairs |

Four of these earn their place by being awkward for the design rather than
flattering to it:

- **INV-05** is a real geometric squeeze the gate **cannot currently detect**,
  because the HVAC acoustic contribution carries no `au:Bound`. It is included to
  mark the boundary of the decidable fragment honestly.
- **INV-10 is a false positive, refuted by the domain expert.** The co-constraint
  detector was right that both claims touch `q-station-power`; the inference that
  sharing a quantity implies incompatibility was wrong. The refutation is recorded
  *with the detector that produced it*, because the mechanism is what should
  improve. A spec system a domain expert cannot correct is worthless.
- **INV-14**'s resolution is neither an adjudication nor a narrowing but a
  **missing claim** — assert the island's electrical boundary and the two
  obligations turn out to be about different networks. None of the five
  `au:Outcome` values fits, which is filed as evidence the vocabulary needs a
  sixth.
- **INV-12** is a homonym over a *date* rather than a measurement. The quantity
  registry handles physical quantities well and temporal predicates poorly.

`conflict-hygiene.rq` reports **7 UNRESOLVED** rows over this corpus and nothing
else — no unwitnessed, unowned, or unbounded-waiver defects. Seven open conflicts
is the correct output, not a failure: a real corpus has open conflicts, and the
gate's job is to make them counted and owned.

## Running it

Canonically via bazel (targets not yet wired — RFC-002 §12 P0). Without bazel:

```sh
pip install rdflib pyshacl
python3 - <<'PY'
from rdflib import Graph
import glob, os
g = Graph()
for f in ['rdf/ontology/aion-rfc.ttl', 'rdf/ontology/authoring.ttl',
          'corpus/ampere/disciplines.ttl', 'corpus/ampere/corpus.ttl',
          'corpus/ampere/conflicts.ttl']:
    g.parse(f, format='turtle')
print(len(g), 'triples')
for q in sorted(glob.glob('rdf/lint/authoring/*.rq')) + \
         sorted(glob.glob('rdf/lint/semantic/*.rq')):
    print(f'{os.path.basename(q):36} {len(list(g.query(open(q).read())))}')
PY
```

## Citation posture — read this before quoting anything

Every clause number, edition, and numeric value in this corpus is a **lead, not a
fact**. Nothing was citation-verified against a primary source. Standard,
programme and instrument names are used because they are the real names for these
concerns; the specific provisions attributed to them are **illustrative
reconstructions**. Claims naming a specific provision carry an
`# UNVERIFIED-CITATION` comment.

Deliberately, no real market operator, manufacturer, insurer, or jurisdiction is
named — scopes use `market-operator-a`, `equipment-manufacturer`,
`authority-having-jurisdiction`. The corpus exists to exercise mechanisms, and
attributing a fabricated tariff provision to a named operator would be worse than
useless.

Before this corpus could carry any weight in a real engagement, every claim needs
a verified citation with the verbatim operative text in `rfc:evidence` — which is
what the ingest track in RFC-001 §6 is for, and what the licensing gate in
RFC-001 §7.1 constrains.
