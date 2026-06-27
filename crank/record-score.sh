#!/usr/bin/env sh
# record-score.sh — append one net Spec Score row to crank/spec-score.tsv.
#
# The Spec Score ∈ [0,100] (higher = better) is the human-facing dual of the
# crank energy E(G): the agent fleet drives E(G) DOWN, which is driving this
# score UP. This records the score (and its sub-scores) straight off the
# materialized ratio corpus so the climb can be watched — and pushed — over time.
#
# Usage:
#   sh crank/record-score.sh N [note]      # N = crank index (e.g. 3)
#   bazel run //crank:record_score -- N    # (if wired)
#
# Columns (see crank/spec-score.tsv header):
#   crank  score  grounding  density  parsimony  structure  note
#
# Idempotent: re-running for the same crank index replaces that row in place.

set -eu

if [ "$#" -lt 1 ]; then
  echo "usage: record-score.sh <crank-index> [note]" >&2
  exit 2
fi
CRANK=$(printf '%03d' "$1" 2>/dev/null || echo "$1")
NOTE="${2:-graph-measured}"

if [ -n "${BUILD_WORKSPACE_DIRECTORY:-}" ]; then
  REPO="${BUILD_WORKSPACE_DIRECTORY}"
else
  SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  REPO=$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)
fi
cd "${REPO}"

# Build the snapshot (which runs the //corpus SPARQL measures and computes the
# score), then read the sub-scores off it.
bazel build //crank:spec_score >&2
SNAP="bazel-bin/crank/spec-score.snapshot.tsv"
[ -f "${SNAP}" ] || { echo "ERROR: ${SNAP} not found after build" >&2; exit 1; }

snap_value() {
  awk -F '\t' -v k="$1" '$1 == k { print $2; exit }' "${SNAP}"
}
SCORE=$(snap_value score)
G=$(snap_value grounding)
D=$(snap_value density)
P=$(snap_value parsimony)
S=$(snap_value structure)

for pair in "score=$SCORE" "grounding=$G" "density=$D" "parsimony=$P" "structure=$S"; do
  [ -n "${pair#*=}" ] || { echo "ERROR: could not parse '${pair%%=*}'" >&2; exit 1; }
done

SERIES="crank/spec-score.tsv"
HEADER="crank	score	grounding	density	parsimony	structure	note"
ROW="${CRANK}	${SCORE}	${G}	${D}	${P}	${S}	${NOTE}"

[ -f "${SERIES}" ] || printf '%s\n' "${HEADER}" > "${SERIES}"

TMP=$(mktemp "${TMPDIR:-/tmp}/spec-score.XXXXXX")
awk -F '\t' -v crank="${CRANK}" '
  NR == 1 { print; next }
  $1 == crank { next }
  { print }
' "${SERIES}" > "${TMP}"
printf '%s\n' "${ROW}" >> "${TMP}"
mv "${TMP}" "${SERIES}"

echo "recorded crank ${CRANK}: score=${SCORE} (g=${G} d=${D} p=${P} s=${S}) (${NOTE})" >&2
echo "  -> ${REPO}/${SERIES}" >&2
