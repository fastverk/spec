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
2. **It is what let `materialize.py` be gated.** Every gate runs over
   `corpus/<project>/proposals.ttl` as committed, so until the snapshot existed
   *nothing* checked that it corresponded to any log — a hand-edited
   `proposals.ttl` passed everything, and invariant ⑥ was a comment.
   `//corpus/studio:proposals_ttl_matches_the_log` re-materializes from the
   snapshot and fails if the TTL differs, both ways: editing the TTL fails, and
   adding a log line without promoting it fails. Without a committed snapshot
   that check could only run against live Neon, where the answer changes between
   a PR opening and merging — a non-deterministic gate, which is worse than none.
3. **Promotion becomes reproducible offline**, with no database.

Cost: a growing committed file, kilobytes per year at human write rates. If that
ever stops being fine, shard by year. Never rotate — rotation is deletion with a
schedule.

## What `log_seq` is, and is not

It replaces the JSONL byte offset in the 202 response. It is a server-assigned
handle, monotone within one log. It is **not** a content address.

~~this console has no hash primitive, and the address is computed by the door in
the build. A fabricated address is strictly worse than an absent one, so
`address` stays `null` with its reason named beside it.~~ **Since #44 there is a
door and it is here**, so the 202 carries a real `address` alongside `log_seq`,
and migration `0004` gives the table a column for it. The two are different kinds
of thing and both are worth having:

| | `log_seq` | `address` |
|---|---|---|
| assigned by | the database | the proposal's own bytes |
| unique | yes, within one log | **no, deliberately** |
| survives an export/reimport | no | yes |
| answers | "did my write land, and in what order" | "which proposal is this" |

⛔ **Not unique, and the index is not either.** Two identical proposals from one
author against one read point have the same address BY CONSTRUCTION — that is
what content addressing means — and both belong in the log. A unique index would
turn "I clicked twice" into a 500 and, worse, would turn a second author's
independent agreement into an error. `0001` refuses to make `line` unique for the
same reason. Deduplication is a read-side question; later wins.

## The door's two columns

`address` and `verdict` (`0004`), both derived from the line and both unable to
lie about it — the same arrangement as `decomposition_matches_the_line` in
`0001`. They are nullable for exactly one reason: rows written before that
migration have neither. `the_door_wrote_both_or_neither` makes "pre-door" a whole
state rather than a per-column accident, and `spec.append_proposal` raises if
either is missing, so the null state can be read and never created.

A pre-door row is still nameable: `tools/proposals/replay.py` recomputes every
address from the record's own `canonical` bytes and never reads the column —
which is also how it catches a record whose stored address is not the address of
its own body, and refuses to replay the log at all when it finds one.

`verdict` is `Admitted` or `Queued`. **Never `Rejected`**: a refused proposal is
not appended, so the value cannot legitimately occur — and `console/lib/overlay.ts`,
`services/spec/src/overlay.rs` and `tools/proposals/materialize.py` each refuse to
replay a record carrying it, because a decision nothing downstream honours is
decoration.
