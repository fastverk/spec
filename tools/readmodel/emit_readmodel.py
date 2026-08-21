#!/usr/bin/env python3
"""emit_readmodel.py — compute the authoring read model and emit it as the plugin's
web-plane JSON payloads.

## Why this exists (the architectural decision it encodes)

The spec plugin (`services/spec/`) is a read-only projection whose index is "a scan
of the git-synced source tree at $SPEC_SOURCE_ROOT" — it does no RDF work. The
authoring read model (conflicts, envelopes, the frontier, per-discipline coverage)
is all SPARQL over a Jena-loaded corpus.

Rather than put a SPARQL engine in the Rust plugin — a new dependency, a second RDF
implementation, and a second thing to keep in agreement with the Jena gates — this
follows the pattern the estate already uses:

    THE BUILD COMPUTES, THE PLUGIN SERVES.

`//corpus/ampere:{measure,coverage,frontier}` and the `spec_authoring_gates`
measures already emit TSV under `bazel-bin/`. This script is the same computation
shaped into the plugin's JSON envelope, so `services/spec` can serve the authoring
panels by reading files — exactly what it already does for the Lean spec index.

Consequences worth stating plainly:
  * The read model is as fresh as the last build, not live. For a spec corpus that
    is the right trade: claims change at review cadence, not per-request.
  * No Rust query path is introduced, so there is no drift risk between a Rust
    engine and the Jena gates.

    ⚠ This bullet used to read "there is exactly ONE SPARQL implementation of
    record. No drift risk." That was false four lines above `from rdflib import
    Graph`. This file's queries run under RDFLIB; the gates run under ARQ
    (Jena 5.2.0, via rules_jena's JenaSparql), and `kg.GateHarness` runs a THIRD
    path — in-process ARQ on Jena 5.0.0. Three engines, and the sentence claiming
    one is why nobody was looking. ARQ-vs-ARQ divergence is already documented and
    load-bearing: see the ⛔ header of rdf/lint/authoring/envelope-unrecorded.rq,
    a gate that returned zero rows for every input and read as passing. Nothing
    compares this file's aggregations against ARQ's. RFC-005 names the Bazel
    sparql_query_test path as the engine of record and this file as the one to
    retire, not reconcile.
  * The plugin needs no new crate, so the browser read model ships without
    touching MODULE.bazel.

## Output contract

One file per web route, in the envelope `services/spec/src/json.rs` already uses:

    { "<rows_field>": [ ...rows... ], "unreachable_repos": [] }

Field names are snake_case (proto3-JSON), matching what the meridian table
descriptors reference via `columns.field_path`.

## Usage

    python3 tools/readmodel/emit_readmodel.py          # -> services/spec/readmodel/
    python3 tools/readmodel/check_wiring.py            # assert every consumer agrees
    python3 tools/readmodel/emit_readmodel.py --out /tmp/rm --corpus corpus/ampere

Requires rdflib. Verified against corpus/ampere; the same script runs over any
corpus carrying the au: vocabulary.
"""

import argparse
import hashlib
import json
import os
import sys

try:
    from rdflib import Graph
except ImportError:
    sys.exit("emit_readmodel.py needs rdflib:  pip install rdflib")

# ⛔ The shapers are SHARED with tools/readmodel/assemble.py, which runs the same
# eight questions under ARQ from inside the build. While both paths exist, a
# difference between their payloads must be attributable to the ENGINE and to
# nothing else — so the shaping is not written twice. See shape.py's header.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shape import (  # noqa: E402
    local,
    shape_claim,
    shape_conflict,
    shape_discipline,
    shape_envelope,
    shape_requirement,
    shape_stall,
    shape_term,
    shape_witness_party,
)



def rows(g, query, shape, project):
    """Run `query`; map each row through `shape`, stamped with its project.

    The project is carried on every ROW rather than kept as a per-file header,
    because the console reads these as flat tables — a header would be dropped
    on the way to a panel column, and a row that cannot say which product it
    describes is not much use once more than one corpus is loaded.
    """
    out = []
    for r in g.query(query):
        d = shape(r)
        d["project"] = project
        out.append(d)
    return out


# ── the routes ───────────────────────────────────────────────────────────────
# Each entry: (route path, rows_field, service method, query, row shaper).
# `method` is the spec.v1.Authoring method name the panel's `populate` block
# names; the plugin's /describe maps it to `path`.

























ROUTES = [
    ("conflicts", "conflicts", "ListConflicts", shape_conflict),
    ("envelopes", "envelopes", "ListEnvelopes", shape_envelope),
    ("frontier", "stalls", "ListStalls", shape_stall),
    ("disciplines", "disciplines", "ListDisciplines", shape_discipline),
    ("claims", "claims", "ListClaims", shape_claim),
    ("witness", "parties", "GetConflictWitness", shape_witness_party),
    ("requirements", "requirements", "ListRequirements", shape_requirement),
    ("terms", "terms", "ListTerms", shape_term),
]

