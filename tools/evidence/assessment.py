"""One evaluator for typed consumer evidence; no domain predicate is copied here."""
import hashlib
import json
import re
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path

from google.protobuf import json_format
from spec.v1 import evidence_pb2 as E
from spec.v1 import invariant_pb2 as I

DIMENSIONS = tuple(range(E.EVIDENCE_DIMENSION_APPROVAL, E.EVIDENCE_DIMENSION_PRODUCTION_ACCEPTANCE + 1))
EXECUTABLE = {E.EVIDENCE_DIMENSION_IMPLEMENTATION, E.EVIDENCE_DIMENSION_TEST, E.EVIDENCE_DIMENSION_PROOF}
HEX256 = re.compile(r"[0-9a-f]{64}\Z")
HEX160 = re.compile(r"[0-9a-f]{40}\Z")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def evaluator_hash():
    return digest(Path(__file__).read_bytes() + E.DESCRIPTOR.serialized_pb + I.DESCRIPTOR.serialized_pb)


def parse(path, message):
    return json_format.Parse(Path(path).read_text(), message)


def render(message):
    return json_format.MessageToJson(message, preserving_proto_field_name=True, always_print_fields_with_no_presence=True) + "\n"


def head(root):
    return subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()


def bound_file(item, roots):
    if item.repository not in roots:
        raise ValueError("missing named checkout: " + item.repository)
    root = Path(roots[item.repository]).resolve(strict=True)
    relative = Path(item.path)
    if not item.path or relative.is_absolute() or ".." in relative.parts:
        raise ValueError("input must be a repository-relative file: " + item.path)
    path = (root / relative).resolve(strict=True)
    if not path.is_relative_to(root) or not path.is_file():
        raise ValueError("input escapes checkout or is not a file: " + item.path)
    return path


def validate(manifest):
    if manifest.schema_version != 1 or not manifest.requirements:
        raise ValueError("schema_version 1 and a nonempty requirement inventory are required")
    ids = set()
    names = set()
    for requirement in manifest.requirements:
        if not requirement.id or not requirement.owner or not requirement.sources:
            raise ValueError("requirement needs stable id, owner, and source inputs")
        for name in [requirement.id, *requirement.aliases]:
            if not name or name in names:
                raise ValueError("duplicate requirement identity or alias: " + name)
            names.add(name)
        ids.add(requirement.id)
        validate_inputs(requirement.sources)
    check_ids = set()
    for check in manifest.checks:
        if not check.id or check.id in check_ids or check.requirement_id not in ids:
            raise ValueError("duplicate check or unknown requirement: " + check.id)
        check_ids.add(check.id)
        if check.dimension not in DIMENSIONS:
            raise ValueError("check must name an independent evidence dimension")
        if not check.check.locator or check.check.kind == I.CHECK_KIND_UNSPECIFIED:
            raise ValueError("check needs an owned locator and kind")
        if not check.working_repository or not check.inputs or not check.toolchain_id:
            raise ValueError("check needs working repository, inputs, and toolchain identity")
        if check.dimension in EXECUTABLE and not check.argv:
            raise ValueError("executable check needs a command argument vector")
        if check.timeout_seconds > 7200:
            raise ValueError("check timeout exceeds 7200 seconds")
        validate_inputs(check.inputs)
        if check.working_repository not in {item.repository for item in check.inputs}:
            raise ValueError("working repository must be among the declared inputs")


def validate_inputs(inputs):
    seen = set()
    for item in inputs:
        key = (item.repository, item.path)
        if not item.repository or not item.path or key in seen or not HEX256.fullmatch(item.sha256):
            raise ValueError("inputs require unique repository/path identities and lowercase SHA-256")
        seen.add(key)
        if item.freshness not in (E.FRESHNESS_POLICY_CONTENT, E.FRESHNESS_POLICY_EXACT_REVISION):
            raise ValueError("each input needs an explicit freshness policy")
        if item.freshness == E.FRESHNESS_POLICY_EXACT_REVISION and not HEX160.fullmatch(item.revision):
            raise ValueError("exact-revision input requires a full commit SHA")
        if item.revision and not HEX160.fullmatch(item.revision):
            raise ValueError("input revision must be a full commit SHA")


