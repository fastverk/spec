"""spec_corpus_gates — the generic RFC-corpus graph-integrity gate library.

rules_spec hosts the RFC-shaped spec ontology (the `rfc:` vocabulary +
SHACL shapes + the consistency SPARQL queries) under `rdf/`. This macro
wires the engine-agnostic rules_rdf rules over those files so any consumer
gets the full gate suite by pointing the macro at *their* corpus dataset:

    load("@rules_spec//rdf:gates.bzl", "spec_corpus_gates")

    rdf_dataset(name = "corpus", srcs = [...my TTLs...],
                deps = ["@rules_spec//rdf:vocab"])

    spec_corpus_gates(name = "corpus_gates", dataset = ":corpus")

generates `corpus_gates_shacl` (rdf_validate_test against shapes.ttl) plus
one `corpus_gates_<name>` sparql_query_test per consistency invariant
(dangling refs, dependency cycles, diagnostic-code collisions, asymmetric
inverse edges). The engine is whatever rdf toolchain the consumer
registers (rules_jena in practice). Replaces the bespoke in-JVM
GateHarness — the gate IS the rule.
"""

load("@rules_rdf//sparql:defs.bzl", "sparql_query_test")
load("@rules_rdf//validate:defs.bzl", "rdf_validate_test")

# The consistency invariants, each a zero-row SPARQL gate. Label()-wrapped
# so they resolve to rules_spec's own rdf/queries/consistency/ even when the
# macro is instantiated in a consumer's package (a bare "//..." would
# resolve in the caller's repo).
_CONSISTENCY_GATES = {
    "dangling": Label("//rdf/queries/consistency:dangling-references.rq"),
    "cycles": Label("//rdf/queries/consistency:circular-deps.rq"),
    "collisions": Label("//rdf/queries/consistency:diagnostic-collisions.rq"),
    "inverse_edges": Label("//rdf/queries/consistency:inverse-edges.rq"),
}

_SHAPES = Label("//rdf/ontology:shapes.ttl")

def spec_corpus_gates(name, dataset, **kwargs):
    """Wire the full RFC-corpus gate suite over `dataset`.

    Args:
      name: prefix for the generated test targets.
      dataset: an `rdf_dataset` (typically the consumer's corpus with
        `deps = ["@rules_spec//rdf:vocab"]`).
      **kwargs: forwarded to each generated test (e.g. `tags`, `size`).
    """
    rdf_validate_test(
        name = name + "_shacl",
        dataset = dataset,
        shapes = _SHAPES,
        **kwargs
    )
    for gate, query in _CONSISTENCY_GATES.items():
        sparql_query_test(
            name = name + "_" + gate,
            dataset = dataset,
            query = query,
            **kwargs
        )
