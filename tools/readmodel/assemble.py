#!/usr/bin/env python3
"""assemble — the read-model payloads, from results the ENGINE OF RECORD produced.

`tools/readmodel/emit_readmodel.py` asks the authoring read model's eight
questions under **rdflib**. RFC-005 §3③ names that path as "the one to retire,
not reconcile", and spec#52's scope says why it matters beyond this repository:

> the emitter must run the engine of record or its payloads carry the ARQ/rdflib
> divergence RFC-005 documents

This is the retirement. `rdf/readmodel/readmodel.bzl`'s `spec_readmodel` macro
runs the same eight `.rq` files under ARQ via `sparql_query` — the same binary
`sparql_query_test` invokes for every gate — and hands the TSVs here. This file
joins and shapes; it asks the graph nothing, so there is no second engine to
drift from the gates.

⛔ THE SHAPERS ARE SHARED (`shape.py`), not reimplemented. While both paths
exist, a difference between their payloads must be attributable to the engine and
to nothing else. A second copy of the shaping would make every diff ambiguous
exactly when the diff is the thing being read.

## The decoder, and why it is not a `split("\\t")`

ARQ's TSV gives `<iri>`, `"literal"`, `"literal"^^<datatype>`, `"literal"@lang`,
or an EMPTY CELL for unbound. Two of those distinctions are load-bearing and both
are easy to lose:

  ⛔ **empty cell ≠ empty string.** `au:boundTo` absent is an OPEN HOLE; bound to
     "" is a term someone bound to nothing. `population` absent renders `—`;
     present and 0 renders `0`, and RFC-002 spends a paragraph on why those are
     different facts.
  ⛔ **`"false"^^xsd:boolean` is not the string `"false"`.** `shape.py` writes
     `str(bool(r.defeasible)).lower()`, and `bool("false")` is **True** in
     Python. Dropping the datatype would silently flip every non-defeasible claim
     in the corpus to defeasible — in a payload whose whole purpose is to show
     which bounds cannot be traded away.

So terms decode to typed Python values: `None`, `bool`, `int`, `float`, `str`.
"""

import argparse
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from shape import (  # noqa: E402
    shape_claim,
    shape_conflict,
    shape_discipline,
    shape_envelope,
    shape_requirement,
    shape_stall,
    shape_term,
    shape_witness_party,
)

XSD = "http://www.w3.org/2001/XMLSchema#"

# route -> (rows_field, shaper). The same table as emit_readmodel.py's ROUTES,
# minus the query and the method: the query is now a .rq file the BUILD runs, and
# the method belongs to the /describe fragment rather than to a payload.
ROUTES = {
    "claims": ("claims", shape_claim),
    "conflicts": ("conflicts", shape_conflict),
    "disciplines": ("disciplines", shape_discipline),
    "envelopes": ("envelopes", shape_envelope),
    "frontier": ("stalls", shape_stall),
    "requirements": ("requirements", shape_requirement),
    "terms": ("terms", shape_term),
    "witness": ("parties", shape_witness_party),
}


class Row:
    """One result row, by SELECT variable name.

    Attribute access rather than a dict because that is the interface `shape.py`
    was written against (rdflib's `ResultRow`), and keeping it means the shapers
    are shared rather than ported.
    """

    __slots__ = ("_v",)

    def __init__(self, values):
        self._v = values

    def __getattr__(self, name):
        # ⚠ A variable the query did not SELECT reads as unbound rather than
        # raising. That is rdflib's behaviour too, and a shaper reading a name
        # the query dropped should produce an empty column, not a crash in a
        # build action whose stderr nobody reads.
        return self._v.get(name)


def term(cell):
    """One TSV cell to a typed Python value. `None` when unbound."""
    cell = cell.strip()
    if not cell:
        return None
    if cell.startswith("<") and cell.endswith(">"):
        return cell[1:-1]
    if cell.startswith('"'):
        # "body" | "body"^^<dt> | "body"@lang
        close = cell.rfind('"')
        body = cell[1:close]
        rest = cell[close + 1:]
        body = body.replace('\\"', '"').replace("\\\\", "\\").replace("\\t", "\t").replace("\\n", "\n")
        if rest.startswith("^^"):
            dt = rest[2:].strip("<>")
            if dt == XSD + "boolean":
                return body == "true"
            if dt in (XSD + "integer", XSD + "int", XSD + "long"):
                return int(body)
            if dt in (XSD + "decimal", XSD + "double", XSD + "float"):
                return float(body)
        return body
    # ⛔ ARQ ABBREVIATES. It writes `false`, not `"false"^^<xsd:boolean>`, and
    # `5`, not `"5"^^<xsd:integer>` — so the datatype branch above never sees
    # them and a fall-through to `str` returns the STRING "false". `shape.py`
    # then computes `str(bool("false")).lower()` == "true", flipping every
    # non-defeasible claim in the corpus to defeasible.
    #
    # ⚠ This file's own header warned about exactly that, and the first version
    # of this decoder shipped the bug anyway — the warning was about dropping a
    # DATATYPE, and ARQ's answer was to not send one. Caught by
    # //tools/readmodel:engine_agreement_test, which is the whole reason it
    # compares row for row instead of counting rows: the counts matched.
    if cell in ("true", "false"):
        return cell == "true"
    try:
        return int(cell)
    except ValueError:
        pass
    try:
        return float(cell)
    except ValueError:
        return cell


