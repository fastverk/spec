"""Run real Lean against counterfeit declarations and mismatched propositions."""
import argparse
from pathlib import Path
from tools.definition_proof.verifier_test import fixture
from tools.definition_proof.verify import digest, encoded, verify

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--lean', required=True)
    parser.add_argument('--schema', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    request, review, sources = fixture()
    certificate = verify(request, review, sources.__getitem__, args.lean, args.schema)
    assert certificate.verified_roots == 1 and len(certificate.executions) == 5
    print('Actual baseline proposition and populated-domain witness passed', flush=True)
    for label, field, value in [
        ('fabricated declaration', 'theorem', 'fabricated'),
        ('wrong true theorem', 'theorem', 'True.intro'),
        ('empty-domain substitution', 'domain_witness', 'True.intro'),
        ('wrong compiler', 'lean_git_revision', '0'*40),
    ]:
        mutant = type(request)(); mutant.CopyFrom(request); setattr(mutant, field, value)
        updated = type(review)(); updated.CopyFrom(review); updated.request_sha256 = digest(encoded(mutant))
        try: verify(mutant, updated, sources.__getitem__, args.lean, args.schema)
        except ValueError: print('Rejected actual ' + label, flush=True)
        else: raise AssertionError(label + ' incorrectly accepted')
    changed = dict(sources)
    changed['Expected.lean'] = sources['Expected.lean'].replace(b'1 + 1 = 2', b'1 + 1 = 3')
    mutant = type(request)(); mutant.CopyFrom(request)
    mutant.inputs[1].sha256 = digest(changed['Expected.lean'])
    updated = type(review)(); updated.CopyFrom(review); updated.request_sha256 = digest(encoded(mutant))
    try: verify(mutant, updated, changed.__getitem__, args.lean, args.schema)
    except ValueError: print('Rejected actual changed expected proposition', flush=True)
    else: raise AssertionError('changed proposition incorrectly accepted')
    for label, extra in [
        ('modified untrusted import', 'public import Lean\n'),
        ('elaboration rules', 'elab_rules : command\n'),
        ('elaboration attribute', '@[command_elab hidden] def hidden := 0\n'),
    ]:
        changed = dict(sources); changed['Proof.lean'] = (extra + sources['Proof.lean'].decode()).encode()
        mutant = type(request)(); mutant.CopyFrom(request)
        mutant.inputs[0].sha256 = digest(changed['Proof.lean'])
        updated = type(review)(); updated.CopyFrom(review); updated.request_sha256 = digest(encoded(mutant))
        try: verify(mutant, updated, changed.__getitem__, args.lean, args.schema)
        except ValueError as error:
            if 'unsupported' not in str(error): raise
            print('Rejected source policy ' + label + ' before compilation', flush=True)
        else: raise AssertionError(label + ' incorrectly accepted')
    Path(args.output).write_text('actual kernel baseline, five type/compiler controls, and three source-policy controls passed\n')

if __name__ == '__main__': main()
