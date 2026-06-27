#!/usr/bin/env sh
# record-eg.sh — append one normalized E(G) snapshot row to crank/eg-series.tsv.
#
# This is the *measure* stage of the deterministic half of the crank loop
# (predict -> project -> gate -> measure). It builds the two SPARQL measurement
# targets over the materialized ratio corpus and reads the E(G)-relevant counts
# straight off the graph, then records them as one tab-separated row so the
# E(G) descent across cranks can be watched.
#
# Usage:
#   sh crank/record-eg.sh N            # N = crank index (e.g. 3)
#   bazel run //crank:record_eg -- N   # same, via the wired target
#
# Columns recorded (see crank/eg-series.tsv header):
#   crank   R   L   S   claims   docs   note
# where
#   R      = redundant edges (transitively implied)        -> redundancy proxy
#   L      = dependsOn edges after transitive reduction     -> connectivity proxy
#   S      = motif templates                                -> symmetry
#   claims = NormativeStatements in the graph
#   docs   = Documents in the graph
#
# Idempotent: re-running for the same crank index replaces that row in place
# rather than appending a duplicate.

set -eu

if [ "$#" -lt 1 ]; then
  echo "usage: record-eg.sh <crank-index> [note]" >&2
  exit 2
fi

# Crank index, zero-padded to 3 digits to match the seeded rows (001, 002, ...).
CRANK_RAW="$1"
CRANK=$(printf '%03d' "$CRANK_RAW" 2>/dev/null || echo "$CRANK_RAW")
NOTE="${2:-graph-measured}"

# Locate the repo root. Under `bazel run` we get BUILD_WORKSPACE_DIRECTORY;
# under a plain `sh crank/record-eg.sh` we resolve it from this script's path.
if [ -n "${BUILD_WORKSPACE_DIRECTORY:-}" ]; then
  REPO="${BUILD_WORKSPACE_DIRECTORY}"
else
  SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
  REPO=$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)
fi

cd "${REPO}"

# Project/measure: build the deterministic measurement targets over the graph.
bazel build //corpus:eg_measure //corpus:compaction_measure >&2

EG_TSV="bazel-bin/corpus/eg_measure.tsv"
CM_TSV="bazel-bin/corpus/compaction_measure.tsv"

if [ ! -f "${EG_TSV}" ] || [ ! -f "${CM_TSV}" ]; then
  echo "ERROR: measurement tsvs not found after build" >&2
  echo "       expected ${EG_TSV} and ${CM_TSV}" >&2
  exit 1
fi

# tsv_value <file> <metric-substring> — pull the ?value for a quoted "metric" row.
# The tsv rows look like:  "metric name"<TAB>value
tsv_value() {
  _file="$1"
  _key="$2"
  awk -F '\t' -v key="$_key" '
    index($1, key) > 0 {
      v = $2
      gsub(/"/, "", v)
      gsub(/[ \t\r]/, "", v)
      print v
      exit
    }
  ' "$_file"
}

R=$(tsv_value "${CM_TSV}" "redundant edges")
L=$(tsv_value "${CM_TSV}" "after reduction")
S=$(tsv_value "${CM_TSV}" "motif templates")
CLAIMS=$(tsv_value "${EG_TSV}" "claims (NormativeStatements)")
DOCS=$(tsv_value "${EG_TSV}" "documents")

for pair in "R=$R" "L=$L" "S=$S" "claims=$CLAIMS" "docs=$DOCS"; do
  name=${pair%%=*}
  val=${pair#*=}
  if [ -z "$val" ]; then
    echo "ERROR: could not parse '$name' from measurement tsvs" >&2
    exit 1
  fi
done

SERIES="crank/eg-series.tsv"
HEADER="crank	R	L	S	claims	docs	note"
ROW="${CRANK}	${R}	${L}	${S}	${CLAIMS}	${DOCS}	${NOTE}"

# Ensure the file exists with a header.
if [ ! -f "${SERIES}" ]; then
  printf '%s\n' "${HEADER}" > "${SERIES}"
fi

# Idempotent upsert: drop any existing row for this crank, then append the fresh
# one. Done via a temp file so the original is never left half-written.
TMP=$(mktemp "${TMPDIR:-/tmp}/eg-series.XXXXXX")
awk -F '\t' -v crank="${CRANK}" '
  NR == 1 { print; next }      # always keep the header
  $1 == crank { next }          # drop the row we are replacing
  { print }                     # keep every other row
' "${SERIES}" > "${TMP}"
printf '%s\n' "${ROW}" >> "${TMP}"
mv "${TMP}" "${SERIES}"

echo "recorded crank ${CRANK}: R=${R} L=${L} S=${S} claims=${CLAIMS} docs=${DOCS} (${NOTE})" >&2
echo "  -> ${REPO}/${SERIES}" >&2
