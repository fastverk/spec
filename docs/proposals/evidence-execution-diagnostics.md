# Retain actual evidence execution failures

Status: implemented local candidate, with exact-head gates and consumer adoption
pending; not an accepted execution contract or a merge waiver. Owner: the evidence evaluator maintainers. The consumer's existing
formal and evaluator pins remain unchanged until a separately reviewed adoption.

## Observed defect

At the current source, `tools/evidence/assessment.py:execute` captures producer
stdout and stderr in memory. After normal termination it retains a stdout digest,
but not the stdout bytes, stderr bytes, or exit code. It catches execution,
timeout, and observation-parsing exceptions as `EVIDENCE_STATE_FAILED` without
retaining their cause. Consequently a failed receipt with no observation cannot
explain whether the command timed out, failed to start, exited unsuccessfully,
or printed an invalid observation. A later successful execution cannot recover
the missing original diagnostic.

Keep every historical receipt unchanged. Do not assign a cause from elapsed time
alone, reconstruct unavailable bytes, or retimestamp a successful retry. Failure
state and its diagnostic evidence must remain separate from a human decision.

## Proposed contract

Use additive protobuf messages in `proto/spec/v1/evidence.proto` for execution
records and artifact bindings. Keep all existing field numbers and independent
evidence dimensions. Store raw command output outside observations and ledgers.

An execution record binds a unique execution identity, check/definition identity,
actual argument vector and working repository, declared source bindings and
actual revision/tree identities, evaluator revision/hash, resolved executable
path/hash, explicit effective timeout, and actual start/completion times. Distinct
fields retain process termination, optional actual exit code, observation
interpretation, and post-execution source freshness. A timeout is not an inferred
exit code; successful process exit is not a valid observation or a current proof.
The executable binding does not claim a hermetic dynamic-library/tool closure.

A completed record binds exact stdout, stderr, and error-detail artifact bytes
through relative paths, SHA-256, and byte sizes. Error detail remains private,
including exception type and actual available diagnostic; do not copy raw logs
into `EvidenceObservation`, assessment explanations, or public CI summaries.
Evidence receipts reference the immutable typed record. A malformed observation
must retain its original bytes without creating a partial successful observation.

The CLI supplies an explicit artifact root, defaulting to a dedicated sibling of
the ledger. New directories are private, and files are exclusively created with
private permissions. Refuse symlink escapes, reused execution identities, and
attempts to overlap the manifest, ledger, lock, decision, report, or declared
source files. Existing unrelated files are never overwritten. Stream child output
to these files rather than retaining unbounded output in memory. Completed
artifacts are flushed and made durable before the final receipt is published.
Assessment must independently validate all referenced record/output bytes and
identity relationships against the selected current check. Missing, modified,
substituted, escaped, or stale artifacts cannot establish CURRENT evidence.

Persist a typed STARTED record before launching the producer. Design its ledger
boundary explicitly: interruption must not leave an older successful receipt as
the apparent latest execution. The implementation appends a nonpassing start receipt
and a distinct final receipt related by the execution identity; it never edits an
earlier receipt. The revision-bound evidence guide documents review idempotency,
latest-check selection, ledger locking, and historical readers behave. Do not
claim interruption recovery solely because an unreferenced file exists.

Run the producer in a dedicated process group. Timeout and caller cancellation
must terminate and reap the process group, including descendants retaining output
pipes. Retain partial output and actual termination details. Explicit cancellation
must stop subsequent selected checks after its nonpassing result is durably
recorded. A hard evaluator crash leaves a pending record, not a successful or
retrospectively classified command. Any recovery policy must preserve this
uncertainty and bind the original execution rather than invent an observation.

## Required regression evidence

Use real subprocesses and actual Git fixtures, with no arbitrary sleep longer
than necessary to cross a short test deadline. Retain planted defects before and
after repair.

- Normal success and a producer-reported FAIL/EXAMINED/SKIPPED/VACUOUS result:
  byte-exact stdout/stderr, actual exit status, and unchanged independent states.
- Nonzero exit that also prints a plausible passing observation: still FAILED,
  with its real exit code and both output streams retained.
- Missing executable, invalid working execution, invalid UTF-8, malformed JSON,
  unknown protobuf fields, and invalid observation: distinct actual failures;
  original diagnostics retained and no partial successful observation published.
- Timeout with flushed partial output and a child/grandchild: no surviving side
  effects after the deadline, no fabricated exit status, and retained failure.
- Cancellation during execution: pending/final history preserved, descendants
  reaped, no subsequent selected command executed, and caller cancellation kept.
- Source or executable mutation during execution, artifact tampering/deletion,
  counterfeit record identity, missing/forged output, path/symlink escape, and
  storage failure: refuse promotion without altering preceding history.
- Passing receipt followed by failed or interrupted execution: assessment cannot
  hide the later attempt behind the earlier pass. Retrying appends distinct real
  observations and preserves both failure and explicit human-review history.
- Actual CLI writer serialization, private artifact permissions, atomic durable
  publication, original output/report protections, and complete source binding.

Run affected assessment/CLI/review tests, schema and consumer gates, then the
upstream's exact-head CI. Consumer adoption is a separate pinned change with
actual receipt replay and its existing strict gates and fresh authenticated Note
acceptance. Changing the evaluator/schema invalidates its earlier receipts and
can change explicit review requests; do not silently transfer approvals onto a
new request. No release, deployment, access widening, or existing gate exception
is part of this proposal.
