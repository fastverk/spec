"""spec_readmodel — the authoring read model, computed by the build (spec#52).

One macro call per corpus:

    load("@spec//rdf/readmodel:readmodel.bzl", "spec_readmodel")

    spec_readmodel(
        name = "readmodel",
        dataset = ":my_corpus",      # an rdf_dataset with authoring_vocab
        project = "myproject",       # the value every row carries
        srcs = MY_CORPUS,            # the dataset's own srcs, hashed into corpus_version
    )

produces `<name>/` — the eight JSON payloads `console/lib/corpus.ts` imports,
in the envelope `services/spec/src/json.rs` already uses.

THE BUILD COMPUTES, THE PLUGIN SERVES — and now the build computes it with the
same engine that decides the gates. `tools/readmodel/emit_readmodel.py` asks
these same eight questions under **rdflib**, which RFC-005 §3③ names as "the one
to retire, not reconcile"; this is that retirement, for the path a consumer runs.

⚠ `srcs` is declared independently of `dataset` and nothing ties them together —
the same caveat `spec_workorders` carries, for the same reason: a macro cannot
read a target's providers. It feeds the `corpus_version` digest, so a caller who
lists fewer files than the dataset contains gets a read point that does not
describe what was queried. Passing exactly the dataset's own srcs is a
requirement, not a convention. Keep them in one list (`AMPERE_CORPUS`,
`STUDIO_CORPUS`) and pass that list to both.

⚠ The dataset's deps must include `@spec//rdf:authoring_vocab`, the same rule as
the gate suites: without the `au:` terms every pattern silently matches nothing
and every payload emits empty — the vacuous pass this plane exists to refuse.
"""

load("@rules_rdf//sparql:defs.bzl", "sparql_query")

# ⛔ Label(), not the bare string. A plain "//rdf/readmodel:conflicts.rq" inside a
# macro resolves against the CONSUMER's repository, where that package does not
# exist, and the consumer sees `no such package` with no hint that the label was
# supposed to be spec's. That is not hypothetical: it is exactly how
# `spec_workorders` shipped broken for every consumer in 0.8.1, caught only by
# //smoke/consumer, from the one position that can see it.
_ROUTES = {
    "claims": Label("//rdf/readmodel:claims.rq"),
    "conflicts": Label("//rdf/readmodel:conflicts.rq"),
    "disciplines": Label("//rdf/readmodel:disciplines.rq"),
    "envelopes": Label("//rdf/readmodel:envelopes.rq"),
    "frontier": Label("//rdf/readmodel:frontier.rq"),
    "requirements": Label("//rdf/readmodel:requirements.rq"),
    "terms": Label("//rdf/readmodel:terms.rq"),
    "witness": Label("//rdf/readmodel:witness.rq"),
}

_ASSEMBLE = Label("//tools/readmodel:assemble")

def spec_readmodel(name, dataset, project, srcs, **kwargs):
    """Emit the eight read-model payloads for `project` from `dataset`."""
    for route, query in _ROUTES.items():
        sparql_query(
            name = "%s_%s" % (name, route),
            dataset = dataset,
            query = query,
            out_format = "tsv",
            **kwargs
        )

    native.genrule(
        name = name,
        srcs = [":%s_%s" % (name, route) for route in _ROUTES] + srcs,
        outs = ["%s/%s.json" % (name, route) for route in _ROUTES],
        cmd = ("$(execpath %s) " % _ASSEMBLE +
               "--project " + project + " " +
               " ".join([
                   "--route %s=$(execpath :%s_%s)" % (route, name, route)
                   for route in _ROUTES
               ]) + " " +
               "--out $(RULEDIR)/" + name + " " +
               "--ttl " + " ".join(["$(execpaths %s)" % s for s in srcs])),
        tools = [_ASSEMBLE],
    )
