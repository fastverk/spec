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
  * There is exactly ONE SPARQL implementation of record. No drift risk between a
    Rust query path and the Jena gates.
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
import json
import os
import sys

try:
    from rdflib import Graph
except ImportError:
    sys.exit("emit_readmodel.py needs rdflib:  pip install rdflib")

PREFIX = """
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
PREFIX rfc:  <https://aion.savvi.io/ontology/rfc#>
PREFIX au:   <https://aion.savvi.io/ontology/authoring#>
"""


def local(term):
    """Local name of an IRI, for stable short ids in the payload."""
    if term is None:
        return None
    s = str(term)
    for sep in ("#", "/"):
        if sep in s:
            s = s.rsplit(sep, 1)[-1]
    return s


def rows(g, query, shape, project):
    """Run `query`; map each row through `shape`, stamped with its project.

    The project is carried on every ROW rather than kept as a per-file header,
    because the console reads these as flat tables — a header would be dropped
    on the way to a panel column, and a row that cannot say which product it
    describes is not much use once more than one corpus is loaded.
    """
    out = []
    for r in g.query(PREFIX + query):
        d = shape(r)
        d["project"] = project
        out.append(d)
    return out


# ── the routes ───────────────────────────────────────────────────────────────
# Each entry: (route path, rows_field, service method, query, row shaper).
# `method` is the spec.v1.Authoring method name the panel's `populate` block
# names; the plugin's /describe maps it to `path`.

Q_CONFLICTS = """
SELECT ?conflict ?kind ?quantity ?owner ?resolution ?outcome
       (GROUP_CONCAT(DISTINCT ?discLabel; separator=" x ") AS ?disciplines)
       (COUNT(DISTINCT ?party) AS ?partyCount)
       (COUNT(DISTINCT ?order) AS ?blockedOrders)
WHERE {
  ?conflict a au:Conflict .
  OPTIONAL { ?conflict au:conflictKind ?kind }
  OPTIONAL { ?conflict au:onQuantity ?quantity }
  OPTIONAL { ?conflict au:owner ?owner }
  OPTIONAL { ?conflict au:resolvedBy ?resolution . ?resolution au:outcome ?outcome }
  OPTIONAL { ?conflict au:blocksWorkOrder ?order }
  OPTIONAL { ?conflict au:party ?party . ?party au:discipline ?d . ?d rdfs:label ?discLabel }
}
GROUP BY ?conflict ?kind ?quantity ?owner ?resolution ?outcome
ORDER BY DESC(?blockedOrders) ?conflict
"""


def shape_conflict(r):
    return {
        "id": local(r.conflict),
        "kind": local(r.kind) or "",
        "quantity": local(r.quantity) or "",
        "disciplines": str(r.disciplines or ""),
        "party_count": int(r.partyCount or 0),
        "blocked_orders": int(r.blockedOrders or 0),
        "owner": local(r.owner) or "",
        # State is derived, not stored: a conflict with no au:Resolution is open.
        # RFC-002 §7 keeps UNRESOLVED a measure rather than a gate, so "open" is a
        # legitimate steady state and the board must be able to show it.
        "state": "resolved" if r.resolution else "open",
        "outcome": local(r.outcome) or "",
    }


Q_ENVELOPES = """
SELECT ?quantity ?unit
       (MAX(?lo) AS ?greatestLower)
       (MIN(?hi) AS ?leastUpper)
       (MAX(?lo) - MIN(?hi) AS ?deficit)
       (COUNT(DISTINCT ?discipline) AS ?disciplines)
       (COUNT(DISTINCT ?conflict) AS ?recorded)
WHERE {
  ?quantity a au:Quantity .
  OPTIONAL { ?quantity au:unit ?unit }
  ?claim a rfc:NormativeStatement ;
         au:constrains ?quantity ; au:hasBound ?bound ; au:discipline ?discipline .
  ?bound au:boundValue ?v ; au:boundKind ?kind .
  BIND(IF(?kind = au:LowerBound, ?v, ?unbound) AS ?lo)
  BIND(IF(?kind = au:UpperBound, ?v, ?unbound) AS ?hi)
  OPTIONAL { ?conflict a au:Conflict ; au:onQuantity ?quantity }
}
GROUP BY ?quantity ?unit
HAVING (MAX(?lo) > MIN(?hi))
ORDER BY DESC(?deficit)
"""


def shape_envelope(r):
    return {
        "quantity": local(r.quantity),
        "unit": str(r.unit or ""),
        "greatest_lower": float(r.greatestLower),
        "least_upper": float(r.leastUpper),
        "deficit": float(r.deficit),
        "disciplines": int(r.disciplines or 0),
        # An infeasibility with no au:Conflict naming it is what
        # envelope-unrecorded.rq gates on. Surfacing the flag here means the board
        # shows the gate's subject, not just its verdict.
        "recorded": bool(int(r.recorded or 0) > 0),
    }


