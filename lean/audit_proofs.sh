#!/usr/bin/env bash
# Fail if any Lean source contains an escape hatch that would make a green build
# meaningless, or if the trusted axiom base grows without someone saying so.
#
# ── Why this exists ──────────────────────────────────────────────────────────
#
# `lean_test` DOES NOT CHECK PROOFS on its own. A `sorry` is a *warning* and
# `lean` exits 0, so a file proving anything `by sorry` passes a `lean_test`
# cleanly. Measured on this repo: before `set_option warningAsError true` was
# added to the sources, a probe theorem `n + 0 = n := by sorry` appended to
# Spec/Grounding/WriteDoor.lean left `//lean:grounding_test` GREEN.
#
# That matters more here than in most repos, because lean/BUILD.bazel claimed
# "compiling (sorry-free) IS the verification that the grounding is real" and
# //grounding:grounding_verified ties the corpus's `:provenBy` to exactly that.
# The guarantee was asserted, not enforced.
#
# Two layers close it:
#   1. `set_option warningAsError true` in every source (after the imports —
#      Lean requires imports first). Turns `declaration uses 'sorry'` into a
#      hard error. That covers `sorry` AND the `admit` tactic, which emits the
#      same warning.
#   2. This audit, for what that option cannot see.
#
# ── Two deliberate differences from the same gate in agora ───────────────────
#
# `admit` is NOT gated textually. In this repo `admit` is a function name —
# `def admit` in Spec/Grounding/WriteDoor.lean IS the kernel write-door being
# modelled — so a textual match is a guaranteed false positive. The tactic of
# the same name is already caught by layer 1.
#
# `axiom` is NOT banned. This repo declares 93 of them on purpose: the universe
# of discourse is deliberately opaque (Spec/Universe.lean), and Spec/Predicates
# states the predicates over it. Banning them would make the gate impossible to
# turn on, and an un-turn-on-able gate is no gate.
#
# Instead the axiom base is RATCHETED. Every proof in this tree is relative to
# those 93 statements, which are believed rather than proven — so what must not
# happen is the set growing quietly. Adding an axiom is a real decision; it
# should cost a line in lean/axiom_baseline.txt and be visible in review.
#
# ⛔ `#print axioms` is NOT a gate — its output is informational and fails
# nothing, which is the same class of mistake as the sorry itself.

set -uo pipefail

baseline=""
srcs=()
for arg in "$@"; do
  case "$arg" in
    *axiom_baseline.txt) baseline="$arg" ;;
    *audit_proofs.sh) ;;
    *) srcs+=("$arg") ;;
  esac
done

status=0

# Strip block comments and line comments before matching, so prose that merely
# DISCUSSES sorry (this repo's docstrings do, repeatedly) does not trip the gate.
strip() { perl -0777 -pe 's{/-.*?-/}{}gs; s{--.*$}{}gm' "$1"; }

# ── 1. escape hatches ────────────────────────────────────────────────────────
for f in "${srcs[@]}"; do
  stripped=$(strip "$f")

  if printf '%s' "$stripped" | grep -qE '(^|[^a-zA-Z_.])sorry([^a-zA-Z_]|$)'; then
    echo "FAIL  $f  contains 'sorry'"
    status=1
  fi

  # native_decide trusts the compiler via Lean.ofReduceBool — a soundness
  # escape hatch, not a proof.
  if printf '%s' "$stripped" | grep -qE '(^|[^a-zA-Z_.])native_decide([^a-zA-Z_]|$)'; then
    echo "FAIL  $f  uses 'native_decide'"
    status=1
  fi

  # The option must be present in EVERY source, or layer 1 can be removed one
  # file at a time without anything noticing.
  if ! grep -q 'set_option warningAsError true' "$f"; then
    echo "FAIL  $f  missing 'set_option warningAsError true'"
    status=1
  fi
done

# ── 2. the axiom ratchet ─────────────────────────────────────────────────────
if [ -z "$baseline" ]; then
  echo "FAIL  no axiom_baseline.txt supplied — the ratchet cannot run"
  exit 1
fi

total=0
declare -a observed=()
for f in "${srcs[@]}"; do
  n=$(strip "$f" | grep -cE '^[[:space:]]*axiom[[:space:]]' || true)
  if [ "$n" -gt 0 ]; then
    # Paths arrive as runfiles-relative; compare on the repo-relative tail.
    rel="lean/${f#*lean/}"
    observed+=("$rel $n")
    total=$((total + n))
  fi
done

expected_total=$(grep -E '^TOTAL ' "$baseline" | awk '{print $2}')
if [ "$total" != "$expected_total" ]; then
  echo "FAIL  axiom count changed: $total, baseline says $expected_total"
  echo "      Every proof here is relative to these. If the change is intended,"
  echo "      update lean/axiom_baseline.txt in the same commit and say why."
  status=1
fi

for line in "${observed[@]}"; do
  file=${line% *}
  count=${line#* }
  want=$(grep -E "^${file} " "$baseline" | awk '{print $2}')
  if [ -z "$want" ]; then
    echo "FAIL  $file declares $count axiom(s) but is not in the baseline"
    status=1
  elif [ "$want" != "$count" ]; then
    echo "FAIL  $file declares $count axiom(s), baseline says $want"
    status=1
  fi
done

if [ "$status" -eq 0 ]; then
  echo "ok    ${#srcs[@]} Lean source(s): no sorry, no native_decide, all guarded"
  echo "ok    trusted base unchanged at $total axioms"
fi
exit "$status"
