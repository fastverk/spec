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
            original = ledger.receipts[0].SerializeToString()
            self.assertEqual(run("run").returncode, 0)
            ledger = A.parse(receipts, E.EvidenceLedger())
            self.assertEqual(len(ledger.receipts), 2)
            self.assertEqual(ledger.receipts[0].SerializeToString(), original)
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


if __name__ == "__main__":
    unittest.main()
