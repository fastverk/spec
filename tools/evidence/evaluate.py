"""Execute consumer-owned predicates or assess existing revision-bound receipts."""
import argparse
import fcntl
import os
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("run", "assess"))
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--receipts", type=Path, required=True)
    parser.add_argument("--checkout", action="append", default=[])
    parser.add_argument("--check", action="append", default=[])
    parser.add_argument("--output", type=Path)
    parser.add_argument("--run-uri", default="")
    args = parser.parse_args()
    roots = {}
    for item in args.checkout:
        name, separator, path = item.partition("=")
        if not separator or not name or not path or name in roots:
            raise ValueError("checkout requires a unique repository=path")
        roots[name] = Path(path).resolve(strict=True)
    manifest = A.parse(args.manifest, E.EvidenceManifest())
    A.validate(manifest)
    revision = A.head(os.environ.get("BUILD_WORKSPACE_DIRECTORY", Path.cwd()))
    args.receipts.parent.mkdir(parents=True, exist_ok=True)
    # Serialize writers around read/execute/append/replace. Assess never edits
    # receipts. No in-place overwrite of earlier receipt entries is performed.
    with args.receipts.with_suffix(args.receipts.suffix + ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX if args.mode == "run" else fcntl.LOCK_SH)
        ledger = A.parse(args.receipts, E.EvidenceLedger()) if args.receipts.exists() else E.EvidenceLedger(schema_version=1)
        if ledger.schema_version != 1:
            raise ValueError("ledger schema_version must be 1")
        checks = {check.id: check for check in manifest.checks}
        selected = set(args.check) if args.check else set(checks)
        if not selected or selected - checks.keys():
            raise ValueError("selection must name nonempty known checks")
        requirements = {item.id: item for item in manifest.requirements}
        if args.mode == "run":
            # Validate all selected checks before executing any of them.
            for key in sorted(selected):
                check = checks[key]
                if check.dimension not in A.EXECUTABLE:
                    raise ValueError("review dimensions cannot be executed")
                A.inspect_inputs(A.expected_inputs(requirements[check.requirement_id], check), roots)
            for key in sorted(selected):
                check = checks[key]
                ledger.receipts.append(A.execute(requirements[check.requirement_id], check, roots, revision, args.run_uri))
                atomic_write(args.receipts, A.render(ledger))
        report = A.assess(manifest, ledger, roots, revision, selected)
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