SERVICE = "spec.v1.Authoring"


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", default="services/spec/readmodel",
                    help="output directory for the JSON payloads (default: the directory\n"
                         "services/spec serves — see src/readmodel.rs)")
    ap.add_argument("--corpus", action="append", default=None, metavar="NAME=DIR",
                    help="a project's corpus, as name=directory. Repeatable — the\n"
                         "payloads are the UNION across projects, with each row\n"
                         "carrying its project. Defaults to the two that exist:\n"
                         "ampere=corpus/ampere studio=corpus/studio")
    # ⛔ THE SAME .rq FILES THE BUILD RUNS. They used to be Python string
    # constants here, which meant the engine-of-record path (ARQ, via
    # //rdf/readmodel:readmodel.bzl) and this one could ask DIFFERENT questions
    # while claiming to be the same read model. They did: the envelopes query
    # was written with a deliberately-unbound variable that rdflib treats as
    # "leave it unbound" and ARQ treats as an evaluation error, so that route
    # returned 2 rows here and 0 there. Sharing the file is what makes
    # //tools/readmodel:engine_agreement_test a statement about the ENGINES.
    ap.add_argument("--queries", default="rdf/readmodel",
                    help="the directory of .rq files (shared with the Bazel path)")
    ap.add_argument("--ontology", nargs="*",
                    default=["rdf/ontology/aion-rfc.ttl", "rdf/ontology/authoring.ttl",
                             "rdf/ontology/tier.ttl"],
                    help="ontology TTLs to fold in")
    args = ap.parse_args()

    specs = args.corpus or ["ampere=corpus/ampere", "studio=corpus/studio"]
    projects = []
    for spec in specs:
        if "=" not in spec:
            sys.exit(f"--corpus expects name=directory, got {spec!r}")
        name, path = spec.split("=", 1)
        projects.append((name, path))

    # One graph PER PROJECT, not one shared graph. Merging first would let two
    # products' claims join to each other through the ontology and produce
    # cross-project rows that are artifacts of the loader rather than findings.
    # Cross-project comparison is a real feature and deserves to be built
    # deliberately, not fall out of a parse order.
    # The READ POINT. Every proposal must name the corpus state its author was
    # looking at — spec refuses a write without one, because a proposal made
    # against a corpus you were not seeing is a different proposal. Without this
    # the console would have to invent a `parent`, which defeats the check.
    corpus_digest = hashlib.sha256()

    loaded = []
    for name, path in projects:
        g = Graph()
        srcs = list(args.ontology)
        for fn in sorted(os.listdir(path)):
            if fn.endswith(".ttl"):
                srcs.append(os.path.join(path, fn))
        for f in srcs:
            g.parse(f, format="turtle")
            with open(f, "rb") as fh:
                corpus_digest.update(f.encode())
                corpus_digest.update(fh.read())
        loaded.append((name, g))
        # ⛔ NAME THE FILES, not just the count. This script decides what a corpus
        # IS by listing the directory, and two derivation-test overlays once
        # landed in corpus/ampere/ — each saying in its own first line "NOT part
        # of the committed corpus". A count of 8 instead of 6 is not something
        # anyone notices; `fixtures-unrunged-party.ttl` scrolling past is.
        # //tools/readmodel:corpus_is_the_corpus_test is the gate; this is so the
        # person running the regeneration can see it too.
        print(f"loaded {name}: {len(srcs)} files, {len(g)} triples", file=sys.stderr)
        for f in srcs:
            print(f"    {f}", file=sys.stderr)

    version = "corpus:" + corpus_digest.hexdigest()[:16]

    os.makedirs(args.out, exist_ok=True)
    routes_manifest = []
    for path, rows_field, method, shaper in ROUTES:
        with open(os.path.join(args.queries, f"{path}.rq"), encoding="utf-8") as fh:
            query = fh.read()
        data = []
        for name, g in loaded:
            data.extend(rows(g, query, shaper, name))
        payload = {rows_field: data, "corpus_version": version, "unreachable_repos": []}
        dest = os.path.join(args.out, f"{path}.json")
        with open(dest, "w") as fh:
            json.dump(payload, fh, indent=2, sort_keys=False)
            fh.write("\n")
        print(f"  {path + '.json':22} {len(data):4d} rows -> {rows_field}", file=sys.stderr)
        routes_manifest.append({
            "service": SERVICE, "method": method, "http_method": "GET", "path": path,
        })

    # The /describe fragment the plugin must serve for the shell to resolve each
    # panel's `populate.service/.method` to a route. Emitted rather than
    # hand-maintained so the two cannot drift.
    with open(os.path.join(args.out, "describe.web_routes.json"), "w") as fh:
        json.dump({"web_routes": routes_manifest}, fh, indent=2)
        fh.write("\n")
    print(f"  describe.web_routes.json  {len(routes_manifest)} routes", file=sys.stderr)


if __name__ == "__main__":
    main()
