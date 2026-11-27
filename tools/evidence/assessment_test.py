import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from spec.v1 import evidence_pb2 as E
from spec.v1 import invariant_pb2 as I
from tools.evidence import assessment as A


class EvidenceTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "consumer"
        self.root.mkdir()
        self.artifacts = Path(self.temporary.name) / "executions"
        self.git("init", "-q")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("config", "user.name", "Evidence fixture")
        (self.root / "requirement.md").write_text("Preserve the complete envelope.\n")
        (self.root / "model.lean").write_text("-- consumer-owned formal model\n")
        self.write_producer()
        self.commit()
        self.roots = {"consumer": self.root}
        self.manifest = E.EvidenceManifest(schema_version=1)
        self.requirement = self.manifest.requirements.add(id="RFC-0041/audit-envelope", owner="Consumer maintainers")
        self.requirement.sources.append(self.input("requirement.md", E.FRESHNESS_POLICY_CONTENT))
        self.check = self.manifest.checks.add(
            id="audit-envelope-test", requirement_id=self.requirement.id,
            dimension=E.EVIDENCE_DIMENSION_TEST,
            check=I.Check(kind=I.CHECK_KIND_TEST, locator="owned-test"),
            working_repository="consumer", argv=[sys.executable, "predicate.py"],
            toolchain_id="fixture-python", inputs=[self.input("predicate.py", E.FRESHNESS_POLICY_EXACT_REVISION)],
        )
        self.ledger = E.EvidenceLedger(schema_version=1)
        self.revision = "a" * 40
        A.validate(self.manifest)

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.root), *args], text=True).strip()

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-qm", "Consumer fixture")

    def input(self, path, policy):
        return E.EvidenceInput(repository="consumer", path=path,
            sha256=A.digest((self.root / path).read_bytes()),
            revision=self.git("rev-parse", "HEAD") if policy == E.FRESHNESS_POLICY_EXACT_REVISION else "",
            freshness=policy)

    def write_producer(self, *, count=2, outcome="OUTCOME_PASSES", terms=(), skipped=False):
        observation = {"outcome": outcome, "population": {"count": count,
            "query_fingerprint": "b" * 64, "evaluated_at": "2026-11-23T12:00:00Z"},
            "ungrounded_terms": list(terms), "skipped": skipped}
        (self.root / "predicate.py").write_text("print(" + repr(json.dumps(observation)) + ")\n")

    def run_check(self):
        receipt = A.execute(self.requirement, self.check, self.roots, self.revision, artifact_root=self.artifacts, on_started=self.ledger.receipts.append)
        self.ledger.receipts.append(receipt)
        return receipt

    def assess(self):
        return A.assess(self.manifest, self.ledger, self.roots, self.revision, artifact_root=self.artifacts)

    def state(self, report):
        return report.requirements[0].dimensions[E.EVIDENCE_DIMENSION_TEST - 1].state

    def test_current_test_does_not_establish_other_dimensions(self):
        self.run_check()
        report = self.assess()
        self.assertTrue(report.selected_checks_passed)
        self.assertFalse(report.ready)
        self.assertEqual(self.state(report), E.EVIDENCE_STATE_CURRENT)
        self.assertEqual(len(report.requirements[0].dimensions), 6)
        self.assertTrue(all(d.state == E.EVIDENCE_STATE_MISSING for d in report.requirements[0].dimensions if d.dimension != E.EVIDENCE_DIMENSION_TEST))

    def test_changed_input_and_changed_requirement_stale_evidence(self):
        self.run_check()
        for file in ("predicate.py", "requirement.md"):
            path = self.root / file
            original = path.read_bytes()
            path.write_bytes(original + b"\n")
            self.assertEqual(self.state(self.assess()), E.EVIDENCE_STATE_STALE)
            path.write_bytes(original)
        self.assertTrue(self.assess().selected_checks_passed)
        self.requirement.owner = "Changed owner"
        self.assertEqual(self.state(self.assess()), E.EVIDENCE_STATE_STALE)

    def test_new_head_stales_exact_binding(self):
        self.run_check()
        (self.root / "unrelated.md").write_text("Unrelated implementation change\n")
        self.commit()
        self.assertEqual(self.state(self.assess()), E.EVIDENCE_STATE_STALE)

    def test_explicit_content_proof_survives_unrelated_implementation_commit(self):
        self.check.dimension = E.EVIDENCE_DIMENSION_PROOF
        self.check.check.kind = I.CHECK_KIND_PROPOSITION
        self.check.inputs[0].CopyFrom(self.input("predicate.py", E.FRESHNESS_POLICY_CONTENT))
        self.check.inputs.append(self.input("model.lean", E.FRESHNESS_POLICY_CONTENT))
        self.run_check()
        (self.root / "unrelated.md").write_text("Another implementation commit\n")
        self.commit()
        self.assertTrue(self.assess().selected_checks_passed)
        (self.root / "model.lean").write_text("-- changed formal assumption\n")
        self.assertFalse(self.assess().selected_checks_passed)

    def test_check_toolchain_and_evaluator_changes_stale_receipt(self):
        self.run_check()
        self.check.toolchain_id = "different-python"
        self.assertEqual(self.state(self.assess()), E.EVIDENCE_STATE_STALE)
        self.check.toolchain_id = "fixture-python"
        self.revision = "c" * 40
        self.assertEqual(self.state(self.assess()), E.EVIDENCE_STATE_STALE)

    def test_zero_ungrounded_examined_skipped_and_failure_are_not_passes(self):
        cases = [(0, "OUTCOME_PASSES", (), False, E.EVIDENCE_STATE_VACUOUS),
                 (0, "OUTCOME_VACUOUS", (), False, E.EVIDENCE_STATE_VACUOUS),
                 (1, "OUTCOME_CANNOT_BE_GROUNDED", ("unresolved",), False, E.EVIDENCE_STATE_UNGROUNDED),
                 (2, "OUTCOME_EXAMINED", (), False, E.EVIDENCE_STATE_EXAMINED),
                 (0, "OUTCOME_UNSPECIFIED", (), True, E.EVIDENCE_STATE_SKIPPED),
                 (2, "OUTCOME_FAILS", (), False, E.EVIDENCE_STATE_FAILED)]
        for count, outcome, terms, skipped, expected in cases:
            with self.subTest(outcome=outcome, skipped=skipped):
                self.write_producer(count=count, outcome=outcome, terms=terms, skipped=skipped)
                self.commit()
                self.check.inputs[0].CopyFrom(self.input("predicate.py", E.FRESHNESS_POLICY_EXACT_REVISION))
                self.run_check()
                self.assertEqual(self.state(self.assess()), expected)
                self.assertFalse(self.assess().selected_checks_passed)

    def test_empty_unknown_malformed_and_nonzero_producer_fail(self):
        for body in ("", "print('{}')", "print('not json')", "print('{\"unknown\": true}')", "raise SystemExit(7)"):
            with self.subTest(body=body):
                (self.root / "predicate.py").write_text(body + "\n")
                self.commit()
                self.check.inputs[0].CopyFrom(self.input("predicate.py", E.FRESHNESS_POLICY_EXACT_REVISION))
                self.run_check()
                self.assertEqual(self.state(self.assess()), E.EVIDENCE_STATE_FAILED)

    def test_latest_failed_receipt_does_not_hide_behind_old_pass(self):
        producer = self.root / "predicate.py"
        producer.write_text("import os\nif os.environ.get('FAIL_EXECUTION_FIXTURE'): raise SystemExit(7)\n" + producer.read_text())
        self.commit()
        self.check.inputs[0].CopyFrom(self.input("predicate.py", E.FRESHNESS_POLICY_EXACT_REVISION))
        first = self.run_check()
        original = [item.SerializeToString() for item in self.ledger.receipts]
        with patch.dict("os.environ", {"FAIL_EXECUTION_FIXTURE": "1"}):
            second = self.run_check()
        self.assertEqual(self.state(self.assess()), E.EVIDENCE_STATE_FAILED)
        self.assertEqual(len(self.ledger.receipts), 4)
        self.assertEqual([item.SerializeToString() for item in self.ledger.receipts[:2]], original)
        self.assertNotEqual(first.id, second.id)

    def test_observation_mutation_is_rejected(self):
        self.run_check()
        self.ledger.receipts[0].observation.population.count += 1
        self.assertFalse(self.assess().selected_checks_passed)

    def test_missing_sibling_and_selection_never_promote_readiness(self):
        self.run_check()
        other = self.manifest.checks.add()
        other.CopyFrom(self.check)
        other.id = "unexecuted-sibling"
        self.assertFalse(self.assess().selected_checks_passed)
        report = A.assess(self.manifest, self.ledger, self.roots, self.revision, [self.check.id], artifact_root=self.artifacts)
        self.assertTrue(report.selected_checks_passed)
        self.assertFalse(report.ready)
        self.assertEqual(self.state(report), E.EVIDENCE_STATE_MISSING)

    def test_escaping_path_duplicate_alias_empty_inventory_and_unknown_selection_refused(self):
        with self.assertRaises(ValueError):
            A.validate(E.EvidenceManifest(schema_version=1))
        self.requirement.aliases.append(self.requirement.id)
        with self.assertRaises(ValueError):
            A.validate(self.manifest)
        del self.requirement.aliases[:]
        with self.assertRaises(ValueError):
            A.assess(self.manifest, self.ledger, self.roots, self.revision, ["unknown"])
        self.check.inputs[0].path = "../escape.py"
        with self.assertRaises(ValueError):
            self.run_check()

    def test_review_dimensions_cannot_be_executed_as_tests(self):
        for dimension in (E.EVIDENCE_DIMENSION_APPROVAL, E.EVIDENCE_DIMENSION_GROUNDING, E.EVIDENCE_DIMENSION_PRODUCTION_ACCEPTANCE):
            self.check.dimension = dimension
            with self.assertRaises(ValueError):
                self.run_check()


if __name__ == "__main__":
    unittest.main()
