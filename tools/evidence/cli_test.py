import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from spec.v1 import evidence_pb2 as E
from spec.v1 import invariant_pb2 as I
from tools.evidence import assessment as A

BINARY = Path(sys.argv.pop(1)).resolve()


class CliTest(unittest.TestCase):
    def test_append_assess_staleness_and_unknown_selection(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            consumer = root / "consumer"
            consumer.mkdir()
            def git(*args):
                return subprocess.check_output(["git", "-C", str(consumer), *args], text=True).strip()
            git("init", "-q")
            git("config", "user.name", "Fixture")
            git("config", "user.email", "fixture@example.invalid")
            (consumer / "source.md").write_text("An owned obligation\n")
            observation = {"outcome": "OUTCOME_PASSES", "population": {"count": "1", "query_fingerprint": "a" * 64, "evaluated_at": "2026-11-23T12:00:00Z"}}
            (consumer / "predicate.py").write_text("print(" + repr(json.dumps(observation)) + ")\n")
            git("add", ".")
            git("commit", "-qm", "Consumer fixture")
            revision = git("rev-parse", "HEAD")
            def bound(path):
                return E.EvidenceInput(repository="consumer", path=path, sha256=A.digest((consumer / path).read_bytes()), revision=revision, freshness=E.FRESHNESS_POLICY_EXACT_REVISION)
            manifest = E.EvidenceManifest(schema_version=1)
            requirement = manifest.requirements.add(id="OWNED-1", owner="Consumer", sources=[bound("source.md")])
            manifest.checks.add(id="owned-test", requirement_id=requirement.id, dimension=E.EVIDENCE_DIMENSION_TEST,
                check=I.Check(kind=I.CHECK_KIND_TEST, locator="predicate.py"), working_repository="consumer",
                argv=[sys.executable, "predicate.py"], inputs=[bound("predicate.py")], toolchain_id="fixture-python")
            path = root / "manifest.json"
            path.write_text(A.render(manifest))
            receipts = root / "receipts.json"
            def run(mode, *extra):
                return subprocess.run([str(BINARY), mode, "--manifest", str(path), "--receipts", str(receipts),
                    "--checkout", "consumer=" + str(consumer), *extra], env={**os.environ, "BUILD_WORKSPACE_DIRECTORY": str(consumer)}, text=True, capture_output=True)
            first = run("run")
            self.assertEqual(first.returncode, 0, first.stderr)
            report = json.loads(first.stdout)
            self.assertTrue(report["selected_checks_passed"])
            self.assertFalse(report["ready"])
            ledger = A.parse(receipts, E.EvidenceLedger())
            self.assertEqual(len(ledger.receipts), 2)
            self.assertEqual([r.execution_state for r in ledger.receipts],
                             [E.EVIDENCE_STATE_PENDING, E.EVIDENCE_STATE_CURRENT])
            original = [r.SerializeToString() for r in ledger.receipts]
            self.assertEqual(run("run").returncode, 0)
            ledger = A.parse(receipts, E.EvidenceLedger())
            self.assertEqual(len(ledger.receipts), 4)
            self.assertEqual([r.SerializeToString() for r in ledger.receipts[:2]], original)
            before = receipts.read_bytes()
            self.assertEqual(run("assess").returncode, 0)
            self.assertEqual(receipts.read_bytes(), before)
            self.assertEqual(run("run", "--check", "unknown").returncode, 2)
            self.assertEqual(receipts.read_bytes(), before)
            (consumer / "source.md").write_text("Changed obligation\n")
            stale = run("assess")
            self.assertEqual(stale.returncode, 1, stale.stderr)
            self.assertIn("EVIDENCE_STATE_STALE", stale.stdout)
            self.assertEqual(receipts.read_bytes(), before)


    def test_explicit_review_plan_append_idempotency_and_conflicting_retry(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary); consumer = root / "consumer"; consumer.mkdir()
            def git(*args):
                return subprocess.check_output(["git", "-C", str(consumer), *args], text=True).strip()
            for args in [("init", "-q"), ("config", "user.name", "Review fixture"), ("config", "user.email", "fixture@example.invalid")]:
                git(*args)
            (consumer / "source.md").write_text("Synthetic review source.\n")
            git("add", "."); git("commit", "-qm", "Review fixture")
            source = E.EvidenceInput(repository="consumer", path="source.md",
                sha256=A.digest((consumer / "source.md").read_bytes()), freshness=E.FRESHNESS_POLICY_CONTENT)
            manifest = E.EvidenceManifest(schema_version=1)
            manifest.requirements.add(id="OWNED-1", owner="Fixture", sources=[source])
            manifest.checks.add(id="human-grounding", requirement_id="OWNED-1", dimension=E.EVIDENCE_DIMENSION_GROUNDING,
                check=I.Check(kind=I.CHECK_KIND_QUERY, locator="source.md"), working_repository="consumer",
                inputs=[source], toolchain_id="explicit-human-review")
            path = root / "manifest.json"; path.write_text(A.render(manifest))
            receipts = root / "receipts.json"; receipts.write_text(A.render(E.EvidenceLedger(schema_version=1)))
            initial = receipts.read_bytes()
            def run(mode, *extra):
                return subprocess.run([str(BINARY), mode, "--manifest", str(path), "--receipts", str(receipts),
                    "--checkout", "consumer=" + str(consumer), "--check", "human-grounding", *extra],
                    env={**os.environ, "BUILD_WORKSPACE_DIRECTORY": str(consumer)}, text=True, capture_output=True)
            self.assertEqual(run("run").returncode, 2)
            self.assertEqual(receipts.read_bytes(), initial)
            for target in [receipts, path, receipts.with_suffix(receipts.suffix + ".lock")]:
                before = path.read_bytes(), receipts.read_bytes()
                self.assertEqual(run("review-plan", "--output", str(target)).returncode, 2)
                self.assertEqual((path.read_bytes(), receipts.read_bytes()), before)
            proposed = run("review-plan"); self.assertEqual(proposed.returncode, 0, proposed.stderr)
            decision = E.EvidenceReviewDecision(); A.json_format.Parse(proposed.stdout, decision)
            self.assertEqual(decision.verdict, E.EVIDENCE_REVIEW_VERDICT_UNSPECIFIED)
            self.assertFalse(decision.reviewer or decision.reviewed_at)
            self.assertEqual(receipts.read_bytes(), initial)
            artifact = root / "decision.json"; artifact.write_text(A.render(decision))
            self.assertEqual(run("review", "--decision", str(artifact)).returncode, 2)
            self.assertEqual(receipts.read_bytes(), initial)
            decision.origin = E.EVIDENCE_REVIEW_ORIGIN_EXPLICIT_HUMAN
            decision.verdict = E.EVIDENCE_REVIEW_VERDICT_ACCEPTED
            decision.reviewer = "Human fixture reviewer"
            decision.reviewed_at = "2026-11-23T12:00:00Z"
            decision.source_uri = "fixture:explicit-human-decision"
            decision.statement = "I confirm the synthetic source reference."
            decision.population.CopyFrom(I.Population(count=1, query_fingerprint="b"*64, evaluated_at=decision.reviewed_at))
            artifact.write_text(A.render(decision))
            accepted = run("review", "--decision", str(artifact)); self.assertEqual(accepted.returncode, 0, accepted.stderr)
            ledger = A.parse(receipts, E.EvidenceLedger()); self.assertEqual(len(ledger.receipts), 1)
            self.assertEqual(ledger.receipts[0].review, decision)
            accepted_bytes = receipts.read_bytes()
            self.assertEqual(run("review", "--decision", str(artifact)).returncode, 0)
            self.assertEqual(receipts.read_bytes(), accepted_bytes)
            decision.statement = "A different decision cannot reuse the identity."
            artifact.write_text(A.render(decision))
            self.assertEqual(run("review", "--decision", str(artifact)).returncode, 2)
            self.assertEqual(receipts.read_bytes(), accepted_bytes)
            self.assertEqual(run("assess").returncode, 0)
            self.assertEqual(receipts.read_bytes(), accepted_bytes)
            (consumer / "source.md").write_text("Changed actual source.\n")
            self.assertEqual(run("assess").returncode, 1)
            self.assertEqual(receipts.read_bytes(), accepted_bytes)


if __name__ == "__main__":
    unittest.main()