def definition_hash(requirement, check):
    return digest(requirement.SerializeToString(deterministic=True) + check.SerializeToString(deterministic=True))


def expected_inputs(requirement, check):
    # A model-only proof can deliberately use content freshness; implementation
    # inputs are not silently added to a proof's dependency set.
    return [*requirement.sources, *check.inputs]


def inspect_inputs(items, roots):
    bound = []
    for item in items:
        path = bound_file(item, roots)
        revision = head(roots[item.repository])
        if digest(path.read_bytes()) != item.sha256:
            raise ValueError("input bytes changed: " + item.repository + ":" + item.path)
        if item.freshness == E.FRESHNESS_POLICY_EXACT_REVISION:
            if revision != item.revision:
                raise ValueError("input revision changed: " + item.repository)
            dirty = subprocess.check_output(["git", "-C", str(roots[item.repository]), "status", "--porcelain", "--untracked-files=all"], text=True)
            if dirty.strip():
                raise ValueError("exact-revision checkout is dirty: " + item.repository)
        copy = E.EvidenceInput()
        copy.CopyFrom(item)
        copy.revision = revision
        bound.append(copy)
    return bound


def observation_state(observation):
    if observation.skipped:
        if observation.outcome != I.OUTCOME_UNSPECIFIED or observation.population.count:
            raise ValueError("skipped observation cannot also claim an evaluation")
        return E.EVIDENCE_STATE_SKIPPED
    if observation.outcome == I.OUTCOME_CANNOT_BE_GROUNDED:
        if not observation.ungrounded_terms:
            raise ValueError("ungrounded observation must identify unresolved terms")
        return E.EVIDENCE_STATE_UNGROUNDED
    if observation.ungrounded_terms:
        raise ValueError("unresolved terms cannot accompany a decided outcome")
    if observation.outcome == I.OUTCOME_FAILS:
        return E.EVIDENCE_STATE_FAILED
    if observation.outcome == I.OUTCOME_VACUOUS:
        if observation.population.count:
            raise ValueError("vacuous observation must have an empty population")
        return E.EVIDENCE_STATE_VACUOUS
    if observation.outcome not in (I.OUTCOME_PASSES, I.OUTCOME_EXAMINED):
        raise ValueError("observation has no supported outcome")
    if not observation.population.count:
        return E.EVIDENCE_STATE_VACUOUS
    if not HEX256.fullmatch(observation.population.query_fingerprint):
        raise ValueError("nonempty evaluation requires the predicate/population fingerprint")
    try:
        evaluated = datetime.fromisoformat(observation.population.evaluated_at.replace("Z", "+00:00"))
        if evaluated.tzinfo is None:
            raise ValueError("evaluation timestamp needs a timezone")
    except ValueError as exc:
        raise ValueError("nonempty evaluation requires an ISO-8601 timestamp with timezone") from exc
    return E.EVIDENCE_STATE_CURRENT if observation.outcome == I.OUTCOME_PASSES else E.EVIDENCE_STATE_EXAMINED


def execute(requirement, check, roots, evaluator_revision, run_uri=""):
    if check.dimension not in EXECUTABLE:
        raise ValueError("review dimensions cannot be established by executing a test")
    inputs = inspect_inputs(expected_inputs(requirement, check), roots)
    receipt = E.EvidenceReceipt(
        id=str(uuid.uuid4()), check_id=check.id,
        definition_sha256=definition_hash(requirement, check),
        evaluator_sha256=evaluator_hash(), evaluator_revision=evaluator_revision,
        inputs=inputs, executed_at=datetime.now(timezone.utc).isoformat(), run_uri=run_uri,
        execution_state=E.EVIDENCE_STATE_FAILED,
    )
    try:
        result = subprocess.run(list(check.argv), cwd=roots[check.working_repository], capture_output=True, timeout=check.timeout_seconds or 300, check=False)
        receipt.observation_artifact_sha256 = digest(result.stdout)
        if result.returncode == 0:
            json_format.Parse(result.stdout.decode(), receipt.observation)
            receipt.execution_state = observation_state(receipt.observation)
            receipt.observation_sha256 = digest(receipt.observation.SerializeToString(deterministic=True))
        # Recheck after execution, including HEAD and dirty exact-revision inputs.
        # A producer cannot mutate its own predicate and retain the old receipt.
        after = inspect_inputs(expected_inputs(requirement, check), roots)
        if [x.SerializeToString() for x in after] != [x.SerializeToString() for x in inputs]:
            receipt.execution_state = E.EVIDENCE_STATE_STALE
    except (ValueError, OSError, subprocess.SubprocessError, json_format.ParseError):
        receipt.execution_state = E.EVIDENCE_STATE_FAILED
    return receipt


