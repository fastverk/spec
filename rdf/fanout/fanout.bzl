"""spec_workorders — derive RFC-002 §10 work orders from a corpus (spec#45).

One macro call per corpus:

    load("@spec//rdf/fanout:fanout.bzl", "spec_workorders")

    spec_workorders(
        name = "workorders",
        dataset = ":my_corpus",         # an rdf_dataset with authoring_vocab
        config = "fanout.json",         # orders: id, scope, paths, budget
        srcs = ["corpus.ttl", ...],     # the sources, hashed into as_of
    )

produces <name>.json — the `workorders` read-model payload (rows_field
"orders") the fanout panel renders and the dispatch door reads.

THE BUILD COMPUTES, THE PLUGIN SERVES: the four graph questions run under the
engine of record (ARQ via sparql_query), the assembler
(//tools/fanout:derive) only joins. The config carries what the corpus cannot
know — order ids, artifact paths, budgets: repo-layout and allocation facts,
not graph facts. Its shape is documented against proto/spec/v1/workorder.proto.

⚠ The dataset's deps must include @spec//rdf:authoring_vocab, the same rule
as the gate suites: without the au: terms every pattern silently matches
nothing and every order derives empty — which is exactly the vacuous pass
this plane exists to refuse.
"""

load("@rules_rdf//sparql:defs.bzl", "sparql_query")

_QUERIES = {
    "bindings": Label("//rdf/fanout:bindings.rq"),
    "lattice": Label("//rdf/fanout:lattice.rq"),
    "live_conflicts": Label("//rdf/fanout:live-conflicts.rq"),
    "glossary": Label("//rdf/fanout:glossary.rq"),
    # The direct-hold record, live branches only — shared with the measure
    # suite so the dispatch door and the board can never disagree about
    # liveness.
    "direct_holds": Label("//rdf/lint/authoring:dispatch-hold.rq"),
}

# ⛔ Label(), not the bare string. A plain "//tools/fanout:derive" inside a
# macro resolves against the CONSUMER's repository, where that package does not
# exist — the consumer sees `no such package 'tools/fanout'` and no hint that
# the label was supposed to be spec's. Label() resolves in the repo this .bzl
# is defined in, which is what every other label here already does. Caught by
# //smoke/consumer, from the only position that can see it.
_DERIVE = Label("//tools/fanout:derive")

def spec_workorders(name, dataset, config, srcs, **kwargs):
    """Derive work orders from `dataset` per `config`, hashing `srcs` into as_of."""
    for key, query in _QUERIES.items():
        sparql_query(
            name = "%s_%s" % (name, key),
            dataset = dataset,
            query = query,
            out_format = "tsv",
            **kwargs
        )

    native.genrule(
        name = name,
        srcs = [
            ":%s_bindings" % name,
            ":%s_lattice" % name,
            ":%s_live_conflicts" % name,
            ":%s_glossary" % name,
            ":%s_direct_holds" % name,
            config,
        ] + srcs,
        outs = [name + ".json"],
        cmd = ("$(execpath %s) " % _DERIVE +
               "--bindings $(execpath :%s_bindings) " % name +
               "--lattice $(execpath :%s_lattice) " % name +
               "--live-conflicts $(execpath :%s_live_conflicts) " % name +
               "--glossary $(execpath :%s_glossary) " % name +
               "--direct-holds $(execpath :%s_direct_holds) " % name +
               "--config $(execpath %s) " % config +
               "--out $@ " +
               "--ttl " + " ".join(["$(execpaths %s)" % s for s in srcs])),
        tools = [_DERIVE],
    )
