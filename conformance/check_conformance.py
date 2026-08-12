#!/usr/bin/env python3
"""check_conformance — assert every implementation of the safety rules agrees.

The vacuous refusal, the pending overlay and the adoption computation exist twice:
in Rust for the Bazel/plugin plane, and in TypeScript because the hosted console
runs on a platform with no Rust runtime. Two implementations of a safety rule
diverge silently — each keeps passing its own suite while they drift apart.

`conformance/*.json` is the shared answer: one set of cases, executed by both.
This file exists because that is necessary and NOT sufficient.

    //services/spec:spec_test runs only when CI can mint a token for the private
    plugin crates (.github/workflows/ci.yml, the `plugin` step, which is
    continue-on-error and has been skipping).

So on an ordinary PR only the TypeScript half actually executes the fixtures, and
a divergence introduced on the Rust side is reported by nothing. This closes as
much of that as can be closed with no Rust toolchain and no credential: it parses
the CONSTANTS out of both sources and re-derives every evaluation verdict from
them, independently of either implementation.

    python3 conformance/check_conformance.py

⚠ What it does NOT catch, stated plainly: this checks the data the rule is made
of, not the code that reads it. Reordering the guards in `evaluation::check` so
the zero-check becomes unreachable would leave every constant intact and pass
here. Only //services/spec:spec_test catches that. This is a mitigation for that
target being unrunnable, not a replacement for it.

Needs nothing but the standard library, which is the point — it runs in CI, in a
pre-commit hook, or on a laptop with no Bazel and no crate registry access.
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

EVAL_CASES = "conformance/evaluation_cases.json"
OVERLAY_CASES = "conformance/overlay_cases.json"
RS_EVAL = "services/spec/src/evaluation.rs"
RS_OVERLAY = "services/spec/src/overlay.rs"
TS_EVAL = "console/lib/evaluation.ts"

# The overlay entry points a case may target, and the corpus payloads each needs.
APPLY_TARGETS = {
    "terms": ("terms",),
    "requirements": ("requirements",),
    "proposals": ("terms", "requirements"),
}

failures = []
checks = 0


def check(cond, msg):
    global checks
    checks += 1
    if not cond:
        failures.append(msg)
    return cond


def read(rel):
    with open(os.path.join(ROOT, rel)) as fh:
        return fh.read()


def load(rel):
    with open(os.path.join(ROOT, rel)) as fh:
        return json.load(fh)


def rust_str_slice(src, name):
    """The string literals of a `const NAME: &[&str] = &[...]` declaration."""
    m = re.search(rf"const {name}:\s*&\[&str\]\s*=\s*&\[(.*?)\];", src, re.S)
    if not m:
        return None
    return re.findall(r'"([^"]+)"', m.group(1))


def ts_str_array(src, name):
    """The string literals of a `const NAME = [...]` declaration in TypeScript."""
    m = re.search(rf"const {name}\s*(?::[^=]+)?=\s*\[(.*?)\]", src, re.S)
    if not m:
        return None
    return re.findall(r'"([^"]+)"', m.group(1))


# ── 1. the fixtures are well-formed ───────────────────────────────────────────
ev = load(EVAL_CASES)
ov = load(OVERLAY_CASES)

fixture_outcomes = ev.get("outcomes")
fixture_positive = ev.get("positive_outcomes")
check(isinstance(fixture_outcomes, list) and fixture_outcomes,
      f"{EVAL_CASES}: no `outcomes` list")
check(isinstance(fixture_positive, list) and fixture_positive,
      f"{EVAL_CASES}: no `positive_outcomes` list")
check(set(fixture_positive or []) <= set(fixture_outcomes or []),
      f"{EVAL_CASES}: positive_outcomes is not a subset of outcomes")

ev_names = [c.get("name") for c in ev.get("cases", [])]
check(len(ev_names) == len(set(ev_names)), f"{EVAL_CASES}: duplicate case names")
check(len(ev_names) >= 10, f"{EVAL_CASES}: only {len(ev_names)} cases")

# Both directions, or the suite is an assertion rather than a check.
expects = [c.get("expect") for c in ev.get("cases", [])]
check("refused" in expects, f"{EVAL_CASES}: no case expects a refusal")
check("accepted" in expects, f"{EVAL_CASES}: no case expects an acceptance")

for c in ev.get("cases", []):
    n = c.get("name", "?")
    check(c.get("expect") in ("accepted", "refused"),
          f"{EVAL_CASES}: {n}: expect must be accepted|refused")
    check(bool(c.get("why")), f"{EVAL_CASES}: {n}: no `why` — a case nobody can read is a case nobody will maintain")
    check(bool(c.get("author")), f"{EVAL_CASES}: {n}: no `author` — nothing is attributed to nobody")
    check(isinstance(c.get("body"), dict), f"{EVAL_CASES}: {n}: no `body`")
    if c.get("expect") == "accepted":
        check("message_contains" not in c,
              f"{EVAL_CASES}: {n}: an accepted case cannot assert a refusal message")

ov_names = [c.get("name") for c in ov.get("cases", [])]
check(len(ov_names) == len(set(ov_names)), f"{OVERLAY_CASES}: duplicate case names")
for c in ov.get("cases", []):
    n = c.get("name", "?")
    check(c.get("apply") in APPLY_TARGETS,
          f"{OVERLAY_CASES}: {n}: apply={c.get('apply')!r} is not one of {sorted(APPLY_TARGETS)}")
    check(bool(c.get("why")), f"{OVERLAY_CASES}: {n}: no `why`")
    check(isinstance(c.get("log"), list) and c["log"],
          f"{OVERLAY_CASES}: {n}: no `log`")
    for need in APPLY_TARGETS.get(c.get("apply"), ()):
        check(isinstance(c.get("corpus", {}).get(need), list),
              f"{OVERLAY_CASES}: {n}: apply={c['apply']} needs corpus.{need}")
    expect = c.get("expect", {})
    check(isinstance(expect.get("rows"), list) and expect["rows"],
          f"{OVERLAY_CASES}: {n}: no `expect.rows`")
    for r in expect.get("rows", []):
        check(isinstance(r.get("where"), dict) and r["where"],
              f"{OVERLAY_CASES}: {n}: a row assertion with no `where`")
        check(bool(r.get("fields")) or bool(r.get("absent")),
              f"{OVERLAY_CASES}: {n}: a row assertion that asserts nothing")
    for entry in c.get("log", []):
        check(("ops" in entry) != ("malformed" in entry),
              f"{OVERLAY_CASES}: {n}: a log entry must carry exactly one of ops|malformed")

# `pending means differs from the corpus` is the rule most likely to be lost in a
# port, and the only proof it survived is a case where the corpus already agrees.
check(any("absent" in r and "pending" in r["absent"]
          for c in ov.get("cases", []) for r in c.get("expect", {}).get("rows", [])),
      f"{OVERLAY_CASES}: no case asserts that an ADOPTED proposal stops being pending")

# ── 2. the Rust constants ─────────────────────────────────────────────────────
rs_eval = read(RS_EVAL)
rs_outcomes = rust_str_slice(rs_eval, "OUTCOMES")
rs_positive = rust_str_slice(rs_eval, "POSITIVE")

check(rs_outcomes is not None, f"{RS_EVAL}: no OUTCOMES slice")
check(rs_positive is not None, f"{RS_EVAL}: no POSITIVE slice")
if rs_outcomes is not None:
    check(rs_outcomes == fixture_outcomes,
          f"{RS_EVAL}: OUTCOMES is {rs_outcomes}, fixtures declare {fixture_outcomes}")
if rs_positive is not None:
    check(rs_positive == fixture_positive,
          f"{RS_EVAL}: POSITIVE is {rs_positive}, fixtures declare {fixture_positive}")
    # ⛔ The single most important constant in the repo. `Examined` is in POSITIVE
    # because its whole content is "there were records to look at" — over zero
    # there were not. Dropping it here is how a vacuous pass gets recorded under a
    # quieter name, and it is a one-word edit.
    check("Examined" in (rs_positive or []),
          f"{RS_EVAL}: POSITIVE no longer contains `Examined` — an Examined over "
          f"zero records is the same lie in a quieter voice")

# There must be no Unknown bucket; it would immediately become where anything
# awkward went.
check("Unknown" not in (rs_outcomes or []), f"{RS_EVAL}: OUTCOMES gained an `Unknown`")

# ── 3. re-derive every verdict from the constants alone ───────────────────────
# This is the cross-check that does not need a toolchain: the rule is small enough
# to state independently, so state it, and make the fixtures agree with it. If the
# rule and the fixtures disagree, one of them is wrong and a human must look.
def derive(body, outcomes, positive):
    """Return None if the measurement is admissible, else why it is refused."""
    def s(k):
        v = body.get(k)
        return v.strip() if isinstance(v, str) else ""

    if not s("claim"):
        return "claim"
    if not s("implementation"):
        return "implementation"
    if s("outcome") not in outcomes:
        return "outcome"
    pop = body.get("population")
    if pop is None:
        return "population" if s("outcome") in positive else None
    if not isinstance(pop, int) or isinstance(pop, bool):
        return "population"
    if pop == 0 and s("outcome") in positive:
        return "Vacuous"
    if pop < 0:
        return "population"
    return None


if rs_outcomes and rs_positive:
    for c in ev.get("cases", []):
        n = c.get("name", "?")
        why = derive(c.get("body", {}), rs_outcomes, rs_positive)
        want_refused = c.get("expect") == "refused"
        check(
            (why is not None) == want_refused,
            f"{EVAL_CASES}: {n}: fixtures expect {c.get('expect')}, but the rule "
            f"re-derived from {RS_EVAL}'s constants says "
            f"{'refused (' + str(why) + ')' if why else 'accepted'}",
        )

# ── 4. the TypeScript constants ───────────────────────────────────────────────
# ⛔ REQUIRED, not optional. This was guarded by an exists() check while the port
# was being written, and the guard outlived its reason: once the file was not
# staged as a Bazel data dep, the most valuable comparison in this file — the one
# that catches `Examined` being dropped from one implementation and not the other
# — skipped silently in CI and ran only on a laptop. A check that quietly does
# nothing is worse than no check, because it is counted.
ts_path = os.path.join(ROOT, TS_EVAL)
ts_present = os.path.exists(ts_path)
check(ts_present, f"{TS_EVAL} is missing or not staged — the Rust/TypeScript "
                  f"constant comparison cannot run, and skipping it silently is "
                  f"how the two implementations drift apart unnoticed")
if ts_present:
    ts_eval = read(TS_EVAL)
    ts_outcomes = ts_str_array(ts_eval, "OUTCOMES")
    ts_positive = ts_str_array(ts_eval, "POSITIVE")
    check(ts_outcomes is not None, f"{TS_EVAL}: no OUTCOMES array")
    check(ts_positive is not None, f"{TS_EVAL}: no POSITIVE array")
    if ts_outcomes is not None:
        check(ts_outcomes == fixture_outcomes,
              f"{TS_EVAL}: OUTCOMES is {ts_outcomes}, fixtures declare {fixture_outcomes}")
    if ts_positive is not None:
        check(ts_positive == fixture_positive,
              f"{TS_EVAL}: POSITIVE is {ts_positive}, fixtures declare {fixture_positive}")
        check("Examined" in (ts_positive or []),
              f"{TS_EVAL}: POSITIVE no longer contains `Examined`")

# ── 5. the reader may not read a field the vocabulary does not declare ────────
# ⛔ This is the check that would have caught two live bugs, and it is here
# because they were both found by hand.
#
# `overlay.rs::read` pulled `discipline` off an amendNS and `project` off an
# assertNS. `proposal.rs::OPS` declared neither, and `check_op` rejects unknown
# fields — so every "reword" and every "write a new requirement" answered 422 and
# appended nothing, while the overlay sat there expecting fields that could never
# arrive. The two halves of the write path disagreed, in the direction where the
# feature simply does not work, and nothing said so.
#
# Nothing in the type system connects a `s(op, "discipline")` to the OpSpec that
# permits it. So the connection is made here.
def strip_line_comments(src):
    return "\n".join(re.sub(r"//.*$", "", ln) for ln in src.split("\n"))


rs_proposal = strip_line_comments(read("services/spec/src/proposal.rs"))
ops_block = re.search(r"pub const OPS:.*?\n\];", rs_proposal, re.S)
check(ops_block is not None, "services/spec/src/proposal.rs: no OPS table")

op_fields = {}
if ops_block:
    for chunk in ops_block.group(0).split("OpSpec {")[1:]:
        kind = re.search(r'kind:\s*"(\w+)"', chunk)
        if not kind:
            continue
        allowed = set()
        for key in ("required", "optional", "exactly_one_of"):
            m = re.search(rf"{key}:\s*&\[(.*?)\]", chunk, re.S)
            if m:
                allowed |= set(re.findall(r'"([^"]+)"', m.group(1)))
        op_fields[kind.group(1)] = allowed
    check(len(op_fields) == 17,
          f"services/spec/src/proposal.rs: parsed {len(op_fields)} ops, expected 17")

rs_overlay = strip_line_comments(read(RS_OVERLAY))
read_fn = re.search(r"pub fn read\(.*?\n    \}", rs_overlay, re.S)
check(read_fn is not None, f"{RS_OVERLAY}: no `pub fn read`")
if read_fn and op_fields:
    body = read_fn.group(0)
    # Each arm runs from its `"kind" => {` marker to the next one.
    marks = [(m.start(), m.group(1)) for m in re.finditer(r'"(\w+)"\s*=>\s*\{', body)]
    for i, (pos, kind) in enumerate(marks):
        end = marks[i + 1][0] if i + 1 < len(marks) else len(body)
        arm = body[pos:end]
        if kind not in op_fields:
            check(False, f"{RS_OVERLAY}: replays `{kind}`, which is not in the OPS vocabulary")
            continue
        seen = set(re.findall(r's\(op,\s*"([^"]+)"\)', arm))
        # `scope(op, k)` reads `project` as well as the named field.
        for k in re.findall(r'scope\(op,\s*"([^"]+)"\)', arm):
            seen |= {k, "project"}
        for field in sorted(seen):
            check(
                field in op_fields[kind],
                f"{RS_OVERLAY}: the `{kind}` arm reads `{field}`, which "
                f"proposal.rs::OPS does not declare — the door would reject any op "
                f"carrying it, so the overlay expects a field that can never arrive",
            )

# ── 6. the conformance package is actually in the CI allowlist ────────────────
# ci.yml uses EXPLICIT package lists, not //..., so a gate can be added and never
# run. That is the same class of gap as a test wired to nothing: coverage that
# reads as coverage without touching the thing. Assert this package is named in
# both steps.
ci = read(".github/workflows/ci.yml")
for step in ("build", "test"):
    m = re.search(rf"- name: {step}\n\s+run: \|\n(.*?)(?=\n      - name:|\Z)", ci, re.S)
    check(m is not None and "//conformance/..." in m.group(1),
          f".github/workflows/ci.yml: the `{step}` step does not name //conformance/... "
          f"— this gate would exist and never run")

# ── 7. the pasteable bundle still matches the migrations ──────────────────────
# `console/db/bootstrap.sql` is the three migrations as one script, for a SQL
# console — the path someone takes when they have a database and not a checkout.
# It embeds each migration's sha256 as a ledger row, so a later `migrate.mjs`
# agrees they are applied. If a migration changes and the bundle is not
# regenerated, the two paths produce DIFFERENT databases and the ledger lies
# about which. Cheap to check, invisible when it breaks.
import hashlib

bundle_path = os.path.join(ROOT, "console/db/bootstrap.sql")
check(os.path.exists(bundle_path),
      "console/db/bootstrap.sql is missing or not staged — the two migration "
      "paths could then build different databases with nothing to say so")
if os.path.exists(bundle_path):
    bundle = read("console/db/bootstrap.sql")
    mig_dir = os.path.join(ROOT, "console/db/migrations")
    for name in sorted(os.listdir(mig_dir)):
        if not name.endswith(".sql"):
            continue
        with open(os.path.join(mig_dir, name), "rb") as fh:
            sha = hashlib.sha256(fh.read()).hexdigest()
        check(
            f"('{name}', '{sha}')" in bundle,
            f"console/db/bootstrap.sql is stale for {name} — re-run "
            f"`node console/db/bundle.mjs > console/db/bootstrap.sql`",
        )
        check(name in bundle, f"console/db/bootstrap.sql does not contain {name}")

# ── 8. the other two refusals still exist ─────────────────────────────────────
# The door is one of three independent places a vacuous pass is refused, and each
# is there because the others can be bypassed. Losing one silently is the failure.
materialize = read("tools/proposals/materialize.py")
check("DROPPED" in materialize and "is not a result" in materialize,
      "tools/proposals/materialize.py: the vacuous drop is gone — promotion would "
      "write the exact defect vacuous-invariant.rq exists to catch")
vacuous_rq = read("rdf/lint/authoring/vacuous-invariant.rq")
check("VACUOUS-PASS" in vacuous_rq and "NO-POPULATION" in vacuous_rq,
      "rdf/lint/authoring/vacuous-invariant.rq: lost one of its two branches")

# ⛔ THE GATE MUST NOT BE WEAKER THAN THE DOOR IT CONFIRMS.
#
# The door refuses every outcome in POSITIVE over a zero population. The gate
# listed only two of the three: `au:Examined` was missing, so an Examined/0
# record was refused at the write path and ADMITTED in the corpus. That is not a
# redundant check disagreeing about style — it is the independent confirmation
# being strictly weaker than the thing it confirms, which is the same shape as
# no confirmation at all, and it survived because nothing compared the two lists.
#
# Compared as SETS: order is meaningless in a SPARQL IN clause and meaningful in
# POSITIVE, so requiring a sequence here would fail for a reason that is not a
# defect.
m = re.search(r"FILTER\(\?outcome IN \(([^)]*)\)\)", vacuous_rq)
check(m is not None,
      "rdf/lint/authoring/vacuous-invariant.rq: no `FILTER(?outcome IN (...))` — "
      "the positive-outcome set cannot be compared against the door's")
if m is not None and fixture_positive:
    gated = {t.strip().removeprefix("au:") for t in m.group(1).split(",") if t.strip()}
    check(gated == set(fixture_positive),
          f"rdf/lint/authoring/vacuous-invariant.rq refuses {sorted(gated)} over a zero "
          f"population; the door refuses {sorted(fixture_positive)}. The gate that exists "
          f"to confirm the refusal independently is weaker than the refusal")

# ── 9. the decomposition rule, EXECUTED on both sides ─────────────────────────
#
# ⛔ This is the one rule in the repo where both implementations actually run the
# shared cases on an ordinary PR. Everywhere else the Rust half needs a
# credential that has been skipping (see the module docstring), so the fixtures
# are executed once and cross-checked by parsing constants. Here the original is
# stdlib Python, so it can simply be imported and called — no toolchain, no
# credential, no parsing of anything.
#
# It matters because the console PREVIEWS this rule while an author is still
# typing, and a preview that disagreed with the decomposer would be worse than no
# preview: it would be believed. 22 of Studio's 23 undecomposed requirements
# carry no markup at all, and nothing has ever told their authors that.
import importlib.util

DEC_CASES = "conformance/decomposition_cases.json"
TS_DECOMPOSE = "console/lib/decompose.ts"

dec = load(DEC_CASES)
dec_cases = dec.get("cases", [])
check(len(dec_cases) >= 10, f"{DEC_CASES}: only {len(dec_cases)} cases")

# Both directions, or the suite is passed trivially by a decomposer that marks
# everything — or by one that marks nothing, which is the actual failure mode.
check(any(not c.get("terms") for c in dec_cases),
      f"{DEC_CASES}: no case expects an EMPTY decomposition — the state 22 of "
      f"Studio's 23 undecomposed requirements are in")
check(any(c.get("terms") for c in dec_cases),
      f"{DEC_CASES}: no case expects any terms")
for c in dec_cases:
    check(bool(c.get("why")), f"{DEC_CASES}: {c.get('name', '?')}: no `why`")

# ⚠ Bytecode writing off BEFORE the import. Under `bazel test` the runfiles tree
# is not a place to be creating `__pycache__`, and a checker that fails because it
# tried to write next to the file it was reading would be an infuriating way to
# learn that.
sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location("_decompose", os.path.join(ROOT, "tools/import/decompose.py"))
_dec_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_dec_mod)

check(_dec_mod.MAX_TERM_WORDS == dec.get("max_term_words"),
      f"tools/import/decompose.py: MAX_TERM_WORDS is {_dec_mod.MAX_TERM_WORDS}, "
      f"{DEC_CASES} declares {dec.get('max_term_words')}")

# The TypeScript constant is compared against the FIXTURE too, never against the
# Python one. Two constants agreeing with a third is checkable from either side;
# two agreeing with each other is a coincidence nobody re-checks.
ts_dec = read(TS_DECOMPOSE)
_ts_max = re.search(r"MAX_TERM_WORDS\s*=\s*(\d+)", ts_dec)
check(_ts_max is not None, f"{TS_DECOMPOSE}: no MAX_TERM_WORDS")
if _ts_max is not None:
    check(int(_ts_max.group(1)) == dec.get("max_term_words"),
          f"{TS_DECOMPOSE}: MAX_TERM_WORDS is {_ts_max.group(1)}, "
          f"{DEC_CASES} declares {dec.get('max_term_words')}")

for c in dec_cases:
    got = [{"surface": s, "source": src} for s, src in _dec_mod.extract(c.get("predicate", ""))]
    check(got == c.get("terms"),
          f"tools/import/decompose.py disagrees with {DEC_CASES} on "
          f"{c.get('name', '?')!r}: extracted {got}, fixture declares {c.get('terms')}")

# ── report ────────────────────────────────────────────────────────────────────
if failures:
    print(f"FAIL — {len(failures)} of {checks} checks failed:\n", file=sys.stderr)
    for f in failures:
        print(f"  * {f}", file=sys.stderr)
    sys.exit(1)
print(f"OK — {checks} checks passed over {len(ev_names)} evaluation "
      f"and {len(ov_names)} overlay cases")
print(f"     outcomes: {', '.join(rs_outcomes or [])}")
print(f"     positive: {', '.join(rs_positive or [])}  (zero makes every one of these meaningless)")
print(f"     typescript: {'checked' if ts_present else 'not present yet — ' + TS_EVAL}")
