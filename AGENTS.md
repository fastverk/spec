# Working on spec

`fastverk/spec` is the spec / corpus spine vehicle: Lean proofs, RDF ontology
and SPARQL gates, flagship corpora, the grounding console, and the Eve markup
assistant. It publishes one Bazel module, `spec`. Read
[the development rules](.agents/rules/development.md) before changing anything,
and [LEDGER.md](LEDGER.md) before adding or moving a top-level directory.

Reusable workflows live in `.agents/skills/`; `.agents` is also the portable
`spec` plugin root (same layout as [mattmarshall/scope](https://github.com/mattmarshall/scope)).
`.agents/` configures coding agents working on this repo. It is unrelated to
`agent/` (the Eve markup assistant product) and to the excluded `agents/` fleet.

| Path | What it is |
| --- | --- |
| `lean/` | Lean spec libraries and the sorry/axiom ratchet |
| `rdf/` | ontology, SPARQL gates (`gates.bzl`, `authoring_gates.bzl`), read-model queries |
| `corpus/` | flagship corpora (`studio`, `ampere`, …) and measures |
| `grounding/`, `java/` | Jena tooling: `grounding_verified`, adversarial gate, `kg.*` |
| `services/spec/` | Rust spec plugin (gRPC + HTTP facade) and read-model payloads |
| `console/` | hosted authoring console (Next.js) |
| `agent/` | Eve markup assistant |
| `conformance/` | cases every Rust/TS implementation of a safety rule executes |
| `tools/` | import, decomposition, proposals, read model, runtime |
| `smoke/consumer/` | unpublished module that resolves `spec` the way consumers do |
| `docs/` | RFCs, runtime notes, releasing, onboarding |

Apply the relevant workflow:

- `spec-gates`: pick, run and interpret the gates for a change.
- `spec-corpus`: import, decompose, propose and materialize requirements without
  inventing evidence.
- `spec-consumer`: wire another repository's corpus to spec's gates.
- `spec-release`: cut a `spec` module release end to end.

Quick checks without Bazel:

```sh
bash tools/ledger-check.sh
bash tools/agents-check.sh
python3 conformance/check_conformance.py
python3 tools/readmodel/check_wiring.py
python3 tools/readmodel/compile_panels.py
```

Full CI is `.github/workflows/ci.yml` (Bazel with `--nohome_rc`).

Install the plugin in Codex from any directory:

```sh
codex plugin marketplace add /absolute/path/to/spec
codex plugin add spec@spec-local
```
