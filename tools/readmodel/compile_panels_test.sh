#!/usr/bin/env bash
# Runs compile_panels.py against the SOURCE TREE, in verify mode (no --write).
#
# Same workspace-root convention as check_wiring_test.sh: it reads committed files
# by repo-relative path, so it needs a real workspace root rather than a runfiles
# tree with a different shape. BUILD_WORKSPACE_DIRECTORY when available, else the
# runfiles copy, which is what CI uses.
#
# ── Why this is a SEPARATE gate from check_wiring_test ──────────────────────────
#
# check_wiring_test already compares ui/panels.binpb to ui/panels.textproto — but by
# PANEL ID. That catches a panel added to one and not the other, which is the common
# mistake. It does not catch a changed column header, a changed pref_width, a
# reworded placeholder, or a corrupted string, because none of those change the id
# list.
#
# The evidence that the finer comparison earns its keep is that it found a bug in
# compile_panels.py itself: a textproto parser that mojibaked `Requires ≥` into
# `Requires â‰¥`, emitting a bundle 12 bytes larger than protoc's. The committed
# bundle was fine and check_wiring_test was correct to pass — byte equality was
# simply the only assertion in the repo that could see a difference that small.
set -uo pipefail
root="${BUILD_WORKSPACE_DIRECTORY:-$PWD}"
cd "$root" || exit 1
exec python3 tools/readmodel/compile_panels.py
