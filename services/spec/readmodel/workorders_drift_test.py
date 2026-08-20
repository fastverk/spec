"""The committed work-order payload matches the derivation that produces it.

⛔ THIS PAYLOAD IS NOT A REPORT. Every other file in this directory is one: a
stale conflicts.json shows an old count and misleads a reader. A stale
workorders.json AUTHORIZES AGENTS — the dispatch door reads it to learn which
orders exist, what holds them and what paths they may write, so a copy taken
before a conflict was raised hands out a READY order the corpus now holds.

The other payloads are emitted outside the build by tools/readmodel/
emit_readmodel.py and nothing checks them. This one is derived BY the build
(//corpus/ampere:workorders), so the check is available — and the first
external consumer is already held to exactly this discipline by its own
//tools/export:drift_test.

    bazel build //corpus/ampere:workorders \\
      && cp bazel-bin/corpus/ampere/workorders.json services/spec/readmodel/

Compared as JSON rather than bytes: key order and indentation are not the
subject, and a red that means "reformatted" teaches people to regenerate
without reading the diff.
"""

import json
import pathlib
import sys
import unittest

ARGS = sys.argv[1:3]


def load(rel):
    for root in (pathlib.Path("."), pathlib.Path("_main")):
        p = root / rel
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8"))
    raise FileNotFoundError(rel)


class NoDrift(unittest.TestCase):
    def test_the_committed_payload_is_what_the_build_derives(self):
        committed = load(ARGS[0])
        derived = load(ARGS[1])
        if committed == derived:
            return
        # Name what moved, because "they differ" sends a reader to a 600-line
        # diff to find out whether an order became dispatchable.
        c = {o["order_id"]: o for o in committed.get("orders", [])}
        d = {o["order_id"]: o for o in derived.get("orders", [])}
        detail = []
        for oid in sorted(set(c) | set(d)):
            if oid not in c:
                detail.append("%s: derived but not committed" % oid)
            elif oid not in d:
                detail.append("%s: committed but no longer derived" % oid)
            elif c[oid] != d[oid]:
                for field in ("state", "obligation_count", "disciplines",
                              "write_capability"):
                    if c[oid].get(field) != d[oid].get(field):
                        detail.append("%s %s: %r -> %r" % (
                            oid, field, c[oid].get(field), d[oid].get(field)))
                if c[oid].get("order", {}).get("conflict_holds") != \
                        d[oid].get("order", {}).get("conflict_holds"):
                    detail.append("%s conflict_holds: %r -> %r" % (
                        oid,
                        c[oid].get("order", {}).get("conflict_holds"),
                        d[oid].get("order", {}).get("conflict_holds")))
                if not detail or detail[-1].split()[0] != oid:
                    detail.append("%s: differs in the packet body" % oid)
        self.fail(
            "services/spec/readmodel/workorders.json has drifted from "
            "//corpus/ampere:workorders.\n  " + "\n  ".join(detail or ["(no field-level summary)"]) +
            "\n\nRegenerate:\n  bazel build //corpus/ampere:workorders && "
            "cp bazel-bin/corpus/ampere/workorders.json services/spec/readmodel/")


if __name__ == "__main__":
    unittest.main(argv=[sys.argv[0]] + sys.argv[3:])
