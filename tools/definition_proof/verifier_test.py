"""Boundary controls; kernel_controls additionally execute the pinned compiler."""
import unittest
from tools.definition_proof.verify import check_source, dependencies, digest, encoded, messages, validate

def fixture():
    pb = messages()
    sources = {
        'Proof.lean': b'theorem full : 1 + 1 = 2 := rfl\ntheorem populated : Exists (fun n : Nat => n = 0) := Exists.intro 0 rfl\n',
        'Expected.lean': b'def expected : Prop := 1 + 1 = 2\ndef domain : Prop := Exists (fun n : Nat => n = 0)\n',
        'claim.md': b'One plus one equals two; inhabited natural-number domain.\n',
    }
    request = pb.DefinitionProofRequest(schema_version=1, claim_id='addition',
        claim_predicate='One plus one equals two.', claim_modality='MUST', model_scope='Natural numbers only.',
        theorem_module='Proof', theorem='full', expected_module='Expected', expected_proposition='expected',
        witness_module='Proof', domain_witness='populated', expected_domain='domain',
        lean_version='4.30.0-rc2', lean_git_revision='3dc1a088b6d2d8eafe25a7cd7ec7b58d731bd7cc')
    for name, data in sources.items():
        request.inputs.add(path=name, sha256=digest(data), module=name[:-5] if name.endswith('.lean') else '')
    review = pb.DefinitionProofReview(schema_version=1, request_sha256=digest(encoded(request)),
        verdict=1, reviewer='fixture semantic review', rationale='Exact natural-number addition and inhabited domain.',
        policy_decision='test fixture only')
    return request, review, sources

class BoundaryTests(unittest.TestCase):
    def test_closed_nonempty_sources(self):
        request, review, sources = fixture()
        self.assertEqual(set(validate(request, review, sources.__getitem__)[0]), {'Proof', 'Expected'})

    def test_stale_source_and_review(self):
        request, review, sources = fixture()
        sources['Proof.lean'] += b'-- edited\n'
        with self.assertRaisesRegex(ValueError, 'stale source'):
            validate(request, review, sources.__getitem__)
        request.claim_id = 'different'
        with self.assertRaisesRegex(ValueError, 'semantic review'):
            validate(request, review, sources.__getitem__)

    def test_hidden_trusted_paths(self):
        for source in ['axiom fake : False', 'theorem fake : False := by sorry',
                       'set_option debug.skipKernelTC true', 'run_cmd pure ()',
                       '#eval 1', '@[implemented_by wrong] def f := 1',
                       'unsafe def f := 1', 'macro "backdoor" : command => pure Syntax.missing']:
            with self.subTest(source=source), self.assertRaises(ValueError):
                check_source(source)
        self.assertEqual(check_source('/- nested /- sorry -/ axiom -/\nimport Std\ndef text := "axiom"'), ['Std'])

    def test_import_and_shadow_rejected(self):
        request, review, sources = fixture()
        sources['Proof.lean'] = b'import Unreviewed\n'
        request.inputs[0].sha256 = digest(sources['Proof.lean'])
        review.request_sha256 = digest(encoded(request))
        with self.assertRaisesRegex(ValueError, 'untrusted import'):
            validate(request, review, sources.__getitem__)
        request.inputs[0].module = 'Std'
        review.request_sha256 = digest(encoded(request))
        with self.assertRaisesRegex(ValueError, 'shadow'):
            validate(request, review, sources.__getitem__)

    def test_dependency_report_not_a_boolean(self):
        self.assertEqual(dependencies("'full' does not depend on any axioms\n", ['full']), [])
        for output in ["'full' depends on axioms: [sorryAx]", '', "'full' depends on axioms: [domainAxiom]"]:
            with self.assertRaises(ValueError): dependencies(output, ['full'])

if __name__ == '__main__':
    unittest.main()
