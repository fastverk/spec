#!/usr/bin/env bash
# Runs check_conformance.py against the SOURCE TREE.
#
# Same shape as tools/readmodel/check_wiring_test.sh, and for the same reason: it
# walks committed files by repo-relative path (conformance/*.json,
# services/spec/src/*.rs, console/lib/*.ts) rather than a runfiles tree, so it
# needs a real workspace root. Under `bazel test` that is
# BUILD_WORKSPACE_DIRECTORY when available; otherwise the runfiles copy, which is
# what CI uses.
set -uo pipefail
root="${BUILD_WORKSPACE_DIRECTORY:-$PWD}"
cd "$root" || exit 1
exec python3 conformance/check_conformance.py