def read_tsv(path):
    with open(path, encoding="utf-8") as fh:
        lines = [ln.rstrip("\n") for ln in fh]
    lines = [ln for ln in lines if ln.strip() != ""]
    if not lines:
        return []
    header = [h.lstrip("?") for h in lines[0].split("\t")]
    out = []
    for ln in lines[1:]:
        cells = ln.split("\t")
        # ⚠ Pad rather than zip-truncate. A row whose trailing variables are all
        # unbound can arrive short, and zip() would silently drop the columns
        # after the last present one — turning "unbound" into "absent from the
        # row", which reads the same and is not.
        cells += [""] * (len(header) - len(cells))
        out.append(Row(dict(zip(header, (term(c) for c in cells)))))
    return out


def corpus_version(ttl_paths):
    """The read point: sha256 over the corpus CONTENT.

    ⚠ CONTENT ONLY, and sorted by basename — deliberately unlike
    `emit_readmodel.py`, which folds each file's PATH into the digest as well.
    A path makes the read point depend on where the corpus happens to sit, so
    the same corpus built from a Bazel execroot and from a checkout would name
    two different read points. A consumer building in both places would then have
    proposals whose `parent` cannot be compared.
    """
    digest = hashlib.sha256()
    for path in sorted(ttl_paths, key=os.path.basename):
        with open(path, "rb") as fh:
            digest.update(fh.read())
    return "corpus:" + digest.hexdigest()[:16]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--project", required=True, help="the value every row carries")
    ap.add_argument("--route", action="append", default=[], metavar="NAME=TSV",
                    help="a route's ARQ results, as name=path. Repeatable.")
    ap.add_argument("--out", required=True, help="directory for the payloads")
    ap.add_argument("--ttl", nargs="*", default=[],
                    help="the corpus sources, hashed into corpus_version")
    args = ap.parse_args()

    given = {}
    for spec in args.route:
        if "=" not in spec:
            sys.exit(f"--route expects name=path, got {spec!r}")
        name, path = spec.split("=", 1)
        given[name] = path

    # ⛔ Every route or none. A missing payload is not a smaller console — it is a
    # page rendering an empty table, which reads as "this corpus has no
    # conflicts" rather than "nobody computed conflicts". `console/lib/readmodel.ts`
    # refuses the same thing from the other end; refusing it here means the
    # BUILD fails rather than the deployment.
    missing = sorted(set(ROUTES) - set(given))
    if missing:
        sys.exit(f"assemble: no results for {missing} — the macro must wire every route")
    unknown = sorted(set(given) - set(ROUTES))
    if unknown:
        sys.exit(f"assemble: {unknown} is not a read-model route")

    if not args.ttl:
        sys.exit("assemble: --ttl is required — without the corpus there is no read point, "
                 "and a payload with no corpus_version cannot be a parent for any proposal")

    version = corpus_version(args.ttl)
    os.makedirs(args.out, exist_ok=True)

    for route, (rows_field, shaper) in sorted(ROUTES.items()):
        rows = read_tsv(given[route])
        data = []
        for r in rows:
            d = shaper(r)
            # The project rides on every ROW rather than in a header: the console
            # reads these as flat tables, and a row that cannot say which product
            # it describes is not much use once more than one corpus is loaded.
            d["project"] = args.project
            data.append(d)
        payload = {rows_field: data, "corpus_version": version, "unreachable_repos": []}
        with open(os.path.join(args.out, f"{route}.json"), "w") as fh:
            json.dump(payload, fh, indent=2, sort_keys=False)
            fh.write("\n")
        print(f"  {route + '.json':22} {len(data):4d} rows -> {rows_field}", file=sys.stderr)

    print(f"  read point {version} over {len(args.ttl)} corpus file(s)", file=sys.stderr)


if __name__ == "__main__":
    main()