Q_FRONTIER = """
SELECT ?claim ?rung ?discipline ?stalledOn
       (COUNT(DISTINCT ?dependent) AS ?dependents)
WHERE {
  ?claim a rfc:NormativeStatement ; au:rung ?rung .
  FILTER(?rung IN (au:R0, au:R1, au:R2, au:R3))
  OPTIONAL { ?claim au:discipline ?d . ?d rdfs:label ?discipline }
  OPTIONAL { ?claim au:stalledOn ?stalledOn }
  OPTIONAL { ?dependent rfc:references ?claim }
}
GROUP BY ?claim ?rung ?discipline ?stalledOn
ORDER BY DESC(?dependents) ?rung ?claim
"""


def shape_stall(r):
    return {
        "claim_id": local(r.claim),
        "rung": local(r.rung),
        "discipline": str(r.discipline or ""),
        "stalled_on": str(r.stalledOn or ""),
        "dependent_count": int(r.dependents or 0),
    }


Q_DISCIPLINES = """
SELECT ?discipline ?steward
       (COUNT(DISTINCT ?claim) AS ?claims)
       (COUNT(DISTINCT ?typed) AS ?typedClaims)
       (COUNT(DISTINCT ?hard) AS ?nonDefeasible)
       (COUNT(DISTINCT ?dark) AS ?darkClaims)
WHERE {
  ?d a au:Discipline .
  OPTIONAL { ?d rdfs:label ?discipline }
  OPTIONAL { ?d au:stewardedBy ?steward }
  ?claim a rfc:NormativeStatement ; au:discipline ?d .
  OPTIONAL { ?typed au:discipline ?d ; au:constrains ?q }
  OPTIONAL { ?hard  au:discipline ?d ; au:defeasible false }
  OPTIONAL { ?dark  au:discipline ?d ; au:rung ?r .
             FILTER(?r IN (au:R0, au:R1, au:R2, au:R3)) }
}
GROUP BY ?discipline ?steward
ORDER BY DESC(?claims)
"""


def shape_discipline(r):
    claims = int(r.claims or 0)
    typed = int(r.typedClaims or 0)
    dark = int(r.darkClaims or 0)
    return {
        "discipline": str(r.discipline or ""),
        "steward": local(r.steward) or "",
        "claim_count": claims,
        "typed_count": typed,
        "non_defeasible_count": int(r.nonDefeasible or 0),
        "dark_count": dark,
        # Percentages precomputed so the table descriptor needs no client-side
        # arithmetic — meridian columns render a field, they do not compute.
        "dark_pct": round(100.0 * dark / claims, 1) if claims else 0.0,
        # The leading indicator: a discipline with a low typed ratio cannot
        # participate in envelope detection at all, so its conflicts are
        # invisible rather than absent.
        "typed_pct": round(100.0 * typed / claims, 1) if claims else 0.0,
    }


Q_CLAIMS = """
SELECT ?claim ?discipline ?modality ?rung ?quantity ?instrument ?defeasible ?predicate
WHERE {
  ?claim a rfc:NormativeStatement ; rfc:modality ?modality .
  OPTIONAL { ?claim rfc:predicate ?predicate }
  OPTIONAL { ?claim au:discipline ?d . ?d rdfs:label ?discipline }
  OPTIONAL { ?claim au:rung ?rung }
  OPTIONAL { ?claim au:constrains ?quantity }
  OPTIONAL { ?claim au:scopedBy ?s . ?s au:instrument ?instrument }
  OPTIONAL { ?claim au:defeasible ?defeasible }
}
ORDER BY ?discipline ?claim
"""


def shape_claim(r):
    return {
        "claim_id": local(r.claim),
        "discipline": str(r.discipline or ""),
        "modality": local(r.modality) or "",
        "rung": local(r.rung) or "",
        "quantity": local(r.quantity) or "",
        "instrument": str(r.instrument or ""),
        "defeasible": "" if r.defeasible is None else str(bool(r.defeasible)).lower(),
        "predicate": str(r.predicate or ""),
    }


