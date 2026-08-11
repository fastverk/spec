# Conformance — one set of cases, every implementation

The safety rules in this repo are about to exist twice. `services/spec` implements
the vacuous refusal, the pending overlay and the adoption computation in Rust for
the Bazel/plugin plane; the hosted console implements the same three rules in
TypeScript because Vercel has no Rust runtime and no filesystem to append to.

**Two implementations of a safety rule diverge silently.** Not loudly — silently,
because each one keeps passing its own tests while they drift apart, and the tests
are the only thing anybody looks at. The rule that decides whether a green build
tested anything is the worst possible candidate for that.

So the cases live here, in a language nobody's implementation is written in, and
every implementation executes *these* rather than a hand-ported copy of them.
Porting the tests alongside the logic would have left two suites free to drift in
exactly the way the two implementations are.

## The files

| file | rule | executed by |
|---|---|---|
| `evaluation_cases.json` | zero is an exception, never a pass | `services/spec/src/evaluation.rs`, `console/lib/evaluation.ts` |
| `overlay_cases.json` | pending means *differs from the corpus*; adoption is measured against the corpus | `services/spec/src/overlay.rs`, `console/lib/overlay.ts` |

Both carry cases in **both directions**. A check only ever shown to accept is an
assertion, so every file asserts what must be refused *and* what must not be —
`Vacuous` over zero records is fine, `Examined` over zero records is not, and a
suite that only proved the first would pass while the refusal was deleted.

## `check_conformance.py` — why a third thing checks the other two

`//services/spec:spec_test` runs only when CI can mint a token for the private
plugin crates (`.github/workflows/ci.yml`, the `plugin` step, `continue-on-error:
true`). It has been skipping. So "Rust and TypeScript both run the fixtures" is
true and *not sufficient*: on a normal PR only the TypeScript half actually
executes, and a divergence introduced on the Rust side would be reported by
nothing.

`check_conformance.py` closes as much of that as can be closed without a Rust
toolchain. It is stdlib-only Python in the idiom of
`tools/readmodel/check_wiring.py` — it regex-parses the *constants* out of the
Rust and TypeScript sources and re-derives every `evaluation_cases.json` verdict
from them independently. Deleting `"Examined"` from Rust's `POSITIVE`, or from
TypeScript's, is then a failing check on an ordinary PR with no credential and no
toolchain.

⚠ **The residual hole, stated plainly.** This checks the *data* the rule is made
of, not the code that reads it. A change to the control flow in
`evaluation::check` — reordering the guards so the zero-check becomes
unreachable, say — would leave the constants intact and pass. Only
`//services/spec:spec_test` catches that, and it needs the credential fixed.
Everything here is a mitigation for that being broken, not a replacement for it.

## Running them

```sh
python3 conformance/check_conformance.py     # constants agree, verdicts re-derive
bazel test //conformance:conformance_test    # the same, as a gate
cd console && pnpm vitest run                # TypeScript executes the fixtures
bazel test //services/spec:spec_test         # Rust executes them (needs the token)
```

## Adding a case

Add it to the JSON and nothing else. Both implementations enumerate the file, so
a case with no counterpart fails on whichever side has not implemented it — which
is the entire point. Do not add a case to one language's suite directly.