def assess_check(requirement, check, receipt, roots, evaluator_revision):
    assessment = E.EvidenceCheckAssessment(check_id=check.id, state=E.EVIDENCE_STATE_MISSING)
    if receipt is None:
        assessment.reasons.append("no receipt")
        return assessment
    assessment.receipt_id = receipt.id
    assessment.population.CopyFrom(receipt.observation.population)
    if (receipt.definition_sha256 != definition_hash(requirement, check)
            or receipt.evaluator_sha256 != evaluator_hash()
            or receipt.evaluator_revision != evaluator_revision):
        assessment.state = E.EVIDENCE_STATE_STALE
        assessment.reasons.append("requirement, check, or evaluator changed")
        return assessment
    try:
        current = inspect_inputs(expected_inputs(requirement, check), roots)
        if len(current) != len(receipt.inputs):
            raise ValueError("receipt input set differs")
        for now, then in zip(current, receipt.inputs):
            if (now.repository, now.path, now.sha256, now.freshness) != (then.repository, then.path, then.sha256, then.freshness):
                raise ValueError("receipt input binding differs")
            if now.freshness == E.FRESHNESS_POLICY_EXACT_REVISION and now.revision != then.revision:
                raise ValueError("receipt revision differs")
        if receipt.execution_state != E.EVIDENCE_STATE_CURRENT:
            if receipt.execution_state not in range(E.EVIDENCE_STATE_STALE, E.EVIDENCE_STATE_EXAMINED + 1):
                raise ValueError("receipt has no terminal execution state")
            assessment.state = receipt.execution_state
        else:
            if receipt.observation_sha256 != digest(receipt.observation.SerializeToString(deterministic=True)):
                raise ValueError("receipt missing observation fingerprint")
            assessment.state = observation_state(receipt.observation)
    except (ValueError, OSError, subprocess.SubprocessError) as exc:
        assessment.state = E.EVIDENCE_STATE_STALE
        assessment.reasons.append(str(exc))
    return assessment


def assess(manifest, ledger, roots, evaluator_revision, selected=()):
    validate(manifest)
    if ledger.schema_version != 1:
        raise ValueError("ledger schema_version must be 1")
    latest = {}
    receipt_ids = set()
    checks = {check.id: check for check in manifest.checks}
    for receipt in ledger.receipts:
        if not receipt.id or receipt.id in receipt_ids:
            raise ValueError("duplicate or missing receipt identity")
        receipt_ids.add(receipt.id)
        latest[receipt.check_id] = receipt
    selected = set(selected) if selected else set(checks)
    if not selected or selected - checks.keys():
        raise ValueError("selection must name a nonempty set of known checks")
    report = E.EvidenceReport(schema_version=1, ready=True, selected_checks_passed=True, selected_check_count=len(selected))
    for requirement in manifest.requirements:
        row = report.requirements.add(requirement_id=requirement.id, ready=True)
        for dimension in DIMENSIONS:
            group = row.dimensions.add(dimension=dimension, state=E.EVIDENCE_STATE_MISSING)
            for check in manifest.checks:
                if check.requirement_id == requirement.id and check.dimension == dimension:
                    result = assess_check(requirement, check, latest.get(check.id), roots, evaluator_revision)
                    group.checks.append(result)
                    if check.id in selected and result.state != E.EVIDENCE_STATE_CURRENT:
                        report.selected_checks_passed = False
            if group.checks:
                # Every check in a dimension must pass; one current receipt must
                # never hide a missing, stale, or failed sibling obligation.
                group.state = next((c.state for c in group.checks if c.state != E.EVIDENCE_STATE_CURRENT), E.EVIDENCE_STATE_CURRENT)
            if group.state != E.EVIDENCE_STATE_CURRENT:
                row.ready = False
        if not row.ready:
            report.ready = False
    return report