Q_WITNESS = """
SELECT ?conflict ?quantity ?unit ?party ?discipline ?modality ?boundKind ?boundValue ?guard ?defeasible
WHERE {
  ?conflict a au:Conflict ; au:party ?party .
  ?party rfc:modality ?modality .
  # The join key to ListEnvelopes. Without it a witness row says "this claim binds
  # at 55" with no way to know 55 of WHAT, which makes the constraint-bar axis
  # (the one screen the whole read model exists for) impossible to draw.
  OPTIONAL { ?conflict au:onQuantity ?quantity . OPTIONAL { ?quantity au:unit ?unit } }
  OPTIONAL { ?party au:discipline ?d . ?d rdfs:label ?discipline }
  OPTIONAL { ?party au:hasBound ?b . ?b au:boundKind ?boundKind ; au:boundValue ?boundValue .
             OPTIONAL { ?b au:boundGuard ?guard } }
  OPTIONAL { ?party au:defeasible ?defeasible }
}
ORDER BY ?conflict ?boundValue
"""


def shape_witness_party(r):
    return {
        "conflict_id": local(r.conflict),
        "quantity": local(r.quantity) or "",
        "unit": str(r.unit or ""),
        "claim_id": local(r.party),
        "discipline": str(r.discipline or ""),
        "modality": local(r.modality) or "",
        "bound_kind": local(r.boundKind) or "",
        "bound_value": None if r.boundValue is None else float(r.boundValue),
        "guard": str(r.guard or ""),
        # The column that makes the witness actionable rather than merely
        # alarming: a non-defeasible bound cannot be traded away at any price.
        "defeasible": "" if r.defeasible is None else str(bool(r.defeasible)).lower(),
    }


Q_REQUIREMENTS = """
SELECT ?claim ?discipline ?modality ?rung ?stall ?impl ?population ?outcome
WHERE {
  ?claim a rfc:NormativeStatement .
  OPTIONAL { ?claim au:discipline ?d . ?d rdfs:label ?discipline }
  OPTIONAL { ?claim rfc:modality ?modality }
  OPTIONAL { ?claim au:rung ?rung }
  OPTIONAL { ?claim au:stalledOn ?stall }
  # LEFT JOIN, deliberately. A requirement with no evaluation must still appear —
  # it is the single largest category and the one worth seeing. An inner join
  # would show only the evaluated ones and make the table look healthy by
  # hiding everything nothing has ever checked.
  OPTIONAL {
    ?claim au:evaluatedBy ?e .
    OPTIONAL { ?e au:implementation ?impl }
    OPTIONAL { ?e au:population ?population }
    OPTIONAL { ?e au:outcomeOf ?outcome }
  }
}
ORDER BY ?claim ?impl
"""


def shape_requirement(r):
    evaluated = r.outcome is not None or r.population is not None
    return {
        "requirement_id": local(r.claim),
        "discipline": str(r.discipline or ""),
        "modality": local(r.modality) or "",
        "rung": local(r.rung) or "",
        # Which implementation answered. Empty when nothing has.
        "implementation": str(r.impl or ""),
        # ⛔ "—" and 0 are DIFFERENT and the distinction is the point: 0 means a
        # check ran and examined nothing (vacuous); "—" means no check has ever
        # run. Rendering both as 0 is how a requirement ends up looking guarded.
        "population": "—" if r.population is None else str(int(r.population)),
        "outcome": local(r.outcome) or ("NOT-EVALUATED" if not evaluated else ""),
        "blocked_on": str(r.stall or ""),
    }


ROUTES = [
    ("conflicts",   "conflicts",  "ListConflicts",       Q_CONFLICTS,   shape_conflict),
    ("envelopes",   "envelopes",  "ListEnvelopes",       Q_ENVELOPES,   shape_envelope),
    ("frontier",    "stalls",     "ListStalls",          Q_FRONTIER,    shape_stall),
    ("disciplines", "disciplines", "ListDisciplines",    Q_DISCIPLINES, shape_discipline),
    ("claims",      "claims",     "ListClaims",          Q_CLAIMS,      shape_claim),
    ("witness",     "parties",    "GetConflictWitness",  Q_WITNESS,     shape_witness_party),
    ("requirements", "requirements", "ListRequirements",  Q_REQUIREMENTS, shape_requirement),
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
    ap.add_argument("--ontology", nargs="*",
                    default=["rdf/ontology/aion-rfc.ttl", "rdf/ontology/authoring.ttl"],
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
    loaded = []
    for name, path in projects:
        g = Graph()
        srcs = list(args.ontology)
        for fn in sorted(os.listdir(path)):
            if fn.endswith(".ttl"):
                srcs.append(os.path.join(path, fn))
        for f in srcs:
            g.parse(f, format="turtle")
        loaded.append((name, g))
        print(f"loaded {name}: {len(srcs)} files, {len(g)} triples", file=sys.stderr)

    os.makedirs(args.out, exist_ok=True)
    routes_manifest = []
    for path, rows_field, method, query, shaper in ROUTES:
        data = []
        for name, g in loaded:
            data.extend(rows(g, query, shaper, name))
        payload = {rows_field: data, "unreachable_repos": []}
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
