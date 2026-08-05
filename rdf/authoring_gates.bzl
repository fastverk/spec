"""spec_authoring_gates — the RFC-002 authoring/coherence gate + measure suite.

The companion to `//rdf:gates.bzl`'s `spec_corpus_gates`. Where that macro wires
the *structural* invariants (SHACL conformance, dangling refs, cycles, collisions,
inverse edges), this one wires the *cross-domain coherence* checks that RFC-002
adds: witnessed conflict, ladder integrity, and unrecorded infeasibility.

    load("@spec//rdf:authoring_gates.bzl", "spec_authoring_gates")

    rdf_dataset(name = "corpus", srcs = [...],
                deps = ["@spec//rdf:authoring_vocab"])   # note: authoring_vocab

    spec_authoring_gates(name = "corpus_authoring", dataset = ":corpus")

## The gate / measure split — the design decision this file encodes

Only three of the six authoring queries are *gates*. The split is not cosmetic:

**Gates** (zero-row, fail the build):

  * `envelope_unrecorded` — an empty feasible envelope with NO `au:Conflict`
    recording it. This is the load-bearing gate. An empty envelope is a true
    finding about the world, so failing on it would mean a corpus could never
    record two instruments that genuinely cannot both be satisfied. What must
    never happen is an infeasibility nobody wrote down.
  * `conflict_hygiene_strict` — unwitnessed / unowned / unbounded-waiver /
    expired-waiver. All four are cases where a conflict exists but cannot be
    acted on.
  * `ladder_integrity` — hand-set rungs, unnamed stalls, `provenBy` asserted
    below R4.

**Measures** (reported, never fail):

  * `empty_envelope` — the infeasibilities themselves, with deficits.
  * `conflict_hygiene` — the full report, INCLUDING `UNRESOLVED`.
  * `cross_discipline_coconstraint` — the implicit co-constraint candidate set.
  * `homonym_unregistered` — the glossary-alignment work queue.

`UNRESOLVED` is deliberately a measure and not a gate. A real multidisciplinary
corpus has open conflicts — the AMPERE corpus has seven, several of whose
resolutions are engineering work not yet done. Gating on them would push authors
toward fake resolutions, which is the exact failure this system exists to
prevent. The distinction the split preserves is between *"we have open
problems"* and *"we have problems nobody can work on"*.
"""

load("@rules_rdf//sparql:defs.bzl", "sparql_query", "sparql_query_test")

# Zero-row gates. Each fires only on a defect that makes a finding unactionable
# or leaves an infeasibility undocumented.
_GATES = {
    "envelope_unrecorded": Label("//rdf/lint/authoring:envelope-unrecorded.rq"),
    "conflict_hygiene_strict": Label("//rdf/lint/authoring:conflict-hygiene-strict.rq"),
    "ladder_integrity": Label("//rdf/lint/authoring:ladder-integrity.rq"),
}

# Reported measures. Non-empty output is normal and often the point.
_MEASURES = {
    "empty_envelope": Label("//rdf/lint/authoring:empty-envelope.rq"),
    "conflict_hygiene": Label("//rdf/lint/authoring:conflict-hygiene.rq"),
    "cross_discipline_coconstraint": Label("//rdf/lint/authoring:cross-discipline-coconstraint.rq"),
    "homonym_unregistered": Label("//rdf/lint/authoring:homonym-unregistered.rq"),
}

def spec_authoring_gates(name, dataset, measures = True, **kwargs):
    """Wire the RFC-002 authoring gate suite over `dataset`.

    Args:
      name: prefix for the generated targets.
      dataset: an `rdf_dataset` whose deps include
        `@spec//rdf:authoring_vocab` (the au: terms must resolve, or every
        pattern is silently unmatched and the gates pass vacuously).
      measures: also generate the reporting `sparql_query` targets. Set False
        for a fixture where only the pass/fail behaviour matters.
      **kwargs: forwarded to each generated target (tags, size, …).
    """
    for gate, query in _GATES.items():
        sparql_query_test(
            name = name + "_" + gate,
            dataset = dataset,
            query = query,
            **kwargs
        )
    if measures:
        for measure, query in _MEASURES.items():
            sparql_query(
                name = name + "_" + measure,
                dataset = dataset,
                query = query,
                out_format = "tsv",
                **kwargs
            )
