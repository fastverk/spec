# The logs, as tables

Two append-only tables replacing the two JSONL files. Nothing else moves: the
corpus stays generated and gated in CI, and `tools/proposals/materialize.py`
still reads JSONL, because promotion is what puts a judgement in front of the
gates.

## Migrations

Plain numbered SQL, applied by `node db/migrate.mjs`. Deliberately not a
schema-diff tool: the DDL here **is** the invariant. A tool that emitted
`DROP CONSTRAINT zero_is_an_exception_never_a_pass` to reconcile a model with a
database would unmake invariant ③ silently, and none of them handle roles,
grants and triggers well anyway.

⛔ **They do not run on Vercel.** Three reasons, the third decisive:

1. Vercel builds run for every deployment including previews, so a build-time
   migration reaches whatever database that preview points at.
2. Builds run concurrently and would serialize on the advisory lock.
3. The role separation only works if migrations are not in the app. Running them
   from Vercel means the **owner** credential lives in the web tier's
   environment — and the owner is exactly the role that can `DISABLE TRIGGER`
   and delete. That hands the web tier the power to erase an append-only log.

They run from CI on `main`, against a GitHub Environment secret behind a
required reviewer.

⚠ **Preview deployments must get their own Neon branch.** Non-negotiable here
specifically because the log is unpurgeable by design: a preview writing to
production puts a record in the permanent log that nobody can remove.

## Export — the promotion path

The `line` column holds the record verbatim, so export is a `SELECT` and not a
serializer. That matters: a re-serializing exporter could reorder keys, and
`canonical` is the pre-image of a content address.

```sh
psql "$NEON_EXPORT_URL" -X -A -t -q --no-psqlrc -v ON_ERROR_STOP=1 \
  -c "SELECT line FROM spec.proposal_log   WHERE seq <= $THROUGH ORDER BY seq" \
  > logs/proposals.jsonl
psql "$NEON_EXPORT_URL" -X -A -t -q --no-psqlrc -v ON_ERROR_STOP=1 \
  -c "SELECT line FROM spec.evaluation_log WHERE seq <= $THROUGH ORDER BY seq" \
  > logs/evaluations.jsonl
```

`-A` unaligned, `-t` tuples-only, one column so there is no separator ambiguity,
and `spec.log_line` guarantees no embedded line terminator of any flavour Python
recognises. `ORDER BY seq`, never `written_at` — clock skew across compute nodes,
and ties.

`$THROUGH` pins which records a promotion covers, so a proposal appended while CI
is running is not half-included.

Then the existing path, unchanged:

```sh
python3 tools/proposals/materialize.py \
    --log logs/proposals.jsonl --evaluations logs/evaluations.jsonl \
    --corpus corpus/studio --project studio
python3 tools/readmodel/emit_readmodel.py
bazel test //corpus/... //rdf/... //conformance/... //tools/...
```

## Why the export is committed

`logs/*.jsonl` is committed, not a build artifact. Three consequences:

1. **It gives the log a second copy under review.** Postgres cannot defend
   against its own owner; a git diff that removes a line is visible forever and
   requires an approval. That is the outside-the-database half of invariant ②.
2. **It lets `materialize.py` finally be gated.** Today `corpus/studio/
   proposals.ttl` is checked by the gates as committed, and *nothing* checks that
   it corresponds to any log — a hand-edited `proposals.ttl` passes everything.
   With the snapshot committed, "re-materializing produces no diff" is a
   deterministic test. Without it, that check could only run against live Neon,
   where the answer changes between PR open and merge.
3. **Promotion becomes reproducible offline**, with no database.

Cost: a growing committed file, kilobytes per year at human write rates. If that
ever stops being fine, shard by year. Never rotate — rotation is deletion with a
schedule.

## What `log_seq` is, and is not

It replaces the JSONL byte offset in the 202 response. It is a server-assigned
handle, monotone within one log. It is **not** a content address: this console
has no hash primitive, and the address is computed by the door in the build. A
fabricated address is strictly worse than an absent one, so `address` stays
`null` with its reason named beside it.
