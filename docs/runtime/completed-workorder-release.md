# Release of a completed WorkOrder attempt

`POST /workorder/release-completed` implements the ProtoJSON projection of
`spec.v1.ReleaseCompletedWorkOrder`. It releases the active source reservation
of a bound execution that reached a fleet terminal state, `EXECUTION_STATE_SUCCEEDED`
or `EXECUTION_STATE_FAILED`, with authoritative FINAL usage of any size, zero
included. Canceled attempts keep [their own door](canceled-workorder-release.md).
Release frees capacity for a next attempt. It does not accept output, it does not
depend on any review verdict (rejected output still frees capacity), and it does
not reclaim the retained fleet Job or its finalizer.

## What the native service checks itself

Spend recorded on the order **after this reservation was appended** must cover
`final_consumed_tokens`. Spend is a per-order cumulative high-water mark, so the
service replays the log, takes the high-water at the reservation row as the
baseline, and refuses with `409 E_SPEND_NOT_RECORDED` while the difference is
smaller than the FINAL figure. The response reports both numbers. The assigned
meter must report through `POST /workorder/spend` first: capacity is never freed
while metered usage is missing from the ledger, and a stale report below the
high-water mark adds nothing. Release never reduces or refunds spend. Spend
from an earlier attempt does not count toward a later one.

The same rule holds on replay: a well-formed `released_completed` row that the
ledger does not cover is treated as a forged or reordered log, and scope
observation fails closed.

## What it trusts the verifier for

Everything else is an attestation by the trusted gateway, as with the canceled
door. The verifier must authenticate the original approving UID with current
fleet TokenReview/SAR, recover the exact immutable approval, and read the actual
execution and drain receipt over verified TLS. It then checks the terminal state,
`USAGE_FINALITY_FINAL`, that `final_consumed_tokens` equals the receipt's FINAL
`consumed_tokens`, the original intent, requester, reservation, execution and
fence, and the meter identity. It forwards the SHA-256 of the exact drain receipt
bytes. The native service does not import or independently verify fleet evidence.

## Credentials

The operation is disabled unless `SPEC_WORK_COMPLETED_RELEASE_TOKEN` is set.
Requests need the existing gateway bearer **and** that credential in
`x-fastverk-work-completed-release-token`. It is deliberately separate from the
canceled door's `SPEC_WORK_RELEASE_TOKEN`: the two verifiers check different
evidence, and holding one does not open the other. The forwarded subject must
equal the original reservation's approving UID. Agents are refused.

## Stop cause

A cause already on the thread is kept: a budget crossing recorded by the spend
door, or a stop request. Otherwise the terminal state fills it in: `SUCCEEDED`
records `STOP_CAUSE_COMPLETED`, matching what `CloseWorkOrder` records by default,
and `FAILED` records the new `STOP_CAUSE_FAILED`, which only this door writes and
`CloseWorkOrder` does not accept. Neither cause asserts acceptance.

## Replay

The transaction holds the same process and file locks as reservation. An exact
replay of a release returns the original receipt and syncs without appending. A
changed request under the same replay key conflicts. Release and canceled-release
receipts share one replay namespace per approver. An old release cannot free a
newer attempt, and a duplicated historical row is not applied twice.

Validation: 124 native service tests and the route-wiring and proto import-boundary
checks pass. Six tests cover the release doors. The completed-release tests cover
spend recorded before the reservation not counting, stale reports, the
over-budget case, the FAILED cause, keeping an earlier cause, original-approver,
agent and credential refusals, malformed fields, restart replay, later-attempt
isolation and an uncovered log row failing closed. These are implementation
tests, not a live release, a runtime theorem, or production interoperability
evidence.
