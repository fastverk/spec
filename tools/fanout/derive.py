"""Assemble work orders from the corpus's own answers — RFC-002 §10, spec#45.

THE BUILD COMPUTES, THE PLUGIN SERVES: every graph question here was already
answered by ARQ (the engine of record, RFC-005) into four TSVs — scoped claims,
the transitive precedes lattice, live conflicts by party, live direct holds.
This module is joins and sorting, deliberately nothing more: stdlib only, no
SPARQL engine, no RDF library, so there is no second engine whose answers
could drift from the gates'.

Per order in the fanout config (scope, id, paths — paths are a repo-layout
fact the corpus cannot know):

  obligations    claims whose scope is in the closure — the order's scope plus
                 everything above and below it on au:precedes. R0–R3 ARRIVE,
                 marked non-binding, with their named stalls; only R4+ binds.
  conflict_holds two sources, unioned: live conflicts whose PARTIES intersect
                 the closure ("an order whose closure touches an open conflict
                 refuses to dispatch"), and live direct au:blocksWorkOrder
                 records naming this order id. Liveness was decided by the
                 queries; this file never re-derives it.
  glossary       the quantities the closure's obligations constrain, with
                 registered disjointness carried along.
  acceptance     the decidable checks the closure's claims name in
                 rfc:evidence, plus the config's own.
  as_of          sha256 over the sorted per-file digests of the corpus
                 sources — content-addressed, so the same corpus derives the
                 same cursor on any machine. (Sorted DIGESTS, not paths:
                 execpath and rootpath name the same file differently, the
                 lesson //tools/export in the first consumer paid for.)
  state          HELD iff conflict_holds is non-empty, else READY — computed,
                 never a human's label. RUNNING/PROMPT_OPEN are the dispatch
                 log's to add, at serve time.

The output is the `workorders` read-model payload: rows_field "orders", flat
panel fields first (order_id, scope, obligation_count, disciplines,
write_capability, state), the full packet nested under "order".
"""

import argparse
import hashlib
import json
import sys

BINDING_RUNGS = {"R4", "R5"}


def read_tsv(path):
    """ARQ TSV: tab-separated, '?name' header, IRIs in <>, literals quoted."""
    with open(path, encoding="utf-8") as f:
        lines = [ln.rstrip("\n") for ln in f if ln.strip()]
    if not lines:
        return []
    header = [h.lstrip("?") for h in lines[0].split("\t")]
    rows = []
    for ln in lines[1:]:
        cells = ln.split("\t")
        row = {}
        for name, cell in zip(header, cells):
            row[name] = _term(cell)
        rows.append(row)
    return rows


def _term(cell):
    cell = cell.strip()
    if not cell:
        return ""
    if cell.startswith("<") and cell.endswith(">"):
        return cell[1:-1]
    if cell.startswith('"'):
        # "literal" or "literal"^^<type> — strip the quotes and any datatype;
        # the corpus's strings contain no embedded tabs, and escaped quotes
        # survive json-style unescaping.
        body = cell.rsplit('"', 1)[0][1:]
        return body.replace('\\"', '"').replace("\\\\", "\\")
    return cell


def local(iri):
    """The fragment a human reads: everything after '#' (or the last '/')."""
    for sep in ("#", "/"):
        if sep in iri:
            return iri.rsplit(sep, 1)[1]
    return iri


def closure_scopes(scope, lattice_rows):
    """The order's scope plus everything above and below it on au:precedes.

    The lattice TSV already carries the TRANSITIVE pairs (au:precedes+), so
    one pass suffices — no walking here, or this file would be a second
    implementation of transitivity that could disagree with ARQ's.
    """
    scopes = {scope}
    for row in lattice_rows:
        if row["narrower"] == scope:
            scopes.add(row["broader"])
        if row["broader"] == scope:
            scopes.add(row["narrower"])
    return scopes


