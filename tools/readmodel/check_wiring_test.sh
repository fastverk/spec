#!/usr/bin/env bash
# Runs check_wiring.py against the SOURCE TREE.
#
# It walks committed files by repo-relative path (services/spec/src/*.rs,
# ui/panels.{textproto,binpb}, readmodel/*.json), so it needs a real workspace
# root rather than a runfiles tree with a different shape. Under `bazel test`
# that root is BUILD_WORKSPACE_DIRECTORY when available; otherwise the runfiles
# copy, which is what CI uses.
set -uo pipefail
root="${BUILD_WORKSPACE_DIRECTORY:-$PWD}"
cd "$root" || exit 1
exec python3 tools/readmodel/check_wiring.py
