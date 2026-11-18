# Stranded work-order release

The canceled and completed release doors (`canceled-workorder-release.md`,
`completed-workorder-release.md`) bind the releaser to the reservation's
recorded approver UID (`E_ORIGINAL_APPROVER_REQUIRED`). That approver identity
can stop existing: a ServiceAccount that is deleted and recreated has a new UID,
and a retired approver never acts again. The reservation is then held forever
and its scope and budget never return.

`POST /workorder/release-stranded` (`spec.v1.ReleaseStrandedWorkOrder`) lets an
administrator release such a reservation. It changes **who** may release, never
**what** must be shown.

## Authorization

The door is disabled unless both are configured:
- `SPEC_WORK_ADMIN_RELEASE_TOKEN`: its own verifier credential, sent as
  `x-fastverk-work-admin-release-token`. Holding a canceled or completed
  release credential does not open this door.
- `SPEC_WORK_ADMIN_RELEASE_UIDS`: a comma-separated allowlist of administrator
  principals.

The request also needs the reservation gateway bearer, like the other doors.
Agents are refused, and so is the reservation's own requester
(`E_REQUESTER_MAY_NOT_RELEASE`).

## Evidence

The request carries the same attestation as the normal doors:
- order and reservation;
- execution;
- `terminal_state`: `EXECUTION_STATE_SUCCEEDED`, `_FAILED` or `_CANCELED`;
- `fence_epoch`, `final_consumed_tokens` and `drain_receipt_sha256`.

It adds:
- `original_approver_uid`: must equal the reservation's recorded
  `approved_by_uid` (`E_ORIGINAL_APPROVER_MISMATCH`), so the administrator
  names exactly whom they supersede;
- `reason`: mandatory, up to 512 characters;
- an idempotency key.

The checks:
- **A canceled attempt** must show a positive fence and FINAL zero, as the
  canceled door requires.
- **Spend coverage** applies exactly as in the completed door: spend recorded
  since the reservation must cover `final_consumed_tokens`
  (`E_SPEND_NOT_RECORDED`).
- **No evidence, no release.** There is no option to release without evidence.
  If the fleet's evidence is lost, the reservation stays held and needs manual
  recovery (fleet `docs/work-storage-recovery.md`).

## Record and replay

The log gains a `released_stranded` event. Its receipt is a `kind: "stranded"`
identity over the request and `released_by_uid`, so every use names the
administrator, the superseded approver and the reason. The server also logs a
warning.

Replay:
- verifies the receipt;
- requires the active reservation, the recorded approver and spend coverage;
- refuses a requester as the releaser.

A forged or reordered row fails replay. Same-key replay returns the original
receipt; a changed request under the same key conflicts. Stop cause: a canceled
attempt records `STOP_CAUSE_WITHDRAWN`, as the canceled door does. Otherwise an
earlier cause is kept, or `COMPLETED`/`FAILED` fills the gap, as in the
completed door.

## Not covered

- A waiting period. The door is usable at any time, with a mandatory reason;
  spec cannot verify that the approver identity really changed.
- Two-person approval.
- Fleet grants pinned to worker, meter or reviewer UIDs that were recreated
  mid-execution. Those are a fleet concern, separate from spec reservations.
