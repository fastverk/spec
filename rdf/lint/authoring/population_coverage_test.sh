#!/usr/bin/env bash
# Every zero-row GATE must carry an authored candidate set.
#
# ⛔ Why this test exists. `examined` reports UNKNOWN (-1) when a gate has no
# `<gate>.population.rq`, and UNKNOWN never reads as EXAMINED_NOTHING. That is
# honest at the row and INVISIBLE IN AGGREGATE: add a gate without a population
# file and it silently loses the ability to report that it examined nothing,
# which is the exact defect the three-valued status was introduced to expose.
# Absence has to be loud or the convention decays one gate at a time.
#
# ⛔ The list is READ FROM `_GATES`, never globbed and never restated here.
# Globbing `*.rq` would demand a population file for the four MEASURES too, and a
# measure is not a gate — non-empty output is normal and often the point. A
# restated list would drift the moment somebody adds a gate, which is the failure
# this test is supposed to catch.
set -euo pipefail

BZL="${1:?usage: population_coverage_test.sh AUTHORING_GATES_BZL QUERY_DIR}"
DIR="${2:?}"

# Extract the keys of the _GATES dict: everything between `_GATES = {` and the
# closing brace, taking the quoted key from each line.
gates=$(awk '/^_GATES = \{/{f=1;next} f&&/^\}/{f=0} f' "$BZL" \
        | sed -n 's/^[[:space:]]*"\([a-z_]*\)":.*/\1/p')

if [ -z "$gates" ]; then
    echo "FAIL: parsed 0 gates from $BZL — the _GATES block moved or changed shape," >&2
    echo "      and a coverage test that examines nothing passes vacuously." >&2
    exit 1
fi

missing=0
count=0
for g in $gates; do
    count=$((count + 1))
    # _GATES keys are snake_case; the files are kebab-case.
    f="$DIR/$(echo "$g" | tr '_' '-').population.rq"
    if [ -f "$f" ]; then
        echo "  ok   $g -> $(basename "$f")"
    else
        echo "  MISS $g -> $(basename "$f") does not exist" >&2
        missing=$((missing + 1))
    fi
done

echo "$count gate(s) checked, $missing without a population query"
if [ "$missing" -gt 0 ]; then
    echo "FAIL: a gate with no population query cannot report that it examined" >&2
    echo "      nothing, and will read as PASSED forever. See RFC-005 §4." >&2
    exit 1
fi
