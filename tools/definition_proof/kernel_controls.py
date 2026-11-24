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
    Path(args.output).write_text('actual kernel baseline and five rejection controls passed\n')

if __name__ == '__main__': main()
