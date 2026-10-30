# Native WorkOrder reservation

`POST /workorder/reserve` reserves exactly one native order before fleet
admission. It shares the native dispatch predicate, append log, and source
transaction lock with dispatch, spend, close, and gate observation. This is an
implemented source primitive, not a completed fleet or A2A integration.

The contract is in `proto/spec/v1/workorder.proto`. Requests name the order,
exact derived cursor, lowercase SHA-256 of the canonical approved fleet intent,
requester UID, and bounded replay key. The authenticated gateway subject is
recorded as the approving subject. It is never inferred from issue authorship.
The Spec service does not parse or independently validate a fleet WorkGrant.
The trusted fleet bridge must verify the immutable grant, actual approving UID,
requester, and exact intent before invoking this source door. A gateway token
and a recognized non-agent subject use the existing native dispatch authority;
they do not establish independent evaluator acceptance.

Unlike standalone read routes, this reservation door requires a configured
nonempty gateway token. Missing/wrong credentials reject before reservation.
The gateway/bridge must verify forwarded subject identity; clients must not be
given the gateway credential. This is a trust boundary, not a formal proof.

A successful reservation appends one native dispatched record with one agent.
A receipt ID hashes the canonical request and approving subject. Exact replay
by that subject returns the same receipt without another append, even after
listener restart or a read-model failure. Reusing the key with a changed payload
conflicts. Another key cannot reserve the same running order. A receipt is a
historical fact; it never substitutes for fresh worker permission.

Native transactions take an advisory OS file lock as well as the process mutex.
Acknowledgments sync the file and its containing directory; replay reconfirms
that sync. All source writers must use this protocol, and the deployment must
provide a durable, preprovisioned parent directory and storage with working
locking/sync semantics. Filesystem deletion, a malicious writer ignoring the
lock, distributed storage guarantees, and arbitrary replica failover are not
proved by these tests.

A native stop record for a reserved order retains its occupied scope and reports
`reservation_stop_requested`. Closing through the legacy close endpoint refuses
until an observed fleet drain/release path exists. That release path is not yet
implemented. In particular, native stop intent, worker completion, and A2A
terminal status are not evidence of stopped resources or FINAL usage.

Gate observations add `reservation` and `reservation_stop_requested` only when a
reservation exists. The existing unreserved response shape stays compatible.
The current observer rejects unknown reserved fields and revokes readiness; it
still needs the bound-reservation extension. Publishing RUNNING as READY to
work around that refusal is not a valid integration.

Validation: 119 native Rust tests pass, including exact replay after a lost reply,
conflicting replay, independent concurrent servers sharing the source log,
agent/stale-cursor/unknown-field/corrupt-receipt refusal, required gateway auth,
and scope retention after stop. Proto import-boundary and route-wiring checks
pass. These are implementation checks, not theorem or production claims.

Remaining work for the full sample:

1. Connect the trusted approval publisher to the immutable approved intent.
   The dependent fastverk/agents#45 implementation commits the exact grant, then
   claims the native order with that namespace-scoped grant as replay key.
   Fleet submission must require that exact active reservation and persist
   ADMITTING before creating the stable fleet run/task. Retry each durable step
   without appending another source dispatch. A reservation may precede fleet
   submission; abandoned reservations retain their scope and also require an
   observed, safe release rather than silently expiring.
2. Extend the source observer and worker gate to authorize only that exact active
   reservation; changed cursor, stop intent, or mismatched binding must refuse.
3. Replace the preparatory emptyDir source log with durable storage. Execute the
   approved file-edit worker in the isolated cluster and retain real artifacts.
4. Implement observed stop/drain, evidence-bound source release, and final
   metering; absence of provider usage is not a universal zero-usage proof.
5. Add durable A2A task/artifact handling and independent acceptance. Keep the
   planner replaceable. Arbitrary tools, repository checks, auctions, and
   monetary settlement remain outside this worker's supported scope.
