# A read model from a corpus that is not this repository's

⛔ **Not a second corpus.** These are eight payloads emitted by the real
`tools/readmodel/emit_readmodel.py` over `rdf/lint/authoring/fixtures/envelope-clean.ttl`
— spec's own negative-control fixture, the file every gate must stay silent on.
They stand in for an external consumer's read model, which by #52's data boundary
can never be committed here.

They exist so two things can be tested that could not be tested before:

1. **`lib/readmodel.ts::ingest` over payloads it did not ship with.** The rules
   were real before this and welded to one set of files, so nothing could ask
   "would a consumer's payloads pass?" These are a payload set that arrived from
   somewhere else, with a different `corpus_version` (`corpus:73b24f9938dc48f4`)
   and its own project name (`fixture`).
2. **The `@readmodel/` seam, end to end.** `next build` with
   `SPEC_READMODEL_DIR` pointed here bakes THIS `corpus_version` into the bundle
   instead of the flagship's — which is the whole of #52's console half, and the
   thing that silently did nothing on the first attempt (see the ⛔ note in
   `next.config.mjs`).

## Regenerating

```sh
mkdir -p /tmp/fixture-corpus
cp rdf/lint/authoring/fixtures/envelope-clean.ttl /tmp/fixture-corpus/
python3 tools/readmodel/emit_readmodel.py \
    --out console/test/fixtures/readmodel --corpus fixture=/tmp/fixture-corpus
rm console/test/fixtures/readmodel/describe.web_routes.json   # the console imports eight
```

⚠ **Not drift-gated, and neither are the flagship's payloads.** Re-emitting needs
`rdflib`, which the console CI job does not install and the Bazel gate job does
not have — the same gap `services/spec/readmodel/*.json` has carried since it was
written. `tools/readmodel/check_wiring.py` checks these against the route→field
table, which catches the envelope changing shape; it does not catch the corpus
moving underneath them. Say so rather than imply a freshness nobody enforces.