def derive_order(cfg, bindings, lattice, live_parties, direct_holds, as_of):
    scopes = closure_scopes(cfg["scope"], lattice)

    obligations = []
    closure_claims = set()
    for row in bindings:
        if row["scope"] not in scopes:
            continue
        closure_claims.add(row["claim"])
        # A claim with no au:rung is in the closure and BINDS NOTHING. Empty
        # rather than defaulted: "R0" would be a rung nobody recorded, and
        # inventing one is how a non-binding claim becomes citable evidence.
        rung = local(row["rung"]) if row.get("rung") else ""
        obligations.append({
            "claim": row["claim"],
            "rung": rung,
            "binding": rung in BINDING_RUNGS,
            "discipline": row.get("discipline", ""),
            "stalled_on": (
                "" if rung in BINDING_RUNGS
                else (row.get("stalledOn")
                      or ("no au:rung recorded — the claim binds nothing and names no blocker"
                          if not rung else ""))
            ),
        })
    # ⚠ Dedupe BEFORE sorting, and choose deterministically. OPTIONAL evidence
    # and stall multiply one claim into several rows that differ only in which
    # optional fields are bound, so "keep the first" made the packet's
    # discipline and stall depend on ARQ's row order — a field that could
    # change between engine versions with nothing to notice. Keep the most
    # informative row instead: more bound fields wins, ties broken on the
    # values themselves.
    by_claim = {}
    for o in obligations:
        prior = by_claim.get(o["claim"])
        rank = (bool(o["discipline"]), bool(o["stalled_on"]),
                o["discipline"], o["stalled_on"])
        if prior is None or rank > prior[0]:
            by_claim[o["claim"]] = (rank, o)
    # Binding first, then IRI — the packet reads obligations before context.
    obligations = sorted((o for _, o in by_claim.values()),
                         key=lambda o: (not o["binding"], o["claim"]))

    holds = set()
    for row in live_parties:
        if row["party"] in closure_claims:
            holds.add(row["conflict"])
    for row in direct_holds:
        if row["order"] == cfg["order_id"]:
            holds.add(row["conflict"])
    conflict_holds = sorted(holds)

    # ⚠ From a SET, not from the rows: OPTIONAL evidence/stall multiply a claim
    # into several rows, and collecting acceptance per row emitted the same
    # check once per multiplied row — a packet whose acceptance list grew with
    # the corpus's optional metadata rather than with its checks.
    acceptance_seen = set()
    acceptance = []
    for row in bindings:
        ev = row.get("evidence", "")
        if ev and row["claim"] in closure_claims:
            key = (row["claim"], ev)
            if key in acceptance_seen:
                continue
            acceptance_seen.add(key)
            acceptance.append({"check": ev, "source": row["claim"]})
    for check in cfg.get("acceptance", []):
        acceptance.append({"check": check, "source": "config"})
    acceptance.sort(key=lambda a: (a["source"], a["check"]))

    return {
        "order_id": cfg["order_id"],
        "scope": cfg["scope"],
        "obligations": obligations,
        "forbidden": sorted(cfg.get("forbidden", [])),
        "conflict_holds": conflict_holds,
        "acceptance": acceptance,
        "write_capability": {
            "artifact_paths": sorted(cfg.get("write_paths", [])),
            "spec_ops": ["assertNS@R0"],
        },
        "as_of": as_of,
        "discipline": cfg.get("discipline", ""),
        "budget": {
            "max_tokens": int(cfg.get("max_tokens", 0)),
            "max_probes": int(cfg.get("max_probes", 0)),
        },
    }


def glossary_for(order, glossary_rows):
    claims = {o["claim"] for o in order["obligations"]}
    by_quantity = {}
    for row in glossary_rows:
        if row["claim"] not in claims:
            continue
        q = by_quantity.setdefault(row["quantity"], set())
        d = row.get("disjoint", "")
        if d:
            q.add(d)
    return [{"quantity": q, "disjoint_from": sorted(d)}
            for q, d in sorted(by_quantity.items())]


