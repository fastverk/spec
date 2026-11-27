"""Private, immutable subprocess evidence; no producer output is a human review."""
import hashlib
import os
import shutil
import signal
import stat
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path

from google.protobuf import json_format
from google.protobuf.message import DecodeError
from spec.v1 import evidence_pb2 as E

MAX_OBSERVATION_BYTES = 1024 * 1024
FILES = {'start.pb', 'complete.pb', 'stdout.bin', 'stderr.bin', 'diagnostic.txt', 'executable.bin'}


class Cancelled(KeyboardInterrupt):
    def __init__(self, signum=signal.SIGINT):
        super().__init__('Evidence execution cancelled')
        self.signum = signum
        self.receipt = None


def encoded(value):
    return value.SerializeToString(deterministic=True)


def file_hash(path):
    value = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def valid_uuid(value):
    try:
        return str(uuid.UUID(value)) == value
    except (ValueError, AttributeError):
        return False


def validate_location(root, protected=()):
    root = Path(root).absolute()
    if root.is_symlink():
        raise ValueError('execution artifact root must not be a symlink')
    root = root.resolve()
    for item in protected:
        item = Path(item).resolve()
        if item == root or item.is_relative_to(root) or root.is_relative_to(item):
            raise ValueError('execution artifacts must be separate from protected files')
    return root


