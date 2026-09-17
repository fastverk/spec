"""The derived packet, checked from consumer position (spec#45).

spec's own ampere_fanout_test proves the derivation against the corpus it
ships. This proves the same machinery reaches a CONSUMER: the macro, its five
queries, the assembler binary and its python toolchain all resolve across the
repo boundary, and what comes out is a packet whose obligations, holds and
capability are the ones the fixture implies.
"""

import json
import pathlib
import unittest

FX = "https://aion.savvi.io/fixture/envelope-clean#"


def payload():
    for root in (pathlib.Path("fanout"), pathlib.Path("_main/fanout"), pathlib.Path(".")):
        p = root / "workorders.json"
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8"))
    raise FileNotFoundError("workorders.json")


class ConsumerFanout(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rows = payload()["orders"]

    def test_one_order_derives(self):
        self.assertEqual([r["order_id"] for r in self.rows], ["wo-smoke-oem"])

    def test_the_coherent_fixture_derives_ready(self):
        # Every conflict in envelope-clean.ttl is adjudicated by au:Narrow, so
        # no hold is live and the order dispatches. If this ever reads HELD,
        # either the fixture stopped being the negative control or the
        # liveness rule started treating history as a hold.
        self.assertEqual(self.rows[0]["state_code"], "WORK_ORDER_STATE_READY")
        self.assertEqual(self.rows[0]["order"]["conflict_holds"], [])

    def test_the_closure_crosses_disciplines(self):
        # scope-oem closes upward over scope-rto: an order cut at the warranty
        # scope must arrive carrying the market obligation binding it, which
        # is the whole claim of RFC-002 §10 mechanism 1.
        obligations = self.rows[0]["order"]["obligations"]
        self.assertGreaterEqual(len(obligations), 2)
        scopes_covered = {o["discipline"] for o in obligations}
        self.assertGreater(len(scopes_covered), 1, sorted(scopes_covered))

    def test_binding_matches_the_ladder(self):
        for o in self.rows[0]["order"]["obligations"]:
            self.assertEqual(o["binding"], o["rung"] in ("R4", "R5"), o["claim"])

    def test_capability_and_cursor_are_carried(self):
        order = self.rows[0]["order"]
        self.assertEqual(order["write_capability"]["artifact_paths"], ["src/thermal/**"])
        self.assertEqual(order["write_capability"]["spec_ops"], ["assertNS@R0"])
        self.assertEqual(order["forbidden"], ["src/market/**"])
        self.assertRegex(order["as_of"], r"^sha256:[0-9a-f]{16}$")
        self.assertEqual(order["budget"], {"max_tokens": 500000, "max_probes": 5})


if __name__ == "__main__":
    unittest.main()
