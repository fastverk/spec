#!/usr/bin/env bash
# Fail if LEDGER.md include dirs are missing, exclude names exist at repo
# root, or documented module(name)/version rows disagree with MODULE.bazel.
#
# This vehicle is native (not a subtree-import of sibling repos). The check
# is directory-level, not "every include is a child MODULE.bazel".
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
exec python3 - "$root" <<'PY'
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(sys.argv[1])
LEDGER = ROOT / "LEDGER.md"

ROW = re.compile(
    r"^\| (?P<name>[\w.-]+) \| (?P<status>imported|pending|excluded|absorb) \|",
    re.M,
)


def parse_module_bazel(text: str) -> tuple[str | None, str | None]:
    name = version = None
    in_call = False
    for line in text.splitlines():
        t = line.strip()
        if t.startswith("#"):
            continue
        if not in_call:
            if t.startswith("module("):
                in_call = True
            else:
                continue
        if name is None:
            m = re.search(r'name\s*=\s*"([^"]+)"', t)
            if m:
                name = m.group(1)
        if version is None:
            m = re.search(r'version\s*=\s*"([^"]+)"', t)
            if m:
                version = m.group(1)
        if ")" in t and name and version:
            break
        if t.endswith(")") and in_call:
            break
    return name, version


def parse_ledger() -> list[dict]:
    rows = []
    section = None
    for line in LEDGER.read_text().splitlines():
        if line.startswith("## Includes"):
            section = "include"
            continue
        if line.startswith("## Optional"):
            section = "optional"
            continue
        if line.startswith("## Absorb"):
            section = "absorb"
            continue
        if line.startswith("## Excludes"):
            section = "exclude"
            continue
        if line.startswith("### ") or line.startswith("## "):
            continue
        if not ROW.match(line):
            continue
        cols = [c.strip() for c in line.strip().strip("|").split("|")]
        row = {
            "name": cols[0],
            "status": cols[1],
            "section": section,
        }
        if row["status"] in {"excluded", "absorb"}:
            if len(cols) < 3:
                continue
            rows.append(row)
            continue
        if len(cols) < 6:
            continue
        row["declared_name"] = cols[4].strip("`")
        row["declared_version"] = cols[5].strip("`")
        rows.append(row)
    return rows


def main() -> int:
    errors: list[str] = []
    rows = parse_ledger()
    if not rows:
        errors.append("LEDGER.md parsed zero rows")

    includes = [r for r in rows if r.get("section") == "include"]
    optionals = [r for r in rows if r.get("section") == "optional"]
    absorbs = [r for r in rows if r["status"] == "absorb"]
    excludes = [r for r in rows if r["status"] == "excluded"]

    imported = [r for r in includes if r["status"] == "imported"]
    pending = [r for r in includes if r["status"] == "pending"]
    optional_pending = [r for r in optionals if r["status"] == "pending"]

    root_mb = ROOT / "MODULE.bazel"
    if not root_mb.is_file():
        errors.append("root MODULE.bazel missing (this vehicle's published module lives at repo root)")
        root_name = root_version = None
    else:
        root_name, root_version = parse_module_bazel(root_mb.read_text())

    smoke_mb = ROOT / "smoke" / "consumer" / "MODULE.bazel"
    if not smoke_mb.is_file():
        errors.append("smoke/consumer/MODULE.bazel missing (nested spec_smoke_consumer module)")
        smoke_name = smoke_version = None
    else:
        smoke_name, smoke_version = parse_module_bazel(smoke_mb.read_text())

    modules = {
        "spec": (root_name, root_version, "root MODULE.bazel"),
        "spec_smoke_consumer": (smoke_name, smoke_version, "smoke/consumer/MODULE.bazel"),
    }

    for r in imported:
        path = ROOT / r["name"]
        if not path.is_dir():
            errors.append(f"{r['name']}: imported in LEDGER but directory missing at repo root")
            continue
        declared_name = r.get("declared_name")
        declared_version = r.get("declared_version")
        if declared_name not in modules:
            errors.append(
                f"{r['name']}: LEDGER module(name) {declared_name!r} is not a module in this vehicle"
            )
            continue
        actual_name, actual_version, where = modules[declared_name]
        if actual_name != declared_name:
            errors.append(
                f"{r['name']}: {where} name {actual_name!r} != ledger {declared_name!r}"
            )
        if actual_version != declared_version:
            errors.append(
                f"{r['name']}: {where} version {actual_version!r} != ledger {declared_version!r}"
            )

    for r in pending + optional_pending:
        if (ROOT / r["name"]).exists():
            errors.append(
                f"{r['name']}: pending in ledger but path exists at repo root"
            )

    for r in absorbs + excludes:
        if (ROOT / r["name"]).exists():
            errors.append(
                f"{r['name']}: listed as {r['status']} but path exists at repo root"
            )

    if errors:
        print("ledger check FAILED:")
        for e in errors:
            print(f"  - {e}")
        return 1
    print(
        f"ledger check OK: {len(imported)} imported / {len(pending)} pending "
        f"(includes); {len(optional_pending)} optional pending; "
        f"{len(absorbs)} absorb; {len(excludes)} excluded"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
PY