def view(order):
    """The flat panel row plus the nested packet."""
    binding = [o for o in order["obligations"] if o["binding"]]
    per_discipline = {}
    for o in binding:
        key = local(o["discipline"]) if o["discipline"] else "unassigned"
        per_discipline[key] = per_discipline.get(key, 0) + 1
    disciplines = " · ".join(
        "%s %d" % (d.removeprefix("d-"), n)
        for d, n in sorted(per_discipline.items(), key=lambda kv: (-kv[1], kv[0])))
    held = bool(order["conflict_holds"])
    state_code = "WORK_ORDER_STATE_HELD" if held else "WORK_ORDER_STATE_READY"
    state = ("HELD · " + ", ".join(local(c) for c in order["conflict_holds"])
             if held else "READY")
    return {
        "order_id": order["order_id"],
        "scope": local(order["scope"]),
        "obligation_count": len(order["obligations"]),
        "disciplines": disciplines,
        "write_capability": " ".join(order["write_capability"]["artifact_paths"]),
        "state": state,
        "state_code": state_code,
        "agents": 0,
        "order": order,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--bindings", required=True)
    ap.add_argument("--lattice", required=True)
    ap.add_argument("--live-conflicts", dest="live_conflicts", required=True)
    ap.add_argument("--direct-holds", dest="direct_holds", required=True)
    ap.add_argument("--glossary", required=True)
    ap.add_argument("--config", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--ttl", nargs="+", required=True,
                    help="corpus sources, hashed into as_of")
    a = ap.parse_args()

    with open(a.config, encoding="utf-8") as f:
        config = json.load(f)

    digests = sorted(
        hashlib.sha256(open(p, "rb").read()).hexdigest() for p in a.ttl)
    as_of = "sha256:" + hashlib.sha256("".join(digests).encode()).hexdigest()[:16]

    bindings = read_tsv(a.bindings)
    lattice = read_tsv(a.lattice)
    live_parties = read_tsv(a.live_conflicts)
    direct_holds = read_tsv(a.direct_holds)
    glossary_rows = read_tsv(a.glossary)

    # Every scope the config names must EXIST in the corpus. A one-character
    # typo — or the wrong IRI base, which is what the first external consumer
    # actually hit — otherwise derives a fully-formed order with an empty
    # closure and no holds, which reads as READY and dispatchable. A packet
    # that authorizes writes against zero obligations is the worst possible
    # thing to produce silently, so this is a hard failure and not a warning.
    known_scopes = {row["scope"] for row in bindings}
    known_scopes.update(row["broader"] for row in lattice)
    known_scopes.update(row["narrower"] for row in lattice)

    orders = []
    ids = set()
    for cfg in config["orders"]:
        if cfg["order_id"] in ids:
            sys.exit("derive: duplicate order_id %s" % cfg["order_id"])
        ids.add(cfg["order_id"])
        if cfg["scope"] not in known_scopes:
            sys.exit(
                "derive: order %s names scope %s, which no claim carries and no\n"
                "        au:precedes edge mentions. Deriving it would produce an\n"
                "        order with an empty closure that reads as READY.\n"
                "        Scopes this corpus knows:\n          %s"
                % (cfg["order_id"], cfg["scope"],
                   "\n          ".join(sorted(known_scopes)) or "(none)"))
        order = derive_order(cfg, bindings, lattice, live_parties,
                             direct_holds, as_of)
        order["glossary"] = glossary_for(order, glossary_rows)
        orders.append(view(order))

    payload = {"orders": orders, "unreachable_repos": []}
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, sort_keys=True)
        f.write("\n")
    for o in orders:
        print("%-8s %-24s %3d obligations  %s" % (
            o["order_id"], o["scope"], o["obligation_count"], o["state"]),
            file=sys.stderr)


if __name__ == "__main__":
    main()
