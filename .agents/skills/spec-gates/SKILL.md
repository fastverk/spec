---
name: spec-gates
description: Run spec's gates (ledger, SPARQL/ARQ authoring and corpus gates, Lean proof audit, grounding, conformance, read-model wiring) and interpret results, including vacuous passes and skipped coverage.
---

# Run and interpret the gates

Start from the change: which surface did it touch? Pick the narrowest gates that
cover it, then widen. Run from the repository root.

| Touched | Run |
| --- | --- |
| `LEDGER.md`, top-level dirs | `bash tools/ledger-check.sh` |
| `conformance/`, Rust/TS safety rules | `python3 conformance/check_conformance.py`, console vitest |
| `rdf/`, `corpus/` | `bazel --nohome_rc test //rdf/... //corpus/...` |
| `lean/` | `bazel --nohome_rc test //lean/...` (includes `//lean:audit_proofs_test`) |
| `grounding/`, `:provenBy` links | `bazel --nohome_rc test //grounding/...` |
| `tools/readmodel/`, `services/spec/ui/` | `python3 tools/readmodel/check_wiring.py`, `python3 tools/readmodel/compile_panels.py`, `bazel --nohome_rc test //tools/...` |
| `console/` | `cd console && pnpm exec tsc --noEmit && pnpm exec vitest run` |
| public `.bzl` / module deps | consumer smoke with `--override_module=spec=<checkout>` |

The authoritative lists are the `build` and `test` steps of
`.github/workflows/ci.yml`; use them for a full run.

Interpret, do not just read exit codes:

- **Population first.** Authoring gates pair `<gate>.rq` with
  `<gate>.population.rq`. A gate that examined zero rows has proved nothing;
  report the population alongside the verdict. `population_coverage_test.sh`
  fails a gate added without one.
- **ARQ is authoritative.** If you reproduce a gate under rdflib
  (`docs/running-locally.md` §3) and it disagrees, the rdflib run is wrong. Known:
  `conflict-hygiene-strict` finds 3 of 4 planted defects under rdflib.
- **Planted defects.** `rdf/lint/authoring/fixtures/` holds TTL each authoring gate must catch. A
  gate edit that stops catching its fixture is a regression even if the corpus
  still passes.
- **Proof audit.** A new axiom needs a line in `lean/axiom_baseline.txt` and a
  justification; a `sorry` or `native_decide` is never acceptable on main.
- **Skipped is not green.** `//services/spec:spec_test` needs the private plugin
  crates; if it was skipped, say so. `check_conformance.py` covers the constants
  of the Rust rules, not their control flow.

Report the commands run, per-gate verdicts with populations, anything skipped and
why, and pre-existing failures separately from regressions.
