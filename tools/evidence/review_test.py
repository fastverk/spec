"""Explicit human review transport, never executing or inferring a decision."""
import copy
import subprocess
import tempfile
import unittest
from pathlib import Path
from spec.v1 import evidence_pb2 as E
from spec.v1 import invariant_pb2 as I
from tools.evidence import assessment as A


class ReviewTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for args in [('init', '-q'), ('config', 'user.name', 'Review fixture'), ('config', 'user.email', 'fixture@example.invalid')]:
            self.git(*args)
        (self.root / 'requirement.md').write_text('An explicit source referent needs a person.\n')
        (self.root / 'referent.txt').write_text('An actual versioned fixture source.\n')
        self.git('add', '.'); self.git('commit', '-qm', 'Review fixture')
        self.roots = {'consumer': self.root}; self.revision = 'a'*40
        def bound(path):
            return E.EvidenceInput(repository='consumer', path=path,
                sha256=A.digest((self.root/path).read_bytes()), freshness=E.FRESHNESS_POLICY_CONTENT)
        self.manifest = E.EvidenceManifest(schema_version=1)
        self.req = self.manifest.requirements.add(id='OWNED-1', owner='Fixture', sources=[bound('requirement.md')])
        self.check = self.manifest.checks.add(id='source-grounding', requirement_id=self.req.id,
            dimension=E.EVIDENCE_DIMENSION_GROUNDING,
            check=I.Check(kind=I.CHECK_KIND_QUERY, locator='referent.txt'), working_repository='consumer',
            inputs=[bound('referent.txt')], toolchain_id='explicit-human-review')
        A.validate(self.manifest)
        self.decision = A.review_plan(self.req, self.check, self.roots)
        self.decision.origin = E.EVIDENCE_REVIEW_ORIGIN_EXPLICIT_HUMAN
        self.decision.verdict = E.EVIDENCE_REVIEW_VERDICT_ACCEPTED
        self.decision.reviewer = 'Human fixture reviewer'
        self.decision.reviewed_at = '2026-11-23T12:00:00Z'
        self.decision.source_uri = 'fixture:explicit-review'
        self.decision.statement = 'I confirm this fixture source reference.'
        self.decision.population.CopyFrom(I.Population(count=1, query_fingerprint='b'*64, evaluated_at=self.decision.reviewed_at))

    def git(self, *args):
        return subprocess.check_output(['git', '-C', str(self.root), *args], text=True).strip()

    def receipt(self, decision=None):
        return A.record_review(self.req, self.check, decision or self.decision, self.roots, self.revision)

    def assess(self, receipt):
        ledger = E.EvidenceLedger(schema_version=1, receipts=[receipt])
        return A.assess(self.manifest, ledger, self.roots, self.revision, [self.check.id])

    def test_plan_never_decides_or_supplies_a_person_or_time(self):
        plan = A.review_plan(self.req, self.check, self.roots)
        self.assertEqual(plan.verdict, E.EVIDENCE_REVIEW_VERDICT_UNSPECIFIED)
        self.assertEqual(plan.origin, E.EVIDENCE_REVIEW_ORIGIN_UNSPECIFIED)
        self.assertFalse(plan.reviewer or plan.reviewed_at or plan.source_uri or plan.statement or plan.population.count)
        with self.assertRaises(ValueError): self.receipt(plan)

    def test_actual_review_is_current_only_in_its_own_dimension(self):
        receipt = self.receipt(); report = self.assess(receipt)
        self.assertTrue(report.selected_checks_passed)
        self.assertFalse(report.ready)
        dimensions = report.requirements[0].dimensions
        self.assertEqual(next(x for x in dimensions if x.dimension == E.EVIDENCE_DIMENSION_GROUNDING).state, E.EVIDENCE_STATE_CURRENT)
        self.assertTrue(all(x.state == E.EVIDENCE_STATE_MISSING for x in dimensions if x.dimension != E.EVIDENCE_DIMENSION_GROUNDING))
        self.assertEqual(receipt.review, self.decision)
        self.assertEqual(receipt.observation.population.evaluated_at, self.decision.reviewed_at)

    def test_review_is_rejected_for_all_executable_and_unknown_dimensions(self):
        for dimension in [0, 3, 4, 5, 99]:
            check = copy.deepcopy(self.check); check.dimension = dimension
            with self.subTest(dimension=dimension), self.assertRaises(ValueError): A.review_plan(self.req, check, self.roots)
            with self.subTest(dimension=dimension), self.assertRaises(ValueError): A.record_review(self.req, check, self.decision, self.roots, self.revision)

    def test_review_never_runs_a_check_command(self):
        self.check.argv.extend(['touch', str(self.root/'must-not-exist')])
        with self.assertRaises(ValueError): self.receipt()
        self.assertFalse((self.root/'must-not-exist').exists())

    def test_run_still_refuses_every_review_dimension(self):
        for dimension in A.REVIEWABLE:
            check = copy.deepcopy(self.check); check.dimension = dimension
            with self.subTest(dimension=dimension), self.assertRaises(ValueError): A.execute(self.req, check, self.roots, self.revision)

    def test_empty_default_missing_identity_and_unknown_decisions_fail(self):
        for field in ['schema_version', 'id', 'check_id', 'definition_sha256', 'dimension', 'origin', 'verdict', 'reviewer', 'reviewed_at', 'source_uri', 'statement', 'inputs', 'population']:
            bad = copy.deepcopy(self.decision); bad.ClearField(field)
            with self.subTest(field=field), self.assertRaises(ValueError): self.receipt(bad)
        for field in ['origin', 'verdict']:
            bad = copy.deepcopy(self.decision); setattr(bad, field, 99)
            with self.subTest(field=field), self.assertRaises(ValueError): self.receipt(bad)

    def test_zero_scope_missing_fingerprint_or_different_scope_time_fail(self):
        for field, value in [('count', 0), ('query_fingerprint', ''), ('evaluated_at', '2026-11-24T12:00:00Z')]:
            bad = copy.deepcopy(self.decision); setattr(bad.population, field, value)
            with self.subTest(field=field), self.assertRaises(ValueError): self.receipt(bad)

    def test_future_unzoned_and_malformed_time_fail(self):
        for stamp in ['9999-01-01T00:00:00Z', '2026-11-23T12:00:00', 'not-a-time']:
            bad = copy.deepcopy(self.decision); bad.reviewed_at = stamp; bad.population.evaluated_at = stamp
            with self.subTest(stamp=stamp), self.assertRaises(ValueError): self.receipt(bad)

    def test_changed_definition_and_changed_or_missing_inputs_fail(self):
        bad = copy.deepcopy(self.decision); bad.definition_sha256 = '0'*64
        with self.assertRaises(ValueError): self.receipt(bad)
        for mutation in ['omit', 'hash', 'extra']:
            bad = copy.deepcopy(self.decision)
            if mutation == 'omit': del bad.inputs[-1]
            elif mutation == 'hash': bad.inputs[0].sha256 = '0'*64
            else: bad.inputs.add().CopyFrom(bad.inputs[0])
            with self.subTest(mutation=mutation), self.assertRaises(ValueError): self.receipt(bad)

    def test_source_drift_stales_existing_review_and_refuses_revival(self):
        receipt = self.receipt()
        (self.root/'referent.txt').write_text('Changed actual source.\n')
        self.assertFalse(self.assess(receipt).selected_checks_passed)
        with self.assertRaises(ValueError): self.receipt()

    def test_unrelated_commit_respects_explicit_content_freshness(self):
        receipt = self.receipt(); (self.root/'unrelated.txt').write_text('Unrelated.\n')
        self.git('add', '.'); self.git('commit', '-qm', 'Unrelated fixture change')
        self.assertTrue(self.assess(receipt).selected_checks_passed)

    def test_rejected_review_remains_nonpassing(self):
        decision = copy.deepcopy(self.decision); decision.verdict = E.EVIDENCE_REVIEW_VERDICT_REJECTED
        receipt = self.receipt(decision)
        self.assertEqual(receipt.execution_state, E.EVIDENCE_STATE_FAILED)
        self.assertFalse(self.assess(receipt).selected_checks_passed)

    def test_flat_current_receipt_cannot_manufacture_review(self):
        receipt = self.receipt(); receipt.ClearField('review')
        report = self.assess(receipt)
        self.assertFalse(report.selected_checks_passed)
        self.assertEqual(report.requirements[0].dimensions[1].state, E.EVIDENCE_STATE_STALE)

    def test_counterfeit_receipt_observation_or_review_fails_assessment(self):
        for mutation in ['verdict', 'population', 'review-input', 'artifact', 'observation-hash', 'state']:
            receipt = self.receipt()
            if mutation == 'verdict': receipt.review.verdict = E.EVIDENCE_REVIEW_VERDICT_REJECTED
            elif mutation == 'population': receipt.observation.population.count += 1
            elif mutation == 'review-input': receipt.review.inputs[0].sha256 = '0'*64
            elif mutation == 'artifact': receipt.observation_artifact_sha256 = '0'*64
            elif mutation == 'observation-hash': receipt.observation_sha256 = '0'*64
            else: receipt.execution_state = E.EVIDENCE_STATE_FAILED
            with self.subTest(mutation=mutation): self.assertFalse(self.assess(receipt).selected_checks_passed)

    def test_duplicate_review_identity_cannot_bypass_the_cli(self):
        first = self.receipt(); second = copy.deepcopy(first); second.id = 'different-receipt-id'
        ledger = E.EvidenceLedger(schema_version=1, receipts=[first, second])
        with self.assertRaises(ValueError): A.assess(self.manifest, ledger, self.roots, self.revision)

    def test_review_field_cannot_masquerade_as_an_executable_proof(self):
        receipt = self.receipt()
        self.check.dimension = E.EVIDENCE_DIMENSION_PROOF
        self.check.check.kind = I.CHECK_KIND_PROPOSITION
        self.check.argv.extend(['python3', 'not-executed.py'])
        receipt.definition_sha256 = A.definition_hash(self.req, self.check)
        self.assertFalse(self.assess(receipt).selected_checks_passed)

if __name__ == '__main__': unittest.main()
