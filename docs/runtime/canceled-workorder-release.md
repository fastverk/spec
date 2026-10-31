# Release of a canceled, zero-provider WorkOrder attempt

`POST /workorder/release-canceled` implements the ProtoJSON projection of
`spec.v1.ReleaseCanceledWorkOrder`. It releases an active source reservation;
it neither accepts output nor removes the retained fleet Job admission barrier.
Only the supported constrained-file-edit cancellation with explicit FINAL zero
provider consumption is in scope. Successful, failed, and nonzero release need
separate contracts and are not accepted through this attestation.

The operation is disabled unless `SPEC_WORK_RELEASE_TOKEN` is configured.
Requests require both the existing gateway bearer and that dedicated credential
in `x-fastverk-work-release-token`. The ordinary shell gateway must not receive
the verifier credential. The forwarded authenticated subject must equal the
original reservation's approving UID. Agents, absent/incorrect verifier tokens,
changed reservation identities, unknown fields, noncanonical or zero fences,
and malformed digest/replay keys refuse before append.

The trusted verifier must authenticate the original approver with current fleet
TokenReview/SAR and recover the exact immutable approval; read the actual fleet
execution and drain receipt over verified TLS; match the original full intent,
requester, reservation, execution and fence; and verify CANCELED, explicit FINAL
zero consumption, approved trusted image, exact evidence hashes, meter identity,
retained resource identities, and matching drain/fence observations. It forwards
SHA-256 references to the exact receipt and fence bytes. The native service does
not import or independently verify fleet evidence. Its security therefore
includes this verifier, its private credentials, the trusted fleet observer,
and the documented Kubernetes/image assumptions. Do not enable this endpoint
behind an unverified forwarding path. The verifier and real release are pending.

The native transaction holds the same process/file locks as reservation. It
binds the original approver and active reservation before appending a durable
release receipt. Acknowledgment and exact historical replay sync the log. Old
reservation replay recovers its original receipt without rearming; old release
replay cannot free a newer attempt. Duplicate historical release records do not
apply twice. Conflicting/corrupt release records make scope observation fail
closed. Cumulative spend is never reduced or refunded. A newly authorized
attempt clears the old thread's current stop flag, retaining all historical
stop/release rows. Release itself never starts a new attempt.

Validation: 121 native service tests and the proto import-boundary and route
wiring checks pass, including original-approver/verifier refusal, release and
reservation replay across restart, later-attempt isolation, retained spend,
canonical fences, malformed requests, and corrupt durable receipts. These are
implementation tests, not a live release, runtime theorem, independent human
acceptance, or production interoperability evidence.
