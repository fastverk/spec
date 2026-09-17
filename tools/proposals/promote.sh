#!/usr/bin/env bash
# The export half of promotion: Neon → logs/*.jsonl → proposals.ttl → the read model.
#
# Runs by hand (console/DEPLOY.md §5) and from .github/workflows/promote.yml —
# which is the point. One script, so the workflow cannot drift from the
# documented manual path, and a person can always do what the cron does.
#
#   NEON_EXPORT_URL='postgres://spec_export:…' tools/proposals/promote.sh
#
# ⛔ SELECT-only. spec_export holds SELECT and nothing else
# (console/db/migrations/0003_grants.sql). This script never needs more, and a
# credential that could do more has no business in its environment: the owner
# is the role that can DISABLE TRIGGER and delete an append-only log.
#
# ⚠ The export is PINNED. Both logs are read `WHERE seq <= $THROUGH_*`, with the
# pins taken once at the start (or passed in), so a proposal appended while the
# evaluations were still exporting cannot land in one file and not the other,
# and the PR that follows says exactly which records it covers. `seq` is
# ordered, not contiguous — a refused insert still consumes a value — so a pin is
# a high-water mark, never a count.
#
# What it writes, and nothing else:
#   logs/proposals.jsonl, logs/evaluations.jsonl   the snapshot, in seq order
#   corpus/<project>/proposals.ttl                  materialize.py, per project
#   services/spec/readmodel/*.json                  emit_readmodel.py
# Committing them together is what keeps
# //corpus/studio:proposals_ttl_matches_the_log green — it re-materializes from
# the committed log and fails if the TTL disagrees.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"

: "${NEON_EXPORT_URL:?NEON_EXPORT_URL is unset — the spec_export (SELECT-only) connection string}"

# Every project whose proposals.ttl is materialized from the log. ampere is a
# hand-authored worked example and has no log; add a project here when its
# console writes land in spec.proposal_log.
PROJECTS=(studio)

q() { psql "$NEON_EXPORT_URL" -X -A -t -q --no-psqlrc -v ON_ERROR_STOP=1 "$@"; }

THROUGH_PROPOSAL="${THROUGH_PROPOSAL:-}"
THROUGH_EVALUATION="${THROUGH_EVALUATION:-}"
[ -n "$THROUGH_PROPOSAL" ]   || THROUGH_PROPOSAL=$(q -c 'SELECT coalesce(max(seq), 0) FROM spec.proposal_log')
[ -n "$THROUGH_EVALUATION" ] || THROUGH_EVALUATION=$(q -c 'SELECT coalesce(max(seq), 0) FROM spec.evaluation_log')
# The pins are interpolated into SQL below; a pin that is not a number is refused
# here rather than handed to psql.
for pin in "$THROUGH_PROPOSAL" "$THROUGH_EVALUATION"; do
  [[ "$pin" =~ ^[0-9]+$ ]] || { echo "a pin must be a non-negative integer seq, got '$pin'" >&2; exit 2; }
done
echo "through: proposal seq $THROUGH_PROPOSAL, evaluation seq $THROUGH_EVALUATION"

# A SELECT of the stored line, never a serializer — console/db/README.md says
# why. spec.log_line forbids every line terminator, so one row is one line.
q -c "SELECT line FROM spec.proposal_log   WHERE seq <= $THROUGH_PROPOSAL   ORDER BY seq" > logs/proposals.jsonl
q -c "SELECT line FROM spec.evaluation_log WHERE seq <= $THROUGH_EVALUATION ORDER BY seq" > logs/evaluations.jsonl
n_p=$(grep -c . logs/proposals.jsonl || true)
n_e=$(grep -c . logs/evaluations.jsonl || true)
echo "exported: $n_p proposal line(s), $n_e evaluation line(s)"

for project in "${PROJECTS[@]}"; do
  python3 tools/proposals/materialize.py \
    --log logs/proposals.jsonl --evaluations logs/evaluations.jsonl \
    --corpus "corpus/$project" --project "$project"
done
python3 tools/readmodel/emit_readmodel.py

# For promote.yml: the pins and counts, so the PR can name what it covers.
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "through_proposal=$THROUGH_PROPOSAL"
    echo "through_evaluation=$THROUGH_EVALUATION"
    echo "proposal_lines=$n_p"
    echo "evaluation_lines=$n_e"
  } >> "$GITHUB_OUTPUT"
fi
