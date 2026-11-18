# Dispatch log integrity and rollback witness

The native dispatch log (`$SPEC_DISPATCH_LOG`, JSONL) is the source of truth
for which orders are running, which reservations are held, and how much spend
has been recorded. `Running::read` replays it on every native request and fails
closed when it cannot read it. Two failure modes were not covered before this
change.

## Hash chain

Every line appended to the dispatch log now carries:
- `seq`: its 1-based position among the log's non-empty lines;
- `prev`: the hex sha256 of the previous line's text, or 64 zeros on line 1.

Replay verifies both, so editing, deleting or reordering any earlier line fails
closed with "breaks the hash chain". Lines written before this change have no
`seq`/`prev` and are accepted as a legacy prefix. Once a chained line appears,
an unchained line after it is refused. Only the dispatch log is chained
(`ProposalLog::dispatch`); the proposal and evaluation logs are unchanged.

## Torn tail

Appends acknowledge only after the line and its newline are fsynced. A crash
mid-append can therefore leave at most one unterminated final line, and that
write was never acknowledged. Replay ignores an unterminated tail instead of
refusing every native route, and the next append truncates it before linking
its own line. A malformed line that does end in a newline is still fatal: it
was acknowledged, so its loss is real.

## Rollback witness

A log that is deleted, or restored from an older copy, replays cleanly: it just
has less history. Spec cannot detect that alone, and an empty log means
"nothing is running", which frees every held reservation. Detection needs a
witness outside the volume.

`GET /workorder/gate?order_id=…&anchor_seq=K` adds two fields:
- `dispatch_head {seq, sha256}`: the current head;
- `dispatch_anchor {seq: K, sha256}`: the hash of line K in the current log.

If the log no longer reaches K, the response is 409 `E_DISPATCH_LOG_REGRESSED`.
Without `anchor_seq` the response is unchanged, for observers that don't
witness.

The fleet's spec observer is the witness. It stores the head it last published
with its gate (in the authority namespace, a different failure domain from the
PVC) and asks for that position as the anchor. A regressed or forked log then
stops gate publication, the gate expires, and fleet admission fails closed
instead of reusing freed scopes. See the fleet's `docs/work-storage-recovery.md`.

## What this does not do

- Repair: a broken chain or a regressed log needs an operator, following the
  recovery runbook.
- Compaction or a size cap: the log still grows without bound and is replayed
  in full.
- Detect a rollback with no witness: an instance with no observer, or one whose
  witness state was restored to the same older point, cannot tell.
