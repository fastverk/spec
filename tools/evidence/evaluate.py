"""Execute consumer-owned predicates or assess existing revision-bound receipts."""
import argparse
import fcntl
import os
import signal
import sys
import tempfile
from pathlib import Path

from google.protobuf import json_format
from spec.v1 import evidence_pb2 as E
from tools.evidence import assessment as A


def atomic_write(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as output:
        temporary = Path(output.name)
        output.write(text)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, path)
    A.X.sync_directory(path.parent)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("run", "assess", "review-plan", "review"))
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--receipts", type=Path, required=True)
    parser.add_argument("--checkout", action="append", default=[])
    parser.add_argument("--check", action="append", default=[])
    parser.add_argument("--output", type=Path)
    parser.add_argument("--run-uri", default="")
    parser.add_argument("--execution-artifacts", type=Path, help="Private immutable execution store; defaults beside the ledger")
    parser.add_argument("--decision", type=Path, help="Explicit protobuf-JSON human review decision; never predicate output")
    args = parser.parse_args()
    # A proposal/report must not replace an append-only ledger or its inputs.
    protected = {args.manifest.resolve(), args.receipts.resolve(), args.receipts.with_suffix(args.receipts.suffix + ".lock").resolve()}
    if args.decision:
        if args.decision.resolve() in protected:
            raise ValueError("review decision must be separate from the manifest and ledger")
        protected.add(args.decision.resolve())
    if args.output and args.output.resolve() in protected:
        raise ValueError("output must not overwrite a manifest, ledger, lock, or decision")
    roots = {}
    for item in args.checkout:
        name, separator, path = item.partition("=")
        if not separator or not name or not path or name in roots:
            raise ValueError("checkout requires a unique repository=path")
        roots[name] = Path(path).resolve(strict=True)
    manifest = A.parse(args.manifest, E.EvidenceManifest())
    A.validate(manifest)
    artifact_root = args.execution_artifacts or args.receipts.with_name(args.receipts.name + ".executions")
    protected_artifacts = [*protected, *([args.output] if args.output else [])]
    for requirement in manifest.requirements:
        protected_artifacts.extend(A.bound_file(item, roots) for item in requirement.sources)
    for check in manifest.checks:
        protected_artifacts.extend(A.bound_file(item, roots) for item in check.inputs)
    artifact_root = A.X.validate_location(artifact_root, protected_artifacts)
    revision = A.head(os.environ.get("BUILD_WORKSPACE_DIRECTORY", Path.cwd()))
    args.receipts.parent.mkdir(parents=True, exist_ok=True)
    # Serialize writers around read/execute/append/replace. Assess never edits
    # receipts. No in-place overwrite of earlier receipt entries is performed.
    with args.receipts.with_suffix(args.receipts.suffix + ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX if args.mode in ("run", "review") else fcntl.LOCK_SH)
        ledger = A.parse(args.receipts, E.EvidenceLedger()) if args.receipts.exists() else E.EvidenceLedger(schema_version=1)
        if ledger.schema_version != 1:
            raise ValueError("ledger schema_version must be 1")
        checks = {check.id: check for check in manifest.checks}
        selected = set(args.check) if args.check else set(checks)
        if not selected or selected - checks.keys():
            raise ValueError("selection must name nonempty known checks")
        requirements = {item.id: item for item in manifest.requirements}
        if args.mode in ("review-plan", "review"):
            if len(selected) != 1:
                raise ValueError("review operations require exactly one selected check")
            check = checks[next(iter(selected))]
            requirement = requirements[check.requirement_id]
            if args.mode == "review-plan":
                if args.decision:
                    raise ValueError("a proposal does not consume a review decision")
                plan = A.review_plan(requirement, check, roots)
                output = A.render(plan)
                if args.output:
                    atomic_write(args.output, output)
                else:
                    sys.stdout.write(output)
                return 0
            if not args.decision:
                raise ValueError("review requires an explicit decision artifact")
            decision = A.parse(args.decision, E.EvidenceReviewDecision())
            # Validate before idempotency lookup: a stale plan cannot be revived.
            A.validate_review(requirement, check, decision, A.inspect_inputs(A.expected_inputs(requirement, check), roots))
            prior = [r for r in ledger.receipts if r.HasField("review") and r.review.id == decision.id]
            if len(prior) > 1:
                raise ValueError("duplicate review decision identities in ledger")
            if prior:
                if prior[0].review != decision:
                    raise ValueError("review identity was already used for a different decision")
            else:
                ledger.receipts.append(A.record_review(requirement, check, decision, roots, revision))
                atomic_write(args.receipts, A.render(ledger))
        elif args.decision:
            raise ValueError("decision artifacts are accepted only by review")
        if args.mode == "run":
            # Validate all selected checks before executing any of them.
            for key in sorted(selected):
                check = checks[key]
                if check.dimension not in A.EXECUTABLE:
                    raise ValueError("review dimensions cannot be executed")
                A.inspect_inputs(A.expected_inputs(requirements[check.requirement_id], check), roots)
            def append(receipt):
                ledger.receipts.append(receipt)
                atomic_write(args.receipts, A.render(ledger))
            def cancel(signum, _frame):
                raise A.X.Canceled(signum)
            handlers = {signum: signal.signal(signum, cancel) for signum in [signal.SIGINT, signal.SIGTERM]}
            try:
                for key in sorted(selected):
                    check = checks[key]
                    append(A.execute(requirements[check.requirement_id], check, roots, revision, args.run_uri,
                        artifact_root=artifact_root, on_started=append))
            except A.X.Canceled as exc:
                if exc.receipt is not None:
                    append(exc.receipt)
                return 128 + exc.signum
            finally:
                for signum, handler in handlers.items():
                    signal.signal(signum, handler)
        report = A.assess(manifest, ledger, roots, revision, selected, artifact_root=artifact_root)
    output = A.render(report)
    if args.output:
        atomic_write(args.output, output)
    else:
        sys.stdout.write(output)
    return 0 if report.selected_checks_passed else 1


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, json_format.ParseError) as exc:
        print("Evidence evaluation refused: " + str(exc), file=sys.stderr)
        sys.exit(2)
