#!/usr/bin/env bash
# Assert corpus/<project>/proposals.ttl is what the committed log materializes to.
#
# ⛔ The gate this closes: until it existed, NOTHING connected the corpus to any
# log. `//corpus/studio:studio_gates` ran over proposals.ttl as committed, so a
# hand-edited one — or one generated from a log nobody has — passed every check
# in the repo. Invariant ⑥ says the corpus is generated and edited by re-running
# a tool or making a proposal; this is the first thing that makes that true
# rather than stated.
#
# Reads only. `materialize.py --check` compares and returns; it writes nothing.
#
# Same workspace-root dance as the other stdlib checks: under `bazel test` there
# is no BUILD_WORKSPACE_DIRECTORY, so it runs against the runfiles tree and sees
# exactly what the target's `data` stages — which is why the data list is the
# load-bearing part of the BUILD rule, not the srcs.
set -uo pipefail
project="${1:?usage: check_materialized.sh <project>}"
root="${BUILD_WORKSPACE_DIRECTORY:-$PWD}"
cd "$root" || exit 1
exec python3 tools/proposals/materialize.py \
    --log logs/proposals.jsonl \
    --evaluations logs/evaluations.jsonl \
    --corpus "corpus/${project}" \
    --project "${project}" \
    --check
