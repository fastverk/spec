---
name: spec-corpus
description: Import, decompose, propose and promote requirements in a spec corpus without inventing evidence — R0 import with stalls, markup-based term extraction, the proposal door, and materialization.
---

# Author a corpus honestly

A corpus is a directory of TTL files under `corpus/<name>/` (or a consumer's
equivalent), one file per act: imported claims (`corpus.ttl`), disciplines,
named holes from decomposition (`terms.ttl`), promoted proposals
(`proposals.ttl`). Read `docs/rfc-002-authoring-plane.md` and an existing corpus
(`corpus/studio/`, `corpus/ampere/`) before writing a new one.

## The ladder

1. **Import (R0).** Parse the source document; do not transcribe it by hand.
   `tools/import/authreq_to_ttl.py` is the worked example: it records the source
   fingerprint, lands every claim at R0 with a mandatory `au:stalledOn`, marks
   modality as machine-proposed, and keeps retired ids as tombstones.
2. **Decompose (R0 → R2).** `python3 tools/import/decompose.py --corpus <dir>`
   extracts terms from the author's own markup (`code` spans, **emphasis**).
   Unmarked claims stay at R0 — that is a finding, not a gap to paper over. An
   LLM decomposer (see `fastverk/decomposer`) may *suggest* holes for review; it
   must never promote a rung or bind a term.
3. **Propose.** Changes go through the door: an append to the proposal log
   (`logs/proposals.jsonl`, or the console's `POST` routes, see
   `docs/running-locally.md`). Never edit the log or the corpus in place to
   "fix" a proposal; write another proposal.
4. **Materialize.** `tools/proposals/materialize.py` turns admitted proposals
   into TTL; `tools/proposals/check_materialized.sh` and `replay_test.sh` prove
   the committed TTL equals a replay of the log.

## Rules

- Never hand-set `au:rung`; promotion carries `au:promotedBy` and is checked by
  `ladder-integrity.rq`.
- Binding a term is a person confirming a referent against a population. A
  machine may name holes; it may not fill them.
- Keep the corpus directory pure: fixtures and overlays go in a subdirectory.
- Wire every new corpus into an `rdf_dataset` with `deps = ["//rdf:authoring_vocab"]`
  (consumers: `@spec//rdf:authoring_vocab`) and the gate macros, else the
  authoring gates pass vacuously.
- Regenerate the read model after corpus changes and run `spec-gates`.

Report: claims per rung before/after, stalls introduced or cleared, proposals
written, and any claim left at R0 with the reason.
