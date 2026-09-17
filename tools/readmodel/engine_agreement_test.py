#!/usr/bin/env python3
"""Do ARQ and rdflib answer the read model's eight questions the same way?

⛔ THIS TEST EXISTS TO BE READ, not merely to be green.

RFC-005 §1 is blunt that this estate runs three SPARQL engines, and §3 makes the
Bazel `sparql_query` path (ARQ) the engine of record — the one that gates the
merge. `tools/readmodel/emit_readmodel.py` answers the same eight questions under
**rdflib**, and its output is what `services/spec/readmodel/*.json` holds and what
the console renders. RFC-005 §3③ files the rdflib path as "retired, not
reconciled" and adds, correctly, that "it is the read model, not a gate".

spec#52 raises the stakes: a CONSUMER's console is built from payloads emitted by
whichever of these it runs, so "the numbers in the console come from a different
engine than the numbers that decide the gates" stops being an internal note and
becomes something a consumer inherits.

Nothing had ever compared them. This does, row for row, over spec's own two
corpora — the same shapers on both sides (`shape.py`), so any difference is the
ENGINE and nothing else.

## What a failure here means

Not that the build is broken. It means the console and the gates disagree about
what the corpus says, and the FAILURE OUTPUT is the finding: it names the route,
the row, and the field. Read it before regenerating anything.

⚠ What it cannot tell you is which one is RIGHT. ARQ is the engine of record, so
ARQ is right by decision rather than by argument — but a disagreement is worth
understanding before it is resolved by fiat, because it may be the query that is
ambiguous rather than either engine that is wrong.
"""

import json
import sys


def load(path, rows_field):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)[rows_field]


def key(row):
    """A stable identity for a row, so two orderings can still be compared.

    ⚠ Order is NOT compared. Both engines honour the query's ORDER BY, but ties
    inside an ORDER BY are unspecified in SPARQL and neither engine promises a
    tiebreak. Comparing sequence would report a difference that is not one; the
    payload's own consumers sort in the panel anyway.
    """
    return json.dumps(row, sort_keys=True)


def compare(route, rows_field, arq_path, rdflib_path, project):
    arq = [r for r in load(arq_path, rows_field) if r.get("project") == project]
    ref = [r for r in load(rdflib_path, rows_field) if r.get("project") == project]

    # ⛔ Two empty lists agree perfectly, so an empty pair is NOT evidence.
    #
    # Some pairs are structurally empty and legitimately so: ampere has no terms
    # (nothing has decomposed it), studio has no conflicts, envelopes or witness
    # parties (nothing has typed its quantities). Those cannot be compared and
    # must not be counted as agreement — but they must not fail either, or the
    # test would demand a corpus contain everything.
    #
    # So they are RETURNED AS SKIPS and named, and `main` then insists every
    # ROUTE was really compared for at least one project. A route that quietly
    # went empty everywhere is the failure this arrangement still catches.
    if not arq and not ref:
        print(f"skip  {route:13} {project:8} both empty — not compared")
        return None

    a, b = {key(r) for r in arq}, {key(r) for r in ref}
    if a == b:
        print(f"ok    {route:13} {project:8} {len(arq):4d} rows, identical")
        return []

    problems = [f"{route}/{project}: ARQ {len(arq)} rows, rdflib {len(ref)} rows, "
                f"{len(a - b)} only-ARQ, {len(b - a)} only-rdflib"]
    for k in sorted(a - b)[:3]:
        problems.append(f"    ARQ only:    {k[:200]}")
    for k in sorted(b - a)[:3]:
        problems.append(f"    rdflib only: {k[:200]}")
    return problems


def main(argv):
    # --route name=rows_field=arq.json=rdflib.json=project
    problems, compared, skipped = [], {}, []
    routes = set()
    for spec in argv:
        route, rows_field, arq, ref, project = spec.split("=", 4)
        routes.add(route)
        result = compare(route, rows_field, arq, ref, project)
        if result is None:
            skipped.append(f"{route}/{project}")
            continue
        compared[route] = compared.get(route, 0) + 1
        problems += result

    if not routes:
        print("FAIL — nothing was compared", file=sys.stderr)
        return 1

    # ⛔ Every route, somewhere. Skips are legitimate per project and never
    # legitimate for a whole route: that would mean this test passed while one of
    # the eight questions was answered by nobody.
    never = sorted(routes - set(compared))
    if never:
        problems.append(
            f"{never} was empty under BOTH engines for EVERY project — the route "
            f"is compared by nothing, which is not the same as agreement")
    if skipped:
        print(f"\n      {len(skipped)} pair(s) not compared (empty on both sides): "
              f"{', '.join(skipped)}")
    if problems:
        print(f"\nFAIL — the engine of record and rdflib disagree, over {checked} "
              f"route/project pair(s):\n", file=sys.stderr)
        for p in problems:
            print("  " + p, file=sys.stderr)
        print("\n  The console renders the rdflib answer; the gates decide with ARQ's.\n"
              "  See RFC-005 §3 and the docstring above before changing either.", file=sys.stderr)
        return 1
    print(f"\nok    {sum(compared.values())} route/project pair(s) compared across "
          f"{len(compared)} route(s): ARQ and rdflib agree row for row")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
