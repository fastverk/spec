#!/usr/bin/env bash
# Assert the one architectural rule spec cannot be trusted to remember:
#
#   NOTHING REACHABLE FROM spec.v1.Invariant CAN HOLD PROJECT DATA.
#
# spec stores invariants. It must never store a customer's rows. The grounding
# UI genuinely needs example rows — showing populations rather than schemas is
# what makes the question answerable — so those exist, in
# grounding_adapter.proto, and are rendered and discarded.
#
# The separation is enforced by the import graph rather than by review:
#
#   invariant.proto         imports NOTHING
#   grounding_adapter.proto imports invariant.proto   (one direction only)
#
# So no field reachable from `Invariant` can have a type declared in the adapter
# file, because that file is not in its transitive closure. Adding a data-bearing
# field to the stored type would require adding an import here, and that import
# is the review conversation.
#
# Deliberately checks the IMPORT GRAPH and not field names. A rule phrased as
# "no field called examples" is a rule about spelling; this one is about
# reachability, which is the property that actually matters.

set -uo pipefail

inv=""
adapter=""
derivation=""
workorder=""
for f in "$@"; do
  case "$f" in
    *invariant.proto) inv="$f" ;;
    *grounding_adapter.proto) adapter="$f" ;;
    *derivation.proto) derivation="$f" ;;
    *workorder.proto) workorder="$f" ;;
  esac
done

status=0

if [ -z "$inv" ] || [ -z "$adapter" ]; then
  echo "FAIL  both protos must be supplied (got: $*)"
  exit 1
fi

# 1. The stored type's file imports nothing at all.
imports=$(grep -E '^import ' "$inv" || true)
if [ -n "$imports" ]; then
  echo "FAIL  invariant.proto has imports, so its transitive closure is no longer"
  echo "      self-evident. Every import is a new way for a row to become reachable"
  echo "      from a type spec persists. Found:"
  printf '        %s\n' "$imports"
  status=1
fi

# 2. The data-bearing type is declared in the adapter file, and only there.
if ! grep -qE '^message DisplayExample' "$adapter"; then
  echo "FAIL  DisplayExample is not declared in grounding_adapter.proto"
  status=1
fi
if grep -qE '(^|[^a-zA-Z_])DisplayExample' "$inv"; then
  echo "FAIL  invariant.proto mentions DisplayExample — the stored type can now"
  echo "      reach display data"
  status=1
fi

# 3. The dependency runs one way. The adapter may know about invariants; the
#    invariant must never know about the adapter.
if ! grep -qE '^import "spec/v1/invariant.proto";' "$adapter"; then
  echo "FAIL  grounding_adapter.proto should import invariant.proto (it reuses"
  echo "      Grounding/Check/Outcome/Population)"
  status=1
fi

# 4. Population stores a count and a fingerprint, never rows. A `repeated`
#    field inside Population would be the obvious way to smuggle them.
pop=$(awk '/^message Population \{/,/^\}/' "$inv")
if printf '%s' "$pop" | grep -qE '^\s*repeated '; then
  echo "FAIL  Population has a repeated field. It carries a count and a"
  echo "      fingerprint; anything repeated is how rows get in."
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "ok    invariant.proto imports nothing; DisplayExample is adapter-only"
  echo "ok    Population carries a count, not rows"
  echo "ok    spec.v1.Invariant cannot reach project data"
fi
# derivation.proto — the gate plane. Same rule, same reason.
#
# ⛔ A gate report carries COUNTS and one corpus row for orientation. The corpus
# is spec's OWN, so a gate row is not a customer row — but the moment this file
# imports grounding_adapter.proto, DisplayExample becomes reachable from a type
# the gate service returns, and a customer's rows are one field away from being
# at rest in spec's plane. The import graph is the review here exactly as it is
# for invariant.proto.
if [ -n "$derivation" ]; then
  dimports=$(grep -E '^import ' "$derivation" || true)
  if [ -n "$dimports" ]; then
    echo "FAIL  derivation.proto has imports. It carries counts about spec's own"
    echo "      corpus and must not be able to reach a customer row. Found:"
    printf '        %s\n' "$dimports"
    status=1
  else
    echo "ok    derivation.proto imports nothing"
  fi
fi
# workorder.proto — the fanout plane. Same rule, same reason.
#
# ⛔ A work order names spec's OWN corpus objects (claims, conflicts,
# quantities, scopes) by IRI, and hands an agent artifact PATHS — never file
# contents, never a customer row. One import of grounding_adapter.proto and
# DisplayExample is reachable from the packet every fanout agent receives,
# which is the widest possible distribution of a customer's rows this plane
# could arrange. The import graph is the review here exactly as everywhere
# else in this file.
if [ -n "$workorder" ]; then
  wimports=$(grep -E '^import ' "$workorder" || true)
  if [ -n "$wimports" ]; then
    echo "FAIL  workorder.proto has imports. It names corpus objects by IRI and"
    echo "      must not be able to reach a customer row. Found:"
    printf '        %s\n' "$wimports"
    status=1
  else
    echo "ok    workorder.proto imports nothing"
  fi
fi
exit "$status"
