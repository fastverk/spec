# The append-only logs, as committed snapshots

Two JSONL files, one record per line, in append order. Empty today.

## Why they are in git

`corpus/<project>/proposals.ttl` is generated from these by
`tools/proposals/materialize.py`, and the gates run over the result. Until these
files existed, **nothing checked that `proposals.ttl` corresponded to any log** —
a hand-edited one passed every gate in the repo, which made invariant ⑥ ("the
corpus is generated — edit by re-running a tool or making a proposal") false in
practice.

`//corpus/studio:proposals_ttl_matches_the_log` closes that. It re-materializes
from these files and fails if the result differs from what is committed.

Three other things follow from committing them, and the second is the one that
matters most:

1. **Promotion is reproducible offline.** Anyone can re-run `materialize.py` with
   no database and get the same TTL.
2. **The log gets a second copy under review.** Postgres cannot defend against
   its own owner — a role that can `ALTER TABLE ... DISABLE TRIGGER` can delete.
   A row can vanish from a table without trace; a line cannot vanish from a
   reviewed diff. This is the outside-the-database half of invariant ②.
3. **The gate is deterministic.** Checked against live Neon instead, the answer
   would change between a PR opening and merging, which is worse than no gate.

## How they get updated

Not by hand. `.github/workflows/promote.yml` (daily, or on dispatch) runs
`tools/proposals/promote.sh`, which exports from Neon with the SELECT-only
credential — pinned, `WHERE seq <= $THROUGH`, the pins taken once before either
export so the two files describe one moment — and commits the result alongside
the regenerated TTL and read model in one PR:

```sh
psql "$NEON_EXPORT_URL" -X -A -t -q --no-psqlrc -v ON_ERROR_STOP=1 \
  -c "SELECT line FROM spec.proposal_log WHERE seq <= $THROUGH ORDER BY seq" > logs/proposals.jsonl
```

See `console/db/README.md` for why export is a `SELECT` of a stored line rather
than a serializer, and `docs/rfc-003-hosted-console.md` §8 for the whole loop.

## Every record has a name

Since #44 a proposal carries a content address — `sha256:` over the canonical
JSON of `{author, ops, parent}`, RFC-002 §5's `Proposal.id` — and the door's
`au:Verdict` beside it. Both are in the line and in their own columns, and a
CHECK stops the two from disagreeing.

```sh
python3 tools/proposals/replay.py --list
python3 tools/proposals/replay.py --address sha256:… --project studio \
    --corpus corpus/studio --check
```

`--check` re-materializes the log PREFIX ending at that record and compares it
byte for byte with the committed TTL — RFC-002 §12's P1 gate. Replaying the last
record must reproduce `corpus/<project>/proposals.ttl` exactly, which is what
`//corpus/studio:proposals_ttl_matches_the_log` asserts by a different route;
replaying an earlier one reproduces the corpus as it stood after that proposal,
which is not committed anywhere and is the point.

⛔ **The address is recomputed from each record's own bytes, never read from the
`address` field.** The field is then compared against the recomputation and a
disagreement stops the replay — a record that lies about its own name is the one
failure this can detect and nothing else can. It is also why records written
before the door (which carry no `address` at all) replay perfectly well: their
name was always implied by their bytes.

⚠ The evaluation log is passed WHOLE, not truncated. It is a separate ordering —
measurements, not judgements — and a proposal's address says nothing about which
measurements had been taken when it was made.

⚠ Both files are still **empty**, so every gate over them is examining nothing.
`//tools/proposals:replay_test` therefore runs over a fixture log that plants a
record the door refused and a record that lies about its name, and fails if either
goes undetected. When the first promotion lands, the gate over the real log stops
being vacuous — see RFC-002 §12.2.

⚠ **Append only, and never rotated.** Rotation is deletion with a schedule. At
human write rates this grows by kilobytes a year; if that ever stops being fine,
shard by year rather than truncating.

⚠ Empty is not the same as absent. An empty file means no proposal has been
promoted yet. A missing file means nobody can tell.
