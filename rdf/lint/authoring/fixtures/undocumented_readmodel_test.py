#!/usr/bin/env python3
"""The console's `envelopes` route, on the fixture the gate was built for.

⛔ WHY THIS EXISTS. `envelope-undocumented.ttl`'s own header records that
`envelope-unrecorded.rq` "returned zero rows for every input and read as
passing", because it was written in the flat form:

    BIND(IF(?kind = au:LowerBound, ?v, ?unbound) AS ?lo)
    BIND(IF(?kind = au:UpperBound, ?v, ?unbound) AS ?hi)
    ...
    HAVING (MAX(?lo) > MIN(?hi))

ARQ's MAX/MIN return UNBOUND for a group in which any row lacks the variable, so
HAVING compares two unbounds and admits nothing. That was found twice — once in
`empty-envelope.rq`, once in `envelope-unrecorded.rq` — and each carries a long
header about it.

**The read model's copy of the same question kept the broken form.** It survived
because `tools/readmodel/emit_readmodel.py` runs rdflib, where the form works, so
the route returned 2 rows there and 0 under the engine that decides every gate.
Nobody had run it under ARQ; spec#52 is what made anyone try.

So this is that route's positive control, on the same fixture, under the same
engine as the gate. Two assertions, and the second is the one that would catch a
plausible-looking rewrite:

  1. the infeasibility appears at all — one row, deficit 30.0;
  2. `recorded` is FALSE. The `recorded` sub-select must bind ?quantity OUTSIDE
     its OPTIONAL. With only the OPTIONAL, a quantity nobody raised a conflict
     against binds ?quantity nowhere, produces no row, and is dropped by the join
     — so the UNRECORDED envelopes, the only ones the gate cares about, vanish
     from the panel that exists to show them. That failure looks exactly like
     "the corpus is clean".
"""

import json
import sys


def main(argv):
    if len(argv) != 1:
        print("usage: undocumented_readmodel_test.py <envelopes.json>", file=sys.stderr)
        return 2
    with open(argv[0], encoding="utf-8") as fh:
        payload = json.load(fh)

    rows = payload.get("envelopes")
    if not isinstance(rows, list):
        print(f"FAIL — no `envelopes` array in {argv[0]}", file=sys.stderr)
        return 1

    problems = []
    if len(rows) != 1:
        problems.append(
            f"expected exactly 1 envelope, got {len(rows)}: {json.dumps(rows)[:400]}\n"
            "      Zero means the route has gone quiet the way the gate once did — "
            "check the query's form before checking the fixture.")
    else:
        row = rows[0]
        if row.get("quantity") != "q-export-power":
            problems.append(f"expected quantity q-export-power, got {row.get('quantity')!r}")
        if row.get("deficit") != 30.0:
            problems.append(f"expected deficit 30.0, got {row.get('deficit')!r}")
        if row.get("greatest_lower") != 90.0 or row.get("least_upper") != 60.0:
            problems.append(
                f"expected bounds 90 > 60, got {row.get('greatest_lower')!r} > "
                f"{row.get('least_upper')!r}")
        # ⛔ The assertion a plausible rewrite fails.
        if row.get("recorded") is not False:
            problems.append(
                f"expected `recorded` False — NO au:Conflict names this quantity — "
                f"got {row.get('recorded')!r}")
        if row.get("disciplines") != 2:
            problems.append(f"expected 2 disciplines, got {row.get('disciplines')!r}")

    if problems:
        print("FAIL — the envelopes route disagrees with the fixture it was built for:\n",
              file=sys.stderr)
        for p in problems:
            print("  * " + p, file=sys.stderr)
        return 1

    print("ok    the envelopes route finds the undocumented infeasibility, "
          "deficit 30.0, recorded=False")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
