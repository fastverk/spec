"""Real process failures and interrupted history cannot masquerade as a pass."""
import json
import os
import signal
import stat
import subprocess
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from spec.v1 import evidence_pb2 as E
from tools.evidence import assessment as A
from tools.evidence import assessment_test as fixtures
from tools.evidence import execution as X

BINARY = Path(sys.argv.pop(1)).resolve()


class ExecutionTest(unittest.TestCase):
    setUp = fixtures.EvidenceTest.setUp
    git = fixtures.EvidenceTest.git
    commit = fixtures.EvidenceTest.commit
    input = fixtures.EvidenceTest.input
    write_producer = fixtures.EvidenceTest.write_producer
    run_check = fixtures.EvidenceTest.run_check
    assess = fixtures.EvidenceTest.assess
    state = fixtures.EvidenceTest.state

    def prepare(self, source):
        (self.root / 'predicate.py').write_text(source + '\n')
        self.commit()
        self.check.inputs[0].CopyFrom(self.input('predicate.py', E.FRESHNESS_POLICY_EXACT_REVISION))

    def record(self, receipt):
        return X.Store(self.artifacts).record(receipt.execution_record)

    def stdout(self, record):
        return X.Store(self.artifacts).read(record.stdout).read_bytes()

    def test_nonzero_exit_retains_both_streams_without_parsing_a_plausible_pass(self):
        value = {'outcome': 'OUTCOME_PASSES', 'population': {'count': '1',
            'query_fingerprint': 'f'*64, 'evaluated_at': '2026-11-23T12:00:00Z'}}
        self.prepare('import sys\nprint(' + repr(json.dumps(value)) + ')\n'
                     "sys.stderr.write('PRIVATE_EXECUTION_FIXTURE\\n')\nraise SystemExit(7)")
        receipt = self.run_check(); record = self.record(receipt)
        self.assertEqual(record.exit_code, 7)
        self.assertEqual(record.termination, E.EVIDENCE_PROCESS_TERMINATION_EXITED)
        self.assertEqual(self.stdout(record), (json.dumps(value)+'\n').encode())
        self.assertEqual(X.Store(self.artifacts).read(record.stderr).read_bytes(), b'PRIVATE_EXECUTION_FIXTURE\n')
        self.assertFalse(receipt.HasField('observation'))
        self.assertEqual(self.state(self.assess()), E.EVIDENCE_STATE_FAILED)
        self.assertNotIn('PRIVATE_EXECUTION_FIXTURE', A.render(self.assess()))
        self.assertEqual([r.execution_state for r in self.ledger.receipts], [E.EVIDENCE_STATE_PENDING, E.EVIDENCE_STATE_FAILED])

    def test_invalid_utf8_json_unknown_fields_and_empty_stdout_keep_original_bytes(self):
        for raw in [b'\xff', b'not json', b'{"unrecognized":true}', b'']:
            with self.subTest(raw=raw):
                self.prepare('import os\nos.write(1, ' + repr(raw) + ')')
                receipt = self.run_check(); record = self.record(receipt)
                self.assertEqual(self.stdout(record), raw)
                self.assertGreater(record.diagnostic.byte_size, 0)
                self.assertFalse(receipt.HasField('observation'))
                self.assertEqual(self.state(self.assess()), E.EVIDENCE_STATE_FAILED)

    def test_missing_executable_has_no_fabricated_process_exit(self):
        self.check.argv[:] = [str(Path(self.temporary.name) / 'no-such-command')]
        receipt = self.run_check(); record = self.record(receipt)
        self.assertEqual(record.termination, E.EVIDENCE_PROCESS_TERMINATION_SPAWN_ERROR)
        self.assertFalse(record.HasField('exit_code'))
        self.assertFalse(record.HasField('executable'))
        self.assertIn(b'FileNotFoundError', X.Store(self.artifacts).read(record.diagnostic).read_bytes())
        self.assertEqual(self.state(self.assess()), E.EVIDENCE_STATE_FAILED)

    def test_timeout_retains_partial_output_and_stops_child_and_grandchild_effects(self):
        ready = Path(self.temporary.name) / 'grandchild-ready'; effect = ready.with_name('late-effect')
        grandchild = f"from pathlib import Path; import time; Path({str(ready)!r}).write_text('ready'); time.sleep(2); Path({str(effect)!r}).write_text('unexpected')"
        child = 'import subprocess,sys,time; subprocess.Popen([sys.executable,"-c",' + repr(grandchild) + ']); time.sleep(30)'
        self.prepare('import subprocess,sys,time\nsubprocess.Popen([sys.executable,"-c",' + repr(child) + '])\n'
                     'print("flushed partial stdout",flush=True)\nprint("flushed partial stderr",file=sys.stderr,flush=True)\ntime.sleep(30)')
        self.check.timeout_seconds = 1
        receipt = self.run_check(); record = self.record(receipt)
        self.assertTrue(ready.exists(), 'The grandchild must actually start for this control')
        self.assertEqual(record.termination, E.EVIDENCE_PROCESS_TERMINATION_TIMED_OUT)
        self.assertEqual(record.exit_code, -signal.SIGKILL)
        self.assertIn(b'flushed partial stdout', self.stdout(record))
        self.assertIn(b'flushed partial stderr', X.Store(self.artifacts).read(record.stderr).read_bytes())
        time.sleep(1.2)
        self.assertFalse(effect.exists())
        self.assertEqual(self.state(self.assess()), E.EVIDENCE_STATE_FAILED)

    def test_output_record_executable_and_diagnostic_tampering_are_rejected(self):
        receipt = self.run_check(); record = self.record(receipt); store = X.Store(self.artifacts)
        for binding in [record.stdout, record.stderr, record.diagnostic, record.executable,
                        record.start_record, receipt.execution_record]:
            with self.subTest(path=binding.path):
                path = store.read(binding); original = path.read_bytes()
                path.write_bytes(original+b'planted alteration')
                self.assertEqual(self.state(self.assess()), E.EVIDENCE_STATE_STALE)
                path.write_bytes(original)
        self.assertTrue(self.assess().selected_checks_passed)

    def test_missing_artifact_and_missing_start_history_cannot_pass(self):
        receipt = self.run_check(); record = self.record(receipt)
        path = X.Store(self.artifacts).read(record.stdout); path.unlink()
        self.assertFalse(self.assess().selected_checks_passed)
        receipt = self.run_check()
        self.assertFalse(self.assess().selected_checks_passed, 'A retry cannot hide missing earlier output')
        del self.ledger.receipts[-2]
        self.assertFalse(self.assess().selected_checks_passed)

    def test_self_consistent_unknown_record_fields_are_rejected(self):
        receipt = self.run_check(); path = X.Store(self.artifacts).read(receipt.execution_record)
        path.write_bytes(path.read_bytes()+b'\x98\x06\x01')  # Unknown field99, not an authorized schema extension.
        receipt.execution_record.CopyFrom(X.Store(self.artifacts).binding(path))
        self.ledger.receipts[-1].CopyFrom(receipt)
        self.assertFalse(self.assess().selected_checks_passed)

    def test_substituted_other_execution_record_is_rejected(self):
        first = self.run_check(); second = self.run_check()
        self.ledger.receipts[-1].execution_record.CopyFrom(first.execution_record)
        self.assertNotEqual(first.id, second.id)
        self.assertFalse(self.assess().selected_checks_passed)

    def test_private_permissions_and_symlink_escape_are_enforced(self):
        receipt = self.run_check(); record = self.record(receipt)
        self.assertEqual(stat.S_IMODE(self.artifacts.stat().st_mode), 0o700)
        path = X.Store(self.artifacts).read(record.stderr)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        path.chmod(0o644)
        self.assertFalse(self.assess().selected_checks_passed)
        path.chmod(0o600)
        outside = Path(self.temporary.name) / 'outside'; path.rename(outside); path.symlink_to(outside)
        self.assertFalse(self.assess().selected_checks_passed)

    def test_changed_inputs_after_durable_start_refuse_command_launch(self):
        effect = Path(self.temporary.name) / 'must-not-run'
        self.prepare('from pathlib import Path\nPath(' + repr(str(effect)) + ').write_text("unexpected")')
        def started(receipt):
            self.ledger.receipts.append(receipt)
            (self.root / 'requirement.md').write_text('Changed before launch')
        receipt = A.execute(self.requirement, self.check, self.roots, self.revision,
            artifact_root=self.artifacts, on_started=started)
        self.ledger.receipts.append(receipt)
        record = self.record(receipt)
        self.assertEqual(record.termination, E.EVIDENCE_PROCESS_TERMINATION_NOT_STARTED)
        self.assertFalse(record.HasField('exit_code'))
        self.assertEqual(receipt.execution_state, E.EVIDENCE_STATE_STALE)
        self.assertFalse(effect.exists())

    def test_source_mutation_and_actual_executable_mutation_are_stale(self):
        self.prepare("from pathlib import Path\nPath('requirement.md').write_text('changed source')\nprint('{}')")
        self.run_check()
        self.assertEqual(self.state(self.assess()), E.EVIDENCE_STATE_STALE)
        # Restore and bind a separate command whose own executable mutates.
        (self.root / 'requirement.md').write_text('Preserve the complete envelope.\n')
        self.write_producer(); self.commit()
        self.requirement.sources[0].CopyFrom(self.input('requirement.md', E.FRESHNESS_POLICY_CONTENT))
        self.check.inputs[0].CopyFrom(self.input('predicate.py', E.FRESHNESS_POLICY_EXACT_REVISION))
        executable = Path(self.temporary.name) / 'owned-command'
        value = {'outcome':'OUTCOME_PASSES','population':{'count':'1','query_fingerprint':'a'*64,'evaluated_at':'2026-11-23T12:00:00Z'}}
        executable.write_text('#!/bin/sh\nprintf "\\n# changed executable\\n" >> "$0"\nprintf \'%s\\n\' \'' + json.dumps(value) + '\'\n')
        executable.chmod(0o700); self.check.argv[:] = [str(executable)]
        receipt = self.run_check()
        self.assertEqual(receipt.execution_state, E.EVIDENCE_STATE_STALE)
        self.assertEqual(self.state(self.assess()), E.EVIDENCE_STATE_STALE)

    def test_failed_final_storage_leaves_pending_after_previous_genuine_pass(self):
        self.run_check(); original = [r.SerializeToString() for r in self.ledger.receipts]
        write = X.Store.write
        def fail_complete(store, directory, name, data):
            if name == 'complete.pb':
                raise OSError('Injected full-disk fixture')
            return write(store, directory, name, data)
        with patch.object(X.Store, 'write', fail_complete), self.assertRaises(OSError):
            self.run_check()
        self.assertEqual([r.SerializeToString() for r in self.ledger.receipts[:2]], original)
        self.assertEqual(len(self.ledger.receipts), 3)
        self.assertEqual(self.state(self.assess()), E.EVIDENCE_STATE_PENDING)
        self.assertFalse(self.assess().selected_checks_passed)

    def cli(self, mode, *extra, env=None):
        base = Path(self.temporary.name)
        manifest = base / 'manifest.json'; manifest.write_text(A.render(self.manifest))
        return [str(BINARY), mode, '--manifest', str(manifest), '--receipts', str(base/'receipts.json'),
                '--checkout', 'consumer='+str(self.root), *extra], {**os.environ,
                'BUILD_WORKSPACE_DIRECTORY':str(self.root), **(env or {})}

    def wait_file(self, path, process):
        deadline = time.monotonic()+10
        while time.monotonic()<deadline:
            if path.exists():
                return
            if process.poll() is not None:
                self.fail('CLI terminated before the real process handshake')
            time.sleep(0.02)
        self.fail('No actual producer handshake')

    def interrupted_cli(self, signum):
        base = Path(self.temporary.name); ready = base/'producer-ready'; effect = base/'after-cancellation'
        grandchild = f"from pathlib import Path; import time; time.sleep(2); Path({str(effect)!r}).write_text('unexpected')"
        original = (self.root/'predicate.py').read_text()
        prefix = ('import os,sys,time,subprocess\nfrom pathlib import Path\n'
                  "if os.environ.get('WAIT_EXECUTION_FIXTURE'):\n"
                  ' subprocess.Popen([sys.executable,"-c",'+repr(grandchild)+'])\n'
                  ' Path('+repr(str(ready))+').write_text(str(os.getpid()))\n'
                  ' print("partial private output",flush=True)\n time.sleep(30)\n')
        self.prepare(prefix+original)
        argv, env = self.cli('run')
        first = subprocess.run(argv, env=env, capture_output=True)
        self.assertEqual(first.returncode,0,first.stderr)
        before = A.parse(base/'receipts.json', E.EvidenceLedger())
        self.assertEqual(len(before.receipts),2)
        later = self.manifest.checks.add(); later.CopyFrom(self.check); later.id='zz-later-check'
        later.argv[:] = [sys.executable,'-c',f"from pathlib import Path; Path({str(effect)!r}).write_text('later command')"]
        argv, env = self.cli('run',env={'WAIT_EXECUTION_FIXTURE':'1'})
        process = subprocess.Popen(argv,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        producer = None
        try:
            self.wait_file(ready,process); producer=int(ready.read_text())
            process.send_signal(signum); stdout,stderr=process.communicate(timeout=10)
            self.assertEqual(process.returncode,128+signum if signum!=signal.SIGKILL else -signal.SIGKILL,stderr)
            if signum==signal.SIGKILL:
                # A hard kill cannot run a cancellation handler; the test reaps its owned group.
                try: os.killpg(producer,signal.SIGKILL)
                except ProcessLookupError: pass
            after=A.parse(base/'receipts.json',E.EvidenceLedger())
            self.assertEqual([r.SerializeToString() for r in after.receipts[:2]], [r.SerializeToString() for r in before.receipts])
            self.assertEqual(len(after.receipts),3 if signum==signal.SIGKILL else 4)
            self.assertFalse(any(r.check_id=='zz-later-check' for r in after.receipts))
            if signum!=signal.SIGKILL:
                store=X.Store(base/'receipts.json.executions'); record=store.record(after.receipts[-1].execution_record)
                self.assertEqual(record.termination,E.EVIDENCE_PROCESS_TERMINATION_CANCELLED)
                self.assertEqual(record.exit_code,-signal.SIGKILL)
            argv, env = self.cli('assess','--check',self.check.id)
            assessed=subprocess.run(argv,env=env,capture_output=True)
            self.assertEqual(assessed.returncode,1,assessed.stderr)
            self.assertIn(b'EVIDENCE_STATE_PENDING' if signum==signal.SIGKILL else b'EVIDENCE_STATE_FAILED',assessed.stdout)
            self.assertNotIn(b'partial private output',assessed.stdout)
            time.sleep(2.1);self.assertFalse(effect.exists())
        finally:
            if process.poll() is None: process.kill()
            process.communicate(timeout=10)
            if producer:
                try: os.killpg(producer,signal.SIGKILL)
                except ProcessLookupError: pass

    def test_cli_sigterm_records_failure_and_stops_later_checks(self):
        self.interrupted_cli(signal.SIGTERM)

    def test_cli_sigint_records_failure_and_stops_later_checks(self):
        self.interrupted_cli(signal.SIGINT)

    def test_cli_hard_interruption_keeps_pending_instead_of_reviving_old_pass(self):
        self.interrupted_cli(signal.SIGKILL)

    def test_cli_refuses_artifact_overlaps_and_symlink_roots_before_execution(self):
        for root in [self.root,Path(self.temporary.name)]:
            argv,env=self.cli('run','--execution-artifacts',str(root))
            result=subprocess.run(argv,env=env,capture_output=True)
            self.assertEqual(result.returncode,2,result.stderr)
            self.assertFalse((Path(self.temporary.name)/'receipts.json').exists())
        target=Path(self.temporary.name)/'private-target';target.mkdir(mode=0o700)
        link=target.with_name('artifact-link');link.symlink_to(target,target_is_directory=True)
        argv,env=self.cli('run','--execution-artifacts',str(link))
        self.assertEqual(subprocess.run(argv,env=env,capture_output=True).returncode,2)


if __name__ == '__main__':
    unittest.main()
