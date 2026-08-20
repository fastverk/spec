"""The derivation, held to the corpus — both directions (spec#45).

What green means: over ampere as committed (seven conflicts open), every
order is HELD and every hold is a live conflict the order's closure or
direct record actually reaches; over ampere with INV-03 adjudicated, wo-042
— whose ONE hold reached INV-03 through the federal-reliability leg of its
closure — derives READY, and wo-046, held three more ways, does not. That
asymmetry is the done-bar at the derivation layer: adjudication releases
exactly the orders the conflict alone was holding.

Also held here: mechanism 2 on the wire (binding ⇔ rung R4+, non-binding
obligations carry their named stall), the packet's internal consistency, and
the as_of cursor moving when the corpus does.
"""

import json
import pathlib
import re
import unittest

AMP = "https://ampere.example/corpus#"


def load(name):
    for root in (pathlib.Path("corpus/ampere"), pathlib.Path("_main/corpus/ampere")):
        p = root / (name + ".json")
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8"))
    raise FileNotFoundError(name)


def by_id(payload):
    return {o["order_id"]: o for o in payload["orders"]}


class Committed(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.orders = by_id(load("workorders"))

    def test_the_four_named_orders_derive(self):
        self.assertEqual(sorted(self.orders), ["wo-041", "wo-042", "wo-046", "wo-057"])

    def test_every_order_is_held_because_the_world_is(self):
        # Seven conflicts are open and closure touch is honest — the
        # transcript's READY column described a cleaner world than this
        # corpus. If this ever fails toward READY, either conflicts were
        # adjudicated (update me with the new truth) or a hold source went
        # quiet (find out which before shipping).
        for oid, o in self.orders.items():
            self.assertEqual(o["state_code"], "WORK_ORDER_STATE_HELD", oid)
            self.assertTrue(o["order"]["conflict_holds"], oid)

    def test_wo042_is_held_by_inv03_alone(self):
        self.assertEqual(self.orders["wo-042"]["order"]["conflict_holds"],
                         [AMP + "INV-03"])

    def test_wo041_direct_hold_and_closure_holds_union(self):
        self.assertEqual(self.orders["wo-041"]["order"]["conflict_holds"],
                         [AMP + "INV-03", AMP + "INV-05", AMP + "INV-11"])

    def test_binding_iff_r4_plus(self):
        for o in self.orders.values():
            for ob in o["order"]["obligations"]:
                self.assertEqual(ob["binding"], ob["rung"] in ("R4", "R5"),
                                 ob["claim"])

    def test_nonbinding_obligations_name_their_stall(self):
        # Mechanism 2's other half: R0-R3 arrive marked non-binding — and a
        # non-binding obligation without a named blocker is exactly the
        # unnamed stall the ladder gate refuses in the corpus itself.
        for o in self.orders.values():
            for ob in o["order"]["obligations"]:
                if not ob["binding"]:
                    self.assertTrue(ob["stalled_on"], ob["claim"])

    def test_packet_consistency(self):
        for oid, o in self.orders.items():
            order = o["order"]
            self.assertEqual(o["obligation_count"], len(order["obligations"]), oid)
            self.assertRegex(order["as_of"], r"^sha256:[0-9a-f]{16}$")
            self.assertEqual(order["write_capability"]["spec_ops"], ["assertNS@R0"])
            self.assertTrue(order["write_capability"]["artifact_paths"], oid)
            # forbidden and writable must not overlap — an order forbidden
            # its own write paths is a config typo, caught here not at
            # dispatch.
            overlap = set(order["forbidden"]) & set(
                order["write_capability"]["artifact_paths"])
            self.assertEqual(overlap, set(), oid)
            # binding obligations sort first: the packet reads obligations
            # before context.
            bindings = [ob["binding"] for ob in order["obligations"]]
            self.assertEqual(bindings, sorted(bindings, reverse=True), oid)

    def test_obligations_span_disciplines(self):
        # "ALL disciplines" is the point of the closure: the warranty-scoped
        # order must arrive carrying more than warranty's own claims.
        wo41 = self.orders["wo-041"]["order"]
        disciplines = {ob["discipline"] for ob in wo41["obligations"] if ob["binding"]}
        self.assertGreater(len(disciplines), 1, sorted(disciplines))


class Inv03Resolved(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.committed = by_id(load("workorders"))
        cls.resolved = by_id(load("workorders_inv03_resolved"))

    def test_wo042_releases_to_ready(self):
        o = self.resolved["wo-042"]
        self.assertEqual(o["state_code"], "WORK_ORDER_STATE_READY")
        self.assertEqual(o["order"]["conflict_holds"], [])
        self.assertEqual(o["state"], "READY")

    def test_wo046_loses_only_inv03(self):
        before = self.committed["wo-046"]["order"]["conflict_holds"]
        after = self.resolved["wo-046"]["order"]["conflict_holds"]
        self.assertIn(AMP + "INV-03", before)
        self.assertEqual(after, [c for c in before if c != AMP + "INV-03"])
        self.assertTrue(after)

    def test_obligations_do_not_move_with_adjudication(self):
        # Resolving a conflict changes what may DISPATCH, never what is
        # OWED — the closure is scope-driven and the corpus's claims did not
        # change.
        for oid in self.committed:
            self.assertEqual(
                [ob["claim"] for ob in self.committed[oid]["order"]["obligations"]],
                [ob["claim"] for ob in self.resolved[oid]["order"]["obligations"]],
                oid)

    def test_as_of_moves_with_the_corpus(self):
        self.assertNotEqual(self.committed["wo-042"]["order"]["as_of"],
                            self.resolved["wo-042"]["order"]["as_of"])


class UnrungedParty(unittest.TestCase):
    """The fail-open control: a claim with no au:rung still holds its order.

    See corpus/ampere/fixtures-unrunged-party.ttl. When bindings.rq made
    au:rung mandatory, such a claim was in no closure and therefore in no
    live-conflict intersection, so an OPEN conflict stopped holding the order
    and it derived READY. Every gate stayed green; the committed test passed;
    the dispatch gate failed open. This is the assertion that fails if the
    rung ever becomes mandatory again.
    """

    @classmethod
    def setUpClass(cls):
        cls.base = by_id(load("workorders"))
        cls.with_unrunged = by_id(load("workorders_unrunged"))

    def test_the_unrunged_claim_is_in_the_closure(self):
        before = {ob["claim"] for ob in self.base["wo-042"]["order"]["obligations"]}
        after = {ob["claim"] for ob in self.with_unrunged["wo-042"]["order"]["obligations"]}
        self.assertEqual(after - before, {AMP + "mkt-quiet-hours"})

    def test_it_binds_nothing_because_it_has_no_rung(self):
        ob = next(o for o in self.with_unrunged["wo-042"]["order"]["obligations"]
                  if o["claim"] == AMP + "mkt-quiet-hours")
        self.assertEqual(ob["rung"], "")
        self.assertFalse(ob["binding"])
        # And it says why, rather than arriving as an unnamed stall.
        self.assertIn("no au:rung", ob["stalled_on"])

    def test_and_its_open_conflict_holds_the_order(self):
        # THE POINT. INV-05 is open and wo-042 does not otherwise touch it.
        self.assertNotIn(AMP + "INV-05", self.base["wo-042"]["order"]["conflict_holds"])
        self.assertIn(AMP + "INV-05", self.with_unrunged["wo-042"]["order"]["conflict_holds"])
        self.assertEqual(self.with_unrunged["wo-042"]["state_code"],
                         "WORK_ORDER_STATE_HELD")


class Glossary(unittest.TestCase):
    """au:disjointQuantity is symmetric, and the packet must carry both ends.

    rdf_dataset concatenates files and runs no entailment, so matching only the
    asserted direction handed the lexically-later member of every registered
    pair an EMPTY disjoint set — silently merging, in the agent's view, exactly
    the two quantities an author had registered as different.
    """

    @classmethod
    def setUpClass(cls):
        cls.orders = by_id(load("workorders"))

    def test_disjointness_is_reported_from_both_ends(self):
        pairs = set()
        for o in self.orders.values():
            for entry in o["order"]["glossary"]:
                for d in entry["disjoint_from"]:
                    pairs.add((entry["quantity"], d))
        self.assertTrue(pairs, "no disjointness registered at all")
        # Every edge present in one direction must be present in the other
        # WHEREVER both quantities appear in the same packet.
        for o in self.orders.values():
            quantities = {e["quantity"]: set(e["disjoint_from"])
                          for e in o["order"]["glossary"]}
            for q, ds in quantities.items():
                for d in ds:
                    if d in quantities:
                        self.assertIn(q, quantities[d],
                                      "%s lists %s but not the reverse" % (q, d))


if __name__ == "__main__":
    unittest.main()
