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
        ('interpolated executable term', 'def hidden := s!"{(show Nat from by run_tac pure ())}"\n'),
        ('quoted-character declaration hiding', 'def q : Char := \'"\'\nelab_rules : command\ndef close : Char := \'"\'\n'),
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
    # The consumer's measured hints must reach the real pinned compiler. Keep
    # the original independently authored proposition/domain and all controls.
    hinted = dict(sources)
    hinted['Proof.lean'] = b"""set_option maxRecDepth 4096
set_option exponentiation.threshold 4096
def successor (n : Nat) : Nat := n + 1
attribute [local irreducible] successor
set_option maxRecDepth 8192 in
theorem full : 1 + 1 = 2 := by
  have computed : successor 1 = 2 := by unfold successor; rfl
  unfold successor at computed
  exact computed
set_option exponentiation.threshold 4096 in
theorem boundedPower : 2 ^ 12 = 4096 := by decide
theorem populated : Exists (fun n : Nat => n = 0) := Exists.intro 0 rfl
"""
    profiled = type(request)(); profiled.CopyFrom(request)
    profiled.inputs[0].sha256 = digest(hinted['Proof.lean'])
    reviewed = type(review)(); reviewed.CopyFrom(review)
    reviewed.request_sha256 = digest(encoded(profiled))
    certificate = verify(profiled, reviewed, hinted.__getitem__, args.lean, args.schema)
    assert certificate.verified_roots == 1 and len(certificate.executions) == 5
    print('Actual bounded resource/local irreducibility proposition and populated domain passed', flush=True)
    for label, extra in [
        ('attribute-tail initializer', 'attribute [local irreducible] successor initialize do IO.println "hidden"\n'),
        ('attribute-tail modified import', 'attribute [local irreducible] successor public import Lean\n'),
        ('resource-tail checking bypass', 'set_option maxRecDepth 4096; set_option debug.skipKernelTC true\n'),
        ('unreviewed resource bound', 'set_option maxRecDepth 8193\n'),
        ('global reduction attribute', 'attribute [irreducible] successor\n'),
        ('attribute-tail open command', 'attribute [local irreducible] successor open Nat\n'),
        ('attribute-tail namespace command', 'attribute [local irreducible] successor namespace Hidden\n'),
    ]:
        changed = dict(hinted); changed['Proof.lean'] = extra.encode() + hinted['Proof.lean']
        mutant = type(profiled)(); mutant.CopyFrom(profiled)
        mutant.inputs[0].sha256 = digest(changed['Proof.lean'])
        updated = type(reviewed)(); updated.CopyFrom(reviewed)
        updated.request_sha256 = digest(encoded(mutant))
        try: verify(mutant, updated, changed.__getitem__, args.lean, args.schema)
        except ValueError as error:
            if 'unsupported' not in str(error): raise
            print('Rejected source policy ' + label + ' before compilation', flush=True)
        else: raise AssertionError(label + ' incorrectly accepted')
    changed = dict(hinted)
    changed['Proof.lean'] = hinted['Proof.lean'].replace(b'maxRecDepth 4096', b'maxRecDepth 8192')
    try: verify(profiled, reviewed, changed.__getitem__, args.lean, args.schema)
    except ValueError as error:
        if 'stale source' not in str(error): raise
        print('Rejected stale reviewed resource bytes before compilation', flush=True)
    else: raise AssertionError('unbound resource edit incorrectly accepted')
    Path(args.output).write_text(
        'actual kernel baseline and bounded-resource profile, five type/compiler controls, '
        'twelve source-policy controls, and stale-resource binding control passed\n')

if __name__ == '__main__': main()
