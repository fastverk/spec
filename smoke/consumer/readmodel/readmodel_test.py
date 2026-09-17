#!/usr/bin/env python3
"""What `spec_readmodel` produced for a consumer, checked from consumer position.

⛔ A BUILD-ONLY TARGET WOULD PROVE THE MACRO RUNS. This proves what it produced,
and the difference is not academic: `spec_workorders` shipped in 0.8.1 reaching
for `//tools/fanout` in the CONSUMER's repository — a bare label inside a macro
always resolves there — and nothing inside spec could see it. //smoke/consumer
is the only position that can.

Three things are asserted, in increasing order of what they would have caught:

  1. **All eight payloads exist**, each with its own rows field and a
     corpus_version. A missing route is a console page rendering an empty table,
     which reads as "this corpus has none" rather than "nobody computed any".

  2. **One read point across all eight.** `console/lib/corpus.ts::frozenReadPoint`
     refuses payloads spanning two corpora, because the read point every proposal
     names would then be a lie whichever one you picked. A consumer must not be
     able to assemble that state by accident.

  3. **The envelopes route says YES.** This is the assertion with history. The
     route was written in the flat BIND(IF(...))+HAVING(MAX>MIN) form that
     `empty-envelope.rq` and `envelope-unrecorded.rq` each document at length as
     returning zero rows under ARQ for every input — and this macro runs ARQ. The
     fixture is `envelope-undocumented.ttl`, built for the gate that had gone
     quiet the same way: one infeasibility, deliberately with NO au:Conflict
     naming it. If a consumer's first build shows an empty envelopes panel, the
     panel is broken and not the corpus.
"""

import json
import os
import sys

ROWS_FIELD = {
    "claims": "claims",
    "conflicts": "conflicts",
    "disciplines": "disciplines",
    "envelopes": "envelopes",
    "frontier": "stalls",
    "requirements": "requirements",
    "terms": "terms",
    "witness": "parties",
}


def main(paths):
    if not paths:
        print("FAIL — no payloads were passed; the test examined nothing", file=sys.stderr)
        return 1

    by_route = {os.path.basename(p)[: -len(".json")]: p for p in paths if p.endswith(".json")}
    problems = []

    missing = sorted(set(ROWS_FIELD) - set(by_route))
    if missing:
        problems.append(f"no payload for {missing} — a console route with no payload "
                        f"renders an empty table, which is a different claim")

    versions = {}
    for route, path in sorted(by_route.items()):
        field = ROWS_FIELD.get(route)
        if field is None:
            problems.append(f"{route}.json is not a read-model route")
            continue
        with open(path, encoding="utf-8") as fh:
            payload = json.load(fh)
        if not isinstance(payload.get(field), list):
            problems.append(f"{route}.json has no `{field}` array")
        if not isinstance(payload.get("unreachable_repos"), list):
            problems.append(f"{route}.json has no `unreachable_repos` — the plugin's "
                            f"partial-result envelope")
        v = payload.get("corpus_version")
        if not isinstance(v, str) or not v.startswith("corpus:"):
            problems.append(f"{route}.json carries no corpus_version")
        else:
            versions.setdefault(v, []).append(route)

    if len(versions) > 1:
        problems.append(f"the payloads span {len(versions)} corpora: "
                        f"{ {v: rs for v, rs in versions.items()} } — the read point "
                        f"every proposal names would be a lie whichever one you picked")

    # ⛔ The route with history.
    env_path = by_route.get("envelopes")
    if env_path:
        with open(env_path, encoding="utf-8") as fh:
            rows = json.load(fh).get("envelopes", [])
        if len(rows) != 1:
            problems.append(
                f"expected exactly 1 empty envelope from envelope-undocumented.ttl, "
                f"got {len(rows)}. ZERO means the route has gone quiet the way the "
                f"gate once did — under ARQ the flat BIND(IF(...))+HAVING form "
                f"admits nothing. Check the query's shape before the fixture.")
        else:
            row = rows[0]
            if row.get("deficit") != 30.0:
                problems.append(f"expected deficit 30.0, got {row.get('deficit')!r}")
            if row.get("recorded") is not False:
                problems.append(
                    f"expected recorded=False (no au:Conflict names this quantity), "
                    f"got {row.get('recorded')!r}")
            if row.get("project") != "smoke":
                problems.append(f"expected project 'smoke', got {row.get('project')!r}")

    if problems:
        print("FAIL — spec_readmodel's output is not what a consumer needs:\n", file=sys.stderr)
        for p in problems:
            print("  * " + p, file=sys.stderr)
        return 1

    only = next(iter(versions))
    print(f"ok    {len(by_route)} payloads, one read point ({only}), "
          f"and the envelopes route found the undocumented infeasibility")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