class Store:
    def __init__(self, root, *, create=False):
        self.root = validate_location(root)
        if create and not self.root.exists():
            self.root.mkdir(mode=0o700, parents=True)
            sync_directory(self.root.parent)
        self.private(self.root, directory=True)

    @staticmethod
    def private(path, *, directory=False):
        info = path.lstat()
        if (stat.S_ISLNK(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o077
                or (not stat.S_ISDIR(info.st_mode) if directory else not stat.S_ISREG(info.st_mode))):
            raise ValueError('execution artifacts require private owned files and directories')

    def begin(self, identity):
        if not valid_uuid(identity):
            raise ValueError('invalid execution identity')
        directory = self.root / identity
        directory.mkdir(mode=0o700)
        sync_directory(self.root)
        return directory

    def new_file(self, directory, name):
        if directory.parent != self.root or not valid_uuid(directory.name) or name not in FILES:
            raise ValueError('invalid execution artifact name')
        return os.fdopen(os.open(directory / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb')

    def write(self, directory, name, data):
        with self.new_file(directory, name) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        sync_directory(directory)
        return self.binding(directory / name)

    def binding(self, path):
        self.private(path)
        return E.EvidenceArtifactBinding(path=str(path.relative_to(self.root)),
            sha256=file_hash(path), byte_size=path.stat().st_size)

    def read(self, binding):
        relative = Path(binding.path)
        if (relative.is_absolute() or len(relative.parts) != 2
                or not valid_uuid(relative.parts[0]) or relative.parts[1] not in FILES):
            raise ValueError('invalid execution artifact path')
        directory = self.root / relative.parts[0]
        self.private(directory, directory=True)
        path = directory / relative.parts[1]
        self.private(path)
        if not path.resolve().is_relative_to(self.root):
            raise ValueError('execution artifact escapes store')
        if path.stat().st_size != binding.byte_size or file_hash(path) != binding.sha256:
            raise ValueError('execution artifact bytes differ')
        return path

    def record(self, binding):
        path = self.read(binding)
        if path.name not in {'start.pb', 'complete.pb'}:
            raise ValueError('invalid execution record artifact')
        try:
            return E.EvidenceExecutionRecord.FromString(path.read_bytes())
        except DecodeError as exc:
            raise ValueError('invalid execution record protobuf') from exc


def terminate(process):
    # Each command owns a fresh session; kill the whole inherited process group.
    try:
        os.killpg(process.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    process.wait()


def execute(requirement, check, roots, revision, run_uri, artifact_root, on_started):
    from tools.evidence import assessment as A
    if artifact_root is None or not callable(on_started):
        raise ValueError('execution requires a private artifact store and durable start callback')
    inputs = A.inspect_inputs(A.expected_inputs(requirement, check), roots)
    store = Store(artifact_root, create=True)
    identity = str(uuid.uuid4()); directory = store.begin(identity)
    started = datetime.now(timezone.utc).isoformat()
    start = E.EvidenceReceipt(id=str(uuid.uuid4()), check_id=check.id,
        definition_sha256=A.definition_hash(requirement, check),
        evaluator_sha256=A.evaluator_hash(), evaluator_revision=revision,
        inputs=inputs, executed_at=started, run_uri=run_uri,
        execution_state=E.EVIDENCE_STATE_PENDING)
    working = Path(roots[check.working_repository])
    record = E.EvidenceExecutionRecord(schema_version=1, id=identity,
        start_receipt_id=start.id, check_id=check.id,
        definition_sha256=start.definition_sha256, evaluator_sha256=start.evaluator_sha256,
        evaluator_revision=revision, inputs=inputs, argv=check.argv,
        working_repository=check.working_repository, timeout_seconds=check.timeout_seconds or 300,
        started_at=started, phase=E.EVIDENCE_EXECUTION_PHASE_STARTED,
        evidence_state=E.EVIDENCE_STATE_PENDING)
    record.working_revision.repository = check.working_repository
    record.working_revision.revision = A.head(working)
    record.working_revision.tree = subprocess.check_output(['git', '-C', str(working), 'rev-parse', 'HEAD^{tree}'], text=True).strip()
    record.working_dirty = bool(subprocess.check_output(['git', '-C', str(working), 'status', '--porcelain', '--untracked-files=all']))
    start.execution_record.CopyFrom(store.write(directory, 'start.pb', encoded(record)))
    # Caller persists this nonpassing receipt under the ledger's writer lock.
    # If the process dies afterward, an old pass cannot hide the new attempt.
    on_started(start)
    receipt = E.EvidenceReceipt(); receipt.CopyFrom(start)
    receipt.id = str(uuid.uuid4()); receipt.execution_state = E.EVIDENCE_STATE_FAILED
    record.final_receipt_id = receipt.id
    record.start_record.CopyFrom(start.execution_record)
    process = None; diagnostic = b''; cancelled = None; executable = None
    try:
        with store.new_file(directory, 'stdout.bin') as stdout, store.new_file(directory, 'stderr.bin') as stderr:
            try:
                now = A.inspect_inputs(A.expected_inputs(requirement, check), roots)
                if [encoded(x) for x in now] != [encoded(x) for x in inputs]:
                    raise ValueError('source changed before command launch')
                command = check.argv[0]
                located = str((working / command).resolve()) if os.sep in command else shutil.which(command)
                if not located:
                    raise FileNotFoundError('command executable is unavailable: ' + command)
                executable = Path(located).resolve(strict=True)
                record.executable_path = str(executable)
                with executable.open('rb') as source, store.new_file(directory, 'executable.bin') as target:
                    shutil.copyfileobj(source, target)
                    target.flush(); os.fsync(target.fileno())
                record.executable.CopyFrom(store.binding(directory / 'executable.bin'))
                if file_hash(executable) != record.executable.sha256:
                    raise ValueError('executable changed before command launch')
                process = subprocess.Popen(list(check.argv), executable=str(executable), cwd=working,
                    stdout=stdout, stderr=stderr, start_new_session=True)
                try:
                    record.exit_code = process.wait(timeout=record.timeout_seconds)
                    record.termination = E.EVIDENCE_PROCESS_TERMINATION_EXITED
                except subprocess.TimeoutExpired as exc:
                    terminate(process)
                    record.exit_code = process.returncode
                    record.termination = E.EVIDENCE_PROCESS_TERMINATION_TIMED_OUT
                    diagnostic = (type(exc).__name__ + ': ' + str(exc) + '\n').encode()
                except KeyboardInterrupt as exc:
                    cancelled = exc if isinstance(exc, Cancelled) else Cancelled()
                    terminate(process); record.exit_code = process.returncode
                    record.termination = E.EVIDENCE_PROCESS_TERMINATION_CANCELLED
                    diagnostic = ('Caller cancellation signal: ' + str(cancelled.signum) + '\n').encode()
                finally:
                    # A normally exiting leader must not leave background group members.
                    terminate(process)
            except (OSError, ValueError, subprocess.SubprocessError) as exc:
                diagnostic = (type(exc).__name__ + ': ' + str(exc) + '\n').encode()
                if process is None:
                    record.termination = (E.EVIDENCE_PROCESS_TERMINATION_NOT_STARTED
                        if isinstance(exc, ValueError) else E.EVIDENCE_PROCESS_TERMINATION_SPAWN_ERROR)
                    if isinstance(exc, ValueError):
                        receipt.execution_state = E.EVIDENCE_STATE_STALE
            finally:
                stdout.flush(); stderr.flush()
                os.fsync(stdout.fileno()); os.fsync(stderr.fileno())
    except KeyboardInterrupt as exc:
        # Cancellation before launch leaves the already durable pending history.
        if process is not None:
            terminate(process)
        raise exc
    record.stdout.CopyFrom(store.binding(directory / 'stdout.bin'))
    record.stderr.CopyFrom(store.binding(directory / 'stderr.bin'))
    receipt.observation_artifact_sha256 = record.stdout.sha256
    if record.termination == E.EVIDENCE_PROCESS_TERMINATION_EXITED and record.exit_code == 0:
        try:
            path = directory / 'stdout.bin'
            if path.stat().st_size > MAX_OBSERVATION_BYTES:
                raise ValueError('observation exceeds the 1 MiB protocol bound')
            observation = json_format.Parse(path.read_bytes().decode('utf-8'), E.EvidenceObservation())
            state = A.observation_state(observation)
            receipt.observation.CopyFrom(observation); receipt.execution_state = state
            receipt.observation_sha256 = A.digest(encoded(observation))
        except (UnicodeError, ValueError, json_format.ParseError) as exc:
            diagnostic = (type(exc).__name__ + ': ' + str(exc) + '\n').encode()
    try:
        after = A.inspect_inputs(A.expected_inputs(requirement, check), roots)
        if [encoded(x) for x in after] != [encoded(x) for x in inputs]:
            raise ValueError('execution source identities changed')
        if executable is not None and file_hash(executable) != record.executable.sha256:
            raise ValueError('execution executable bytes changed')
    except (OSError, ValueError, subprocess.SubprocessError) as exc:
        receipt.execution_state = E.EVIDENCE_STATE_STALE
        diagnostic += (type(exc).__name__ + ': ' + str(exc) + '\n').encode()
    record.diagnostic.CopyFrom(store.write(directory, 'diagnostic.txt', diagnostic))
    record.completed_at = datetime.now(timezone.utc).isoformat()
    record.phase = E.EVIDENCE_EXECUTION_PHASE_COMPLETED
    record.evidence_state = receipt.execution_state
    record.observation_sha256 = receipt.observation_sha256
    receipt.execution_record.CopyFrom(store.write(directory, 'complete.pb', encoded(record)))
    if cancelled is not None:
        cancelled.receipt = receipt
        raise cancelled
    return receipt


def validate_receipt(receipt, check, artifact_root, history):
    """Recheck raw bytes and lifecycle links; stored state alone proves nothing."""
    from tools.evidence import assessment as A
    if artifact_root is None or not receipt.HasField('execution_record'):
        raise ValueError('executable evidence requires its private execution artifacts')
    store = Store(artifact_root)
    record = store.record(receipt.execution_record)
    known = E.EvidenceExecutionRecord(); known.CopyFrom(record); known.DiscardUnknownFields()
    if encoded(record) != encoded(known):
        raise ValueError('unknown execution record fields')
    if (record.schema_version != 1 or not valid_uuid(record.id)
            or Path(receipt.execution_record.path).parts[0] != record.id
            or record.check_id != receipt.check_id or record.check_id != check.id
            or record.definition_sha256 != receipt.definition_sha256
            or record.evaluator_sha256 != receipt.evaluator_sha256
            or record.evaluator_revision != receipt.evaluator_revision
            or list(record.argv) != list(check.argv)
            or record.working_repository != check.working_repository
            or record.timeout_seconds != (check.timeout_seconds or 300)
            or record.started_at != receipt.executed_at
            or [encoded(x) for x in record.inputs] != [encoded(x) for x in receipt.inputs]
            or record.working_revision.repository != check.working_repository
            or not A.HEX160.fullmatch(record.working_revision.revision)
            or not A.HEX160.fullmatch(record.working_revision.tree)):
        raise ValueError('execution record identity or declared command differs')
    started_at = datetime.fromisoformat(record.started_at.replace('Z', '+00:00'))
    if started_at.tzinfo is None or started_at > datetime.now(timezone.utc):
        raise ValueError('invalid execution start timestamp')
    if record.phase == E.EVIDENCE_EXECUTION_PHASE_STARTED:
        if (Path(receipt.execution_record.path).name != 'start.pb'
                or record.start_receipt_id != receipt.id or record.final_receipt_id
                or record.completed_at or record.termination or record.HasField('exit_code')
                or receipt.execution_state != E.EVIDENCE_STATE_PENDING
                or record.evidence_state != E.EVIDENCE_STATE_PENDING
                or receipt.HasField('observation') or receipt.observation_sha256
                or receipt.observation_artifact_sha256):
            raise ValueError('a pending execution cannot claim a terminal result')
        return
    if (record.phase != E.EVIDENCE_EXECUTION_PHASE_COMPLETED
            or Path(receipt.execution_record.path).name != 'complete.pb'
            or record.final_receipt_id != receipt.id or record.start_receipt_id == receipt.id
            or record.evidence_state != receipt.execution_state):
        raise ValueError('invalid completed execution identity or state')
    completed_at = datetime.fromisoformat(record.completed_at.replace('Z', '+00:00'))
    if completed_at.tzinfo is None or not started_at <= completed_at <= datetime.now(timezone.utc):
        raise ValueError('invalid execution completion timestamp')
    if record.start_receipt_id not in history or receipt.id not in history:
        raise ValueError('completed execution lacks its retained start receipt')
    start_index, start_receipt = history[record.start_receipt_id]
    if start_index >= history[receipt.id][0] or start_receipt.execution_record != record.start_record:
        raise ValueError('execution start history is missing, reordered, or substituted')
    original = store.record(record.start_record)
    expected = E.EvidenceExecutionRecord(); expected.CopyFrom(record)
    for name in ['final_receipt_id', 'completed_at', 'termination', 'exit_code', 'stdout',
                 'stderr', 'diagnostic', 'start_record', 'observation_sha256', 'executable', 'executable_path']:
        expected.ClearField(name)
    expected.phase = E.EVIDENCE_EXECUTION_PHASE_STARTED
    expected.evidence_state = E.EVIDENCE_STATE_PENDING
    if expected != original or start_receipt.id != original.start_receipt_id:
        raise ValueError('completed execution differs from its original start record')
    validate_receipt(start_receipt, check, artifact_root, history)
    paths = {}
    for name, filename in [('stdout', 'stdout.bin'), ('stderr', 'stderr.bin'), ('diagnostic', 'diagnostic.txt')]:
        binding = getattr(record, name)
        if binding.path != record.id + '/' + filename:
            raise ValueError('execution output identity differs')
        paths[name] = store.read(binding)
    if receipt.observation_artifact_sha256 != record.stdout.sha256:
        raise ValueError('receipt stdout fingerprint differs')
    if record.HasField('executable'):
        if record.executable.path != record.id + '/executable.bin' or not Path(record.executable_path).is_absolute():
            raise ValueError('execution executable identity differs')
        store.read(record.executable)
    if record.termination in [E.EVIDENCE_PROCESS_TERMINATION_SPAWN_ERROR, E.EVIDENCE_PROCESS_TERMINATION_NOT_STARTED]:
        if record.HasField('exit_code'):
            raise ValueError('a failed spawn cannot supply an exit code')
    elif record.termination in [E.EVIDENCE_PROCESS_TERMINATION_EXITED,
            E.EVIDENCE_PROCESS_TERMINATION_TIMED_OUT, E.EVIDENCE_PROCESS_TERMINATION_CANCELLED]:
        if not record.HasField('exit_code') or not record.HasField('executable'):
            raise ValueError('started process lacks its actual status or executable')
    else:
        raise ValueError('execution has no supported termination')
    observation = None
    state = E.EVIDENCE_STATE_FAILED
    if record.termination == E.EVIDENCE_PROCESS_TERMINATION_EXITED and record.exit_code == 0:
        try:
            if record.stdout.byte_size > MAX_OBSERVATION_BYTES:
                raise ValueError('observation exceeds protocol bound')
            parsed = json_format.Parse(paths['stdout'].read_bytes().decode('utf-8'), E.EvidenceObservation())
            state = A.observation_state(parsed); observation = parsed
        except (UnicodeError, ValueError, json_format.ParseError):
            if not record.diagnostic.byte_size:
                raise ValueError('invalid observation lacks its diagnostic artifact')
    if observation is None:
        if receipt.HasField('observation') or receipt.observation_sha256 or record.observation_sha256:
            raise ValueError('unsuccessful execution cannot claim a parsed observation')
    elif (receipt.observation != observation
            or receipt.observation_sha256 != A.digest(encoded(observation))
            or record.observation_sha256 != receipt.observation_sha256):
        raise ValueError('receipt observation differs from actual retained stdout')
    if receipt.execution_state != state:
        if receipt.execution_state != E.EVIDENCE_STATE_STALE or not record.diagnostic.byte_size:
            raise ValueError('receipt state differs from actual process and observation')


def validate_history_artifacts(receipt, artifact_root):
    """Retained attempts need intact bytes even after a genuine successful retry."""
    if artifact_root is None:
        raise ValueError('execution history requires its private artifact store')
    store = Store(artifact_root); record = store.record(receipt.execution_record)
    if (record.schema_version != 1 or not valid_uuid(record.id)
            or Path(receipt.execution_record.path).parts[0] != record.id
            or record.check_id != receipt.check_id
            or record.definition_sha256 != receipt.definition_sha256
            or record.evaluator_sha256 != receipt.evaluator_sha256
            or record.evaluator_revision != receipt.evaluator_revision
            or record.evidence_state != receipt.execution_state
            or [encoded(x) for x in record.inputs] != [encoded(x) for x in receipt.inputs]):
        raise ValueError('retained execution history metadata differs')
    if record.phase == E.EVIDENCE_EXECUTION_PHASE_STARTED:
        if record.start_receipt_id != receipt.id or receipt.execution_state != E.EVIDENCE_STATE_PENDING:
            raise ValueError('retained pending history identity differs')
    elif record.phase == E.EVIDENCE_EXECUTION_PHASE_COMPLETED:
        if record.final_receipt_id != receipt.id:
            raise ValueError('retained final history identity differs')
        for name, filename in [('stdout', 'stdout.bin'), ('stderr', 'stderr.bin'),
                               ('diagnostic', 'diagnostic.txt'), ('start_record', 'start.pb')]:
            binding = getattr(record, name)
            if binding.path != record.id + '/' + filename:
                raise ValueError('retained output history identity differs')
            store.read(binding)
        if record.HasField('executable'):
            if record.executable.path != record.id + '/executable.bin':
                raise ValueError('retained executable history identity differs')
            store.read(record.executable)
    else:
        raise ValueError('retained execution history has no supported phase')
