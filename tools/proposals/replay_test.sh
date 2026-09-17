#!/usr/bin/env bash
# `spec replay <address>` — RFC-002 §12's P1 gate, exercised.
#
# ⛔ Against a FIXTURE log, not the committed one. //logs/proposals.jsonl is
# empty (no proposal has been promoted yet), and a test that ran over it would
# pass by examining nothing — the precise defect //rdf/lint/authoring:vacuous-
# invariant.rq exists to catch, in a test rather than in a corpus.
#
# The fixture is three records and is adversarial in the way this repo's other
# fixtures are: it PLANTS defects and fails if they are not detected.
#
#   1  bindTerm deploy:* → role='deployer'      Admitted
#   2  bindTerm deploy:* → role='anyone'        ⛔ REJECTED — the door never
#                                                appends a refusal, so this
#                                                record can only come from a
#                                                hand-edited or restored log.
#                                                If it is replayed, "anyone" can
#                                                deploy and nothing said so.
#   3  bindTerm publish:* → role='publisher'    no verdict, no address at all —
#                                                a record from before the door
#                                                computed either. It must still
#                                                replay, or the whole history
#                                                disappears.
#
# and a second fixture holding one record whose stored address is not the address
# of its own body.

set -uo pipefail
root="${BUILD_WORKSPACE_DIRECTORY:-$PWD}"
cd "$root" || exit 1

replay="tools/proposals/replay.py"
log="tools/proposals/fixtures/replay-log.jsonl"
lying="tools/proposals/fixtures/replay-log-lying.jsonl"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fail=0
ok()   { echo "  ✓ $1"; }
bad()  { echo "  ✗ $1"; echo "      $2"; fail=1; }

# ── 1. every record is named by its own bytes ────────────────────────────────
listing="$work/list.txt"
if ! python3 "$replay" --log "$log" --list >"$listing" 2>"$work/list.err"; then
  bad "--list" "$(cat "$work/list.err")"
else
  n=$(grep -c '^[0-9]' "$listing")
  [ "$n" = 3 ] && ok "names all 3 records" || bad "names all 3 records" "got $n"
  # The addresses are recomputed from each record's canonical bytes, so the two
  # that carry an `address` field must agree with it — and the one that carries
  # none is named anyway.
  for a in $(python3 -c '
import json,sys
for line in open(sys.argv[1], encoding="utf-8").read().split("\n"):
    if line.strip():
        a = json.loads(line).get("address")
        if a: print(a)
' "$log"); do
    grep -q "$a" "$listing" \
      && ok "recomputes the stored address $a" \
      || bad "recomputes the stored address $a" "not in --list output"
  done
  # ⛔ The third record stores NO address and NO verdict, and is named anyway —
  # which is the proof that the name comes from the bytes rather than from the
  # field. Its verdict column reads `-`: absent, and absent is not Rejected.
  pre_door_verdict=$(awk 'END {print $3}' "$listing")
  pre_door_address=$(awk 'END {print $2}' "$listing")
  [ "$pre_door_verdict" = "-" ] \
    && ok "a record written before the door shows no verdict" \
    || bad "a pre-door record's verdict" "got '$pre_door_verdict'"
  case "$pre_door_address" in
    sha256:*) ok "…and is named anyway, from its own bytes" ;;
    *) bad "a pre-door record is named" "got '$pre_door_address'" ;;
  esac
fi

first=$(awk 'NR==2 {print $2}' "$listing")
last=$(awk 'END {print $2}' "$listing")

# ── 2. replaying through a record reproduces the corpus AT THAT POINT ────────
python3 "$replay" --log "$log" --address "$first" --project fixture \
  --evaluations /nonexistent --out "$work/at-first" >/dev/null 2>"$work/first.err"
python3 "$replay" --log "$log" --address "$last" --project fixture \
  --evaluations /nonexistent --out "$work/at-last" >/dev/null 2>"$work/last.err"

if [ ! -f "$work/at-first/proposals.ttl" ] || [ ! -f "$work/at-last/proposals.ttl" ]; then
  bad "replays a prefix" "$(cat "$work/first.err" "$work/last.err")"
else
  grep -q "deployer" "$work/at-first/proposals.ttl" \
    && ok "the first record's binding is in the replay at that point" \
    || bad "the first record's binding" "absent from at-first"
  grep -q "publisher" "$work/at-first/proposals.ttl" \
    && bad "a LATER record leaked into an earlier replay" "publish:* must not be here" \
    || ok "a later record is not in an earlier replay"
  grep -q "publisher" "$work/at-last/proposals.ttl" \
    && ok "replaying through the last record includes every earlier one" \
    || bad "the last replay" "publish:* missing"

  # ⛔ THE PLANTED REFUSAL. If this string appears, a proposal the door refused
  # was promoted into the corpus the gates run over.
  grep -q "anyone" "$work/at-last/proposals.ttl" \
    && bad "a REJECTED record was promoted" "role='anyone' reached the corpus" \
    || ok "the rejected record is not promoted"
  grep -q "DROPPED" "$work/last.err" \
    && ok "and the drop is reported rather than silent" \
    || bad "the drop is reported" "nothing on stderr said so"
  # The positive control for that drop: the term it tried to overwrite still
  # holds the value the ADMITTED record gave it. A silently-empty corpus would
  # pass the check above for the wrong reason.
  grep -q "deployer" "$work/at-last/proposals.ttl" \
    && ok "and the admitted binding it tried to overwrite still stands" \
    || bad "the admitted binding" "deploy:* lost its value entirely"
fi

# ── 3. a record that lies about its own name is a hard error ─────────────────
if python3 "$replay" --log "$lying" --list >"$work/lying.txt" 2>&1; then
  bad "a record whose stored address is not its own" "accepted: $(cat "$work/lying.txt")"
else
  grep -q "claims" "$work/lying.txt" \
    && ok "a record that lies about its own name is refused, by name" \
    || bad "the refusal names the disagreement" "$(cat "$work/lying.txt")"
fi

# ── 4. an address nobody wrote ───────────────────────────────────────────────
if python3 "$replay" --log "$log" --project fixture \
     --address "sha256:$(printf '0%.0s' $(seq 64))" >"$work/unknown.txt" 2>&1; then
  bad "an unknown address" "accepted"
else
  ok "an address no record has is refused"
fi

if [ "$fail" -eq 0 ]; then
  echo "ok    replay reproduces a prefix, refuses a refusal, and refuses a lie"
fi
exit "$fail"
